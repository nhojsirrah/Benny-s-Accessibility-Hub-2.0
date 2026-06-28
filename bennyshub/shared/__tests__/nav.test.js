/**
 * Conformance tests for Nav (nav.js).
 *
 * Runs under the jsdom jest env (window + DOM + customElements available).
 *
 * The hub iframe contract under test: an app "goes back" by sending its parent
 *     window.parent.postMessage({ action: 'closeApp' }, '*')
 * which the hub (bennyshub/index.html) handles by closing the active iframe.
 */

const Nav = require("../nav.js");

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

afterEach(() => {
  restoreParent();
  delete window.electronAPI;
  jest.restoreAllMocks();
});

// ---- goBack() ------------------------------------------------------------

describe("goBack", () => {
  test("inside the hub iframe, posts { action: 'closeApp' } to the parent", () => {
    const postMessage = jest.fn();
    setFakeParent({ postMessage });

    const result = Nav.goBack();

    expect(result).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ action: "closeApp" }, "*");
  });

  test("isInIframe reflects the framed state", () => {
    expect(Nav.isInIframe()).toBe(false); // top-level by default in jsdom
    setFakeParent({ postMessage: jest.fn() });
    expect(Nav.isInIframe()).toBe(true);
  });

  test("standalone (not framed) falls back to history.back()", () => {
    // window.parent === window in jsdom → not framed.
    const back = jest
      .spyOn(window.history, "back")
      .mockImplementation(() => {});

    const result = Nav.goBack();

    expect(result).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
  });

  test("standalone Electron window uses the bridge window.close()", () => {
    const close = jest.fn();
    window.electronAPI = { window: { close } };
    const back = jest
      .spyOn(window.history, "back")
      .mockImplementation(() => {});

    const result = Nav.goBack();

    expect(result).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
  });

  test("the iframe contract takes precedence over the Electron path", () => {
    const postMessage = jest.fn();
    setFakeParent({ postMessage });
    const close = jest.fn();
    window.electronAPI = { window: { close } };

    Nav.goBack();

    expect(postMessage).toHaveBeenCalledWith({ action: "closeApp" }, "*");
    expect(close).not.toHaveBeenCalled();
  });
});

// ---- <benny-back> custom element -----------------------------------------

describe("<benny-back> custom element", () => {
  test("registers itself with the custom element registry", () => {
    expect(Nav.defineBennyBack()).toBe(true);
    expect(customElements.get("benny-back")).toBe(Nav.BennyBackElement);
  });

  test("is scannable/accessible: role=button, tabindex, aria-label", () => {
    const el = document.createElement("benny-back");
    document.body.appendChild(el);

    expect(el.getAttribute("role")).toBe("button");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-label")).toBe("Back");
    expect(el.textContent.trim()).toBe("Back");

    el.remove();
  });

  test("honors a custom label attribute", () => {
    const el = document.createElement("benny-back");
    el.setAttribute("label", "Return to Hub");
    document.body.appendChild(el);

    expect(el.getAttribute("aria-label")).toBe("Return to Hub");
    expect(el.textContent.trim()).toBe("Return to Hub");

    el.remove();
  });

  test("click triggers goBack (posts closeApp when framed)", () => {
    const postMessage = jest.fn();
    setFakeParent({ postMessage });

    const el = document.createElement("benny-back");
    document.body.appendChild(el);
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    expect(postMessage).toHaveBeenCalledWith({ action: "closeApp" }, "*");

    el.remove();
  });

  test("Enter key triggers goBack", () => {
    const back = jest
      .spyOn(window.history, "back")
      .mockImplementation(() => {});

    const el = document.createElement("benny-back");
    document.body.appendChild(el);
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    expect(back).toHaveBeenCalledTimes(1);

    el.remove();
  });

  test("Space key triggers goBack", () => {
    const back = jest
      .spyOn(window.history, "back")
      .mockImplementation(() => {});

    const el = document.createElement("benny-back");
    document.body.appendChild(el);
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );

    expect(back).toHaveBeenCalledTimes(1);

    el.remove();
  });

  test("ignores non-activation keys", () => {
    const back = jest
      .spyOn(window.history, "back")
      .mockImplementation(() => {});

    const el = document.createElement("benny-back");
    document.body.appendChild(el);
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );

    expect(back).not.toHaveBeenCalled();

    el.remove();
  });
});
