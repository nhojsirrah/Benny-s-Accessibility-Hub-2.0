/**
 * Conformance tests for BennyHud (hud.js).
 *
 * Runs under the jsdom jest env (window + DOM + customElements available).
 *
 * Contract under test: <benny-hud> renders the shared chrome (Back / Pause /
 * Settings) as one accessible, scannable surface.
 *   - Back  -> Nav.goBack()                  (nav.js contract)
 *   - Pause -> postMessage `app:requestPause` (IP-4 lifecycle handshake)
 *   - Settings -> postMessage `app:requestSettings`
 *   - The three controls are exposable as ScanController scan targets and are
 *     activable via click and Enter/Space.
 */

const BennyHud = require("../hud.js");

// jsdom sets window.parent === window (top-level). To simulate running inside
// the hub iframe we swap in a fake parent exposing a postMessage spy, then
// restore the real descriptor afterward.
let originalParentDescriptor;

function setFakeParent(fakeParent) {
  originalParentDescriptor =
    originalParentDescriptor ||
    Object.getOwnPropertyDescriptor(window, "parent");
  Object.defineProperty(window, "parent", {
    configurable: true,
    get: () => fakeParent,
  });
}

function restoreParent() {
  if (originalParentDescriptor) {
    Object.defineProperty(window, "parent", originalParentDescriptor);
    originalParentDescriptor = undefined;
  }
}

function makeHud(attrs) {
  const el = document.createElement("benny-hud");
  if (attrs) {
    Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
  }
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  restoreParent();
  delete window.Nav;
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});

// ---- registration --------------------------------------------------------

describe("registration", () => {
  test("defineBennyHud registers the custom element", () => {
    expect(BennyHud.defineBennyHud()).toBe(true);
    expect(customElements.get("benny-hud")).toBe(BennyHud.BennyHudElement);
  });

  test("is idempotent", () => {
    expect(BennyHud.defineBennyHud()).toBe(true);
    expect(BennyHud.defineBennyHud()).toBe(true);
  });
});

// ---- rendering & accessibility -------------------------------------------

describe("rendering", () => {
  test("renders Back / Pause / Settings buttons by default", () => {
    const el = makeHud();
    const actions = Array.from(el.querySelectorAll("[data-action]")).map((b) =>
      b.getAttribute("data-action"),
    );
    expect(actions).toEqual(["back", "pause", "settings"]);
  });

  test("each control is an accessible button with role and aria-label", () => {
    const el = makeHud();
    const buttons = el.querySelectorAll("[data-action]");
    expect(buttons.length).toBe(3);
    buttons.forEach((b) => {
      expect(b.getAttribute("role")).toBe("button");
      expect(b.getAttribute("tabindex")).toBe("0");
      expect(b.getAttribute("aria-label")).toBeTruthy();
    });
    expect(
      el.querySelector('[data-action="back"]').getAttribute("aria-label"),
    ).toBe("Back");
    expect(
      el.querySelector('[data-action="pause"]').getAttribute("aria-label"),
    ).toBe("Pause");
    expect(
      el.querySelector('[data-action="settings"]').getAttribute("aria-label"),
    ).toBe("Settings");
  });

  test("the HUD itself is an accessible toolbar surface", () => {
    const el = makeHud();
    expect(el.getAttribute("role")).toBe("toolbar");
    expect(el.getAttribute("aria-label")).toBeTruthy();
  });

  test("configurable which buttons show via the buttons attribute", () => {
    const el = makeHud({ buttons: "back settings" });
    const actions = Array.from(el.querySelectorAll("[data-action]")).map((b) =>
      b.getAttribute("data-action"),
    );
    expect(actions).toEqual(["back", "settings"]);
    expect(el.querySelector('[data-action="pause"]')).toBeNull();
  });

  test("buttons attribute respects requested order and de-dupes", () => {
    const el = makeHud({ buttons: "settings,back,back" });
    const actions = Array.from(el.querySelectorAll("[data-action]")).map((b) =>
      b.getAttribute("data-action"),
    );
    expect(actions).toEqual(["settings", "back"]);
  });

  test("per-action label override", () => {
    const el = makeHud({ "back-label": "Return to Hub" });
    const back = el.querySelector('[data-action="back"]');
    expect(back.getAttribute("aria-label")).toBe("Return to Hub");
    expect(back.textContent.trim()).toBe("Return to Hub");
  });

  test("re-renders when the buttons attribute changes", () => {
    const el = makeHud();
    expect(el.querySelectorAll("[data-action]").length).toBe(3);
    el.setAttribute("buttons", "pause");
    const actions = Array.from(el.querySelectorAll("[data-action]")).map((b) =>
      b.getAttribute("data-action"),
    );
    expect(actions).toEqual(["pause"]);
  });
});

// ---- Back -> Nav.goBack --------------------------------------------------

