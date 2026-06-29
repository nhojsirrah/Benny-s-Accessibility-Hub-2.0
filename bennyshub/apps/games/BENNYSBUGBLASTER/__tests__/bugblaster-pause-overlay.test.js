/**
 * Tests for BENNYSBUGBLASTER's adoption of the shared <benny-pause-overlay>.
 *
 * BugBlaster is canvas-drawn: its menus (incl. PAUSED) are painted on a <canvas>
 * and scanned via the shared ScanController over {value,label} targets. This
 * suite covers retiring the bespoke canvas pause panel in favour of the shared
 * DOM overlay (PAUSE-OVERLAY CONTRACT v1). The overlay is mocked against the
 * contract and exposed on window exactly as the real
 * <script src="../../../shared/pause-overlay.js"> would. The game's own
 * ScanController still drives stepping/selection; the overlay only supplies
 * getTargets()/activate(). The fallback test omits window.BennyPauseOverlay and
 * asserts the canvas pause path still runs.
 *
 * Runs in jsdom with jest fake timers. game.js is a plain <script> in the
 * browser; for tests it exposes a CommonJS surface and skips its rAF auto-start.
 */

const ScanController = require("../../../../shared/scan-core.js");
const Themes = require("../../../../shared/themes.js");
const Nav = require("../../../../shared/nav.js");

// ---- Helpers -------------------------------------------------------------

function dispatchKey(type, code) {
  const event = new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

// Short press = keydown immediately followed by keyup (duration 0 < hold
// thresholds), which advances (Space) or selects (Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

function makeMockScanManager(overrides = {}) {
  return {
    autoScan: overrides.autoScan || false,
    interval: overrides.interval || 2000,
    getSettings() {
      return { autoScan: this.autoScan, scanInterval: this.interval };
    },
    getScanInterval() {
      return this.interval;
    },
    cycleScanSpeed() {},
    updateSettings(p) {
      if (typeof p.autoScan === "boolean") this.autoScan = p.autoScan;
    },
    subscribe() {},
    unsubscribe() {},
  };
}

// Minimal CONTRACT v1 mock: create({actions,scanManager,voice}) -> overlay with
// show/hide/isOpen/setActions/getTargets/activate. getTargets() returns the
// action buttons; activate(target) runs that action's onSelect and emits a
// pause-action CustomEvent {id}.
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
          return Array.from(root.querySelectorAll("button"));
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

// Open the PAUSED menu the way the in-game entry points do: enter the state,
// clear the highlight (so the first Space lands on Continue), then hand it to
// the shared overlay.
function openPause(app) {
  app.setGameState("PAUSED");
  app.setMenuIndex(-1);
  app.showPauseOverlay();
}

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

  localStorage.clear();
  document.body.innerHTML = '<canvas id="gameCanvas"></canvas>';

  // jsdom implements neither a 2d canvas context nor media playback.
  window.HTMLCanvasElement.prototype.getContext = jest.fn(() => null);
  window.HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue();
  window.HTMLMediaElement.prototype.pause = jest.fn();
  window.speechSynthesis = { cancel: jest.fn() };

  lastOverlay = null;
  installMockPauseOverlay();

  window.ScanController = ScanController;
  window.Themes = Themes;
  window.Nav = Nav;
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };

  jest.resetModules();
  app = require("../game.js");
});

