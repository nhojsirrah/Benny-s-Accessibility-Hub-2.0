/**
 * GridMemoryEngine — a config-driven memory-grid game built on the shared
 * accessibility stack (BennyGame + ScanController). IP-5 pilot.
 *
 * The engine renders and plays a board entirely from a JSON pack (see
 * grid-memory-pack.js for the schema). Two memory variants that differ only in
 * board size, tiles, timing, scan order, or difficulty are two JSON files, not
 * two code forks — that is the thesis this engine exists to prove.
 *
 * It extends BennyGame, so the pause/back overlay, TTS announcements, and the
 * single-switch scanning wiring all come for free. The engine supplies the two
 * abstract overrides (getScanTargets + onSelect) plus a renderer and a
 * reveal/match state machine, parameterised by the pack.
 *
 * Scan strategies (pack.scanOrder):
 *   - "linear":  the scanner steps every selectable tile, left-to-right,
 *                top-to-bottom.
 *   - "row-col": two-stage. The scanner first steps eligible ROWS (whole row
 *                highlighted); selecting a row drops into stepping the tiles in
 *                that row; selecting a tile reveals it and returns to row scan.
 *
 * Host apps (e.g. Matchy) can either run the engine directly or reuse just its
 * pure layout/scan/match core; lifecycle callbacks (onReveal/onMatch/onMismatch/
 * onWin) let a host layer game-mode rules on top without the engine knowing.
 *
 * Loaded as an IIFE global via <script src> after benny-app.js + scan-core.js,
 * with a dual CommonJS export for jest + jsdom.
 */
