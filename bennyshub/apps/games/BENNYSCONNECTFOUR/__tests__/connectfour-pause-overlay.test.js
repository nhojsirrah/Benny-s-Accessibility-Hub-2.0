/**
 * Integration tests for BENNYSCONNECTFOUR after retiring its bespoke pause menu
 * in favor of the shared <benny-pause-overlay> (PAUSE-OVERLAY CONTRACT v1).
 *
 * The shared module (shared/pause-overlay.js) lands in a sibling PR, so these
 * tests inject a minimal contract-compliant mock on window.BennyPauseOverlay:
 *   create({ actions, scanManager, voice }) -> instance with
 *   show()/hide()/isOpen()/setActions()/getTargets()/activate(target);
 *   getTargets() returns the action buttons; activate() runs one action's
 *   onSelect; selecting emits a "pause-action" event with the action id.
 *
 * The tests confirm that ConnectFour's ScanController is routed at the overlay
 * while it is open (getTargets -> overlay.getTargets(), select -> activate()),
 * preserving Space-scan / Enter-select / NumpadEnter parity, and that Resume and
 * the Main Menu ("exit") path both close the overlay. Run in jsdom with jest
 * fake timers; the shared scan/voice managers are mocked exactly as the real
 * page exposes them. Two-player mode keeps the flow deterministic (no AI).
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
// thresholds): advances (Space) or selects (Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

// Hold Enter past the pause threshold (config.enterLongPress = 5000ms) to open
// the pause menu via ScanController.onPause, then release without a trailing
// select (mirrors the real onPause flow).
function holdEnterToPause() {
  dispatchKey("keydown", "Enter");
  jest.advanceTimersByTime(5000);
  dispatchKey("keyup", "Enter");
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
      return {
        gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
        connect() {},
      };
    }
  };
}

// Minimal contract-compliant stand-in for the shared pause overlay. Builds a
// real DOM button per action so the ScanController can scan and activate them.
function makeMockBennyPauseOverlay() {
  return {
    lastInstance: null,
    create(opts) {
      const config = opts || {};
      let acts = config.actions || [];
      let open = false;

      const el = document.createElement("div");
      el.id = "benny-pause-overlay";
      el.style.display = "none";
      document.body.appendChild(el);

      let buttons = [];
      const instance = {
        scanManager: config.scanManager,
        voice: config.voice,
        _render() {
          el.innerHTML = "";
          buttons = acts.map((a) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = a.label;
            b.setAttribute("data-action-id", a.id);
            b.onclick = () => instance.activate(b);
            el.appendChild(b);
            return b;
          });
        },
        show() {
          open = true;
          el.style.display = "flex";
        },
        hide() {
          open = false;
          el.style.display = "none";
        },
        isOpen() {
          return open;
        },
        setActions(next) {
          acts = next || [];
          this._render();
        },
        getTargets() {
          return buttons;
        },
        activate(target) {
          const idx = buttons.indexOf(target);
          if (idx < 0) return;
          const a = acts[idx];
          el.dispatchEvent(
            new CustomEvent("pause-action", { detail: { id: a.id } }),
          );
          if (a && typeof a.onSelect === "function") a.onSelect();
        },
      };
      instance._render();
      this.lastInstance = instance;
      return instance;
    },
  };
}

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

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
  // Fuller voice mock than the scan suite's {speak} stub: rendering the pause
  // Settings list reads getSettings().ttsEnabled, so it must be present.
  window.NarbeVoiceManager = {
    speak: jest.fn(),
    _ttsEnabled: true,
    getSettings() {
      return { ttsEnabled: this._ttsEnabled };
    },
    toggleTTS() {
      this._ttsEnabled = !this._ttsEnabled;
    },
  };
  window.AudioContext = makeAudioContextStub();
  window.BennyPauseOverlay = makeMockBennyPauseOverlay();

  jest.resetModules();
  app = require("../script.js");
  app.init();
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

describe("pause opens the shared overlay with the migrated actions", () => {
  test("create() received the four pause actions verbatim", () => {
    const overlay = app.getPauseOverlay();
    expect(overlay).toBeTruthy();
    const labels = overlay.getTargets().map((b) => b.textContent);
    expect(labels).toEqual([
      "Continue Game",
      "Reset Game",
      "Settings",
      "Main Menu",
    ]);
    const ids = overlay
      .getTargets()
      .map((b) => b.getAttribute("data-action-id"));
    expect(ids).toEqual(["continue", "reset", "settings", "mainmenu"]);
  });

  test("contract collaborators (scanManager, voice) are passed through", () => {
    const overlay = app.getPauseOverlay();
    expect(overlay.scanManager).toBe(window.NarbeScanManager);
    expect(overlay.voice).toBe(window.NarbeVoiceManager);
  });

  test("hold-Enter during a game shows the overlay and routes scan at it", () => {
    app.startGame("two");
    expect(app.state.mode).toBe("game");

    holdEnterToPause();
    expect(app.state.mode).toBe("pause");

    const overlay = app.getPauseOverlay();
    expect(overlay.isOpen()).toBe(true);
    // Scan targets are now the overlay buttons, not the menus.pause array.
    expect(app.getScanTargets()).toBe(overlay.getTargets());
    expect(app.getScanTargets()).toHaveLength(4);
  });
});

describe("scan + select routes through the overlay", () => {
  test("selecting Resume (Continue Game) closes the overlay and resumes", () => {
    app.startGame("two");
    holdEnterToPause();
    const overlay = app.getPauseOverlay();
    expect(overlay.isOpen()).toBe(true);

    // Seated at index 0 = Continue Game on open.
    expect(app.getScan().getIndex()).toBe(0);
    tap("Enter");

    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("game");
  });

  test("Space scans to Main Menu and select takes the exit path", () => {
    app.startGame("two");
    holdEnterToPause();
    const overlay = app.getPauseOverlay();

    // Continue(0) -> Reset(1) -> Settings(2) -> Main Menu(3).
    tap("Space");
    tap("Space");
    tap("Space");
    expect(app.getScan().getIndex()).toBe(3);
    expect(
      app.getScan().getCurrentTarget().getAttribute("data-action-id"),
    ).toBe("mainmenu");

    tap("Enter");
    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("menu");
    expect(app.state.menuState).toBe("main");
  });

  test("NumpadEnter selects identically to Enter (Resume)", () => {
    app.startGame("two");
    holdEnterToPause();
    const overlay = app.getPauseOverlay();
    expect(app.getScan().getIndex()).toBe(0);

    tap("NumpadEnter");

    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("game");
  });

  test("activate emits a pause-action event with the action id", () => {
    app.startGame("two");
    holdEnterToPause();
    const overlay = app.getPauseOverlay();

    const seen = [];
    const el = document.getElementById("benny-pause-overlay");
    el.addEventListener("pause-action", (e) => seen.push(e.detail.id));

    tap("Enter"); // Continue Game
    expect(seen).toEqual(["continue"]);
  });
});

describe("pause Settings sub-menu falls back to the legacy host", () => {
  test("selecting Settings hides the overlay and scans the settings list", () => {
    app.startGame("two");
    holdEnterToPause();
    const overlay = app.getPauseOverlay();

    // Scan to Settings (index 2) and select it.
    tap("Space");
    tap("Space");
    expect(
      app.getScan().getCurrentTarget().getAttribute("data-action-id"),
    ).toBe("settings");
    tap("Enter");

    // Overlay hidden; scanning now targets the pause settings list.
    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("pause");
    expect(app.state.pauseMenuState).toBe("settings");
    expect(app.getScanTargets()).toBe(app.menus.pauseSettings);
  });
});

describe("absent-API guard falls back to the bespoke pause menu", () => {
  test("with no BennyPauseOverlay, pause uses the legacy #pause-overlay menu", () => {
    // Rebuild the app without the shared module present.
    app.getScan()?.destroy?.();
    delete window.BennyPauseOverlay;

    document.body.innerHTML =
      '<div id="game-container"><div id="main-content"></div></div>' +
      '<div id="status-display"></div><div id="audio-container"></div>';

    jest.resetModules();
    const fallback = require("../script.js");
    fallback.init();

    expect(fallback.getPauseOverlay()).toBeNull();

    fallback.startGame("two");
    fallback.openPauseMenu();

    expect(fallback.state.mode).toBe("pause");
    // Legacy host is shown and scanning targets the menus.pause array.
    const legacy = document.getElementById("pause-overlay");
    expect(legacy.style.display).toBe("flex");
    expect(fallback.getScanTargets()).toBe(fallback.menus.pause);

    fallback.getScan()?.destroy?.();
  });
});
