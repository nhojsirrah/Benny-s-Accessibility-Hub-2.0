/**
 * Contract-adoption tests for the Streaming tool after wiring it onto the shared
 * Nav / SettingsStore modules.
 *
 * Streaming's app.js is a DOM-coupled module that bootstraps on DOMContentLoaded,
 * so these tests assert the shared contracts the tool now depends on (loaded as
 * the page exposes them via <script src>).
 *
 * Adoption summary (see app.js for the in-code notes):
 *   - nav:      exitApp() delegates the hub-iframe + Electron cases to
 *               Nav.goBack(); the legacy /close_app fallback is preserved.
 *   - settings: `theme` rides SettingsStore.app("streaming"); the legacy
 *               "streaming_settings" blob migrates on first read. highlightStyle
 *               ('fill') and highlightColor are kept local (non-canonical).
 *   - themes:   kept local (CSS-class palette, not the shared gradient THEMES).
 *   - predict:  out of scope for this tool (keeps its own predictions.js).
 */

const Nav = require("../../../../shared/nav.js");
const SettingsStore = require("../../../../shared/settings-store.js");

beforeEach(() => {
  localStorage.clear();
  SettingsStore._reset();
});

// ---- Nav -----------------------------------------------------------------

describe("nav: exitApp delegates to the shared Nav closeApp contract", () => {
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

describe("settings: theme round-trips through SettingsStore.app('streaming')", () => {
  test("a written theme reads back after the in-memory cache is dropped", () => {
    expect(SettingsStore.app("streaming").set("theme", "midnight")).toBe(true);
    SettingsStore._reset();
    expect(SettingsStore.app("streaming").get("theme")).toBe("midnight");
  });

  test("legacy streaming_settings blob migrates theme on first read", () => {
    localStorage.setItem(
      "streaming_settings",
      JSON.stringify({
        theme: "forest",
        highlightStyle: "fill",
        highlightColor: "cyan",
      }),
    );
    SettingsStore._reset();

    const ran = SettingsStore.runMigrations(true);
    expect(ran).toContain("streaming_settings");

    // theme lands in the per-app store...
    expect(SettingsStore.app("streaming").get("theme")).toBe("forest");
    // ...and the legacy 'fill' style normalizes to the canonical 'full', with the
    // color name mapped onto the shared highlight index.
    expect(SettingsStore.global.get("highlightStyle")).toBe("full");
    expect(SettingsStore.global.get("highlightColorIndex")).toBe(3); // "Cyan"
  });
});
