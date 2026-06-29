/**
 * Tests for BENNYSBATTLEBOATS adopting the shared <benny-pause-overlay>
 * (shared/pause-overlay.js, BennyPauseOverlay) in place of its bespoke pause
 * menu.
 *
 * The bespoke pause menu's three actions (Continue / Settings / Main Menu) are
 * migrated verbatim onto the overlay, and the app's ScanController is routed at
 * the overlay's buttons while it is open. These tests exercise that wiring
 * through the REAL shared overlay module (loaded exactly as the page does) and
 * the REAL ScanController, plus the graceful fallback to the bespoke modal when
 * BennyPauseOverlay is absent.
 *
 * Runs in jsdom with jest fake timers; the shared scan/voice managers are mocked
 * and injected via window globals, mirroring the live page. 1-Player mode is
 * used and assertions are made during the live attack phase (the enemy turn is
 * driven by setTimeout).
 */

const ScanController = require("../../../../shared/scan-core.js");
const Themes = require("../../../../shared/themes.js");
const SettingsStore = require("../../../../shared/settings-store.js");
const Nav = require("../../../../shared/nav.js");
const PauseOverlay = require("../../../../shared/pause-overlay.js");

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

// Short press = keydown immediately followed by keyup (advance on Space,
// select on Enter / NumpadEnter).
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
    getInputSensitivity() {
      return 0;
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

const fs = require("fs");
const pathlib = require("path");

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

// (Re)load battleship.js fresh, optionally exposing the shared overlay module,
// then init the app. Keeping the require inside a helper lets the fallback test
// boot with BennyPauseOverlay deliberately absent.
function boot({ withOverlay = true } = {}) {
  if (withOverlay) {
    window.BennyPauseOverlay = PauseOverlay;
  } else {
    delete window.BennyPauseOverlay;
  }
  jest.resetModules();
  app = require("../scripts/battleship.js");
  app.init();
}

// Drive the game into a live 1-player attack phase.
function startAttack() {
  app.showGame("1p"); // place all ships
  app.startGame(); // 1P -> generate enemy fleet -> attack phase
}

function openPause() {
  document.getElementById("pauseButton").click(); // -> showPauseModal()
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

  localStorage.clear();
  SettingsStore._reset();

  document.body.innerHTML = APP_SHELL;

  window.ScanController = ScanController;
  window.Themes = Themes;
  window.SettingsStore = SettingsStore;
  window.Nav = Nav;
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };
  window.AudioContext = makeAudioContextStub();
});

afterEach(() => {
  try {
    app.getScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  // Detach any overlay element so it can't leak into the next test's body.
  document.querySelectorAll("benny-pause-overlay").forEach((el) => el.remove());
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Tests ---------------------------------------------------------------

describe("shared pause overlay adoption", () => {
  test("pausing mounts the shared overlay with the bespoke actions verbatim", () => {
    boot();
    startAttack();
    openPause();

    const overlay = app.getPauseOverlay();
    expect(overlay).toBeTruthy();
    expect(overlay.isOpen()).toBe(true);

    // Injected collaborators are passed through to the overlay.
    expect(overlay.scanManager).toBe(window.NarbeScanManager);
    expect(overlay.voice).toBe(window.NarbeVoiceManager);

    // The scan now targets the overlay's buttons (Continue / Settings / Main Menu).
    const targets = app.getScanTargets();
    expect(targets).toHaveLength(3);
    expect(targets).toEqual(overlay.getTargets()); // same buttons, fresh slice
    expect(targets.map((b) => b.textContent)).toEqual([
      "Continue",
      "Settings",
      "Main Menu",
    ]);
    expect(targets.map((b) => b.getAttribute("data-action-id"))).toEqual([
      "resume",
      "settings",
      "mainmenu",
    ]);
  });

  test("scan + select Resume (Continue) closes the overlay and resumes the game", () => {
    boot();
    startAttack();
    openPause();
    const overlay = app.getPauseOverlay();

    tap("Space"); // seat on Continue (index 0)
    expect(app.getScan().getIndex()).toBe(0);
    tap("Enter"); // select -> overlay.activate(Continue) -> resume

    expect(overlay.isOpen()).toBe(false);
    expect(app.scanState.mode).toBe("game-row"); // back to the live board
  });

  test("NumpadEnter selects in the overlay identically to Enter", () => {
    boot();
    startAttack();
    openPause();
    const overlay = app.getPauseOverlay();

    tap("Space"); // seat on Continue
    tap("NumpadEnter"); // select via numpad

    expect(overlay.isOpen()).toBe(false);
    expect(app.scanState.mode).toBe("game-row");
  });

  test("selecting Main Menu closes the overlay and returns to the main menu", () => {
    boot();
    startAttack();
    openPause();
    const overlay = app.getPauseOverlay();

    tap("Space"); // Continue (0)
    tap("Space"); // Settings (1)
    tap("Space"); // Main Menu (2)
    expect(app.getScan().getIndex()).toBe(2);
    tap("Enter"); // select Main Menu

    expect(overlay.isOpen()).toBe(false);
    expect(app.scanState.mode).toBe("main-menu");
    expect(app.getDebug().gameStarted).toBe(false);
  });

  test("Settings opens the bespoke settings sub-view; Back re-opens the overlay", () => {
    boot();
    startAttack();
    openPause();
    const overlay = app.getPauseOverlay();

    tap("Space"); // Continue (0)
    tap("Space"); // Settings (1)
    tap("Enter"); // select Settings

    expect(overlay.isOpen()).toBe(false);
    expect(app.scanState.mode).toBe("pause-settings");
    expect(document.getElementById("pauseModal").style.display).toBe("flex");
    expect(document.getElementById("pauseSettingsView").style.display).toBe(
      "block",
    );

    // Back returns to the (overlay) pause menu.
    document.getElementById("pauseSettingsBackBtn").click();
    expect(app.getPauseOverlay().isOpen()).toBe(true);
    expect(app.scanState.mode).toBe("pause");
    expect(document.getElementById("pauseModal").style.display).toBe("none");
  });

  test("anti-tremor minIntervalMs is preserved on the ScanController", () => {
    boot();
    // getInputSensitivity() returns 0 here; the live page falls back to 50.
    expect(app.getScan().minIntervalMs).toBe(
      window.NarbeScanManager.getInputSensitivity(),
    );
  });
});

describe("fallback when BennyPauseOverlay is absent", () => {
  test("pausing uses the bespoke #pauseModal and its scan handling", () => {
    boot({ withOverlay: false });
    startAttack();
    openPause();

    // No shared overlay was created.
    expect(app.getPauseOverlay()).toBeFalsy();

    // The bespoke modal is shown and scanned.
    expect(document.getElementById("pauseModal").style.display).toBe("flex");
    expect(app.scanState.mode).toBe("pause");
    const targets = app.getScanTargets();
    expect(targets).toBe(app.scanState.pauseButtons);
    expect(targets).toHaveLength(3);
    expect(targets.map((t) => t.action)).toEqual([
      "continue",
      "settings",
      "mainMenu",
    ]);

    // Selecting Continue closes the bespoke modal and resumes.
    tap("Space"); // Continue (0)
    tap("Enter");
    expect(document.getElementById("pauseModal").style.display).toBe("none");
    expect(app.scanState.mode).toBe("game-row");
  });
});
