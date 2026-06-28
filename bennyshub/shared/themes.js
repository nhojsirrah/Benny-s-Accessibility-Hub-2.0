/**
 * Themes — canonical theme + highlight-color palette for the Narbehouse
 * Accessibility Hub games.
 *
 * Most 2D games (TicTacToe, WordJumble, MatchyMatch, ConnectFour,
 * ChessCheckers, ...) each hand-rolled their own `themes` and `highlightColors`
 * arrays. The values drifted slightly between copies even though the intent was
 * a single shared look. This module consolidates them into one source of truth.
 *
 * This is a behavior-preserving extraction: the resolved colors below reproduce
 * exactly what the standard-cluster games currently render. Apps adopt this
 * module (deleting their local arrays) in follow-up sweeps; this PR only
 * establishes the canonical module and proves equivalence via tests.
 *
 * Loaded as an IIFE-style global via <script src>, matching the other shared
 * modules (NarbeScanManager, NarbeVoiceManager, ScanController). Apps read
 * window.Themes. A dual CommonJS export is provided so jsdom/node tests can
 * require() it.
 *
 * --- Reconciliation notes -------------------------------------------------
 *
 * THEMES is the "standard cluster" of 8 background themes. The background
 * gradients for these 8 are byte-identical across TicTacToe, WordJumble and
 * MatchyMatch, so the extraction is exact for those games. ConnectFour and
 * ChessCheckers share the first 6 themes verbatim but each substitute a single
 * 7th game-specific theme (ConnectFour: "Classic Blue"; ChessCheckers:
 * "Classic Wood") — those bespoke themes are intentionally NOT pulled into the
 * canonical list; those games keep (or pass in) their own extra theme.
 *
 * Each theme carries a `highlight` (its default highlight color), sourced from
 * WordJumble, which is the only standard-cluster game that defined a per-theme
 * highlight for all 8 themes. MatchyMatch's per-theme highlights match these
 * (it spells two of them as the CSS names "yellow"/"white", which are the same
 * colors as #ffff00/#ffffff). TicTacToe/ConnectFour/ChessCheckers did not carry
 * per-theme highlights and instead used a flat "#ffcc00" fallback for the
 * "Theme Default" option; the canonical behavior resolves "Theme Default" to
 * the theme's own highlight (the WordJumble behavior), a deliberate improvement
 * those games inherit on adoption.
 *
 * HIGHLIGHT_COLORS is the 13-entry palette shared verbatim by TicTacToe and
 * MatchyMatch — the modal highlight palette and the most complete one.
 * ConnectFour and ChessCheckers use the same CSS color names minus the leading
 * "Theme Default" entry. The values are kept as the literal CSS color names
 * those games use (e.g. "Yellow", "Cyan"), which is exactly what their
 * getHighlightColor() returns and what the browser renders.
 *
 * Games with genuinely different palettes are out of scope for this canonical
 * pair and keep their own arrays for now:
 *   - SlotMachine: casino-flavored themes + an 8-entry {name,color} highlight
 *     list.
 *   - BattleBoats: themes carry multiple surface colors (background, cardBg,
 *     menuBg, buttonBg), not a single bg gradient.
 *   - Bowling: 3D themes are functions that mutate a Three.js scene.
 *   - TriviaMaster: a name-only string list ('Default','Dark','Pastel',...).
 */

/**
 * Canonical background themes.
 * @type {Array<{name: string, bg: string, highlight: string}>}
 */
const THEMES = [
  {
    name: "Default",
    bg: "linear-gradient(135deg, #ff4b1f, #ff9068)",
    highlight: "#ffff00",
  },
  {
    name: "Ocean",
    bg: "linear-gradient(135deg, #2193b0, #6dd5ed)",
    highlight: "#ffffff",
  },
  {
    name: "Midnight",
    bg: "linear-gradient(135deg, #232526, #414345)",
    highlight: "#00ff00",
  },
  {
    name: "Forest",
    bg: "linear-gradient(135deg, #134e5e, #71b280)",
    highlight: "#ffcc00",
  },
  {
    name: "Sunset",
    bg: "linear-gradient(135deg, #f12711, #f5af19)",
    highlight: "#ffff00",
  },
  {
    name: "Lavender",
    bg: "linear-gradient(135deg, #834d9b, #d04ed6)",
    highlight: "#00ffff",
  },
  {
    name: "Mint",
    bg: "linear-gradient(135deg, #00b09b, #96c93d)",
    highlight: "#ffffff",
  },
  {
    name: "Dark Blue",
    bg: "linear-gradient(135deg, #0f2027, #203a43, #2c5364)",
    highlight: "#00ffcc",
  },
];

/**
 * Canonical highlight-color palette. Index 0 ("Theme Default") is a sentinel:
 * it resolves to the active theme's own `highlight`. Every other entry is a CSS
 * color name applied directly.
 * @type {string[]}
 */
const HIGHLIGHT_COLORS = [
  "Theme Default",
  "Yellow",
  "White",
  "Cyan",
  "Lime",
  "Magenta",
  "Red",
  "Orange",
  "Pink",
  "Gold",
  "DeepSkyBlue",
  "SpringGreen",
  "Violet",
];

/** Sentinel name for "use the active theme's default highlight". */
const THEME_DEFAULT_HIGHLIGHT = "Theme Default";

/**
 * Resolve the highlight color for a (theme, highlight-index) pair.
 *
 * Mirrors the games' current behavior: when the selected highlight is
 * "Theme Default" the theme's own `highlight` is used; otherwise the chosen CSS
 * color name is returned as-is.
 *
 * @param {{highlight?: string}|null|undefined} theme A THEMES entry (or any
 *   object exposing `highlight`).
 * @param {number} index Index into HIGHLIGHT_COLORS.
 * @returns {string} The resolved highlight color (CSS color string).
 */
function getThemeHighlight(theme, index) {
  const choice = HIGHLIGHT_COLORS[index];
  if (choice === undefined) {
    throw new RangeError(
      `getThemeHighlight: index ${index} is out of range (0..${HIGHLIGHT_COLORS.length - 1})`,
    );
  }
  if (choice === THEME_DEFAULT_HIGHLIGHT) {
    // Fall back to a neutral default if the theme carries no highlight.
    return (theme && theme.highlight) || "#ffcc00";
  }
  return choice;
}

const Themes = {
  THEMES,
  HIGHLIGHT_COLORS,
  THEME_DEFAULT_HIGHLIGHT,
  getThemeHighlight,
};

if (typeof window !== "undefined") {
  window.Themes = Themes;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = Themes;
}
