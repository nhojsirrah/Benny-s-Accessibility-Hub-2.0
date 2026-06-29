/**
 * Integration tests for BENNYSCHESSCHECKERS after retiring its bespoke in-page
 * pause menu in favour of the shared pause overlay (window.BennyPauseOverlay,
 * shared/pause-overlay.js).
 *
 * The shared module lands in a sibling PR, so these tests build against the
 * PAUSE-OVERLAY CONTRACT v1 with a faithful jsdom mock:
 *
 *   window.BennyPauseOverlay.create({ actions, scanManager, voice })
 *     -> show() / hide() / isOpen() / setActions() / getTargets() / activate(t)
 *   actions: [{ id, label, onSelect }]; activate() runs one action's onSelect and
 *   emits a `pause-action` { id } event; getTargets() returns the action buttons.
 *
 * They verify that ChessCheckers' ScanController is routed at the overlay while
 * it is open (getTargets -> overlay.getTargets(), select -> overlay.activate()),
 * preserving Space scan / Enter select / NumpadEnter parity, and that the app
 * falls back to the legacy pause menu when the contract is absent.
 *
 * Runs in jsdom with jest fake timers, mirroring chesscheckers-scan.test.js.
 */

const ScanController = require("../../../../shared/scan-core.js");
const Themes = require("../../../../shared/themes.js");
const SettingsStore = require("../../../../shared/settings-store.js");
const Nav = require("../../../../shared/nav.js");

// ---- Helpers -------------------------------------------------------------

function dispatchKey(type, code, opts = {}) {
  const event = new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
    repeat: !!opts.repeat,
  });
  document.dispatchEvent(event);
  return event;
}

// Short press = keydown immediately followed by keyup (duration 0 < hold
// thresholds), which advances (Space) or selects (Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

function makeMockScanManager(overrides = {}) {
  const subscribers = [];
  return {
    autoScan: overrides.autoScan || false,
    interval: overrides.interval || 2000,
    getSettings() {
      return {
        autoScan: this.autoScan,
        scanSpeedIndex: 1,
        scanInterval: this.interval,
      };
    },
    getScanInterval() {
      return this.interval;
    },
    cycleScanSpeed() {},
    setAutoScan(v) {
      this.autoScan = !!v;
    },
    updateSettings(patch) {
      Object.assign(this, patch);
    },
    subscribe(cb) {
      subscribers.push(cb);
    },
    unsubscribe(cb) {
      const i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    },
  };
}

// Minimal AudioContext stub (ChessCheckers' playSound() constructs one on
// select/move and jsdom does not provide it).
function makeAudioContextStub() {
  return class {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
    }
    resume() {
      return Promise.resolve();
    }
    createOscillator() {
      return {
        type: "",
        frequency: { setValueAtTime() {}, linearRampToValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
      };
    }
    createGain() {
      return { gain: { setValueAtTime() {} }, connect() {} };
    }
  };
}

// Faithful mock of the PAUSE-OVERLAY CONTRACT v1. Builds real <button> targets in
// a container so the app's ScanController can scan/activate them exactly as it
// would the shipped <benny-pause-overlay>.
function makeMockPauseOverlay() {
  let last = null;
  return {
    create(opts) {
      const el = document.createElement("div");
      el.id = "benny-pause-overlay-mock";
      el.style.display = "none";
      document.body.appendChild(el);

      let actions = [];
      let buttons = [];
      let open = false;

      function render() {
        el.innerHTML = "";
        buttons = actions.map((a, i) => {
          const btn = document.createElement("button");
          btn.textContent = a.label;
          btn.dataset.actionId = a.id;
          btn.dataset.index = String(i);
          btn.onclick = () => instance.activate(btn);
          el.appendChild(btn);
          return btn;
        });
      }

      const instance = {
        el,
        scanManager: opts.scanManager,
        voice: opts.voice,
        setActions(next) {
          actions = (next || []).slice();
          render();
        },
        getActions() {
          return actions.slice();
        },
        getTargets() {
          return buttons.slice();
        },
        isOpen() {
          return open;
        },
        show() {
          open = true;
          el.style.display = "flex";
        },
        hide() {
          open = false;
          el.style.display = "none";
        },
        activate(target) {
          const idx = buttons.indexOf(target);
          if (idx < 0) return;
          const action = actions[idx];
          el.dispatchEvent(
            new CustomEvent("pause-action", { detail: { id: action.id } }),
          );
          if (action && typeof action.onSelect === "function")
            action.onSelect();
        },
      };

      instance.setActions(opts.actions || []);
      last = instance;
      return instance;
    },
    last() {
      return last;
    },
  };
}

