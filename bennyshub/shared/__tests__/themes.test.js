/**
 * Conformance tests for the canonical themes/highlight palette (themes.js).
 *
 * These pin the extraction against the values the standard-cluster games
 * currently ship, so the eventual app-adoption sweeps are provably equivalent.
 * Plain node assertions (no DOM needed), runs under the jsdom jest env.
 */

const Themes = require("../themes.js");
const { THEMES, HIGHLIGHT_COLORS, getThemeHighlight } = Themes;

// --- Source-of-truth snapshots collected from the apps ---------------------
//
// Copied verbatim from the games' local arrays at extraction time. If a future
// edit to themes.js drifts from these, that is a behavior change and these
// tests should fail loudly.

// TicTacToe (apps/games/BENNYSTICTACTOE/script.js) — modal palette.
const TICTACTOE_THEME_NAMES = [
  "Default",
  "Ocean",
  "Midnight",
  "Forest",
  "Sunset",
  "Lavender",
  "Mint",
  "Dark Blue",
];
const TICTACTOE_THEME_BG = {
  Default: "linear-gradient(135deg, #ff4b1f, #ff9068)",
  Ocean: "linear-gradient(135deg, #2193b0, #6dd5ed)",
  Midnight: "linear-gradient(135deg, #232526, #414345)",
  Forest: "linear-gradient(135deg, #134e5e, #71b280)",
  Sunset: "linear-gradient(135deg, #f12711, #f5af19)",
  Lavender: "linear-gradient(135deg, #834d9b, #d04ed6)",
  Mint: "linear-gradient(135deg, #00b09b, #96c93d)",
  "Dark Blue": "linear-gradient(135deg, #0f2027, #203a43, #2c5364)",
};
// TicTacToe / MatchyMatch highlight palette (identical 13-entry list).
const TICTACTOE_HIGHLIGHT_COLORS = [
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

// WordJumble (apps/games/BENNYSWORDJUMBLE/game.js) — only standard-cluster game
// with a per-theme `highlight` for all 8 themes. Canonical `highlight` is sourced
// from here.
const WORDJUMBLE_THEME_HIGHLIGHT = {
  Default: "#ffff00",
  Ocean: "#ffffff",
  Midnight: "#00ff00",
  Forest: "#ffcc00",
  Sunset: "#ffff00",
  Lavender: "#00ffff",
  Mint: "#ffffff",
  "Dark Blue": "#00ffcc",
};

const byName = (name) => THEMES.find((t) => t.name === name);

describe("THEMES", () => {
  test("exposes the standard 8-theme cluster in order", () => {
    expect(THEMES.map((t) => t.name)).toEqual(TICTACTOE_THEME_NAMES);
  });

  test("background gradients match TicTacToe verbatim", () => {
    for (const t of THEMES) {
      expect(t.bg).toBe(TICTACTOE_THEME_BG[t.name]);
    }
  });

  test("per-theme highlight matches WordJumble verbatim", () => {
    for (const t of THEMES) {
      expect(t.highlight).toBe(WORDJUMBLE_THEME_HIGHLIGHT[t.name]);
    }
  });

  test("every theme has name, bg and highlight", () => {
    for (const t of THEMES) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.bg).toBe("string");
      expect(typeof t.highlight).toBe("string");
    }
  });
});

describe("HIGHLIGHT_COLORS", () => {
  test("matches the TicTacToe/MatchyMatch 13-entry palette verbatim", () => {
    expect(HIGHLIGHT_COLORS).toEqual(TICTACTOE_HIGHLIGHT_COLORS);
  });

  test('"Theme Default" is the sentinel at index 0', () => {
    expect(HIGHLIGHT_COLORS[0]).toBe(Themes.THEME_DEFAULT_HIGHLIGHT);
  });
});

describe("getThemeHighlight", () => {
  // Full (theme, index) matrix. For "Theme Default" (index 0) the expected
  // value is the theme's own highlight (WordJumble behavior); for every other
  // index it is the CSS color name returned as-is (TicTacToe behavior).
  test("resolves the full theme × index matrix to expected colors", () => {
    for (const theme of THEMES) {
      HIGHLIGHT_COLORS.forEach((choice, index) => {
        const expected =
          index === 0 ? WORDJUMBLE_THEME_HIGHLIGHT[theme.name] : choice;
        expect(getThemeHighlight(theme, index)).toBe(expected);
      });
    }
  });

  test('index 0 ("Theme Default") returns the active theme highlight', () => {
    expect(getThemeHighlight(byName("Ocean"), 0)).toBe("#ffffff");
    expect(getThemeHighlight(byName("Default"), 0)).toBe("#ffff00");
    expect(getThemeHighlight(byName("Dark Blue"), 0)).toBe("#00ffcc");
  });

  test("non-default indices return the CSS color name regardless of theme", () => {
    expect(getThemeHighlight(byName("Ocean"), 1)).toBe("Yellow");
    expect(getThemeHighlight(byName("Forest"), 3)).toBe("Cyan");
    expect(getThemeHighlight(byName("Midnight"), 9)).toBe("Gold");
    // Theme choice does not affect a concrete (non-default) color.
    expect(getThemeHighlight(byName("Default"), 1)).toBe(
      getThemeHighlight(byName("Sunset"), 1),
    );
  });

  test('falls back to "#ffcc00" when a theme carries no highlight', () => {
    expect(getThemeHighlight({}, 0)).toBe("#ffcc00");
    expect(getThemeHighlight(null, 0)).toBe("#ffcc00");
  });

  test("throws on out-of-range index", () => {
    expect(() => getThemeHighlight(byName("Ocean"), -1)).toThrow(RangeError);
    expect(() =>
      getThemeHighlight(byName("Ocean"), HIGHLIGHT_COLORS.length),
    ).toThrow(RangeError);
  });
});

describe("module exports", () => {
  test("dual CommonJS export surface", () => {
    expect(typeof Themes.getThemeHighlight).toBe("function");
    expect(Array.isArray(Themes.THEMES)).toBe(true);
    expect(Array.isArray(Themes.HIGHLIGHT_COLORS)).toBe(true);
  });
});
