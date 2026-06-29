/**
 * Conformance tests for BennyPauseOverlay (pause-overlay.js).
 *
 * Runs under the jsdom jest env (window + DOM + customElements available).
 *
 * Contract under test: <benny-pause-overlay> renders ONE accessible, scannable
 * pause menu a game configures with its action list, so the bespoke per-app
 * pause overlays can be retired.
 *   - Default actions Resume / Settings / Exit; games pass their own.
 *   - Selecting runs onSelect() + emits a `pause-action` CustomEvent { id };
 *     resume/exit auto-hide unless prevented.
 *   - getTargets()/activate() expose the buttons to a game's ScanController.
 *   - role="dialog" aria-modal, buttons role/tabindex, focus restore.
 */

const BennyPauseOverlay = require("../pause-overlay.js");

function makeOverlay(opts) {
  return BennyPauseOverlay.create(opts || {});
}

function actionIds(el) {
  return Array.from(el.querySelectorAll("[data-action-id]")).map((b) =>
    b.getAttribute("data-action-id"),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  jest.restoreAllMocks();
});

// ---- registration --------------------------------------------------------

describe("registration", () => {
  test("definePauseOverlay registers the custom element", () => {
    expect(BennyPauseOverlay.definePauseOverlay()).toBe(true);
    expect(customElements.get("benny-pause-overlay")).toBe(
      BennyPauseOverlay.BennyPauseOverlayElement,
    );
  });

  test("is idempotent", () => {
    expect(BennyPauseOverlay.definePauseOverlay()).toBe(true);
    expect(BennyPauseOverlay.definePauseOverlay()).toBe(true);
  });

  test("exposes the global", () => {
    expect(window.BennyPauseOverlay).toBe(BennyPauseOverlay);
  });
});

// ---- rendering -----------------------------------------------------------

describe("rendering", () => {
  test("renders default Resume / Settings / Exit actions when none given", () => {
    const el = makeOverlay();
    expect(actionIds(el)).toEqual(["resume", "settings", "exit"]);
  });

  test("renders custom actions (incl. restart) in the given order", () => {
    const el = makeOverlay({
      actions: [
        { id: "resume", label: "Resume" },
        { id: "restart", label: "Restart" },
        { id: "settings", label: "Settings" },
        { id: "exit", label: "Exit" },
      ],
    });
    expect(actionIds(el)).toEqual(["resume", "restart", "settings", "exit"]);
    const restart = el.querySelector('[data-action-id="restart"]');
    expect(restart.textContent).toBe("Restart");
  });

  test("setActions replaces the rendered actions", () => {
    const el = makeOverlay();
    el.setActions([
      { id: "resume", label: "Keep Playing" },
      { id: "exit", label: "Quit" },
    ]);
    expect(actionIds(el)).toEqual(["resume", "exit"]);
    expect(el.querySelector('[data-action-id="resume"]').textContent).toBe(
      "Keep Playing",
    );
  });

  test("de-duplicates ids and falls back to defaults on empty input", () => {
    const el = makeOverlay({ actions: [] });
    expect(actionIds(el)).toEqual(["resume", "settings", "exit"]);
    el.setActions([
      { id: "resume", label: "A" },
      { id: "resume", label: "B" },
    ]);
    expect(actionIds(el)).toEqual(["resume"]);
  });

  test("injects scoped styles once", () => {
    makeOverlay();
    makeOverlay();
    expect(
      document.querySelectorAll("#benny-pause-overlay-styles").length,
    ).toBe(1);
  });
});

// ---- accessibility -------------------------------------------------------

describe("accessibility", () => {
  test("root is a modal dialog", () => {
    const el = makeOverlay();
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
  });

  test("each action is a focusable button with role and aria-label", () => {
    const el = makeOverlay();
    el.querySelectorAll("[data-action-id]").forEach((btn) => {
      expect(btn.getAttribute("role")).toBe("button");
      expect(btn.getAttribute("tabindex")).toBe("0");
      expect(btn.getAttribute("aria-label")).toBeTruthy();
    });
  });

  test("show focuses the first action and hide restores prior focus", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const el = makeOverlay();
    el.show();
    expect(document.activeElement).toBe(
      el.querySelector('[data-action-id="resume"]'),
    );

    el.hide();
    expect(document.activeElement).toBe(trigger);
  });

  test("Tab traps focus within the action buttons", () => {
    const el = makeOverlay();
    el.show();
    const buttons = el.getTargets();
    expect(document.activeElement).toBe(buttons[0]);

    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[1]);

    // Wrap from last back to first.
    buttons[buttons.length - 1].focus();
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[0]);
  });
});

// ---- show / hide / isOpen ------------------------------------------------

