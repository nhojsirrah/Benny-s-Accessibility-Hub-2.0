/**
 * Tests for BENNYSBASKETBALLSHOOTER's adoption of the shared
 * <benny-pause-overlay>.
 *
 * The bespoke pause menu (#pause-screen markup + the menu ScanController driving
 * #pause-menu-list) is retired in favour of mounting the shared overlay. The
 * game's own ScanController still drives stepping/selection — getTargets() routes
 * at the overlay's action buttons while it is open, and onSelect() runs
 * overlay.activate(). The overlay only supplies the targets and runs the action.
 *
 * Runs in jsdom with jest fake timers, mirroring basketball-menu-scan.test.js:
 * app.js is a plain <script> in the browser but exposes a CommonJS surface here
 * and skips its window 'load' auto-start under module.exports. The 3D engine
 * (Three.js + Cannon.js) it boots at module scope is replaced with deep no-op
 * stubs so the file can be require()'d headless without a WebGL context.
 *
 * The shared overlay (shipping in a sibling PR via
 * <script src="../../../shared/pause-overlay.js">) is mocked here against the
 * PAUSE-OVERLAY CONTRACT v1 and exposed on window exactly as the real script
 * would. The fallback path (window.BennyPauseOverlay absent) is covered by its
 * own describe block, and by the existing basketball-menu-scan suite.
 */

const ScanController = require("../../../../shared/scan-core.js");
const Themes = require("../../../../shared/themes.js");
const Nav = require("../../../../shared/nav.js");

// ---- Deep no-op stub for Three.js / Cannon.js / AudioContext --------------
// (Identical strategy to basketball-menu-scan.test.js.)
function makeDeepStub() {
  const canvas = document.createElement("canvas");
  const base = function () {};
  const handler = {
    get(_t, prop) {
      if (prop === "domElement") return canvas;
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "length") return 0;
      if (prop === "then") return undefined; // not a thenable
      if (prop === "toString") return () => "";
      if (prop === "valueOf") return () => 0;
      return stub;
    },
    apply: () => stub,
    construct: () => stub,
    set: () => true,
    has: () => true,
  };
  const stub = new Proxy(base, handler);
  return stub;
}

// ---- Helpers --------------------------------------------------------------

// Drive the key-up handler on the live InputHandler directly (see the note in
// basketball-menu-scan.test.js about re-require()'d window listeners).
function keyUp(code) {
  app.Input.handleKeyUp({ code });
}

// Open the pause menu from in-game play.
function openPause() {
  app.setGameState("AIMING");
  app.getMenu().togglePause();
}

function menuDom() {
  return `
    <div id="canvas-container"></div>
    <div id="start-screen" class="screen">
      <div class="menu-items-list" id="main-menu-list">
        <div class="menu-item selected" data-action="start">START GAME</div>
        <div class="menu-item" data-action="settings">SETTINGS</div>
        <div class="menu-item" data-action="exit">EXIT GAME</div>
      </div>
    </div>
    <div id="settings-screen" class="screen" style="display:none;">
      <div class="menu-items-list" id="settings-menu-list"></div>
    </div>
    <div id="pause-screen" class="screen" style="display:none;">
      <div class="menu-items-list" id="pause-menu-list">
        <div class="menu-item selected" data-action="resume">CONTINUE GAME</div>
        <div class="menu-item" data-action="restart">RESTART GAME</div>
        <div class="menu-item" data-action="settings">SETTINGS</div>
        <div class="menu-item" data-action="menu">MAIN MENU</div>
      </div>
    </div>
    <div id="game-over-screen" class="screen" style="display:none;">
      <div id="final-score"></div>
      <div class="menu-items-list" id="gameover-menu-list">
        <div class="menu-item selected" data-action="restart">PLAY AGAIN</div>
        <div class="menu-item" data-action="menu">MAIN MENU</div>
      </div>
    </div>
  `;
}