const EXPECTED_LABELS = [
  "Continue Game",
  "Reset Game",
  "Settings",
  "Main Menu",
];

// Stand up the shared-module globals + DOM and (re)load the app fresh. Pass
// withOverlay=false to exercise the no-contract fallback.
function bootApp({ withOverlay = true } = {}) {
  localStorage.clear();
  SettingsStore._reset();

  document.body.innerHTML =
    '<div id="game-container"><div id="main-content"></div></div>' +
    '<div id="status-display"></div><div id="audio-container"></div>';

  window.ScanController = ScanController;
  window.Themes = Themes;
  window.SettingsStore = SettingsStore;
  window.Nav = Nav;
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };
  window.AudioContext = makeAudioContextStub();

  if (withOverlay) {
    window.BennyPauseOverlay = makeMockPauseOverlay();
  } else {
    delete window.BennyPauseOverlay;
  }

  jest.resetModules();
  const app = require("../script.js");
  app.init();
  return app;
}

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
});

afterEach(() => {
  try {
    app?.getScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Overlay adoption ----------------------------------------------------

describe("pause opens the shared overlay with the migrated actions", () => {
  beforeEach(() => {
    app = bootApp();
  });

  test("openPauseMenu shows the overlay populated with the four pause actions", () => {
    app.startGame("two");
    app.openPauseMenu();

    const overlay = app.getPauseOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay.isOpen()).toBe(true);
    expect(app.state.mode).toBe("pause");

    const targets = overlay.getTargets();
    expect(targets).toHaveLength(4);
    expect(targets.map((b) => b.textContent)).toEqual(EXPECTED_LABELS);
  });

  test("the migrated actions mirror menus.pause verbatim (labels + ids)", () => {
    expect(app.pauseActions.map((a) => a.label)).toEqual(EXPECTED_LABELS);
    expect(app.pauseActions.map((a) => a.id)).toEqual([
      "continue",
      "reset",
      "settings",
      "mainMenu",
    ]);
    // The legacy pause menu text must still match the overlay labels.
    expect(app.menus.pause.map((m) => m.text)).toEqual(EXPECTED_LABELS);
  });

  test("the ScanController scans the overlay's buttons while it is open", () => {
    app.startGame("two");
    app.openPauseMenu();

    const overlayTargets = app.getPauseOverlay().getTargets();
    const scanned = app.getScanTargets();
    expect(scanned).toHaveLength(overlayTargets.length);
    scanned.forEach((node, i) => expect(node).toBe(overlayTargets[i]));
    // Seated on the first action (Continue Game).
    expect(app.getScan().getIndex()).toBe(0);
  });

  test("Space advances through the overlay targets", () => {
    app.startGame("two");
    app.openPauseMenu();
    expect(app.getScan().getIndex()).toBe(0);

    tap("Space");
    expect(app.getScan().getIndex()).toBe(1);
    tap("Space");
    expect(app.getScan().getIndex()).toBe(2);
  });
});

// ---- Selection routes through overlay.activate() -------------------------

describe("select runs through overlay.activate()", () => {
  beforeEach(() => {
    app = bootApp();
  });

  test("scan to Resume (Continue Game) and select closes the overlay", () => {
    app.startGame("two");
    app.openPauseMenu();
    const overlay = app.getPauseOverlay();
    expect(overlay.isOpen()).toBe(true);

    // Seated on Continue Game (index 0) at open; select it.
    expect(overlay.getTargets()[app.getScan().getIndex()].textContent).toBe(
      "Continue Game",
    );
    tap("Enter");

    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("game");
    expect(document.getElementById("pause-overlay").style.display).toBe("none");
  });

  test("Exit path: selecting Main Menu closes the overlay and returns to menu", () => {
    app.startGame("two");
    app.openPauseMenu();
    const overlay = app.getPauseOverlay();

    // Scan to the last action (Main Menu) and select it.
    app.getScan().setIndex(3);
    expect(overlay.getTargets()[3].textContent).toBe("Main Menu");
    tap("Enter");

    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("menu");
    expect(app.state.menuState).toBe("main");
  });

  test("activate emits a `pause-action` event carrying the action id", () => {
    app.startGame("two");
    app.openPauseMenu();
    const overlay = app.getPauseOverlay();

    const seen = [];
    overlay.el.addEventListener("pause-action", (e) => seen.push(e.detail.id));

    app.getScan().setIndex(1); // Reset Game
    tap("Enter");

    expect(seen).toEqual(["reset"]);
  });

  test("NumpadEnter selects identically to Enter (closes on Continue Game)", () => {
    app.startGame("two");
    app.openPauseMenu();
    const overlay = app.getPauseOverlay();

    expect(overlay.isOpen()).toBe(true);
    tap("NumpadEnter");

    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("game");
  });
});

// ---- Pause settings sub-page (not part of the overlay contract) ----------

describe("pause settings sub-page", () => {
  beforeEach(() => {
    app = bootApp();
  });

  test("Settings hides the overlay and renders the legacy settings list", () => {
    app.startGame("two");
    app.openPauseMenu();
    const overlay = app.getPauseOverlay();

    // Select Settings (index 2).
    app.getScan().setIndex(2);
    expect(overlay.getTargets()[2].textContent).toBe("Settings");
    tap("Enter");

    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("pause");
    expect(app.state.pauseMenuState).toBe("settings");
    // The legacy container is now the visible pause surface (renderMenu switches
    // the settings list to a grid layout, so just assert it is shown).
    expect(document.getElementById("pause-overlay").style.display).not.toBe(
      "none",
    );
    // Scan now reads the legacy settings menu, not the overlay buttons.
    expect(app.getScanTargets()).toBe(app.menus.pauseSettings);
  });

  test("Back from pause settings reopens the overlay", () => {
    app.startGame("two");
    app.openPauseMenu();
    app.showPauseSettings();
    expect(app.getPauseOverlay().isOpen()).toBe(false);

    app.openPauseMenu(); // pauseSettings "Back" action calls openPauseMenu()
    expect(app.getPauseOverlay().isOpen()).toBe(true);
    expect(app.state.pauseMenuState).toBe("main");
    expect(document.getElementById("pause-overlay").style.display).toBe("none");
  });
});

// ---- Fallback when the contract is absent --------------------------------

describe("fallback: legacy pause menu when BennyPauseOverlay is absent", () => {
  beforeEach(() => {
    app = bootApp({ withOverlay: false });
  });

  test("no overlay is created and the legacy in-page pause menu is used", () => {
    app.startGame("two");
    app.openPauseMenu();

    expect(app.getPauseOverlay()).toBeNull();
    expect(app.state.mode).toBe("pause");
    // Legacy scan targets + visible in-page overlay container.
    expect(app.getScanTargets()).toBe(app.menus.pause);
    expect(document.getElementById("pause-overlay").style.display).toBe("flex");
  });

  test("Enter still selects the focused legacy pause item (Continue Game resumes)", () => {
    app.startGame("two");
    app.openPauseMenu();
    expect(app.getScan().getIndex()).toBe(0); // Continue Game

    tap("Enter");

    expect(app.state.mode).toBe("game");
    expect(document.getElementById("pause-overlay").style.display).toBe("none");
  });
});
