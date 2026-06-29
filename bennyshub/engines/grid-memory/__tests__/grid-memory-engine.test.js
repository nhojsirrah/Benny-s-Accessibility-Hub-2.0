/**
 * @jest-environment jsdom
 *
 * Integration tests for GridMemoryEngine running on the REAL shared stack
 * (ScanController + BennyGame). They prove the config-driven thesis end to end:
 *   - the engine renders a known seeded pack deterministically,
 *   - swapping the pack changes the board with no code change,
 *   - both scan strategies (linear + row-col) drive selection through the real
 *     ScanController, and
 *   - the reveal/match/mismatch state machine behaves.
 */

// Order matters: each require populates the window globals the next one reads.
require("../../../shared/scan-core");
require("../../../shared/benny-app");
require("../grid-memory-pack");
const GridMemoryEngine = require("../grid-memory-engine");

const animals = require("../packs/animals.pack.json");
const shapes = require("../packs/shapes.pack.json");

const ANIMALS_ORDER = [
  "rabbit",
  "lizard",
  "bird",
  "dog",
  "rabbit",
  "lizard",
  "turtle",
  "ferret",
  "dog",
  "fish",
  "bird",
  "fish",
  "cat",
  "ferret",
  "cat",
  "turtle",
];

function dispatchKey(type, code) {
  document.dispatchEvent(
    new KeyboardEvent(type, { code, bubbles: true, cancelable: true }),
  );
}
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

function domTileIds(root) {
  return [...root.querySelectorAll(".gm-tile")].map((el) =>
    el.getAttribute("data-tile-id"),
  );
}

function makeMockScanManager() {
  return {
    getSettings: () => ({ autoScan: false, scanInterval: 2000 }),
    getScanInterval: () => 2000,
    subscribe() {},
    unsubscribe() {},
  };
}

let root;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  document.body.innerHTML = '<main id="game-root"></main>';
  root = document.getElementById("game-root");
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("deterministic render", () => {
  test("renders the animals pack into its known fixed board", () => {
    const game = new GridMemoryEngine({ pack: animals }).mount(root);
    const grid = root.querySelector("#gm-grid");
    expect(grid).not.toBeNull();
    expect(grid.querySelectorAll(".gm-tile")).toHaveLength(16);
    expect(domTileIds(root)).toEqual(ANIMALS_ORDER);
    game.teardown();
  });

  test("two engines built from the same pack render identical boards", () => {
    const a = new GridMemoryEngine({ pack: animals }).mount(root);
    const idsA = domTileIds(root);
    a.teardown();
    root.innerHTML = "";
    const b = new GridMemoryEngine({ pack: animals }).mount(root);
    expect(domTileIds(root)).toEqual(idsA);
    b.teardown();
  });
});

describe("pack swap changes the board with no code change", () => {
  test("loadPack swaps board dimensions and tiles", () => {
    const game = new GridMemoryEngine({ pack: animals }).mount(root);
    expect(root.querySelectorAll(".gm-tile")).toHaveLength(16);
    const before = domTileIds(root);

    game.loadPack(shapes);
    const after = domTileIds(root);

    expect(after).toHaveLength(12); // 3x4
    expect(after).not.toEqual(before);
    expect(new Set(after)).toEqual(
      new Set(["circle", "square", "triangle", "star", "heart", "diamond"]),
    );
    game.teardown();
  });

  test("a brand-new inline pack needs no engine code", () => {
    const customPack = {
      id: "custom",
      board: { rows: 2, cols: 2 },
      scanOrder: "linear",
      seed: 5,
      tiles: [
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
      ],
    };
    const game = new GridMemoryEngine({ pack: customPack }).mount(root);
    expect(root.querySelectorAll(".gm-tile")).toHaveLength(4);
    game.teardown();
  });
});

describe("linear scan via the real ScanController", () => {
  test("Space steps every selectable tile in row-major order", () => {
    const game = new GridMemoryEngine({ pack: shapes }).mount(root);
    expect(game.scan).toBeInstanceOf(window.ScanController);

    tap("Space"); // first target
    expect(game.scan.getCurrentTarget().getAttribute("data-tile-id")).toBe(
      "star",
    );
    tap("Space");
    expect(game.scan.getCurrentTarget().getAttribute("data-tile-id")).toBe(
      "heart",
    );
    game.teardown();
  });

  test("Enter reveals the focused tile", () => {
    const game = new GridMemoryEngine({ pack: shapes }).mount(root);
    tap("Space"); // focus first tile (0,0)
    tap("Enter");
    expect(game.getCell(0, 0).revealed).toBe(true);
    game.teardown();
  });
});

describe("row-col two-stage scan", () => {
  test("selecting a row drops into that row, then a tile reveals", () => {
    const game = new GridMemoryEngine({ pack: animals }).mount(root);
    expect(game.scanOrder).toBe("row-col");

    // Row stage: anchors are one per eligible row.
    const rowTargets = game.getScanTargets();
    expect(rowTargets).toHaveLength(4);
    expect(rowTargets.map((el) => el.getAttribute("data-row"))).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);

    tap("Space"); // focus row 0 anchor
    tap("Enter"); // select row 0 -> col stage
    expect(game._scanStage).toBe("col");

    const colTargets = game.getScanTargets();
    expect(colTargets.map((el) => el.getAttribute("data-row"))).toEqual([
      "0",
      "0",
      "0",
      "0",
    ]);

    tap("Space"); // focus first tile in row 0 (0,0)
    tap("Enter"); // reveal it
    expect(game.getCell(0, 0).revealed).toBe(true);
    // After a reveal we return to row scanning.
    expect(game._scanStage).toBe("row");
    game.teardown();
  });
});

describe("reveal / match / mismatch state machine", () => {
  test("a matched pair stays up and fires onMatch", () => {
    const onMatch = jest.fn();
    const game = new GridMemoryEngine({ pack: animals, onMatch }).mount(root);
    // animals: rabbit sits at (0,0) and (1,0).
    game.revealAt(0, 0);
    game.revealAt(1, 0);
    expect(game.getCell(0, 0).matched).toBe(true);
    expect(game.getCell(1, 0).matched).toBe(true);
    expect(onMatch).toHaveBeenCalledTimes(1);
    game.teardown();
  });

  test("a mismatched pair hides again after the pack's timing", () => {
    const onMismatch = jest.fn();
    const game = new GridMemoryEngine({ pack: animals, onMismatch }).mount(
      root,
    );
    // rabbit (0,0) vs lizard (0,1) -> mismatch.
    game.revealAt(0, 0);
    game.revealAt(0, 1);
    expect(game.busy).toBe(true);
    expect(onMismatch).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(3000); // animals timing.mismatchHideMs
    expect(game.getCell(0, 0).revealed).toBe(false);
    expect(game.getCell(0, 1).revealed).toBe(false);
    expect(game.busy).toBe(false);
    game.teardown();
  });

  test("isWon + onWin fire once every pair is matched", () => {
    const onWin = jest.fn();
    const pack = {
      board: { rows: 2, cols: 1 },
      scanOrder: "linear",
      seed: 1,
      tiles: [{ id: "only", label: "Only" }],
    };
    const game = new GridMemoryEngine({ pack, onWin }).mount(root);
    expect(game.isWon()).toBe(false);
    game.revealAt(0, 0);
    game.revealAt(1, 0);
    expect(game.isWon()).toBe(true);
    expect(onWin).toHaveBeenCalledTimes(1);
    game.teardown();
  });
});
