/**
 * Integration tests for BENNYSSLOTMACHINE after migrating its menu/scan layer onto
 * the shared ScanController (shared/scan-core.js).
 *
 * The slot machine is a single-axis scanner whose live target list depends on the
 * current mode (main/settings menu, in-game action bar, pause menu, game-over,
 * autoplay menu). getScanTargets() is re-read by the controller on every step. The
 * controller's per-step focus is mirrored back onto the app's per-mode index, so the
 * existing highlight/announce/select code is reused unchanged.
 *
 * Anti-tremor: the original game delegated debouncing to the shared scan-manager's
 * capture-phase 200ms input cooldown (INPUT_COOLDOWN_MS). That same floor is mirrored
 * onto the controller via minIntervalMs (200ms) so the gate survives even when the
 * manager is not present — which is exactly the situation in these tests (only
 * ScanController is loaded). Because Date.now() is frozen by fake timers, taps must
 * advance the clock past the 200ms floor to be accepted; a tap inside the floor is
 * rejected, which is the behaviour the gate test asserts.
 *
 * Runs in jsdom with jest fake timers. The shared scan/voice managers are mocked and
 * injected via window globals exactly as the real page would expose them.
 */

const fs = require("fs");
const pathlib = require("path");

const ScanController = require("../../../../shared/scan-core.js");
const SettingsStore = require("../../../../shared/settings-store.js");
const Nav = require("../../../../shared/nav.js");

// ---- Helpers -------------------------------------------------------------

let now = 0;

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

// Short press = keydown immediately followed by keyup (duration 0 < hold thresholds),
// which advances (Space) or selects (Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

// Advance the clock past the 200ms anti-tremor floor, then tap — the normal case for
// a deliberate switch press.
function tapAfterCooldown(code) {
  now += 250;
  jest.setSystemTime(now);
  tap(code);
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
    subscribe(cb) {
      subscribers.push(cb);
    },
    unsubscribe(cb) {
      const i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    },
  };
}

// Minimal AudioContext stub — startGame() calls initAudio(), which jsdom cannot do.
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
        frequency: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        start() {},
        stop() {},
      };
    }
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    }
    createBiquadFilter() {
      return {
        type: "",
        frequency: { value: 0, setValueAtTime() {} },
        connect() {},
      };
    }
  };
}

// The app shell markup, pulled from index.html (scripts stripped) so the test DOM
// stays in sync with the real page's element IDs.
function loadAppShell() {
  const html = fs.readFileSync(
    pathlib.join(__dirname, "..", "index.html"),
    "utf8",
  );
  const body = html
    .replace(/[\s\S]*<body[^>]*>/i, "")
    .replace(/<\/body>[\s\S]*/i, "");
  return body.replace(/<script[\s\S]*?<\/script>/gi, "");
}

const APP_SHELL = loadAppShell();

let app;

beforeEach(() => {
  jest.useFakeTimers();
  now = 1000;
  jest.setSystemTime(now);

  localStorage.clear();
  SettingsStore._reset();

  document.body.innerHTML = APP_SHELL;

  // jsdom has no 2D canvas context; the game guards on a null context.
  if (!HTMLCanvasElement.prototype.getContext.__stubbed) {
    HTMLCanvasElement.prototype.getContext = function () {
      return null;
    };
    HTMLCanvasElement.prototype.getContext.__stubbed = true;
  }

  window.ScanController = ScanController;
  window.SettingsStore = SettingsStore;
  window.Nav = Nav;
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };
  window.AudioContext = makeAudioContextStub();

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
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Tests ---------------------------------------------------------------

describe("main menu scan", () => {
  test("starts on the main menu with the three main-menu items as targets", () => {
    expect(app.state.mode).toBe("menu");
    expect(app.state.menuState).toBe("main");
    expect(app.state.menuIndex).toBe(0);

    const targets = app.getScanTargets();
    expect(targets).toBe(app.menus.main);
    expect(targets).toHaveLength(3);
    expect(app.getScan().getIndex()).toBe(0);
  });

  test("Space advances the cursor, announces, and wraps the main menu", () => {
    const voice = window.NarbeVoiceManager;

    tapAfterCooldown("Space"); // 0 -> 1 (Settings)
    expect(app.state.menuIndex).toBe(1);
    expect(app.getScan().getIndex()).toBe(1);
    expect(voice.speak).toHaveBeenCalled();

    tapAfterCooldown("Space"); // 1 -> 2 (Exit)
    expect(app.state.menuIndex).toBe(2);

    tapAfterCooldown("Space"); // 2 -> 0 (wrap to Play)
    expect(app.state.menuIndex).toBe(0);
  });

  test("Enter on Play starts the game (menu -> game), re-seating the cursor", () => {
    app.getScan().setIndex(0); // Play
    app.state.menuIndex = 0;

    tapAfterCooldown("Enter");

    expect(app.state.mode).toBe("game");
    expect(app.state.scanIndex).toBe(0);
    expect(app.getScan().getIndex()).toBe(0);
    // In-game action bar is now the live scan target list.
    expect(app.getScanTargets()).toBe(app.state.gameActions);
    expect(app.getScanTargets()).toHaveLength(6);
  });

  test("NumpadEnter selects identically to Enter (Play starts the game)", () => {
    app.getScan().setIndex(0);
    app.state.menuIndex = 0;

    tapAfterCooldown("NumpadEnter");

    expect(app.state.mode).toBe("game");
  });

  test("Enter on Settings opens the settings menu with its full item list", () => {
    // Advance to the Settings item (index 1) then select it.
    tapAfterCooldown("Space");
    expect(app.state.menuIndex).toBe(1);

    tapAfterCooldown("Enter");

    expect(app.state.mode).toBe("menu");
    expect(app.state.menuState).toBe("settings");
    expect(app.getScanTargets()).toBe(app.menus.settings);
    expect(app.state.menuIndex).toBe(0);
    expect(app.getScan().getIndex()).toBe(0);
  });
});

describe("anti-tremor gate (minIntervalMs)", () => {
  test("controller carries the original 200ms input floor", () => {
    expect(app.getScan().minIntervalMs).toBe(200);
  });

  test("a second advance inside the 200ms floor is rejected; one past it is accepted", () => {
    tapAfterCooldown("Space"); // accepted: 0 -> 1
    expect(app.state.menuIndex).toBe(1);

    // Same instant (no clock advance) => inside the floor => rejected.
    tap("Space");
    expect(app.state.menuIndex).toBe(1);

    // A small bump that is still under 200ms => still rejected.
    now += 150;
    jest.setSystemTime(now);
    tap("Space");
    expect(app.state.menuIndex).toBe(1);

    // Past the floor => accepted.
    tapAfterCooldown("Space");
    expect(app.state.menuIndex).toBe(2);
  });
});

describe("contract adoption", () => {
  test("themes stay LOCAL (casino { name, color/bg } shape), not the shared list", () => {
    expect(app.themes[0]).toHaveProperty("name");
    expect(app.themes[0]).toHaveProperty("bg");
    expect(app.themes[0].name).toBe("Casino Nights");
  });

  test("Nav.goBack and SettingsStore are wired up", () => {
    expect(typeof Nav.goBack).toBe("function");
    expect(typeof SettingsStore.global.get).toBe("function");
  });

  test("highlightStyle is mirrored into the shared SettingsStore global store", () => {
    // init() seeds the shared store from the local settings blob on first load.
    expect(SettingsStore.global.get("highlightStyle")).toBe(
      app.settings.highlightStyle,
    );
  });
});
