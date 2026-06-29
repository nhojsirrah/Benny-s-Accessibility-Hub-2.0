/**
 * BennyHud — the shared, scannable on-screen chrome for Narbehouse Accessibility
 * Hub apps.
 *
 * Today every app hand-rolls its own "Back" affordance (the ~21 nav copies Nav
 * is consolidating) and its own pause menu. IP-7 establishes a single, shared
 * heads-up display that renders the common chrome — Back / Pause / Settings —
 * ONCE, as one accessible, switch-scannable surface. A later sweep retires the
 * per-app pause menus and the duplicated nav buttons in favour of mounting this
 * element; this PR only ships the module + its tests (the hub/app wiring and the
 * IP-7 registry/profiles parts are deferred).
 *
 * It is an "extension point": a host mounts <benny-hud>, decides which of the
 * three controls are visible, exposes the controls to its ScanController as scan
 * targets via getTargets(), and listens for the high-level intents the HUD emits
 * (pause / settings) — or lets the HUD drive the existing iframe + lifecycle
 * handshake conventions directly. It owns no app state.
 *
 * Integration with the merged shared pieces:
 *   - nav.js — Back calls Nav.goBack() (the ~21-copy "return to hub" contract).
 *   - scan-core.js — the HUD's controls are themselves ScanController targets;
 *     getTargets() returns them in order and activate(target) selects one, so a
 *     host wires `getTargets: () => hud.getTargets()` /
 *     `onSelect: (t) => hud.activate(t)`.
 *   - benny-app.js / IP-4 lifecycle handshake — Pause posts
 *     `{ type: 'app:requestPause' }` to the embedding hub (the same message
 *     BennyApp.requestPause() sends); Settings posts
 *     `{ type: 'app:requestSettings' }`.
 *
 * Loaded as an IIFE-style global via <script src>, matching the other shared
 * modules (Nav, ScanController, BennyApp, Themes, SettingsStore). Apps read
 * window.BennyHud. A dual CommonJS export is provided so jsdom/node tests can
 * require() it.
 */

