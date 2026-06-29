/**
 * Contract-adoption tests for the Phraseboard tool.
 *
 * Phraseboard is a single inline-script index.html, so these tests assert the
 * shared contracts it now depends on (loaded as the page exposes them via
 * <script src>).
 *
 * Adoption summary:
 *   - nav:      exitToHub() delegates to Nav.goBack(). It used to post the older
 *               { action: 'focusBackButton' } alias; the hub treats that and
 *               { action: 'closeApp' } identically, so switching to Nav is
 *               behaviour-preserving (the focusBackButton post is kept as a
 *               fallback for older hub builds).
 *   - themes:   kept local. Phraseboard's THEMES (light/dark/blue/green/purple)
 *               are a CSS-class palette, not the shared gradient THEMES, so they
 *               are not byte-equivalent and are not adopted.
 *   - settings: DEFERRED. The shared SettingsStore has no "phraseboard" app
 *               schema and no "phraseboard_settings" migration, so routing
 *               phraseboard's settings through it would require a change to the
 *               shared module (out of scope here). The guard test below records
 *               that rationale so a future shared-schema addition is noticed.
 */

const Nav = require("../../../../shared/nav.js");
const SettingsStore = require("../../../../shared/settings-store.js");

// ---- Nav -----------------------------------------------------------------

describe("nav: exitToHub delegates to the shared Nav closeApp contract", () => {
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

// ---- Settings (deferred) -------------------------------------------------

describe("settings: deferred — no shared phraseboard schema/migration yet", () => {
  test("SettingsStore has no phraseboard app schema or migration", () => {
    expect(SettingsStore.APP_SCHEMAS.phraseboard).toBeUndefined();
    expect(
      SettingsStore.migrations.some((m) => m.appId === "phraseboard"),
    ).toBe(false);
  });
});