describe("show / hide / isOpen", () => {
  test("starts closed and toggles open state", () => {
    const el = makeOverlay();
    expect(el.isOpen()).toBe(false);
    el.show();
    expect(el.isOpen()).toBe(true);
    expect(el.classList.contains("benny-pause-open")).toBe(true);
    el.hide();
    expect(el.isOpen()).toBe(false);
    expect(el.hasAttribute("hidden")).toBe(true);
  });

  test("show is idempotent", () => {
    const el = makeOverlay();
    el.show();
    el.show();
    expect(el.isOpen()).toBe(true);
  });
});

// ---- scannability --------------------------------------------------------

describe("scannability", () => {
  test("getTargets returns the visible buttons in order while open, empty when closed", () => {
    const el = makeOverlay();
    expect(el.getTargets()).toEqual([]);
    el.show();
    const targets = el.getTargets();
    expect(targets.map((b) => b.getAttribute("data-action-id"))).toEqual([
      "resume",
      "settings",
      "exit",
    ]);
    el.hide();
    expect(el.getTargets()).toEqual([]);
  });

  test("activate(target element) runs the action and emits pause-action", () => {
    const onSelect = jest.fn();
    const heard = jest.fn();
    const el = makeOverlay({
      actions: [{ id: "settings", label: "Settings", onSelect }],
    });
    el.addEventListener("pause-action", (e) => heard(e.detail.id));
    el.show();

    const ok = el.activate(el.querySelector('[data-action-id="settings"]'));
    expect(ok).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith("settings");
  });

  test("activate(id string) works for pointing a ScanController at the overlay", () => {
    const onSelect = jest.fn();
    const el = makeOverlay({
      actions: [{ id: "settings", label: "Settings", onSelect }],
    });
    el.show();
    el.activate("settings");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("unknown targets are ignored", () => {
    const el = makeOverlay();
    el.show();
    expect(el.activate("nope")).toBe(false);
    expect(el.activate(null)).toBe(false);
  });
});

// ---- activation: click / Enter / Space -----------------------------------

describe("activation via input", () => {
  test("click runs the action and emits pause-action", () => {
    const onSelect = jest.fn();
    const heard = jest.fn();
    const el = makeOverlay({
      actions: [{ id: "settings", label: "Settings", onSelect }],
    });
    el.addEventListener("pause-action", (e) => heard(e.detail.id));
    el.show();
    el.querySelector('[data-action-id="settings"]').click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith("settings");
  });

  test("Enter activates the focused action", () => {
    const onSelect = jest.fn();
    const el = makeOverlay({
      actions: [{ id: "settings", label: "Settings", onSelect }],
    });
    el.show();
    const btn = el.querySelector('[data-action-id="settings"]');
    btn.focus();
    btn.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("Space activates the focused action", () => {
    const onSelect = jest.fn();
    const el = makeOverlay({
      actions: [{ id: "settings", label: "Settings", onSelect }],
    });
    el.show();
    const btn = el.querySelector('[data-action-id="settings"]');
    btn.focus();
    btn.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

// ---- auto-hide semantics -------------------------------------------------

describe("auto-hide semantics", () => {
  test("resume auto-hides", () => {
    const el = makeOverlay();
    el.show();
    el.activate("resume");
    expect(el.isOpen()).toBe(false);
  });

  test("exit auto-hides", () => {
    const el = makeOverlay();
    el.show();
    el.activate("exit");
    expect(el.isOpen()).toBe(false);
  });

  test("settings does NOT auto-hide", () => {
    const el = makeOverlay();
    el.show();
    el.activate("settings");
    expect(el.isOpen()).toBe(true);
  });

  test("a handler preventing default keeps resume open", () => {
    const el = makeOverlay({
      actions: [
        {
          id: "resume",
          label: "Resume",
          onSelect: (e) => e && e.preventDefault(),
        },
      ],
    });
    el.show();
    el.activate("resume");
    expect(el.isOpen()).toBe(true);
  });

  test("an external listener preventing default keeps exit open", () => {
    const el = makeOverlay({ actions: [{ id: "exit", label: "Exit" }] });
    el.addEventListener("pause-action", (e) => e.preventDefault());
    el.show();
    el.activate("exit");
    expect(el.isOpen()).toBe(true);
  });
});

// ---- collaborators -------------------------------------------------------

describe("collaborators", () => {
  test("voice.speak announces on show", () => {
    const voice = { speak: jest.fn() };
    const el = makeOverlay({ voice });
    el.show();
    expect(voice.speak).toHaveBeenCalledWith("Paused");
  });

  test("Escape activates resume (closing the overlay)", () => {
    const onSelect = jest.fn();
    const el = makeOverlay({
      actions: [{ id: "resume", label: "Resume", onSelect }],
    });
    el.show();
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(el.isOpen()).toBe(false);
  });
});
