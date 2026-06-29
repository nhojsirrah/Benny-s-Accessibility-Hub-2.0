/**
 * Integration tests for the BENNYSCONNECTFOUR scan layer after migrating it onto
 * the shared ScanController (shared/scan-core.js).
 *
 * Connect Four uses a SINGLE-AXIS scan: it scans the droppable columns above the
 * board and a select drops a piece into the focused column. getScanTargets()
 * returns the set of NON-FULL columns (the same empty-cells technique TicTacToe
 * uses to skip occupied cells), so full columns are skipped for free and the
 * controller re-reads the live set on every step.
 *
 * Runs in jsdom with jest fake timers. The shared scan/voice managers are mocked
 * and injected via window globals exactly as the real page would expose them, so
 * these tests exercise the app's getTargets / select / announce wiring through
 * the real ScanController rather than the removed hand-rolled scan loop. Tests
 * use two-player mode so the flow is deterministic (no AI / randomness).
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

// Minimal AudioContext stub — Connect Four's playSound() constructs one on every
// scan/select/drop, and jsdom does not provide it.
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

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

  localStorage.clear();
  SettingsStore._reset(); // drop cached singletons so cleared storage is re-read

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

describe("game-mode getScanTargets()", () => {
  test("returns all seven columns on an empty board", () => {
    app.startGame("two");
    const targets = app.getScanTargets();
    expect(targets.map((t) => t.col)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(targets.every((t) => t.type === "column")).toBe(true);
  });

  test("skips full columns (droppable-only target set)", () => {
    app.startGame("two");
    // Fill column 3 to the top so its top cell is occupied.
    for (let r = 0; r < 6; r++) app.state.board[r][3] = 1;

    const targets = app.getScanTargets();
    expect(targets.map((t) => t.col)).toEqual([0, 1, 2, 4, 5, 6]);
    expect(targets.some((t) => t.col === 3)).toBe(false);
    expect(targets).toHaveLength(6);
  });

  test("forward advance steps over a full column", () => {
    app.startGame("two");
    for (let r = 0; r < 6; r++) app.state.board[r][1] = 1; // fill column 1

    // Seated on column 0 at startGame; one advance should skip to column 2.
    expect(app.getScan().getCurrentTarget().col).toBe(0);
    tap("Space");
    expect(app.getScan().getCurrentTarget().col).toBe(2);
  });
});

describe("selection drops a piece into the focused column", () => {
  test("Enter drops into the currently focused column", () => {
    app.startGame("two"); // two-player always starts with Player 1 (turn 1)
    expect(app.getScan().getCurrentTarget().col).toBe(0);

    tap("Enter");
    // Piece lands in the bottom row (row 5) of column 0.
    expect(app.state.board[5][0]).toBe(1);
    // Turn flips to player 2.
    expect(app.state.turn).toBe(-1);
  });

  test("NumpadEnter drops identically to Enter", () => {
    app.startGame("two");
    tap("Space"); // advance to column 1
    expect(app.getScan().getCurrentTarget().col).toBe(1);

    tap("NumpadEnter");
    expect(app.state.board[5][1]).toBe(1);
  });

  test("stacked drops fill a column bottom-up", () => {
    app.startGame("two");
    app.dropPiece(0); // P1 -> row 5
    app.dropPiece(0); // P2 -> row 4
    expect(app.state.board[5][0]).toBe(1);
    expect(app.state.board[4][0]).toBe(-1);
  });
});

describe("forward scanning wraps around the droppable columns", () => {
  test("advancing past the last column wraps to index 0", () => {
    app.startGame("two");
    const n = app.getScanTargets().length; // 7
    app.getScan().setIndex(n - 1); // last column
    tap("Space");
    expect(app.getScan().getIndex()).toBe(0); // wrapped
  });
});

describe("mode switching re-seats the scan targets", () => {
  test("menu -> game -> menu swaps the target set and re-seats to index 0", () => {
    expect(app.state.mode).toBe("menu");

    app.startGame("two");
    expect(app.state.mode).toBe("game");
    expect(app.getScanTargets()).toHaveLength(7);
    expect(app.getScan().getIndex()).toBe(0);
    expect(app.getScan().getCurrentTarget().col).toBe(0);

    app.showMainMenu();
    expect(app.state.mode).toBe("menu");
    expect(app.getScanTargets()).toBe(app.menus.main);
    expect(app.getScanTargets()).toHaveLength(4);
    expect(app.getScan().getIndex()).toBe(0);
  });
});

describe("menu-mode scanning", () => {
  test("getTargets returns the main-menu items", () => {
    expect(app.state.mode).toBe("menu");
    const targets = app.getScanTargets();
    expect(targets).toBe(app.menus.main);
    expect(targets).toHaveLength(4); // Single, Two, Settings, Exit
  });

  test("forward wrap-around over the main-menu buttons", () => {
    const targets = app.getScanTargets();
    app.getScan().setIndex(targets.length - 1);
    tap("Space");
    expect(app.getScan().getIndex()).toBe(0);
  });

  test("selecting 'Two Player' from the main menu starts a game", () => {
    app.getScan().setIndex(1); // [0] Single, [1] Two Player
    tap("Enter");
    expect(app.state.mode).toBe("game");
    expect(app.state.gameMode).toBe("two");
  });
});

describe("hold-Enter opens the pause menu (onPause)", () => {
  test("holding Enter past the hold threshold during a game pauses", () => {
    app.startGame("two");
    expect(app.state.mode).toBe("game");

    dispatchKey("keydown", "Enter");
    jest.advanceTimersByTime(5000); // config.enterLongPress
    expect(app.state.mode).toBe("pause");

    // Releasing after the hold must NOT also fire a select.
    dispatchKey("keyup", "Enter");
    expect(app.state.mode).toBe("pause");

    // Pause menu is now the scan target set.
    expect(app.getScanTargets()).toBe(app.menus.pause);
  });
});

describe("contract adoption", () => {
  test("themes come from the shared module (6 standard + Classic Blue)", () => {
    expect(app.themes).toHaveLength(7);
    expect(app.themes.slice(0, 6)).toEqual(Themes.THEMES.slice(0, 6));
    expect(app.themes[6].name).toBe("Classic Blue");
  });

  test("highlight palette stays local (differs from the shared list)", () => {
    expect(app.highlightColors).not.toBe(Themes.HIGHLIGHT_COLORS);
    expect(app.highlightColors[0]).toBe("Yellow"); // no "Theme Default" sentinel
    expect(app.highlightColors).toHaveLength(10);
  });

  test("highlightStyle round-trips through the shared global SettingsStore", () => {
    expect(SettingsStore.global.get("highlightStyle")).toBe("outline");
  });

  test("main-menu Exit delegates to the shared Nav.goBack contract", () => {
    const goBack = jest.spyOn(Nav, "goBack").mockImplementation(() => {});
    const exit = app.menus.main.find((m) => m.text === "Exit");
    expect(exit).toBeDefined();

    exit.action();
    expect(goBack).not.toHaveBeenCalled(); // deferred 500ms behind the TTS
    jest.advanceTimersByTime(500);
    expect(goBack).toHaveBeenCalledTimes(1);
    goBack.mockRestore();
  });
});

describe("two-player vs computer gating", () => {
  test("single-player blocks a drop on the computer's turn", () => {
    app.startGame("single");
    app.state.turn = -1; // simulate the computer's turn
    app.handleColumnClick(0);
    // Board untouched — handleColumnClick returns early on the computer's turn.
    expect(app.state.board[5][0]).toBe(0);
  });
});