(function () {
  "use strict";

  // Resolve a global object that works in the browser, in jsdom, and in plain
  // Node without throwing a ReferenceError when `window` is absent.
  var GLOBAL =
    typeof window !== "undefined"
      ? window
      : typeof globalThis !== "undefined"
        ? globalThis
        : {};

  // The three controls the HUD knows how to render, in canonical order. Each
  // descriptor drives one button: its data-action, default aria-label, and the
  // visible glyph/text. Keeping this declarative makes `buttons="..."` filtering
  // and the scan-target ordering fall out for free.
  var CONTROLS = [
    { action: "back", label: "Back", text: "Back" },
    { action: "pause", label: "Pause", text: "Pause" },
    { action: "settings", label: "Settings", text: "Settings" },
  ];

  var DEFAULT_ACTIONS = CONTROLS.map(function (c) {
    return c.action;
  });

  // Lifecycle-handshake / iframe messages the HUD emits to the embedding hub.
  // `app:requestPause` matches BennyApp.requestPause() exactly so a hub that
  // already speaks the IP-4 handshake handles the HUD with no new code.
  var MSG_PAUSE = "app:requestPause";
  var MSG_SETTINGS = "app:requestSettings";

  /**
   * Parse a `buttons` attribute ("back pause settings", comma- or space-
   * separated, any order) into the ordered, de-duplicated, validated list of
   * actions to render. Falls back to all three controls when absent/empty.
   *
   * @param {string|null|undefined} value
   * @returns {string[]}
   */
  function parseButtons(value) {
    if (value === null || value === undefined) return DEFAULT_ACTIONS.slice();
    var tokens = String(value)
      .split(/[\s,]+/)
      .map(function (t) {
        return t.trim().toLowerCase();
      })
      .filter(Boolean);
    var seen = {};
    var out = [];
    tokens.forEach(function (t) {
      if (DEFAULT_ACTIONS.indexOf(t) !== -1 && !seen[t]) {
        seen[t] = true;
        out.push(t);
      }
    });
    return out.length ? out : DEFAULT_ACTIONS.slice();
  }

  var BennyHudElement = null;

  // Guard the class definition itself: in a pure (non-DOM) node env HTMLElement
  // is undefined and `class extends HTMLElement` would throw at parse/eval time.
  if (typeof HTMLElement !== "undefined") {
    BennyHudElement = class BennyHud extends HTMLElement {
      constructor() {
        super();
        // Injectable collaborators. Logic reads these (falling back to the
        // globals) so tests can pass mocks and apps get the real wiring.
        //   nav  — the Nav module (Back -> nav.goBack()).
        //   hub  — the postMessage target for the lifecycle handshake.
        this.nav = null;
        this.hub = null;

        // action -> button element, populated by render().
        this._buttons = {};

        // Bind once so add/removeEventListener reference the same function.
        this._onClick = this._onClick.bind(this);
        this._onKeydown = this._onKeydown.bind(this);
      }

      static get observedAttributes() {
        return ["buttons"];
      }

      connectedCallback() {
        if (!this.hasAttribute("role")) this.setAttribute("role", "toolbar");
        if (!this.hasAttribute("aria-label")) {
          this.setAttribute("aria-label", "App controls");
        }
        this.render();
        this.addEventListener("click", this._onClick);
        this.addEventListener("keydown", this._onKeydown);
      }

      disconnectedCallback() {
        this.removeEventListener("click", this._onClick);
        this.removeEventListener("keydown", this._onKeydown);
      }

      attributeChangedCallback(name, oldValue, newValue) {
        if (name === "buttons" && oldValue !== newValue && this.isConnected) {
          this.render();
        }
      }

      /**
       * (Re)build the button bar from the `buttons` attribute. Idempotent: each
       * call clears and rebuilds the children so toggling visibility is just a
       * matter of setting the attribute.
       */
      render() {
        var doc = this.ownerDocument || GLOBAL.document;
        if (!doc) return;

        // Clear existing children via the DOM (no innerHTML) so the rebuild is
        // string-injection-free.
        while (this.firstChild) this.removeChild(this.firstChild);
        this._buttons = {};

        var actions = parseButtons(this.getAttribute("buttons"));
        actions.forEach(
          function (action) {
            var spec = CONTROLS.find(function (c) {
              return c.action === action;
            });
            if (!spec) return;

            var btn = doc.createElement("button");
            btn.type = "button";
            btn.className = "benny-hud-button benny-hud-" + spec.action;
            btn.setAttribute("data-action", spec.action);
            btn.setAttribute("role", "button");
            // Buttons are natively focusable; an explicit tabindex keeps the
            // scan/keyboard contract identical to <benny-back>.
            btn.setAttribute("tabindex", "0");

            // Per-action label override: `<benny-hud back-label="Return">`.
            var labelAttr = this.getAttribute(spec.action + "-label");
            var label = labelAttr || spec.label;
            btn.setAttribute("aria-label", label);
            btn.textContent = labelAttr || spec.text;

            this.appendChild(btn);
            this._buttons[spec.action] = btn;
          }.bind(this),
        );
      }

      // ---- Scannability (ScanController integration) ----------------------

      /**
       * The visible controls, in render order, as ScanController scan targets.
       * A host wires `getTargets: () => hud.getTargets()`.
       * @returns {HTMLElement[]}
       */
      getTargets() {
        var out = [];
        parseButtons(this.getAttribute("buttons")).forEach(
          function (action) {
            var btn = this._buttons[action];
            if (btn) out.push(btn);
          }.bind(this),
        );
        return out;
      }

      /**
       * Activate one of the HUD's controls. Accepts either the button element
       * (what a ScanController hands back via onSelect) or the action string.
       * Unknown targets are ignored.
       * @param {HTMLElement|string} target
       * @returns {boolean} true if an action was dispatched.
       */
      activate(target) {
        var action =
          typeof target === "string"
            ? target
            : target && target.getAttribute
              ? target.getAttribute("data-action")
              : null;
        if (!action) return false;
        switch (action) {
          case "back":
            return this._doBack();
          case "pause":
            return this._doPause();
          case "settings":
            return this._doSettings();
          default:
            return false;
        }
      }

      // ---- Event handling -------------------------------------------------

      _onClick(event) {
        var btn = this._closestButton(event.target);
        if (btn) this.activate(btn);
      }

      _onKeydown(event) {
        if (
          event.key === "Enter" ||
          event.key === " " ||
          event.key === "Spacebar"
        ) {
          var btn = this._closestButton(event.target);
          if (btn) {
            event.preventDefault();
            this.activate(btn);
          }
        }
      }

      /**
       * Walk up from an event target to the owning HUD button (so clicks on
       * nested glyphs still resolve), stopping at the HUD element itself.
       * @param {EventTarget} node
       * @returns {HTMLElement|null}
       * @protected
       */
      _closestButton(node) {
        var el = node;
        while (el && el !== this) {
          if (el.getAttribute && el.getAttribute("data-action")) return el;
          el = el.parentNode;
        }
        return null;
      }

      // ---- Actions --------------------------------------------------------

      /** Back -> Nav.goBack() (the shared "return to hub" contract). */
      _doBack() {
        var nav = this.nav || GLOBAL.Nav;
        if (nav && typeof nav.goBack === "function") {
          nav.goBack();
        }
        this._emit("back");
        return true;
      }

      /**
       * Pause -> post the IP-4 `app:requestPause` handshake message to the hub
       * AND dispatch a bubbling `pause` CustomEvent for in-page listeners.
       */
      _doPause() {
        this._postToHub({ type: MSG_PAUSE });
        this._emit("pause");
        return true;
      }

      /**
       * Settings -> post `app:requestSettings` to the hub AND dispatch a
       * bubbling `settings` CustomEvent.
       */
      _doSettings() {
        this._postToHub({ type: MSG_SETTINGS });
        this._emit("settings");
        return true;
      }

      /**
       * Post a message up to the embedding hub. No-op (swallowing errors) when
       * no usable postMessage target exists, so standalone apps still work.
       * @param {object} message
       * @protected
       */
      _postToHub(message) {
        var target = this.hub || GLOBAL.parent || null;
        // Don't post to ourselves when un-framed (parent === window): that would
        // be a no-op message back into the same page. Only post to a real,
        // distinct parent or an injected target.
        if (
          target &&
          target !== GLOBAL &&
          typeof target.postMessage === "function"
        ) {
          try {
            target.postMessage(message, "*");
          } catch (e) {
            /* standalone / cross-origin: ignore */
          }
        }
      }

      /**
       * Dispatch a bubbling, composed CustomEvent named after the action so a
       * host can `hud.addEventListener('pause', ...)`.
       * @param {string} name
       * @protected
       */
      _emit(name) {
        var Ctor =
          (this.ownerDocument && this.ownerDocument.defaultView
            ? this.ownerDocument.defaultView.CustomEvent
            : GLOBAL.CustomEvent) || GLOBAL.CustomEvent;
        if (typeof Ctor !== "function") return;
        this.dispatchEvent(
          new Ctor("benny-hud:" + name, {
            bubbles: true,
            composed: true,
            detail: { action: name },
          }),
        );
        // Also fire the bare action name for convenience.
        this.dispatchEvent(
          new Ctor(name, {
            bubbles: true,
            composed: true,
            detail: { action: name },
          }),
        );
      }
    };
  }

  /**
   * Register the <benny-hud> custom element when the platform supports it.
   * Safe to call repeatedly and in non-DOM/test environments (it no-ops).
   *
   * @returns {boolean} true if the element is defined (now or already), false
   *   if custom elements are unavailable in this environment.
   */
  function defineBennyHud() {
    if (
      typeof customElements === "undefined" ||
      typeof customElements.define !== "function" ||
      !BennyHudElement
    ) {
      return false;
    }
    if (!customElements.get("benny-hud")) {
      customElements.define("benny-hud", BennyHudElement);
    }
    return true;
  }

  // Auto-register on load when running in a real DOM.
  defineBennyHud();

  var BennyHud = {
    defineBennyHud: defineBennyHud,
    BennyHudElement: BennyHudElement,
    parseButtons: parseButtons,
    CONTROLS: CONTROLS,
    MSG_PAUSE: MSG_PAUSE,
    MSG_SETTINGS: MSG_SETTINGS,
  };

  if (typeof window !== "undefined") {
    window.BennyHud = BennyHud;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = BennyHud;
  }
})();