afterEach(() => {
  try {
    app.getScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  delete window.BennyPauseOverlay;
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Tests ---------------------------------------------------------------

describe("opening pause shows the shared overlay with the right actions", () => {
  test("showPauseOverlay builds and shows the overlay", () => {
    openPause(app);

    expect(app.getState().gameState).toBe("PAUSED");
    const overlay = app.getPauseOverlay();
    expect(overlay).toBe(lastOverlay);
    expect(overlay.isOpen()).toBe(true);
  });

  test("overlay carries the same labels as the bespoke pause menu", () => {
    openPause(app);

    const labels = app
      .getPauseOverlay()
      .getTargets()
      .map((b) => b.textContent);
    expect(labels).toEqual([
      "Continue",
      "Restart Level",
      "Settings",
      "Main Menu",
    ]);
  });

  test("the ScanController scans the overlay's buttons while open", () => {
    openPause(app);

    const targets = app.getMenuTargets();
    expect(targets).toEqual(app.getPauseOverlay().getTargets());
    expect(targets).toHaveLength(4);

    // Seated before the first action; the first Space tap lands on Continue.
    expect(app.getScan().getCurrentTarget()).toBeUndefined();
    tap("Space");
    expect(app.getScan().getCurrentTarget()).toBe(
      app.getPauseOverlay().getTargets()[0],
    );
  });
});

describe("scanning + selecting closes / routes correctly", () => {
  test("selecting Continue (Enter) closes the overlay and resumes the game", () => {
    openPause(app);
    expect(app.getPauseOverlay().isOpen()).toBe(true);

    tap("Space"); // focus index 0 -> Continue
    tap("Enter"); // select -> resume

    expect(app.getState().gameState).toBe("PLAYING");
    expect(app.getPauseOverlay().isOpen()).toBe(false);
  });

  test("NumpadEnter selects identically to Enter", () => {
    openPause(app);

    tap("Space"); // focus index 0 -> Continue
    tap("NumpadEnter"); // select -> resume

    expect(app.getState().gameState).toBe("PLAYING");
    expect(app.getPauseOverlay().isOpen()).toBe(false);
  });

  test("selecting Main Menu resets to the menu and closes the overlay", () => {
    openPause(app);

    tap("Space"); // index 0
    tap("Space"); // index 1
    tap("Space"); // index 2
    tap("Space"); // index 3 -> Main Menu
    expect(app.getScan().getIndex()).toBe(3);

    tap("Enter"); // select -> reset_game_state + MENU
    expect(app.getState().gameState).toBe("MENU");
    expect(app.getPauseOverlay().isOpen()).toBe(false);
  });

  test("activate emits a pause-action CustomEvent carrying the action id", () => {
    openPause(app);

    const seen = [];
    app
      .getPauseOverlay()
      .getTargets()[0]
      .parentElement.addEventListener("pause-action", (e) =>
        seen.push(e.detail.id),
      );

    tap("Space"); // index 0
    tap("Enter"); // activate Continue
    expect(seen).toEqual(["0"]);
  });
});

describe("pause settings submenu still works alongside the shared overlay", () => {
  test("Settings hides the overlay and shows the canvas settings menu", () => {
    openPause(app);

    tap("Space"); // index 0
    tap("Space"); // index 1
    tap("Space"); // index 2 -> Settings
    tap("Enter"); // select -> showSettings

    expect(app.getState().gameState).toBe("SETTINGS");
    expect(app.getPauseOverlay().isOpen()).toBe(false);

    // The canvas SETTINGS menu is now the scan target set ({value,label}).
    const labels = app.getMenuTargets().map((t) => t.label);
    expect(labels).toEqual([
      "TTS",
      "Auto Scan",
      "Scan Speed",
      "Auto Stomp",
      "SFX",
      "Music",
      "Back",
    ]);
  });
});

describe("fallback when BennyPauseOverlay is absent", () => {
  test("the bespoke canvas pause path still drives PAUSED", () => {
    delete window.BennyPauseOverlay;

    app.setGameState("PAUSED");
    app.setMenuIndex(-1);
    expect(app.showPauseOverlay()).toBe(false);
    expect(app.getPauseOverlay()).toBe(null);

    // getMenuTargets falls back to the canvas {value,label} targets.
    const targets = app.getMenuTargets();
    expect(targets).toEqual([
      { value: 0, label: "Continue" },
      { value: 1, label: "Restart Level" },
      { value: 2, label: "Settings" },
      { value: 3, label: "Main Menu" },
    ]);

    // Scanning + selecting Continue still resumes via runMenuAction.
    tap("Space"); // focus index 0
    tap("Enter"); // select -> resume
    expect(app.getState().gameState).toBe("PLAYING");
  });
});
