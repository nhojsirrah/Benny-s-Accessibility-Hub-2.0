/**
 * Integration tests for the BENNYSCHESSCHECKERS scan layer after migrating it
 * onto the shared ScanController (shared/scan-core.js).
 *
 * ChessCheckers uses a DYNAMIC single-axis scan: it rebuilds state.scanItems
 * (the available pieces, then the legal-move targets for the selected piece) and
 * the controller steps through that flat list. getTargets() simply returns the
 * current state.scanItems, so the controller re-reads the freshly-rebuilt list
 * on every step and on every context switch (piece -> moves -> back to pieces).
 *
 * Runs in jsdom with jest fake timers. The shared scan/voice managers are mocked
 * and injected via window globals exactly as the real page would expose them, so
 * these tests exercise the app's getTargets / select / announce wiring through
 * the real ScanController rather than the removed hand-rolled scan loop. Tests
 * use checkers two-player mode so the flow is deterministic (no AI / randomness).
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

// Minimal AudioContext stub — ChessCheckers' playSound() constructs one on
// select/move, and jsdom does not provide it.
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

describe("getTargets() reflects the dynamic scanItems", () => {
  test("game mode: getTargets returns the live state.scanItems (pieces phase)", () => {
    app.startGame("two"); // checkers, two-player

    const targets = app.getScanTargets();
    expect(targets).toBe(app.state.scanItems); // same reference, rebuilt per context
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((it) => it.type === "piece")).toBe(true);
  });

  test("menu mode: getTargets returns the main-menu items", () => {
    // init() lands on the main menu (Game toggle, Single, Two, Settings, Exit).
    expect(app.state.mode).toBe("menu");
    const targets = app.getScanTargets();
    expect(targets).toBe(app.menus.main);
    expect(targets).toHaveLength(5);
  });
});

describe("context re-seat: piece -> moves", () => {
  test("selecting a piece swaps scanItems to move targets and re-seats to 0", () => {
    app.startGame("two");

    // Seated on the first available piece.
    expect(app.getScan().getIndex()).toBe(0);
    const firstPiece = app.state.scanItems[0];
    expect(firstPiece.type).toBe("piece");

    // Enter selects the focused piece -> context switches to its move targets.
    tap("Enter");

    expect(app.state.selectedPiece).not.toBeNull();
    const targets = app.getScanTargets();
    expect(targets).toBe(app.state.scanItems);
    // Moves, then a trailing "cancel" (select a different piece) item.
    expect(targets.some((it) => it.type === "move")).toBe(true);
    expect(targets[targets.length - 1].type).toBe("cancel");
    // Re-seated to the first move target.
    expect(app.getScan().getIndex()).toBe(0);
    expect(app.getScan().getCurrentTarget().type).toBe("move");
  });
});

describe("select runs the move", () => {
  test("Enter on a piece then Enter on a move mutates the board", () => {
    app.startGame("two");

    // Select the first piece.
    const piece = app.state.scanItems[0];
    tap("Enter");

    // Now focused on the first legal move; capture it before selecting.
    const move = app.state.scanItems[0];
    expect(move.type).toBe("move");
    const dest = { r: move.r, c: move.c };

    tap("Enter"); // execute the move

    // Origin emptied, destination now holds the piece (P1 == 1).
    expect(app.state.board[piece.r][piece.c]).toBe(0);
    expect(app.state.board[dest.r][dest.c]).toBe(1);
    // Turn flipped to player 2.
    expect(app.state.turn).toBe(-1);
  });

  test("NumpadEnter selects identically to Enter", () => {
    app.startGame("two");

    const piece = app.state.scanItems[0];
    tap("NumpadEnter"); // select the piece via the numpad key

    expect(app.state.selectedPiece).toEqual({ r: piece.r, c: piece.c });
    expect(app.state.scanItems.some((it) => it.type === "move")).toBe(true);

    const move = app.state.scanItems[0];
    const dest = { r: move.r, c: move.c };
    tap("NumpadEnter"); // execute the move via the numpad key

    expect(app.state.board[dest.r][dest.c]).toBe(1);
  });
});

describe("forward scanning wraps around the dynamic list", () => {
  test("advancing past the last piece wraps to index 0", () => {
    app.startGame("two");
    const n = app.getScanTargets().length;
    expect(n).toBeGreaterThan(1);

    app.getScan().setIndex(n - 1); // focus the last piece
    tap("Space"); // forward advance
    expect(app.getScan().getIndex()).toBe(0); // wrapped
  });
});

describe("cancel item re-seats back to the pieces context", () => {
  test("selecting cancel clears the selection and rebuilds the pieces list", () => {
    app.startGame("two");
    tap("Enter"); // select first piece -> moves context

    expect(app.state.selectedPiece).not.toBeNull();

    // Focus the trailing cancel item and select it.
    const cancelIdx = app.state.scanItems.findIndex(
      (it) => it.type === "cancel",
    );
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    app.getScan().setIndex(cancelIdx);
    tap("Enter");

    expect(app.state.selectedPiece).toBeNull();
    expect(app.getScanTargets().every((it) => it.type === "piece")).toBe(true);
    expect(app.getScan().getIndex()).toBe(0);
  });
});

describe("hold-Enter opens the pause menu (onPause)", () => {
  test("holding Enter for the hold threshold during a game pauses", () => {
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
  test("themes come from the shared module (6 standard + Classic Wood)", () => {
    expect(app.themes).toHaveLength(7);
    expect(app.themes.slice(0, 6)).toEqual(Themes.THEMES.slice(0, 6));
    expect(app.themes[6].name).toBe("Classic Wood");
    expect(app.highlightColors).toBe(Themes.HIGHLIGHT_COLORS);
  });

  test("global highlight settings round-trip through SettingsStore", () => {
    // init() seeds the shared global store from the app defaults.
    expect(SettingsStore.global.get("highlightStyle")).toBe("outline");
    expect(typeof SettingsStore.global.get("highlightColorIndex")).toBe(
      "number",
    );
  });
});

describe("menu selection runs the menu action", () => {
  test("selecting 'Two Player' from the main menu starts a game", () => {
    expect(app.state.mode).toBe("menu");
    // main menu order: [0] Game toggle, [1] Single, [2] Two Player, ...
    app.getScan().setIndex(2);
    tap("Enter");
    expect(app.state.mode).toBe("game");
    expect(app.state.gameMode).toBe("two");
  });
});