// Minimal CONTRACT v1 mock: create({actions,scanManager,voice}) -> overlay with
// show/hide/isOpen/setActions/getTargets/activate. getTargets() returns the
// action buttons; activate(target) emits a pause-action CustomEvent {id} and runs
// that action's onSelect. (No auto-hide — the game's handlers close it, exactly
// like the real overlay's resume/exit auto-hide plus the app's own hide calls.)
let lastOverlay = null;
function installMockPauseOverlay() {
  window.BennyPauseOverlay = {
    create({ actions }) {
      let current = actions || [];
      let open = false;
      const root = document.createElement("div");
      root.className = "benny-pause-overlay-mock";
      document.body.appendChild(root);

      function render() {
        root.innerHTML = "";
        current.forEach((act) => {
          const btn = document.createElement("button");
          btn.className = "benny-pause-action";
          btn.dataset.actionId = act.id;
          btn.textContent = act.label;
          root.appendChild(btn);
        });
      }

      const api = {
        show() {
          open = true;
          root.style.display = "flex";
          render();
        },
        hide() {
          open = false;
          root.style.display = "none";
        },
        isOpen() {
          return open;
        },
        setActions(a) {
          current = a || [];
          if (open) render();
        },
        getTargets() {
          return open ? Array.from(root.querySelectorAll("button")) : [];
        },
        activate(target) {
          const btns = Array.from(root.querySelectorAll("button"));
          const i = btns.indexOf(target);
          if (i < 0 || !current[i]) return;
          root.dispatchEvent(
            new CustomEvent("pause-action", { detail: { id: current[i].id } }),
          );
          if (current[i].onSelect) current[i].onSelect();
        },
      };
      lastOverlay = api;
      return api;
    },
  };
}

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

  localStorage.clear();
  document.body.innerHTML = menuDom();

  // Engine + audio stubs (must exist before require -- module scope boots them).
  global.THREE = window.THREE = makeDeepStub();
  global.CANNON = window.CANNON = makeDeepStub();
  window.AudioContext = window.webkitAudioContext = function () {
    return makeDeepStub();
  };
  window.HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue();
  window.HTMLMediaElement.prototype.pause = jest.fn();
  window.HTMLCanvasElement.prototype.getContext = jest.fn(() => makeDeepStub());

  // Shared modules exposed exactly as the real page exposes them via <script src>.
  window.ScanController = ScanController;
  window.Themes = Themes;
  window.Nav = Nav;
  window.NarbeVoiceManager = { speak: jest.fn() };
  delete window.NarbeScanManager; // app falls back to its local GameSettings.

  lastOverlay = null;
  installMockPauseOverlay();

  jest.resetModules();
  app = require("../js/app.js");
  app.getMenu().init();
  app.GameSettings.autoScan = false; // deterministic: no auto-scan timer.
});

