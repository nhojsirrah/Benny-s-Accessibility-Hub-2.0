/**
 * Contract-adoption tests for RT Convo after wiring its exitApp() back path
 * onto the shared Nav module.
 *
 * RT Convo's logic is an inline IIFE inside index.html that auto-runs on load,
 * so — like the journal-contracts tests — these assert the shared contract the
 * tool now delegates to, plus a static check that the tool is wired to it.
 *
 * Adoption summary (see index.html):
 *   - nav:      exitApp(), when framed, now delegates to Nav.goBack() (postMessage
 *               closeApp). The hub treats closeApp and the legacy focusBackButton
 *               identically; the focusBackButton post is kept as a fallback, and
 *               the standalone-Electron (closeToolWindow) / window.close() paths
 *               are left untouched.
 *   - settings: NOT adopted. Scan speed / auto-scan already ride NarbeScanManager;
 *               the app's own settings (conv_settings, conv_personality, bio,
 *               topic board, non-canonical "light" theme flag) have no
 *               SettingsStore schema, so they stay in their local blobs.
 *   - themes:   kept local (a single "light" body-class toggle, not the shared
 *               gradient THEMES).
 *   - scan:     left as-is (a multi-mode row/column/listen/quiz/consent/warning
 *               state machine — not a clean single-axis list).
 */

const fs = require("fs");
const path = require("path");
const Nav = require("../../../../shared/nav.js");

const htmlSrc = fs.readFileSync(
  path.join(__dirname, "..", "index.html"),
  "utf8",
);

describe("rt-convo nav: exitApp delegates to the shared Nav closeApp contract", () => {
  test("index.html loads the shared nav module", () => {
    expect(htmlSrc).toContain("shared/nav.js");
  });

  test("exitApp() routes through Nav.goBack() when framed", () => {
    expect(htmlSrc).toContain("window.Nav.goBack()");
    // Legacy fallback is preserved.
    expect(htmlSrc).toContain("{ action: 'focusBackButton' }");
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
