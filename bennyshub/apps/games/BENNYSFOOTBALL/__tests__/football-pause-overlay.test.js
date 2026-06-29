/**
 * Tests for BENNYSFOOTBALL after retiring the bespoke in-canvas MAIN pause menu
 * in favour of the shared <benny-pause-overlay> (window.BennyPauseOverlay,
 * shared/pause-overlay.js).
 *
 * Football is a switch-scan Phaser game: its shared ScanInput owns Space (tap =
 * scan forward) and Enter / NumpadEnter (select) at the window level. While the
 * MAIN pause menu is shown, the GameScene routes that scan at the overlay —
 * scanForward()/scanBackward() step overlay.getTargets() and commit() runs
 * overlay.activate() — so the labels and onPauseSelect handlers are unchanged.
 * The pause SETTINGS sub-view is not part of the overlay contract and keeps using
 * the bespoke in-canvas ScanList; when BennyPauseOverlay is absent the whole pause
 * menu falls back to the bespoke ScanList.
 *
 * The shared module lands in a sibling PR, so these tests inject a minimal
 * contract-compliant mock on window.BennyPauseOverlay that builds a real DOM
 * button per action (so getTargets()/activate() exercise real elements). Runs in
 * jsdom with fake timers; Phaser is stubbed with chainable no-op display objects.
 */

const ScanController = require("../../../../shared/scan-core.js"); // sets window.ScanController
require("../../../../shared/nav.js"); // registers window.Nav

// ---- Phaser + global stubs (must exist before requiring the game files) -----
global.Phaser = {
  Scene: class {
    constructor() {}
  },
  Input: { Keyboard: { KeyCodes: { SPACE: 32 } } },
  Math: { Clamp: (v, a, b) => Math.min(Math.max(v, a), b) },
};
global.W = 1000;
global.H = 600;

// Settings sub-view globals (only read when pauseView === 'settings').
global.easyThrowOn = () => false;
global.colorblindMode = () => "normal";
global.COLORBLIND_MODES = [{ id: "normal", label: "Normal" }];

const { ScanList, ScanInput, PauseOverlayController } = require("../js/ui.js");
// game.js references these as bare globals (the browser loads ui.js as a <script>).
global.ScanList = ScanList;
global.ScanInput = ScanInput;
global.PauseOverlayController = PauseOverlayController;

const { GameScene } = require("../js/game.js");

// ---- Chainable no-op Phaser display object ---------------------------------
function makeChain() {
  const store = {};
  const obj = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop in store) return store[prop];
      if (prop === "isDown") return false;
      if (prop === Symbol.toPrimitive) return () => 0;
      return () => obj;
    },
    set(_t, prop, val) {
      store[prop] = val;
      return true;
    },
  });
  return obj;
}

// ---- Contract-compliant mock for window.BennyPauseOverlay ------------------
let lastOverlay = null;
function installMockOverlay() {
  window.BennyPauseOverlay = {
    create(opts) {
      const cfg = opts || {};
      const actions = cfg.actions || [];
      const el = document.createElement("div");
      el.className = "benny-pause-overlay-mock";
      el.style.display = "none";
      const buttons = actions.map((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "benny-pause-action benny-pause-" + a.id;
        b.setAttribute("data-action-id", a.id);
        b.setAttribute("aria-label", a.label);
        b.textContent = a.label;
        return b;
      });
      buttons.forEach((b) => el.appendChild(b));
      document.body.appendChild(el);

      let open = false;
      const inst = {
        scanManager: cfg.scanManager,
        voice: cfg.voice,
        actions,
        buttons,
        el,
        show() {
          open = true;
          el.style.display = "flex";
          if (buttons[0] && buttons[0].focus) buttons[0].focus();
        },
        hide() {
          open = false;
          el.style.display = "none";
        },
        isOpen() {
          return open;
        },
        setActions() {},
        getTargets() {
          return open ? buttons.slice() : [];
        },
        activate(target) {
          const id =
            typeof target === "string"
              ? target
              : target && target.getAttribute
                ? target.getAttribute("data-action-id")
                : null;
          const act = actions.find((x) => x.id === id);
          if (!act) return false;
          if (act.onSelect) act.onSelect();
          // Mirror the real overlay: only resume/exit auto-hide. Football's ids
          // (continue/settings/menu) do not, so the handlers do the hiding.
          return true;
        },
        remove() {
          if (el.parentNode) el.parentNode.removeChild(el);
        },
      };
      lastOverlay = inst;
      return inst;
    },
  };
}

// ---- Audio + scan/voice manager mocks --------------------------------------
function makeAudio() {
  return {
    settings: { soundEnabled: true, musicEnabled: true },
    saveSettings: jest.fn(),
    toggleMusic: jest.fn(),
    play: jest.fn(),
    speak: jest.fn(),
  };
}

// ---- GameScene factory: build an instance with the minimal stubbed surface --
const liveScenes = [];
function makeGameScene() {
  const scene = new GameScene();
  scene.audio = makeAudio();
  scene.add = new Proxy({}, { get: () => () => makeChain() });
  scene.time = { addEvent: () => makeChain() };
  scene.scene = { start: jest.fn() };
  scene.input = {
    keyboard: { addKey: () => ({ isDown: false }) },
    on: () => {},
  };
  scene.events = { once: () => {} };
  scene.phase = "idle";
  scene.paused = false;
  scene.playMenu = null;
  scene.playDiagram = null;
  scene.setupKeys(); // wires a real ScanInput → scanForward / commit / togglePause
  liveScenes.push(scene);
  return scene;
}

