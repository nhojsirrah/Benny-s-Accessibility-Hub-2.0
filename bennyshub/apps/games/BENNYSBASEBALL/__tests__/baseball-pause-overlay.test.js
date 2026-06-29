/**
 * jsdom integration tests for Benny's Baseball after retiring its bespoke pause
 * menu in favour of the shared <benny-pause-overlay> (shared/pause-overlay.js,
 * PAUSE-OVERLAY CONTRACT v1).
 *
 * The shared module ships on main, so these tests exercise the REAL overlay
 * (not a mock) wired exactly as the app wires it:
 *   - js/pauseOverlay.js (createBaseballPauseOverlay) builds the overlay from the
 *     four migrated pause actions (Resume Game / Settings / Restart Game / Main
 *     Menu), each reusing the original window.* handler verbatim. Ids use the
 *     shared resume/exit convention so Resume and Main Menu auto-hide.
 *   - js/menuScan.js routes the menu ScanController at the overlay while it is
 *     open: getTargets() -> overlay.getTargets(), select -> overlay.activate(),
 *     preserving Space-scan / Enter+NumpadEnter-select.
 *
 * Covered: overlay built with the right actions, scan targets routed at the
 * overlay while open, scan+select Resume closes it, the Exit (Main Menu) path
 * closes it, NumpadEnter selects identically to Enter, and the absent-API
 * fallback (factory returns null; the menu scan falls back to the legacy bespoke
 * #pauseMenu DOM-button click).
 */
const fs = require("fs");
const path = require("path");

const ScanController = require("../../../../shared/scan-core.js");
const BennyPauseOverlay = require("../../../../shared/pause-overlay.js");
const createMenuScan = require("../js/menuScan.js");
const createBaseballPauseOverlay = require("../js/pauseOverlay.js");

// Load the REAL game constants (the file declares `const GAME_CONSTANTS = {...}`
// with no export) so the assertions pin the actual shipped values.
const constantsCode = fs.readFileSync(
  path.join(__dirname, "../js/core/constants.js"),
  "utf8",
);
const GAME_CONSTANTS = new Function(
  constantsCode + "\nreturn GAME_CONSTANTS;",
)();
const MODES = GAME_CONSTANTS.MODES;

function makeGame(overrides = {}) {
  return {
    gameState: {
      mode: MODES.PAUSE_MENU,
      menuOptions: [],
      selectedIndex: 0,
      currentColorIndex: 0,
    },
    menuSystem: { handleMenuSelection: jest.fn() },
    audioSystem: { speak: jest.fn(), playSound: jest.fn() },
    ...overrides,
  };
}

function dispatchKey(type, code) {
  document.dispatchEvent(
    new KeyboardEvent(type, { code, bubbles: true, cancelable: true }),
  );
}
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

function labelsOf(buttons) {
  return buttons.map(
    (b) => (b.getAttribute && b.getAttribute("aria-label")) || b.textContent,
  );
}
function idsOf(buttons) {
  return buttons.map((b) => b.getAttribute("data-action-id"));
}

beforeAll(() => {
  global.GAME_CONSTANTS = GAME_CONSTANTS;
  window.GAME_CONSTANTS = GAME_CONSTANTS;
  global.ScanController = ScanController;
  window.ScanController = ScanController;
});

beforeEach(() => {
  // Restore the shared overlay API + a quiet scan/voice manager before each test
  // (a later test deletes window.BennyPauseOverlay to exercise the fallback).
  window.BennyPauseOverlay = BennyPauseOverlay;
  window.NarbeScanManager = {
    getScanInterval: () => 2000,
    getSettings: () => ({ autoScan: false }),
    subscribe() {},
    unsubscribe() {},
  };
  window.NarbeVoiceManager = { speak: jest.fn() };

  // The migrated handlers the overlay actions call (verbatim window.* functions).
  window.resumeGame = jest.fn();
  window.showPauseSettings = jest.fn();
  window.restartGame = jest.fn();
  window.quitToMenu = jest.fn();
});

