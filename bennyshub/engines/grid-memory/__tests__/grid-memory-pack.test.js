/**
 * @jest-environment jsdom
 *
 * Unit tests for the grid-memory pack schema, validator, and deterministic
 * layout builder. These pin the "a new pack is just data" contract: the same
 * pack + seed always builds the same board, and a different pack builds a
 * different board — with no engine code involved.
 */

const GMP = require("../grid-memory-pack");

const animals = require("../packs/animals.pack.json");
const shapes = require("../packs/shapes.pack.json");

describe("validatePack", () => {
  test("accepts the shipped packs", () => {
    expect(GMP.validatePack(animals).valid).toBe(true);
    expect(GMP.validatePack(shapes).valid).toBe(true);
  });

  test("rejects a missing board", () => {
    const res = GMP.validatePack({ tiles: [{ id: "a" }] });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/board/);
  });

  test("rejects non-integer / non-positive board dimensions", () => {
    expect(
      GMP.validatePack({ board: { rows: 0, cols: 4 }, tiles: [{ id: "a" }] })
        .valid,
    ).toBe(false);
    expect(
      GMP.validatePack({ board: { rows: 4, cols: 1.5 }, tiles: [{ id: "a" }] })
        .valid,
    ).toBe(false);
  });

  test("rejects an empty tiles array and tiles missing an id", () => {
    expect(
      GMP.validatePack({ board: { rows: 2, cols: 2 }, tiles: [] }).valid,
    ).toBe(false);
    const res = GMP.validatePack({
      board: { rows: 2, cols: 2 },
      tiles: [{ label: "no id" }],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/tiles\[0\]\.id/);
  });

  test("rejects an unknown scanOrder", () => {
    const res = GMP.validatePack({
      board: { rows: 2, cols: 2 },
      tiles: [{ id: "a" }],
      scanOrder: "spiral",
    });
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/scanOrder/);
  });

  test("rejects bad timing and seed", () => {
    expect(
      GMP.validatePack({
        board: { rows: 2, cols: 2 },
        tiles: [{ id: "a" }],
        timing: { mismatchHideMs: -5 },
      }).valid,
    ).toBe(false);
    expect(
      GMP.validatePack({
        board: { rows: 2, cols: 2 },
        tiles: [{ id: "a" }],
        seed: 1.5,
      }).valid,
    ).toBe(false);
  });

  test("assertValidPack throws on an invalid pack", () => {
    expect(() => GMP.assertValidPack({})).toThrow(/Invalid grid-memory pack/);
  });
});

describe("buildLayout determinism", () => {
  test("same pack + seed builds a byte-identical board", () => {
    const a = GMP.buildLayout(animals);
    const b = GMP.buildLayout(animals);
    expect(a.grid.map((c) => c.tileId)).toEqual(b.grid.map((c) => c.tileId));
  });

  test("the animals pack builds its known fixed arrangement (seed 1337)", () => {
    const layout = GMP.buildLayout(animals);
    expect(layout.rows).toBe(4);
    expect(layout.cols).toBe(4);
    expect(layout.inactiveIndex).toBe(-1);
    expect(layout.grid.map((c) => c.tileId)).toEqual([
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
    ]);
  });

  test("an injected rng overrides the seed (callers stay in control)", () => {
    const seq = [0.1, 0.9, 0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 0.05];
    let i = 0;
    const rng = () => seq[i++ % seq.length];
    const a = GMP.buildLayout(shapes, { rng });
    i = 0;
    const b = GMP.buildLayout(shapes, { rng });
    expect(a.grid.map((c) => c.tileId)).toEqual(b.grid.map((c) => c.tileId));
  });
});

describe("buildLayout structure", () => {
  test("lays out exactly rows*cols cells in row-major order", () => {
    const layout = GMP.buildLayout(shapes);
    expect(layout.grid).toHaveLength(12);
    layout.grid.forEach((cell, idx) => {
      expect(cell.r).toBe(Math.floor(idx / 4));
      expect(cell.c).toBe(idx % 4);
    });
  });

  test("every face appears exactly twice (it is a memory board)", () => {
    const layout = GMP.buildLayout(animals);
    const counts = {};
    layout.grid.forEach((c) => {
      counts[c.tileId] = (counts[c.tileId] || 0) + 1;
    });
    Object.values(counts).forEach((n) => expect(n).toBe(2));
  });

  test("an odd board leaves exactly one inactive cell", () => {
    const pack = {
      board: { rows: 3, cols: 3 },
      tiles: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      seed: 99,
    };
    const layout = GMP.buildLayout(pack);
    const inactive = layout.grid.filter((c) => c.inactive);
    expect(inactive).toHaveLength(1);
    expect(layout.grid.filter((c) => !c.inactive)).toHaveLength(8);
  });

  test("cycles the catalog when there are fewer faces than pairs", () => {
    const pack = {
      board: { rows: 4, cols: 4 }, // 8 pairs needed
      tiles: [{ id: "a" }, { id: "b" }], // only 2 faces
      seed: 7,
    };
    const layout = GMP.buildLayout(pack);
    const ids = new Set(layout.grid.map((c) => c.tileId));
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  test("active cells keep a source reference back to the tile object", () => {
    const layout = GMP.buildLayout(shapes);
    const cell = layout.grid.find((c) => !c.inactive);
    expect(cell.source).toBeDefined();
    expect(cell.source.id).toBe(cell.tileId);
  });
});
