/**
 * Contract-adoption tests for Day Hub after wiring its "Exit — back to hub"
 * path onto the shared Nav module.
 *
 * Day Hub's app.js is a DOM-coupled IIFE that auto-runs on load (and fetches
 * live weather), so — like the journal-contracts tests — these assert the shared
 * contract the tool now delegates to, plus a static check that the tool is wired
 * to it, rather than re-running the whole app.
 *
 * Adoption summary (see app.js / index.html):
 *   - nav:      exitHub() now delegates to Nav.goBack() (postMessage closeApp)
 *               when framed, keeping the hand-rolled postMessage as a fallback.
 *   - settings: NOT adopted. Scan speed / auto-scan already ride NarbeScanManager
 *               and voice rides NarbeVoiceManager; Day Hub's only local settings
 *               (weather lat/lon/label) have no SettingsStore schema, so they
 *               stay in the local "dayhub_weather_v1" blob.
 *   - themes:   none (fixed CSS, no palette).
 *   - scan:     left as-is (coupled to NarbeScanManager + a long-press gate).
 */

const fs = require("fs");
const path = require("path");
const Nav = require("../../../../shared/nav.js");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(
  path.join(__dirname, "..", "index.html"),
  "utf8",
);

describe("dayhub nav: exitHub delegates to the shared Nav closeApp contract", () => {
  test("index.html loads the shared nav module", () => {
    expect(htmlSrc).toContain("shared/nav.js");
  });

  test("exitHub() routes through Nav.goBack()", () => {
    expect(appSrc).toContain("window.Nav.goBack()");
  });

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
