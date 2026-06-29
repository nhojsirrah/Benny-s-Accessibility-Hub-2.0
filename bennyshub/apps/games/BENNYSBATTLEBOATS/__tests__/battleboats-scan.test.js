/**
 * Integration tests for the BENNYSBATTLEBOATS scan layer after migrating it onto
 * the shared ScanController (shared/scan-core.js).
 *
 * BattleBoats uses a TWO-PHASE grid scan modelled as a flat, context-re-seating
 * single-axis list (the ChessCheckers technique): getScanTargets() returns the
 * scannable ROWS while in a *-row mode, and — once a row is selected (descend) —
 * the scannable CELLS of that row while in a *-cell mode. getScanTargets() is
 * re-read by the controller on every step, so fully-fired rows and already-fired
 * cells drop out of the live target set automatically.
 *
 * Runs in jsdom with jest fake timers. The shared scan/voice managers are mocked
 * and injected via window globals exactly as the real page would expose them, so
 * these tests exercise the app's getTargets / select / announce wiring through the
 * real ScanController rather than the removed hand-rolled scan loop. 1-Player mode
 * is used; the enemy turn is driven by setTimeout, so assertions are made before
 * advancing timers (while the attack phase is still live).
 */

const fs = require("fs");
const pathlib = require("path");

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

// Minimal AudioContext stub — BattleBoats' playSound() constructs one on every
// scan/select/fire, and jsdom does not provide it.
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

  jest.resetModules();
  app = require("../scripts/battleship.js");
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

describe("menu wiring", () => {
  test("main menu targets are the four menu buttons", () => {
    expect(app.scanState.mode).toBe("main-menu");
    const targets = app.getScanTargets();
    expect(targets).toBe(app.scanState.mainMenuButtons);
    expect(targets).toHaveLength(4);
    expect(targets[0].action).toBe("1p");
  });

  test("NumpadEnter selects identically to Enter (start 1-player game)", () => {
    // index 0 is "1 Player".
    app.getScan().setIndex(0);
    tap("NumpadEnter");
    // showGame('1p') -> placement screen, scanning the game buttons.
    expect(app.scanState.mode).toBe("buttons");
    expect(app.getDebug().gameMode).toBe("1p");
  });
});

describe("placement grid: two-phase row -> cell", () => {
  function enterPlacement() {
    app.showGame("1p"); // randomizes & places all ships, mode 'buttons'
  }

  test("row mode targets are the ten board rows; descend re-seats to that row's cells", () => {
    enterPlacement();

    // Drive the placement grid directly through the controller.
    app.scanState.mode = "row";
    app.getScan().setIndex(-1);

    let targets = app.getScanTargets();
    expect(targets).toHaveLength(10);
    expect(targets.every((t) => t.type === "row")).toBe(true);

    // First scan seats on row A (index 0).
    tap("Space");
    expect(app.getScan().getIndex()).toBe(0);
    expect(app.scanState.rowIndex).toBe(0);

    // Enter descends into that row's cells (re-seat to a fresh cell phase).
    tap("Enter");
    expect(app.scanState.mode).toBe("cell");
    expect(app.getScan().getIndex()).toBe(-1);

    targets = app.getScanTargets();
    expect(targets).toHaveLength(10);
    expect(targets.every((t) => t.type === "cell" && t.row === 0)).toBe(true);
  });

  test("selecting a cell places the current ship there", () => {
    enterPlacement();
    const shipIndex = app.getDebug().currentShipIndex;

    // Clear the board so the target corner is guaranteed free (randomized
    // placement otherwise makes the first cell collision-dependent).
    app.getDebug().playerCells.forEach((rowArr) =>
      rowArr.forEach((c) => {
        c.occupied = false;
        c.hit = false;
        c.miss = false;
      }),
    );
    app.getDebug().ships.forEach((s) => {
      s.placed = false;
      s.coords = [];
    });

    app.scanState.mode = "row";
    app.getScan().setIndex(-1);
    tap("Space"); // seat row A
    tap("Enter"); // descend into cells of row A
    tap("Space"); // seat first cell (A1 -> col 0)

    const row = app.scanState.rowIndex;
    const col = app.scanState.cellIndex;
    tap("Enter"); // place

    // Placement returns to the buttons menu and the ship now occupies that cell.
    expect(app.scanState.mode).toBe("buttons");
    const ship = app.getDebug().ships[shipIndex];
    expect(ship.placed).toBe(true);
    expect(ship.coords.some((c) => c.row === row && c.col === col)).toBe(true);
    expect(app.getDebug().playerCells[row][col].occupied).toBe(true);
  });

  test("forward scanning wraps around the row list", () => {
    enterPlacement();
    app.scanState.mode = "row";
    app.getScan().setIndex(9); // last row (J)
    tap("Space");
    expect(app.getScan().getIndex()).toBe(0); // wrapped to row A
  });
});