afterEach(() => {
  try {
    app.getMenu().stopAutoScan();
    app.getScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  delete window.BennyPauseOverlay;
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Opening pause shows the shared overlay -------------------------------

describe("opening pause shows the shared overlay with the right actions", () => {
  test("togglePause builds and shows the shared overlay", () => {
    openPause();

    expect(app.getGameState()).toBe("PAUSED");
    const overlay = app.getPauseOverlay();
    expect(overlay).toBe(lastOverlay);
    expect(overlay.isOpen()).toBe(true);
    // The bespoke pause screen stays hidden so only one pause UI is on screen.
    expect(document.getElementById("pause-screen").style.display).toBe("none");
  });

  test("overlay carries the bespoke pause menu's verbatim labels", () => {
    openPause();

    const labels = app
      .getPauseOverlay()
      .getTargets()
      .map((b) => b.textContent);
    expect(labels).toEqual([
      "CONTINUE GAME",
      "RESTART GAME",
      "SETTINGS",
      "MAIN MENU",
    ]);
  });

  test("the ScanController scans the overlay's action buttons while open", () => {
    openPause();

    const scan = app.getScan();
    const targets = app.getPauseOverlay().getTargets();
    expect(targets).toHaveLength(4);
    // Seated on the first action (Continue Game).
    expect(scan.getCurrentTarget()).toBe(targets[0]);

    // Stepping advances along the overlay's buttons.
    app.getMenu().scanNext();
    expect(scan.getCurrentTarget()).toBe(targets[1]);
  });
});

// ---- Scanning + selecting routes correctly -------------------------------

describe("scanning + selecting closes / routes correctly", () => {
  test("selecting Resume (Enter) closes the overlay and resumes the game", () => {
    openPause();
    expect(app.getPauseOverlay().isOpen()).toBe(true);

    keyUp("Enter"); // index 0 -> Continue Game -> resume
    expect(app.getGameState()).toBe("AIMING");
    expect(app.getPauseOverlay().isOpen()).toBe(false);
  });

  test("NumpadEnter selects identically to Enter", () => {
    openPause();

    keyUp("NumpadEnter"); // index 0 -> Continue Game -> resume
    expect(app.getGameState()).toBe("AIMING");
    expect(app.getPauseOverlay().isOpen()).toBe(false);
  });

  test("selecting Main Menu closes the overlay and returns to the main menu", () => {
    // Basketball's pause menu has no hub-exit action; its terminal action is
    // "MAIN MENU" (the in-app exit back to the start screen). The hub-exit
    // (Nav.goBack) lives on the START menu's "EXIT GAME" item, out of scope here.
    openPause();

    app.getMenu().scanNext(); // -> Restart (1)
    app.getMenu().scanNext(); // -> Settings (2)
    app.getMenu().scanNext(); // -> Main Menu (3)

    keyUp("Enter"); // activate Main Menu -> menu
    expect(app.getGameState()).toBe("MENU");
    expect(app.getPauseOverlay().isOpen()).toBe(false);
    expect(document.getElementById("start-screen").style.display).toBe("flex");
  });

  test("activate emits a pause-action CustomEvent carrying the action id", () => {
    openPause();

    const overlay = app.getPauseOverlay();
    const root = overlay.getTargets()[0].parentElement;
    const seen = [];
    root.addEventListener("pause-action", (e) => seen.push(e.detail.id));

    keyUp("Enter"); // index 0 -> resume
    expect(seen).toEqual(["resume"]);
  });
});

// ---- Pause settings submenu still works alongside the shared overlay ------

describe("pause settings submenu still works alongside the shared overlay", () => {
  test("Settings hides the overlay and shows the bespoke settings screen", () => {
    openPause();

    app.getMenu().scanNext(); // -> Restart (1)
    app.getMenu().scanNext(); // -> Settings (2)
    keyUp("Enter"); // activate Settings

    expect(app.getPauseOverlay().isOpen()).toBe(false);
    expect(document.getElementById("settings-screen").style.display).toBe(
      "flex",
    );
    // Settings preserves the paused state so Back can return to the pause menu.
    expect(app.getGameState()).toBe("PAUSED");
    expect(app.getMenu().returnToId).toBe("pause");
  });

  test("Back from pause settings reopens the shared overlay", () => {
    openPause();
    app.getMenu().handleAction("settings"); // enter settings from pause
    expect(app.getPauseOverlay().isOpen()).toBe(false);

    app.getMenu().handleAction("back"); // returnToId === 'pause'
    expect(app.getGameState()).toBe("PAUSED");
    expect(app.getPauseOverlay().isOpen()).toBe(true);
  });
});

// ---- Fallback when the shared module is absent ----------------------------

describe("falls back to the bespoke pause menu when BennyPauseOverlay is absent", () => {
  test("togglePause shows the bespoke #pause-screen and builds no overlay", () => {
    delete window.BennyPauseOverlay; // overlay is built lazily, so this disables it

    openPause();

    expect(app.getGameState()).toBe("PAUSED");
    expect(app.getPauseOverlay()).toBeNull();
    expect(document.getElementById("pause-screen").style.display).toBe("flex");
    // The menu ScanController drives the bespoke #pause-menu-list.
    expect(app.getMenu().currentMenu).toBe(
      document.getElementById("pause-menu-list"),
    );
  });

  test("the bespoke pause menu still resumes the game", () => {
    delete window.BennyPauseOverlay;

    openPause();
    app.getMenu().setActiveMenu("pause");
    app.getMenu().activeIndex = 0; // seat on Continue Game
    keyUp("Enter");

    expect(app.getGameState()).toBe("AIMING");
    expect(document.getElementById("pause-screen").style.display).toBe("none");
  });
});