// ---- Key dispatch (real KeyboardEvents through ScanInput's window listeners) -
function dispatch(type, code) {
  window.dispatchEvent(
    new window.KeyboardEvent(type, { code, bubbles: true, cancelable: true }),
  );
}
function tap(code) {
  dispatch("keydown", code);
  dispatch("keyup", code);
}

beforeEach(() => {
  jest.useFakeTimers();
  lastOverlay = null;
  installMockOverlay();
  window.NarbeScanManager = {
    getSettings: () => ({ autoScan: false, scanInterval: 2200 }),
    getScanInterval: () => 2200,
  };
  window.NarbeVoiceManager = { getSettings: () => ({ ttsEnabled: true }) };
});

afterEach(() => {
  while (liveScenes.length) {
    const s = liveScenes.pop();
    if (s.scanInput) s.scanInput.destroy();
  }
  document
    .querySelectorAll(".benny-pause-overlay-mock")
    .forEach((n) => n.remove());
  delete window.BennyPauseOverlay;
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ===========================================================================

describe("shared overlay adoption", () => {
  test("togglePause builds the overlay with the three pause actions verbatim", () => {
    const scene = makeGameScene();
    scene.togglePause();

    expect(scene.pauseOverlayCtrl).toBeTruthy();
    expect(scene.pauseOverlayCtrl.isOpen()).toBe(true);
    // No canvas dim backdrop in the shared path — the DOM overlay supplies it.
    expect(scene.pauseOverlay).toBeFalsy();

    expect(lastOverlay.actions.map((a) => [a.id, a.label])).toEqual([
      ["continue", "Continue Game"],
      ["settings", "Settings"],
      ["menu", "Main Menu"],
    ]);
    // scanManager / voice are handed through from the shared singletons.
    expect(lastOverlay.scanManager).toBe(window.NarbeScanManager);
    expect(lastOverlay.voice).toBe(window.NarbeVoiceManager);
  });

  test("show() moves focus out of the overlay so Space stays a scan key", () => {
    const scene = makeGameScene();
    scene.togglePause();
    // The mock (like the real overlay) focuses its first button on show(); the
    // controller must blur it so the focused button can't self-activate on Space.
    expect(lastOverlay.buttons).toContain(
      lastOverlay.buttons.find(
        (b) => b.getAttribute("data-action-id") === "continue",
      ),
    );
    expect(lastOverlay.buttons.indexOf(document.activeElement)).toBe(-1);
  });
});

describe("scan + select via the shared ScanInput", () => {
  test("Space scans and Enter on Resume closes the overlay and resumes", () => {
    const scene = makeGameScene();
    scene.togglePause();

    tap("Space"); // → scanForward → overlay.next → index 0 (Continue Game)
    expect(scene.audio.speak).toHaveBeenCalledWith("Continue Game", true);

    tap("Enter"); // → commit → overlay.activate('continue') → closePause()
    expect(scene.paused).toBe(false);
    expect(scene.pauseOverlayCtrl).toBeNull();
    // destroy() removed the element from the DOM.
    expect(document.querySelector(".benny-pause-overlay-mock")).toBeNull();
  });

  test("Main Menu (exit) closes the overlay and starts the TitleScene", () => {
    const scene = makeGameScene();
    scene.togglePause();

    tap("Space"); // index 0
    tap("Space"); // index 1
    tap("Space"); // index 2 (Main Menu)
    expect(scene.audio.speak).toHaveBeenLastCalledWith("Main Menu", true);

    tap("Enter"); // activate('menu') → closePause() + scene.start('TitleScene')
    expect(scene.scene.start).toHaveBeenCalledWith("TitleScene");
    expect(scene.paused).toBe(false);
    expect(document.querySelector(".benny-pause-overlay-mock")).toBeNull();
  });

  test("NumpadEnter selects the focused action (parity with Enter)", () => {
    const scene = makeGameScene();
    scene.togglePause();

    tap("Space"); // index 0 (Continue Game)
    tap("NumpadEnter"); // → commit → activate('continue') → closePause()
    expect(scene.paused).toBe(false);
    expect(scene.pauseOverlayCtrl).toBeNull();
  });
});

describe("settings sub-view handoff", () => {
  test("Settings hands the screen to the canvas ScanList; Back returns to the overlay", () => {
    const scene = makeGameScene();
    scene.togglePause();

    tap("Space"); // index 0
    tap("Space"); // index 1 (Settings)
    tap("Enter"); // activate('settings')

    expect(scene.pauseView).toBe("settings");
    expect(lastOverlay.isOpen()).toBe(false); // overlay handed off
    expect(scene.pauseMenu).toBeInstanceOf(ScanList); // canvas settings list
    expect(scene.pauseOverlay).toBeTruthy(); // canvas dim backdrop now present
    expect(scene._sharedPauseActive()).toBe(false);

    // The settings list's "Back" option routes through onPauseSelect('back').
    scene.onPauseSelect("back");
    expect(scene.pauseView).toBe("main");
    expect(lastOverlay.isOpen()).toBe(true); // overlay back in control
    expect(scene.pauseMenu).toBeNull();
    expect(scene.pauseOverlay).toBeFalsy(); // canvas backdrop removed
  });
});

describe("fallback when BennyPauseOverlay is absent", () => {
  test("togglePause uses the bespoke in-canvas ScanList pause menu", () => {
    delete window.BennyPauseOverlay;
    const scene = makeGameScene();
    scene.togglePause();

    expect(scene.pauseOverlayCtrl).toBeNull();
    expect(scene.pauseMenu).toBeInstanceOf(ScanList); // bespoke menu
    expect(scene.pauseOverlay).toBeTruthy(); // canvas dim backdrop
    expect(scene.audio.speak).toHaveBeenCalledWith("Paused.");
    expect(document.querySelector(".benny-pause-overlay-mock")).toBeNull();
  });
});