afterEach(() => {
  document.querySelectorAll("benny-pause-overlay").forEach((el) => el.remove());
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

describe("the factory builds the shared overlay from the migrated pause actions", () => {
  test("Resume Game / Settings / Restart Game / Main Menu, in order", () => {
    const overlay = createBaseballPauseOverlay();
    expect(overlay).toBeTruthy();
    overlay.show();

    const buttons = overlay.getTargets();
    expect(buttons).toHaveLength(4);
    expect(labelsOf(buttons)).toEqual([
      "Resume Game",
      "Settings",
      "Restart Game",
      "Main Menu",
    ]);
    // Resume + Main Menu use the shared resume/exit ids so they auto-hide.
    expect(idsOf(buttons)).toEqual(["resume", "settings", "restart", "exit"]);
  });

  test("each action runs the original window handler verbatim", () => {
    const overlay = createBaseballPauseOverlay();
    overlay.show();
    const [resume, settings, restart, exit] = overlay.getTargets();

    overlay.activate(settings);
    expect(window.showPauseSettings).toHaveBeenCalledTimes(1);
    overlay.activate(restart);
    expect(window.restartGame).toHaveBeenCalledTimes(1);
    overlay.activate(resume);
    expect(window.resumeGame).toHaveBeenCalledTimes(1);
    overlay.activate(exit);
    expect(window.quitToMenu).toHaveBeenCalledTimes(1);
  });

  test("absent BennyPauseOverlay API -> factory returns null (legacy fallback)", () => {
    delete window.BennyPauseOverlay;
    expect(createBaseballPauseOverlay()).toBeNull();
  });
});

describe("the menu ScanController is routed at the overlay while it is open", () => {
  test("getTargets() returns the overlay action buttons while open", () => {
    const overlay = createBaseballPauseOverlay();
    overlay.show();
    const game = makeGame({ bennyPauseOverlay: overlay });
    const m = createMenuScan(game);

    expect(m.getTargets()).toHaveLength(4);
    expect(m.getTargets()).toEqual(overlay.getTargets());
  });

  test("while closed, pause scanning falls back to the menuOptions list", () => {
    const overlay = createBaseballPauseOverlay();
    overlay.hide(); // closed
    const game = makeGame({ bennyPauseOverlay: overlay });
    game.gameState.menuOptions = [
      "Resume Game",
      "Settings",
      "Restart Game",
      "Main Menu",
    ];
    const m = createMenuScan(game);

    expect(m.getTargets()).toEqual(game.gameState.menuOptions);
  });
});

describe("selecting a scanned action runs it through the overlay", () => {
  test("scan + select Resume runs resumeGame and closes the overlay", () => {
    const overlay = createBaseballPauseOverlay();
    overlay.show();
    const game = makeGame({ bennyPauseOverlay: overlay });
    const m = createMenuScan(game);

    // Resume is the first action (index 0); select it.
    game.gameState.selectedIndex = 0;
    m.select();

    expect(window.resumeGame).toHaveBeenCalledTimes(1);
    expect(overlay.isOpen()).toBe(false); // resume auto-hides
  });

  test("Exit path (Main Menu) runs quitToMenu and closes the overlay", () => {
    const overlay = createBaseballPauseOverlay();
    overlay.show();
    const game = makeGame({ bennyPauseOverlay: overlay });
    const m = createMenuScan(game);

    game.gameState.selectedIndex = 3; // Main Menu (id "exit")
    m.select();

    expect(window.quitToMenu).toHaveBeenCalledTimes(1);
    expect(overlay.isOpen()).toBe(false); // exit auto-hides
  });

  test("Settings keeps the overlay open (its handler drives the legacy sub-menu)", () => {
    const overlay = createBaseballPauseOverlay();
    overlay.show();
    const game = makeGame({ bennyPauseOverlay: overlay });
    const m = createMenuScan(game);

    game.gameState.selectedIndex = 1; // Settings (no auto-hide)
    m.select();

    expect(window.showPauseSettings).toHaveBeenCalledTimes(1);
    expect(overlay.isOpen()).toBe(true);
  });
});

describe("Space scans and Enter / NumpadEnter select identically while open", () => {
  test("NumpadEnter selects the focused overlay action, exactly like Enter", () => {
    jest.useFakeTimers();
    jest.setSystemTime(10000);
    try {
      const overlay = createBaseballPauseOverlay();
      overlay.show();
      const game = makeGame({ bennyPauseOverlay: overlay });
      const m = createMenuScan(game);

      // Predicate parity (the shared isSelect contract).
      expect(m.scan.isSelect({ code: "Enter" })).toBe(true);
      expect(m.scan.isSelect({ code: "NumpadEnter" })).toBe(true);
      expect(m.scan.isScan({ code: "Space" })).toBe(true);

      // Drive the controller through real key events on the focused exit action.
      m.scan.attach(document);
      m.scan.setIndex(3); // Main Menu

      tap("NumpadEnter");
      expect(window.quitToMenu).toHaveBeenCalledTimes(1);
      expect(overlay.isOpen()).toBe(false);

      m.scan.destroy();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("absent-API fallback keeps the legacy bespoke pause menu working", () => {
  test("with no shared overlay, pause select clicks the focused legacy DOM button", () => {
    document.body.innerHTML = `
      <div id="pauseMenu" style="display:block">
        <button>Resume Game</button>
        <button>Settings</button>
        <button>Restart Game</button>
        <button>Main Menu</button>
      </div>
      <div id="pauseSettingsMenu" style="display:none"></div>
      <div id="resetSeasonConfirmation" style="display:none"></div>`;

    const game = makeGame({ bennyPauseOverlay: null });
    game.gameState.mode = MODES.PAUSE_MENU;
    game.gameState.menuOptions = [
      "Resume Game",
      "Settings",
      "Restart Game",
      "Main Menu",
    ];
    game.gameState.selectedIndex = 2;
    const m = createMenuScan(game);

    const target = document.querySelectorAll("#pauseMenu button")[2];
    const clicked = jest.fn();
    target.addEventListener("click", clicked);

    m.select();
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
