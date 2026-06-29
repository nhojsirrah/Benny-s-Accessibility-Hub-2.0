/**
 * jsdom integration tests for Benny's Baseball MENU scanning after migrating it
 * onto the shared ScanController (shared/scan-core.js) via js/menuScan.js.
 *
 * The menu engine is exercised through the same createBaseballMenuScan factory
 * the app wires into InputHandler. The factory is a movement + select engine:
 *   - getTargets is the live menu list (COLOR_SELECT is a fixed two-item axis),
 *   - onFocus publishes the cursor to gameState.selectedIndex (the existing draw
 *     functions read it, so the highlight + voice are reused),
 *   - onSelect runs the existing actions (MenuSystem.handleMenuSelection, or a
 *     DOM button click for the pause overlay).
 *
 * Gameplay scanning (pitch grid, interactive batting, fielder scan) stays on
 * InputHandler's own path and is out of scope here.
 */
const fs = require("fs");
const path = require("path");

const ScanController = require("../../../../shared/scan-core.js");
const createMenuScan = require("../js/menuScan.js");

// Load the REAL game constants (the file declares `const GAME_CONSTANTS = {...}`
// with no export) so the assertions below pin the actual shipped values.
const constantsCode = fs.readFileSync(
  path.join(__dirname, "../js/core/constants.js"),
  "utf8",
);
const GAME_CONSTANTS = new Function(
  constantsCode + "\nreturn GAME_CONSTANTS;",
)();
const MODES = GAME_CONSTANTS.MODES;

beforeAll(() => {
  global.GAME_CONSTANTS = GAME_CONSTANTS;
  window.GAME_CONSTANTS = GAME_CONSTANTS;
  global.ScanController = ScanController;
  window.ScanController = ScanController;
});

function makeGame(overrides = {}) {
  return {
    gameState: {
      mode: MODES.MAIN_MENU,
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

afterEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

describe("the menu scan engine is built on the shared ScanController", () => {
  test("createBaseballMenuScan returns an engine wrapping a ScanController", () => {
    const m = createMenuScan(makeGame());
    expect(m).toBeTruthy();
    expect(m.scan).toBeInstanceOf(ScanController);
  });
});

describe("forward / reverse scanning of a list menu", () => {
  test("MAIN MENU forward advances 0 -> 1 -> 2 then wraps to 0", () => {
    const game = makeGame();
    game.gameState.mode = MODES.MAIN_MENU;
    game.gameState.menuOptions = ["Play Game", "Settings", "Exit Game"];
    game.gameState.selectedIndex = 0;
    const m = createMenuScan(game);

    m.advance();
    expect(game.gameState.selectedIndex).toBe(1);
    m.advance();
    expect(game.gameState.selectedIndex).toBe(2);
    m.advance();
    expect(game.gameState.selectedIndex).toBe(0);
  });

  test("reverse from index 0 wraps to the last item", () => {
    const game = makeGame();
    game.gameState.mode = MODES.MAIN_MENU;
    game.gameState.menuOptions = ["Play Game", "Settings", "Exit Game"];
    game.gameState.selectedIndex = 0;
    const m = createMenuScan(game);

    m.back();
    expect(game.gameState.selectedIndex).toBe(2);
  });

  test("COLOR SELECT is a fixed two-item axis", () => {
    const game = makeGame();
    game.gameState.mode = MODES.COLOR_SELECT;
    game.gameState.menuOptions = []; // color select doesn't use menuOptions
    game.gameState.selectedIndex = 0;
    const m = createMenuScan(game);

    expect(m.getTargets()).toHaveLength(2);
    m.advance();
    expect(game.gameState.selectedIndex).toBe(1);
    m.advance();
    expect(game.gameState.selectedIndex).toBe(0);
    m.back();
    expect(game.gameState.selectedIndex).toBe(1);
  });
});

describe("selection runs the existing actions", () => {
  test("a canvas list menu selects via MenuSystem.handleMenuSelection", () => {
    const game = makeGame();
    game.gameState.mode = MODES.MAIN_MENU;
    game.gameState.menuOptions = ["Play Game", "Settings", "Exit Game"];
    game.gameState.selectedIndex = 1;
    const m = createMenuScan(game);

    m.select();
    expect(game.menuSystem.handleMenuSelection).toHaveBeenCalledTimes(1);
  });

  test("the pause overlay clicks the focused DOM button", () => {
    document.body.innerHTML = `
      <div id="pauseMenu" style="display:block">
        <button>Resume Game</button>
        <button>Settings</button>
        <button>Restart Game</button>
        <button>Main Menu</button>
      </div>
      <div id="pauseSettingsMenu" style="display:none"></div>
      <div id="resetSeasonConfirmation" style="display:none"></div>`;
    const game = makeGame();
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

describe("NumpadEnter selects identically to Enter (shared isSelect predicate)", () => {
  test("isSelect matches Enter and NumpadEnter; isScan matches Space", () => {
    const m = createMenuScan(makeGame());
    expect(m.scan.isSelect({ code: "Enter" })).toBe(true);
    expect(m.scan.isSelect({ code: "NumpadEnter" })).toBe(true);
    expect(m.scan.isSelect({ code: "Space" })).toBe(false);
    expect(m.scan.isScan({ code: "Space" })).toBe(true);
    expect(m.scan.isScan({ code: "Enter" })).toBe(false);
  });
});

describe("anti-tremor scan rate limit is preserved", () => {
  test("minIntervalMs mirrors the original SPACE_SCAN_DELAY; constants intact", () => {
    const m = createMenuScan(makeGame());
    expect(GAME_CONSTANTS.TIMING.SPACE_SCAN_DELAY).toBe(200);
    expect(GAME_CONSTANTS.TIMING.ACTION_COOLDOWN).toBe(500);
    expect(m.scan.minIntervalMs).toBe(GAME_CONSTANTS.TIMING.SPACE_SCAN_DELAY);
  });

  test("the controller rejects a second scan within the rate-limit window", () => {
    jest.useFakeTimers();
    try {
      const game = makeGame();
      game.gameState.mode = MODES.MAIN_MENU;
      game.gameState.menuOptions = ["a", "b", "c", "d"];
      game.gameState.selectedIndex = 0;
      const m = createMenuScan(game);

      // Drive the controller through its own keyboard path so minIntervalMs
      // (the preserved 200ms scan gate) is exercised. The app additionally
      // enforces the same floor at the InputHandler keyboard layer
      // (SPACE_SCAN_DELAY + the 500ms ACTION_COOLDOWN select gate).
      m.scan.attach(document);
      m.scan.setIndex(0);

      jest.setSystemTime(10000);
      tap("Space"); // accepted: 0 -> 1
      expect(game.gameState.selectedIndex).toBe(1);

      jest.setSystemTime(10100); // +100ms (< 200ms): rejected
      tap("Space");
      expect(game.gameState.selectedIndex).toBe(1);

      jest.setSystemTime(10400); // +400ms since last accepted: accepted 1 -> 2
      tap("Space");
      expect(game.gameState.selectedIndex).toBe(2);

      m.scan.destroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
