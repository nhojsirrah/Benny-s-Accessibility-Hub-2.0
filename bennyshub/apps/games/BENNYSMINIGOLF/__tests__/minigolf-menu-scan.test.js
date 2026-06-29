/**
 * Integration tests for the BENNYSMINIGOLF menu scan layer after migrating it
 * onto the shared ScanController (shared/scan-core.js).
 *
 * The menu is a flat, re-read-each-step list: getSelectableItems() returns the
 * scannable rows (info-only rows are skipped), onFocus highlights + onAnnounce
 * speaks, and onSelect runs the item's existing action. Space short-press
 * advances; Enter / NumpadEnter select. The migration preserves the original
 * anti-tremor gate (the shared scan-manager.js INPUT_COOLDOWN_MS of 200ms) by
 * setting ScanController.minIntervalMs to that value.
 *
 * Runs in jsdom with jest fake timers. The shared scan/voice managers, AudioSys,
 * Settings and Utils are stubbed and exposed as globals exactly as the real page
 * would, so these tests exercise MenuSystem's getTargets / focus / announce /
 * select wiring through the real ScanController.
 */

const ScanController = require("../../../../shared/scan-core.js");
const Themes = require("../../../../shared/themes.js");
const SettingsStore = require("../../../../shared/settings-store.js");
const Nav = require("../../../../shared/nav.js");

// ---- Helpers -------------------------------------------------------------

function dispatchKey(type, code) {
  const event = new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

// Short press = keydown immediately followed by keyup (duration 0), which
// advances (Space) or selects (Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

function makeMockScanManager(overrides = {}) {
  const subscribers = [];
  return {
    autoScan: overrides.autoScan || false,
    interval: overrides.interval || 2000,
    // NOTE: deliberately NO getInputSensitivity() — the real shared scan-manager
    // has none, so MenuSystem falls back to minIntervalMs: 200 (INPUT_COOLDOWN_MS).
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

function makeAudioStub() {
  return {
    speak: jest.fn(),
    playSound: jest.fn(),
    soundEnabled: true,
    musicEnabled: true,
    ttsEnabled: true,
    getCurrentVoiceName: () => "Default",
    toggleSound() {},
    toggleMusic() {},
    toggleTTS() {},
    cycleVoice() {},
  };
}

function makeSettingsStub() {
  const data = {
    aimerStyle: "TRAJECTORY",
    aimerSpeed: "Medium",
    ballColor: "white",
  };
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
    },
  };
}

function makeGameStub() {
  return {
    state: "MENU",
    aimerThickness: 3,
    aimerThicknessName: "Medium",
    setGameMode: jest.fn(),
    setupMultiplayer: jest.fn(),
    updateBallColor: jest.fn(),
    cycleAimerThickness: jest.fn(),
    resumeGame: jest.fn(),
    loadCourse: jest.fn(),
  };
}

let MenuSystem;
let menu;
let game;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

  localStorage.clear();
  SettingsStore._reset();

  document.body.innerHTML =
    '<div id="ui-layer"></div>' +
    '<div id="course-creator-warning-overlay" class="hidden">' +
    '<button id="cc-cancel"></button><button id="cc-proceed"></button></div>';

  window.ScanController = ScanController;
  window.Themes = Themes;
  window.SettingsStore = SettingsStore;
  window.Nav = Nav;
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };
  window.AudioSys = makeAudioStub();
  window.Settings = makeSettingsStub();
  window.Utils = { BALL_COLORS: ["white", "pink", "red"] };

  jest.resetModules();
  MenuSystem = require("../js/menu.js");
  game = makeGameStub();
  menu = new MenuSystem(game);
});

afterEach(() => {
  try {
    menu.scan?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Tests ---------------------------------------------------------------

describe("menu wiring", () => {
  test("constructs on the main menu, seated on the first selectable item", () => {
    expect(menu.state).toBe("MAIN_MENU");
    expect(menu.scan).toBeTruthy();
    expect(menu.scan.getIndex()).toBe(0); // seated on 'Play Game'
    expect(AudioSys.speak).toHaveBeenLastCalledWith("Benny's Mini Golf");
  });

  test("Space advances the highlight and announces the next item", () => {
    AudioSys.speak.mockClear();
    tap("Space"); // 0 (Play Game) -> 1 (Settings)

    expect(menu.scan.getIndex()).toBe(1);
    expect(menu.selectedIndex).toBe(1);
    expect(AudioSys.speak).toHaveBeenLastCalledWith("Settings");

    const selected = document.querySelector(".menu-item.selected");
    expect(selected).toBeTruthy();
    expect(selected.textContent).toBe("Settings");
  });
});

describe("selection", () => {
  test("Enter selects the focused item and runs its action", () => {
    // Seated on 'Play Game' -> action opens the game-mode select.
    tap("Enter");
    expect(menu.state).toBe("MODE_SELECT");
  });

  test("NumpadEnter selects the focused item (Enter parity)", () => {
    tap("NumpadEnter");
    expect(menu.state).toBe("MODE_SELECT");
  });

  test("scanning then selecting runs the focused item's action", () => {
    tap("Space"); // -> 'Settings'
    // Distinct switch actions must clear the 200ms anti-tremor cooldown.
    jest.setSystemTime(300);
    tap("Enter"); // select 'Settings'
    expect(menu.state).toBe("SETTINGS");
  });
});

describe("anti-tremor gate (minIntervalMs = 200, the scan-manager cooldown)", () => {
  test("a second advance landing < 200ms after the first is ignored", () => {
    jest.setSystemTime(1000);
    tap("Space"); // accepted: 0 -> 1
    expect(menu.scan.getIndex()).toBe(1);

    // Immediately (same ms): blocked by the 200ms rate limit.
    tap("Space");
    expect(menu.scan.getIndex()).toBe(1);

    // After the cooldown elapses: accepted again.
    jest.setSystemTime(1300);
    tap("Space"); // 1 -> 2
    expect(menu.scan.getIndex()).toBe(2);
  });
});

describe("settings adoption (bmg_settings migration)", () => {
  test("a legacy bmg_settings blob migrates into the minigolf app store", () => {
    localStorage.setItem(
      "bmg_settings",
      JSON.stringify({
        aimerStyle: "BASIC",
        ballColor: "red",
        sound: false,
        voiceIndex: 2,
        notInSchema: 123,
      }),
    );
    SettingsStore._reset();
    SettingsStore.runMigrations(true);

    const app = SettingsStore.app("minigolf");
    expect(app.get("aimerStyle")).toBe("BASIC");
    expect(app.get("ballColor")).toBe("red");
    expect(app.get("sound")).toBe(false);
    expect(app.get("voiceIndex")).toBe(2);
    expect(app.get("notInSchema")).toBeUndefined();
  });
});
