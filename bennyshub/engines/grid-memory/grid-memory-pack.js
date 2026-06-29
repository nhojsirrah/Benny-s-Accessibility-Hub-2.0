/**
 * grid-memory-pack — schema, validator, and deterministic layout builder for the
 * config-driven grid-memory engine (Narbehouse Accessibility Hub, IP-5 pilot).
 *
 * The whole point of the pilot: a new memory-game variant should be a JSON file,
 * not a code fork. This module owns the *data* half of that contract — the pack
 * shape and the pure function that turns a pack into a concrete board layout.
 *
 * A pack is:
 *   {
 *     id, title,                       // identity (optional, for tooling)
 *     board:   { rows, cols },         // REQUIRED grid dimensions
 *     scanOrder: "linear" | "row-col", // how the scanner steps the board
 *     tiles:   [ { id, label?, image?, match? }, ... ], // REQUIRED face catalog
 *     timing:  { mismatchHideMs? },    // reveal/mismatch cadence
 *     difficulty: "easy" | ...,        // free-form label
 *     seed:    <int>                   // optional — makes the layout deterministic
 *   }
 *
 * buildLayout(pack) is pure and deterministic when a seed (or an injected rng) is
 * supplied: same pack + same seed => byte-identical board. That determinism is
 * what the engine tests pin, and what lets a pack swap change the board with no
 * code change.
 *
 * Loaded as an IIFE-style global via <script src> like the other shared modules
 * (window.GridMemoryPack), with a dual CommonJS export for jest + jsdom.
 */