(function () {
  "use strict";

  const GLOBAL =
    typeof window !== "undefined"
      ? window
      : typeof globalThis !== "undefined"
        ? globalThis
        : {};

  const BennyGame = GLOBAL.BennyGame;
  const GridMemoryPack =
    GLOBAL.GridMemoryPack ||
    (typeof require === "function" ? require("./grid-memory-pack") : undefined);

  if (!BennyGame) {
    throw new Error(
      "GridMemoryEngine requires BennyGame (load shared/benny-app.js first).",
    );
  }
  if (!GridMemoryPack) {
    throw new Error(
      "GridMemoryEngine requires GridMemoryPack (load grid-memory-pack.js first).",
    );
  }

  const noop = function () {};

  /**
   * @class GridMemoryEngine
   * @extends BennyGame
   */
  class GridMemoryEngine extends BennyGame {
    /**
     * @param {object} options
     * @param {object} options.pack            REQUIRED grid-memory pack.
     * @param {() => number} [options.rng]      Random source (deterministic builds).
     * @param {number} [options.seed]           Seed for a deterministic build.
     * @param {string} [options.scanOrder]      Override pack.scanOrder.
     * @param {Function} [options.onReveal]     (cell) => void, after a tile flips up.
     * @param {Function} [options.onMatch]      (a, b) => void, on a matched pair.
     * @param {Function} [options.onMismatch]   (a, b) => void, on a mismatched pair.
     * @param {Function} [options.onWin]        () => void, when every pair is matched.
     * ...plus the usual BennyApp options (scanManager, voice, ScanController...).
     */
    constructor(options = {}) {
      super(options);
      if (!options.pack) {
        throw new Error("GridMemoryEngine: options.pack is required");
      }
      this.pack = GridMemoryPack.assertValidPack(options.pack);
      this.scanOrder = options.scanOrder || this.pack.scanOrder || "linear";
      this._rngOptions = { rng: options.rng, seed: options.seed };
      this._mismatchHideMs = GridMemoryPack.mismatchHideMs(this.pack);

      // Lifecycle callbacks (host hooks).
      this.onReveal = options.onReveal || noop;
      this.onMatch = options.onMatch || noop;
      this.onMismatch = options.onMismatch || noop;
      this.onWin = options.onWin || noop;

      // Board + interaction state.
      this.layout = null;
      this.grid = [];
      this.firstSelection = null;
      this.busy = false;
      this._mismatchTimer = null;

      // row-col scan state.
      this._scanStage = "row"; // "row" | "col"
      this._activeRow = 0;

      this.build();
    }

    /**
     * (Re)build the board layout from the pack. Deterministic when a seed/rng was
     * supplied. Call load() / loadPack() to swap to a different pack at runtime.
     * @returns {this}
     */
    build() {
      this.layout = GridMemoryPack.buildLayout(this.pack, this._rngOptions);
      this.grid = this.layout.grid;
      this.firstSelection = null;
      this.busy = false;
      this._scanStage = "row";
      this._activeRow = this._firstEligibleRow();
      return this;
    }

    /**
     * Swap to a different pack and rebuild — the "a new pack is just data" path.
     * Re-renders if currently mounted.
     * @param {object} pack
     * @param {{ rng?: () => number, seed?: number, scanOrder?: string }} [options]
     * @returns {this}
     */
    loadPack(pack, options = {}) {
      this.pack = GridMemoryPack.assertValidPack(pack);
      this.scanOrder = options.scanOrder || pack.scanOrder || "linear";
      this._rngOptions = { rng: options.rng, seed: options.seed };
      this._mismatchHideMs = GridMemoryPack.mismatchHideMs(pack);
      this.build();
      if (this.root) {
        this.render();
        this.scan?.setIndex?.(-1);
      }
      return this;
    }

    // ---- Rendering --------------------------------------------------------

    /** @override */
    onMount() {
      this.render();
    }

    /** @override */
    onTeardown() {
      this._clearMismatchTimer();
    }

    /** Render the board into the mount root. Idempotent. */
    render() {
      const root = this.root;
      if (!root || !root.ownerDocument) return;
      const doc = root.ownerDocument;
      root.innerHTML = "";

      const container = doc.createElement("div");
      container.className = "gm-grid";
      container.id = "gm-grid";
      container.style.display = "grid";
      container.style.gridTemplateColumns = `repeat(${this.layout.cols}, 1fr)`;
      container.style.gridTemplateRows = `repeat(${this.layout.rows}, 1fr)`;

      this.grid.forEach((cell) => {
        const cellDiv = doc.createElement("div");
        cellDiv.className = "gm-cell";
        cellDiv.id = `gm-cell-${cell.r}-${cell.c}`;

        if (cell.inactive) {
          cellDiv.classList.add("gm-inactive");
          cellDiv.setAttribute("aria-hidden", "true");
        } else {
          const btn = doc.createElement("button");
          btn.type = "button";
          btn.className = "gm-tile";
          btn.id = `gm-tile-${cell.r}-${cell.c}`;
          btn.setAttribute("data-row", String(cell.r));
          btn.setAttribute("data-col", String(cell.c));
          btn.setAttribute("data-tile-id", cell.tileId);
          btn.setAttribute("aria-label", cell.label);
          btn.onclick = () => this.revealAt(cell.r, cell.c);
          this._paintTile(btn, cell);
          cellDiv.appendChild(btn);
        }
        container.appendChild(cellDiv);
      });

      root.appendChild(container);
      this._refreshHighlight();
    }

    /** Paint a tile button to reflect its current matched/revealed state. */
    _paintTile(btn, cell) {
      const doc = btn.ownerDocument;
      btn.innerHTML = "";
      btn.classList.toggle("gm-matched", !!cell.matched);
      btn.classList.toggle("gm-revealed", !!cell.revealed && !cell.matched);
      if ((cell.matched || cell.revealed) && cell.image) {
        const img = doc.createElement("img");
        img.src = cell.image;
        img.alt = cell.label;
        btn.appendChild(img);
      } else if (cell.matched || cell.revealed) {
        btn.textContent = cell.label;
      }
    }

    /** Re-render a single tile in place (no full re-render). */
    _updateTile(r, c) {
      const cell = this.getCell(r, c);
      const btn = this._tileEl(r, c);
      if (cell && btn) this._paintTile(btn, cell);
      this._refreshHighlight();
    }

    _tileEl(r, c) {
      const doc = this.root && this.root.ownerDocument;
      return doc ? doc.getElementById(`gm-tile-${r}-${c}`) : null;
    }

    // ---- Scan contract (BennyGame overrides) -----------------------------

    /**
     * @override
     * @returns {HTMLElement[]}
     */
    getScanTargets() {
      if (this.scanOrder === "row-col") {
        if (this._scanStage === "row") return this._rowAnchorEls();
        return this._rowTileEls(this._activeRow);
      }
      // linear
      return this._selectableEls();
    }

    /**
     * @override
     */
    onSelect(target) {
      if (!target) return;
      const r = Number(target.getAttribute("data-row"));
      const c = Number(target.getAttribute("data-col"));

      if (this.scanOrder === "row-col" && this._scanStage === "row") {
        this._activeRow = r;
        this._scanStage = "col";
        this.scan?.setIndex?.(-1);
        this._refreshHighlight();
        return;
      }

      // col stage or linear: reveal the tile.
      this.revealAt(r, c);
      if (this.scanOrder === "row-col") {
        this._scanStage = "row";
        this._activeRow = this._firstEligibleRow();
        this.scan?.setIndex?.(-1);
      }
      this._refreshHighlight();
    }

    /**
     * Highlight the focused target. In row-col row stage the whole row lights
     * up; otherwise a single tile does.
     * @override
     */
    onFocus(target) {
      this._clearHighlight();
      if (!target) return;
      if (this.scanOrder === "row-col" && this._scanStage === "row") {
        const r = Number(target.getAttribute("data-row"));
        this._rowTileEls(r).forEach((el) => el.classList.add("gm-focus"));
      } else {
        target.classList.add("gm-focus");
      }
    }

    /** @override — back on the pause overlay returns to the hub by default. */
    onBack() {
      if (typeof window !== "undefined" && window.history)
        window.history.back();
    }

    // ---- Reveal / match state machine ------------------------------------

    /**
     * Reveal the tile at (r, c) and advance the match state machine.
     * @returns {boolean} whether a tile was revealed.
     */
    revealAt(r, c) {
      if (this.busy) return false;
      const cell = this.getCell(r, c);
      if (!cell || cell.inactive || cell.matched || cell.revealed) return false;

      cell.revealed = true;
      this._updateTile(r, c);
      this.onReveal(cell);

      if (!this.firstSelection) {
        this.firstSelection = cell;
        return true;
      }

      const first = this.firstSelection;
      if (first.matchKey === cell.matchKey) {
        first.matched = true;
        cell.matched = true;
        this.firstSelection = null;
        this._updateTile(first.r, first.c);
        this._updateTile(cell.r, cell.c);
        this.onMatch(first, cell);
        if (this.isWon()) this.onWin();
      } else {
        this.busy = true;
        const a = first;
        const b = cell;
        this.onMismatch(a, b);
        this._mismatchTimer = setTimeout(() => {
          a.revealed = false;
          b.revealed = false;
          this.firstSelection = null;
          this.busy = false;
          this._updateTile(a.r, a.c);
          this._updateTile(b.r, b.c);
        }, this._mismatchHideMs);
      }
      return true;
    }

    /** @returns {boolean} every active tile is matched. */
    isWon() {
      return this.grid.every((cell) => cell.inactive || cell.matched);
    }

    getCell(r, c) {
      return this.grid.find((cell) => cell.r === r && cell.c === c);
    }

    // ---- Internal: selectable sets & highlight ---------------------------

    _isSelectable(cell) {
      return cell && !cell.inactive && !cell.matched && !cell.revealed;
    }

    _selectableEls() {
      const doc = this.root && this.root.ownerDocument;
      if (!doc) return [];
      return this.grid
        .filter((cell) => this._isSelectable(cell))
        .map((cell) => doc.getElementById(`gm-tile-${cell.r}-${cell.c}`))
        .filter(Boolean);
    }

    _eligibleRows() {
      const rows = [];
      for (let r = 0; r < this.layout.rows; r++) {
        if (
          this.grid.some((cell) => cell.r === r && this._isSelectable(cell))
        ) {
          rows.push(r);
        }
      }
      return rows;
    }

    _firstEligibleRow() {
      const rows = this._eligibleRows();
      return rows.length ? rows[0] : 0;
    }

    /** One anchor element per eligible row (its first selectable tile). */
    _rowAnchorEls() {
      const doc = this.root && this.root.ownerDocument;
      if (!doc) return [];
      return this._eligibleRows()
        .map((r) => {
          const cell = this.grid.find(
            (c) => c.r === r && this._isSelectable(c),
          );
          return cell
            ? doc.getElementById(`gm-tile-${cell.r}-${cell.c}`)
            : null;
        })
        .filter(Boolean);
    }

    /** Selectable tile elements within a row, in column order. */
    _rowTileEls(r) {
      const doc = this.root && this.root.ownerDocument;
      if (!doc) return [];
      return this.grid
        .filter((cell) => cell.r === r && this._isSelectable(cell))
        .sort((a, b) => a.c - b.c)
        .map((cell) => doc.getElementById(`gm-tile-${cell.r}-${cell.c}`))
        .filter(Boolean);
    }

    _clearHighlight() {
      const doc = this.root && this.root.ownerDocument;
      if (!doc) return;
      doc
        .querySelectorAll(".gm-focus")
        .forEach((el) => el.classList.remove("gm-focus"));
    }

    /** Re-apply the focus highlight after a structural change. */
    _refreshHighlight() {
      const idx = this.scan ? this.scan.getIndex() : -1;
      const targets = this.getScanTargets();
      this._clearHighlight();
      if (idx >= 0 && idx < targets.length) {
        this.onFocus(targets[idx], idx);
      }
    }

    _clearMismatchTimer() {
      if (this._mismatchTimer !== null) {
        clearTimeout(this._mismatchTimer);
        this._mismatchTimer = null;
      }
    }
  }

  if (typeof window !== "undefined") {
    window.GridMemoryEngine = GridMemoryEngine;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = GridMemoryEngine;
  }
})();