describe("attack phase: live grid + fire", () => {
  function startAttack() {
    app.showGame("1p"); // place all ships
    app.startGame(); // 1P -> generate enemy fleet -> attack phase
    expect(app.scanState.mode).toBe("game-row");
    expect(app.getDebug().gameStarted).toBe(true);
    expect(app.getDebug().gamePhase).toBe("attack");
  }

  test("game-row targets reflect the live grid (fully-fired rows drop out)", () => {
    startAttack();

    let rows = app.getScanTargets();
    expect(rows).toHaveLength(10);
    expect(rows.every((t) => t.type === "row")).toBe(true);

    // Mark every cell in row 0 as fired -> the row should disappear next read.
    const attacks = app.getDebug().player1.attacks;
    for (let c = 0; c < 10; c++) attacks[0][c].fired = true;

    rows = app.getScanTargets();
    expect(rows).toHaveLength(9);
    expect(rows.some((t) => t.row === 0)).toBe(false);
  });

  test("game-cell targets skip already-fired cells", () => {
    startAttack();
    app.scanState.mode = "game-cell";
    app.scanState.rowIndex = 0;

    expect(app.getScanTargets()).toHaveLength(10);

    app.getDebug().player1.attacks[0][3].fired = true;
    const cells = app.getScanTargets();
    expect(cells).toHaveLength(9);
    expect(cells.some((t) => t.col === 3)).toBe(false);
  });

  test("selecting a cell fires at the enemy and re-seats to the row phase", () => {
    startAttack();

    // Descend into row A, then its first cell, then fire.
    tap("Space"); // seat row A (game-row)
    tap("Enter"); // descend -> game-cell
    expect(app.scanState.mode).toBe("game-cell");
    tap("Space"); // seat first unfired cell

    const row = app.scanState.rowIndex;
    const col = app.scanState.cellIndex;
    tap("Enter"); // fire

    expect(app.getDebug().player1.attacks[row][col].fired).toBe(true);
    // Re-seated back to the row phase for the (eventual) next turn.
    expect(app.scanState.mode).toBe("game-row");
    expect(app.getScan().getIndex()).toBe(-1);
  });

  test("NumpadEnter fires identically to Enter", () => {
    startAttack();
    tap("Space"); // seat row A
    tap("NumpadEnter"); // descend
    expect(app.scanState.mode).toBe("game-cell");
    tap("Space"); // seat first cell
    const row = app.scanState.rowIndex;
    const col = app.scanState.cellIndex;
    tap("NumpadEnter"); // fire
    expect(app.getDebug().player1.attacks[row][col].fired).toBe(true);
  });

  test("forward scanning wraps around the live cell list", () => {
    startAttack();
    app.scanState.mode = "game-cell";
    app.scanState.rowIndex = 0;
    const n = app.getScanTargets().length;
    expect(n).toBeGreaterThan(1);
    app.getScan().setIndex(n - 1);
    tap("Space");
    expect(app.getScan().getIndex()).toBe(0);
  });

  test("scanning is gated off during the enemy's defense turn", () => {
    startAttack();
    // Fire once, then run the post-fire cooldown so the enemy turn begins.
    tap("Space");
    tap("Enter"); // descend
    tap("Space"); // seat cell
    tap("Enter"); // fire -> awaitingEnemy, schedules defense switch
    jest.advanceTimersByTime(4000); // run cooldown + enemy fire transition

    expect(app.getDebug().gamePhase).toBe("defense");
    expect(app.getScanTargets()).toEqual([]); // board frozen during enemy turn
  });
});

describe("contract adoption", () => {
  test("themes stay LOCAL (multi-surface) and are not the shared Themes list", () => {
    // BattleBoats themes carry background/cardBg/menuBg/buttonBg, so they are not
    // adopted from shared/themes.js (documented as out of scope there).
    expect(app.themes).not.toBe(Themes.THEMES);
    expect(app.themes[0]).toHaveProperty("cardBg");
    expect(app.themes[0]).toHaveProperty("menuBg");
    expect(app.themes[0]).toHaveProperty("buttonBg");
  });

  test("shared modules load cleanly (Nav + SettingsStore present)", () => {
    expect(typeof Nav.goBack).toBe("function");
    expect(typeof SettingsStore.global.get).toBe("function");
  });
});