(function () {
  "use strict";

  const GLOBAL =
    typeof window !== "undefined"
      ? window
      : typeof globalThis !== "undefined"
        ? globalThis
        : {};

  /** Supported scan strategies. "linear" steps every tile; "row-col" is the
   *  two-stage row-then-column scan classic switch-access memory games use. */
  const SCAN_ORDERS = ["linear", "row-col"];

  const DEFAULT_MISMATCH_HIDE_MS = 3000;

  /**
   * Small, fast, seedable PRNG (mulberry32). Returns a function yielding floats
   * in [0, 1). Deterministic for a given 32-bit seed — the basis for the
   * engine's reproducible boards.
   * @param {number} seed
   * @returns {() => number}
   */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Validate a pack against the schema. Pure; returns a result rather than
   * throwing so callers (editors, loaders) can surface every problem at once.
   * @param {*} pack
   * @returns {{ valid: boolean, errors: string[] }}
   */
  function validatePack(pack) {
    const errors = [];
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
      return { valid: false, errors: ["pack must be a plain object"] };
    }

    const b = pack.board;
    if (!b || typeof b !== "object") {
      errors.push("board is required and must be an object");
    } else {
      if (!Number.isInteger(b.rows) || b.rows < 1)
        errors.push("board.rows must be a positive integer");
      if (!Number.isInteger(b.cols) || b.cols < 1)
        errors.push("board.cols must be a positive integer");
    }

    if (
      pack.scanOrder !== undefined &&
      SCAN_ORDERS.indexOf(pack.scanOrder) === -1
    ) {
      errors.push(`scanOrder must be one of: ${SCAN_ORDERS.join(", ")}`);
    }

    if (!Array.isArray(pack.tiles) || pack.tiles.length === 0) {
      errors.push("tiles must be a non-empty array");
    } else {
      pack.tiles.forEach((t, i) => {
        if (!t || typeof t !== "object") {
          errors.push(`tiles[${i}] must be an object`);
        } else if (typeof t.id !== "string" || t.id === "") {
          errors.push(`tiles[${i}].id must be a non-empty string`);
        }
      });
    }

    if (pack.timing !== undefined) {
      if (typeof pack.timing !== "object" || pack.timing === null) {
        errors.push("timing must be an object");
      } else if (
        pack.timing.mismatchHideMs !== undefined &&
        (typeof pack.timing.mismatchHideMs !== "number" ||
          pack.timing.mismatchHideMs < 0)
      ) {
        errors.push("timing.mismatchHideMs must be a non-negative number");
      }
    }

    if (pack.difficulty !== undefined && typeof pack.difficulty !== "string") {
      errors.push("difficulty must be a string");
    }

    if (pack.seed !== undefined && !Number.isInteger(pack.seed)) {
      errors.push("seed must be an integer when provided");
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate and return the pack, throwing a single aggregated error if invalid.
   * @param {*} pack
   * @returns {object} the same pack
   */
  function assertValidPack(pack) {
    const { valid, errors } = validatePack(pack);
    if (!valid) {
      throw new Error("Invalid grid-memory pack:\n - " + errors.join("\n - "));
    }
    return pack;
  }

  /** Resolve the effective mismatch-hide delay for a pack. */
  function mismatchHideMs(pack) {
    const t = pack && pack.timing;
    if (t && typeof t.mismatchHideMs === "number") return t.mismatchHideMs;
    return DEFAULT_MISMATCH_HIDE_MS;
  }

  /**
   * Resolve the random source for a layout build. Priority: an explicitly
   * injected rng (tests / behaviour-preserving callers) > a seeded PRNG from
   * pack.seed (deterministic) > Math.random (fresh each call).
   * @param {object} pack
   * @param {{ rng?: () => number, seed?: number }} [options]
   * @returns {() => number}
   */
  function resolveRng(pack, options) {
    const o = options || {};
    if (typeof o.rng === "function") return o.rng;
    if (Number.isInteger(o.seed)) return mulberry32(o.seed);
    if (Number.isInteger(pack.seed)) return mulberry32(pack.seed);
    return Math.random;
  }

  /**
   * Turn a pack into a concrete board layout: a flat row-major array of cells.
   *
   * Faces are drawn from `tiles` (cycling if the catalog is smaller than the
   * board), each placed as a pair, then shuffled. An odd cell count leaves one
   * deterministically-chosen inactive cell. Every active cell keeps a `source`
   * reference back to its originating tile object, so host apps can read extra,
   * non-schema fields (sounds, alt text, …) off it without the engine knowing
   * about them.
   *
   * @param {object} pack
   * @param {{ rng?: () => number, seed?: number }} [options]
   * @returns {{ rows: number, cols: number, inactiveIndex: number, grid: object[] }}
   */
  function buildLayout(pack, options) {
    assertValidPack(pack);
    const rows = pack.board.rows;
    const cols = pack.board.cols;
    const total = rows * cols;
    const rng = resolveRng(pack, options);

    let active = total;
    let inactiveIndex = -1;
    if (total % 2 !== 0) {
      active--;
      inactiveIndex = Math.floor(rng() * total);
    }
    const pairs = active / 2;

    // Shuffle the face catalog, then pick `pairs` faces (cycling if needed).
    const catalog = pack.tiles.slice();
    shuffle(catalog, rng);
    const faces = [];
    for (let i = 0; i < pairs; i++) {
      faces.push(catalog[i % catalog.length]);
    }

    // Two of each face, then shuffle the deck.
    const deck = [];
    faces.forEach((face) => {
      deck.push(face);
      deck.push(face);
    });
    shuffle(deck, rng);

    const grid = [];
    let d = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (idx === inactiveIndex) {
          grid.push({
            r,
            c,
            inactive: true,
            matched: false,
            revealed: false,
          });
        } else {
          const face = deck[d++];
          grid.push({
            r,
            c,
            inactive: false,
            matched: false,
            revealed: false,
            tileId: face.id,
            label: face.label != null ? face.label : face.id,
            image: face.image || "",
            matchKey: face.match != null ? face.match : face.id,
            source: face,
          });
        }
      }
    }

    return { rows, cols, inactiveIndex, grid };
  }

  /** In-place Fisher–Yates shuffle driven by the supplied rng. */
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  const GridMemoryPack = {
    SCAN_ORDERS,
    DEFAULT_MISMATCH_HIDE_MS,
    mulberry32,
    validatePack,
    assertValidPack,
    mismatchHideMs,
    resolveRng,
    buildLayout,
  };

  if (typeof window !== "undefined") {
    window.GridMemoryPack = GridMemoryPack;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = GridMemoryPack;
  }
})();
