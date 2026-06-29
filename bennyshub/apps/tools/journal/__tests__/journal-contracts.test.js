/**
 * Contract-adoption tests for Ben's Journal after wiring it onto the shared
 * Nav / SettingsStore / Predict modules.
 *
 * Journal's app.js is a DOM-coupled IIFE that auto-runs init() on load, so these
 * tests assert the shared contracts the tool now depends on (loaded exactly as
 * the page exposes them via <script src>), rather than re-running the whole app.
 *
 * Adoption summary (see app.js for the in-code notes):
 *   - nav:      closeApp() now delegates to Nav.goBack() (postMessage closeApp).
 *   - settings: `theme` rides SettingsStore.app("journal"); the legacy
 *               "journal_settings" blob migrates on first read. highlightColor is
 *               kept local (journal's palette is non-canonical).
 *   - predict:  the local predictions.js engine is replaced by the shared Predict
 *               engine, identical to the keyboard tool.
 *   - themes:   kept local (CSS-class palette, not the shared gradient THEMES).
 */

const Nav = require("../../../../shared/nav.js");
const SettingsStore = require("../../../../shared/settings-store.js");
const Predict = require("../../../../shared/predict.js");

beforeEach(() => {
  localStorage.clear();
  SettingsStore._reset();
});

// ---- Nav -----------------------------------------------------------------

describe("nav: closeApp delegates to the shared Nav closeApp contract", () => {
  test("Nav.goBack posts the closeApp message when framed", () => {
    const post = jest.fn();
    const realParent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage: post },
    });
    try {
      expect(Nav.goBack()).toBe(true);
      expect(post).toHaveBeenCalledWith({ action: "closeApp" }, "*");
    } finally {
      if (realParent) Object.defineProperty(window, "parent", realParent);
    }
  });
});

// ---- Settings ------------------------------------------------------------

describe("settings: theme round-trips through SettingsStore.app('journal')", () => {
  test("a written theme reads back after the in-memory cache is dropped", () => {
    expect(SettingsStore.app("journal").set("theme", "dark")).toBe(true);
    SettingsStore._reset();
    expect(SettingsStore.app("journal").get("theme")).toBe("dark");
  });

  test("legacy journal_settings blob migrates theme on first read", () => {
    localStorage.setItem(
      "journal_settings",
      JSON.stringify({ theme: "blue", highlightColor: "pink" }),
    );
    SettingsStore._reset();

    const ran = SettingsStore.runMigrations(true);
    expect(ran).toContain("journal_settings");

    // theme lands in the per-app store...
    expect(SettingsStore.app("journal").get("theme")).toBe("blue");
    // ...and the canonical highlight index is derived from the legacy color name.
    expect(SettingsStore.global.get("highlightColorIndex")).toBe(8); // "Pink"
  });
});

// ---- Predict -------------------------------------------------------------

describe("predict: journal runs on the shared Predict engine", () => {
  // A small deterministic corpus. With no `last_used`, every entry shares the
  // same recency multiplier, so ranking is driven purely by count + the cascade.
  const corpus = {
    frequent_words: {
      THE: { count: 10 },
      THIS: { count: 5 },
      THAT: { count: 1 },
    },
    bigrams: {
      "I AM": { count: 3 },
      "I WAS": { count: 1 },
    },
    trigrams: {},
  };

  test("next-word ranking after a context: bigrams beat frequency", () => {
    const engine = Predict.create({ data: corpus });
    expect(engine.getHybridPredictions("I ")).toEqual([
      "AM",
      "WAS",
      "THE",
      "THIS",
      "THAT",
      "YES",
    ]);
  });

  test("partial-word completion ranks candidates by frequency", () => {
    const engine = Predict.create({ data: corpus });
    expect(engine.getHybridPredictions("TH").slice(0, 3)).toEqual([
      "THE",
      "THIS",
      "THAT",
    ]);
  });
});
