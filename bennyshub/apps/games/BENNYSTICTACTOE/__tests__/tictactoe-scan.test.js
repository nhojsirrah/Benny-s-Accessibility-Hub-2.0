/**
 * Integration tests for the BENNYSTICTACTOE scan layer after migrating it onto
 * the shared ScanController (shared/scan-core.js).
 *
 * Runs in jsdom with jest fake timers. The shared scan/voice managers are mocked
 * and injected via window globals exactly as the real page would expose them, so
 * these tests exercise the app's getTargets / select / announce wiring through
 * the real ScanController rather than the removed hand-rolled scan loop.
 */

const ScanController = require("../../../../shared/scan-core.js");

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
    subscribe(cb) {
      subscribers.push(cb);
    },
    unsubscribe(cb) {
      const i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    },
  };
}

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

  localStorage.clear();
  document.body.innerHTML =
    '<div id="header"></div><div id="main-content"></div>';

  window.ScanController = ScanController;
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };

  jest.resetModules();
  // script.js now reads the shared Themes / SettingsStore / Nav globals (loaded
  // via <script src> in the browser); expose fresh instances for jsdom.
  window.Themes = require("../../../../shared/themes.js");
  window.SettingsStore = require("../../../../shared/settings-store.js");
  window.Nav = require("../../../../shared/nav.js");
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
  test("returns all nine cells on an empty board", () => {
    app.startGame("two");
    const ids = app.getScanTargets().map((el) => el.id);
    expect(ids).toEqual([
      "cell-0",
      "cell-1",
      "cell-2",
      "cell-3",
      "cell-4",
      "cell-5",
      "cell-6",
      "cell-7",
      "cell-8",
    ]);
  });

  test("excludes occupied cells (occupied-skip via the empty-cells target set)", () => {
    app.startGame("two");
    app.state.board[1] = "X";
    app.state.board[4] = "O";

    const ids = app.getScanTargets().map((el) => el.id);
    expect(ids).not.toContain("cell-1");
    expect(ids).not.toContain("cell-4");
    expect(ids).toHaveLength(7);
  });
});

describe("game-mode scanning skips occupied cells", () => {
  test("forward advance steps over an occupied cell", () => {
    app.startGame("two");
    app.state.board[1] = "O"; // occupy the cell between cell-0 and cell-2

    // Seated on cell-0 at startGame; one advance should land on cell-2.
    expect(app.getScan().getCurrentTarget().id).toBe("cell-0");
    tap("Space");
    expect(app.getScan().getCurrentTarget().id).toBe("cell-2");
  });

  test("forward scanning wraps around the empty cells", () => {
    app.startGame("two");
    const n = app.getScanTargets().length; // 9
    app.getScan().setIndex(n - 1); // last empty cell
    tap("Space");
    expect(app.getScan().getIndex()).toBe(0); // wrapped
  });
});

describe("selection plays a move on the focused cell", () => {
  test("Enter selects the currently focused cell", () => {
    app.startGame("two"); // two-player always starts with X
    expect(app.getScan().getCurrentTarget().id).toBe("cell-0");

    tap("Enter");
    expect(app.state.board[0]).toBe("X");
  });

  test("NumpadEnter selects identically to Enter", () => {
    app.startGame("two");
    tap("Space"); // advance to cell-1
    expect(app.getScan().getCurrentTarget().id).toBe("cell-1");

    tap("NumpadEnter");
    expect(app.state.board[1]).toBe("X");
  });

  test("selecting an occupied cell does not overwrite it", () => {
    app.startGame("two");
    app.state.board[0] = "O";
    // Force focus onto the occupied cell and select it directly.
    app.playerMove(0);
    expect(app.state.board[0]).toBe("O");
  });
});

describe("menu-mode scanning", () => {
  test("forward wrap-around over the main-menu buttons", () => {
    // Main menu: Single Player, Two Player, Settings, Exit -> 4 targets.
    const targets = app.getScanTargets();
    expect(targets).toHaveLength(4);
    expect(targets.every((el) => /^btn-menu-container-\d+$/.test(el.id))).toBe(
      true,
    );

    app.getScan().setIndex(targets.length - 1);
    tap("Space");
    expect(app.getScan().getIndex()).toBe(0);
  });
});

describe("mode switching re-seats the scan targets", () => {
  test("menu -> game -> menu swaps the target set and re-seats to index 0", () => {
    expect(app.state.mode).toBe("menu");

    app.startGame("two");
    expect(app.state.mode).toBe("game");
    expect(app.getScanTargets()).toHaveLength(9);
    expect(app.getScan().getIndex()).toBe(0);
    expect(app.getScan().getCurrentTarget().id).toBe("cell-0");

    app.showMainMenu();
    expect(app.state.mode).toBe("menu");
    const ids = app.getScanTargets().map((el) => el.id);
    expect(ids).toEqual([
      "btn-menu-container-0",
      "btn-menu-container-1",
      "btn-menu-container-2",
      "btn-menu-container-3",
    ]);
    expect(app.getScan().getIndex()).toBe(0);
  });

  test("pausing then resuming returns focus to the pre-pause cell", () => {
    app.startGame("two");
    tap("Space"); // cell-1
    tap("Space"); // cell-2
    expect(app.getScan().getCurrentTarget().id).toBe("cell-2");

    app.showPauseMenu();
    expect(app.state.mode).toBe("pause");
    // Pause overlay buttons are now the scan targets.
    expect(
      app.getScanTargets().every((el) => /^btn-pause-overlay-\d+$/.test(el.id)),
    ).toBe(true);

    app.resumeGame();
    expect(app.state.mode).toBe("game");
    expect(app.getScan().getCurrentTarget().id).toBe("cell-2");
  });
});