describe("Back", () => {
  test("calls Nav.goBack (injected)", () => {
    const el = makeHud();
    el.nav = { goBack: jest.fn() };
    el.querySelector('[data-action="back"]').click();
    expect(el.nav.goBack).toHaveBeenCalledTimes(1);
  });

  test("falls back to window.Nav.goBack", () => {
    const goBack = jest.fn();
    window.Nav = { goBack };
    const el = makeHud();
    el.querySelector('[data-action="back"]').click();
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  test("emits a back event", () => {
    const el = makeHud();
    el.nav = { goBack: jest.fn() };
    const onBack = jest.fn();
    el.addEventListener("back", onBack);
    el.querySelector('[data-action="back"]').click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

// ---- Pause -> app:requestPause -------------------------------------------

describe("Pause", () => {
  test("posts app:requestPause to the embedding hub (framed)", () => {
    const postMessage = jest.fn();
    setFakeParent({ postMessage });
    const el = makeHud();
    el.querySelector('[data-action="pause"]').click();
    expect(postMessage).toHaveBeenCalledWith({ type: "app:requestPause" }, "*");
  });

  test("posts to an injected hub target", () => {
    const postMessage = jest.fn();
    const el = makeHud();
    el.hub = { postMessage };
    el.querySelector('[data-action="pause"]').click();
    expect(postMessage).toHaveBeenCalledWith({ type: "app:requestPause" }, "*");
  });

  test("emits a pause event", () => {
    const el = makeHud();
    const onPause = jest.fn();
    el.addEventListener("pause", onPause);
    el.querySelector('[data-action="pause"]').click();
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  test("does not post to itself when un-framed", () => {
    // window.parent === window in jsdom → standalone; nothing should be posted
    // back into the same page. We assert no throw and a pause event still fires.
    const el = makeHud();
    const onPause = jest.fn();
    el.addEventListener("pause", onPause);
    expect(() =>
      el.querySelector('[data-action="pause"]').click(),
    ).not.toThrow();
    expect(onPause).toHaveBeenCalledTimes(1);
  });
});

// ---- Settings -> app:requestSettings + event ----------------------------

describe("Settings", () => {
  test("posts app:requestSettings and emits a settings event", () => {
    const postMessage = jest.fn();
    setFakeParent({ postMessage });
    const el = makeHud();
    const onSettings = jest.fn();
    el.addEventListener("settings", onSettings);
    el.querySelector('[data-action="settings"]').click();
    expect(postMessage).toHaveBeenCalledWith(
      { type: "app:requestSettings" },
      "*",
    );
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});

// ---- keyboard activation -------------------------------------------------

describe("keyboard activation", () => {
  test("Enter activates the focused control", () => {
    const el = makeHud();
    el.nav = { goBack: jest.fn() };
    const back = el.querySelector('[data-action="back"]');
    back.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(el.nav.goBack).toHaveBeenCalledTimes(1);
  });

  test("Space activates the focused control", () => {
    const postMessage = jest.fn();
    setFakeParent({ postMessage });
    const el = makeHud();
    const pause = el.querySelector('[data-action="pause"]');
    pause.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(postMessage).toHaveBeenCalledWith({ type: "app:requestPause" }, "*");
  });

  test("ignores non-activation keys", () => {
    const el = makeHud();
    el.nav = { goBack: jest.fn() };
    const back = el.querySelector('[data-action="back"]');
    back.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    expect(el.nav.goBack).not.toHaveBeenCalled();
  });
});

// ---- scannability (ScanController integration) ---------------------------

describe("scannability", () => {
  test("getTargets exposes the visible controls in order", () => {
    const el = makeHud();
    const targets = el.getTargets();
    expect(targets.map((t) => t.getAttribute("data-action"))).toEqual([
      "back",
      "pause",
      "settings",
    ]);
  });

  test("getTargets reflects the buttons attribute", () => {
    const el = makeHud({ buttons: "pause back" });
    const targets = el.getTargets();
    expect(targets.map((t) => t.getAttribute("data-action"))).toEqual([
      "pause",
      "back",
    ]);
  });

  test("activate(target) runs the action for a scanned target", () => {
    const postMessage = jest.fn();
    setFakeParent({ postMessage });
    const el = makeHud();
    el.nav = { goBack: jest.fn() };

    // Simulate a ScanController handing back a focused target on select.
    const targets = el.getTargets();
    el.activate(targets[0]); // back
    expect(el.nav.goBack).toHaveBeenCalledTimes(1);

    el.activate(targets[1]); // pause
    expect(postMessage).toHaveBeenCalledWith({ type: "app:requestPause" }, "*");
  });

  test("activate accepts an action string", () => {
    const el = makeHud();
    el.nav = { goBack: jest.fn() };
    expect(el.activate("back")).toBe(true);
    expect(el.nav.goBack).toHaveBeenCalledTimes(1);
  });

  test("activate ignores unknown targets", () => {
    const el = makeHud();
    expect(el.activate(null)).toBe(false);
    expect(el.activate(document.createElement("div"))).toBe(false);
    expect(el.activate("nope")).toBe(false);
  });

  test("controls drive a real ScanController as targets", () => {
    let ScanController;
    try {
      ScanController = require("../scan-core.js");
    } catch (e) {
      return; // scan-core not present in this checkout — skip integration.
    }
    const el = makeHud();
    el.nav = { goBack: jest.fn() };

    const sc = new ScanController({
      getTargets: () => el.getTargets(),
      onFocus: () => {},
      onSelect: (t) => el.activate(t),
      autoScan: false,
    });

    sc.advance(); // focus first target (back)
    expect(sc.getCurrentTarget().getAttribute("data-action")).toBe("back");
    sc.select();
    expect(el.nav.goBack).toHaveBeenCalledTimes(1);

    sc.destroy();
  });
});
