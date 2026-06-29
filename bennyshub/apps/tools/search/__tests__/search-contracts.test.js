/**
 * Contract-adoption tests for the Search launcher after wiring its "Go Back"
 * button onto the shared Nav module.
 *
 * search/index.html is a thin splash page that POSTs /launch/search to start the
 * native scan-browser; its only interactive control is the "Go Back" button.
 *
 * Adoption summary (see index.html):
 *   - nav:      the Go Back button now delegates to Nav.goBack() (postMessage
 *               closeApp when framed), falling back to history.back() standalone
 *               — exactly the page's previous behaviour when not framed.
 *   - settings: none (the launcher stores nothing).
 *   - themes:   none (fixed inline CSS).
 *   - scan:     none in this page (scanning lives in the native narbe_scan_browser
 *               Python tool, out of scope for JS adoption).
 */

const fs = require("fs");
const path = require("path");
const Nav = require("../../../../shared/nav.js");

const htmlSrc = fs.readFileSync(
  path.join(__dirname, "..", "index.html"),
  "utf8",
);

describe("search nav: Go Back delegates to the shared Nav contract", () => {
  test("index.html loads the shared nav module and wires the button to it", () => {
    expect(htmlSrc).toContain("shared/nav.js");
    expect(htmlSrc).toContain("window.Nav.goBack()");
    // Legacy fallback preserved.
    expect(htmlSrc).toContain("window.history.back()");
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

  test("Nav.goBack falls back to history.back() when standalone", () => {
    // jsdom: window.parent === window (not framed) and no electronAPI, so the
    // resolution order lands on history.back() — the launcher's legacy behaviour.
    const back = jest
      .spyOn(window.history, "back")
      .mockImplementation(() => {});
    try {
      expect(Nav.goBack()).toBe(true);
      expect(back).toHaveBeenCalled();
    } finally {
      back.mockRestore();
    }
  });
});
