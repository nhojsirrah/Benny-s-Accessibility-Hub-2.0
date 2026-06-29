/**
 * BennyPauseOverlay — the shared, scannable pause menu for Narbehouse
 * Accessibility Hub games.
 *
 * Today every game hand-rolls its own pause overlay (Resume / Restart /
 * Settings / Exit) with its own markup, CSS, focus handling and switch-scan
 * wiring. IP-7 establishes ONE accessible, scannable overlay that a game
 * configures with its action list, so the bespoke per-app pause menus can be
 * retired in favour of mounting this element. This PR ships only the module +
 * its tests; the per-game adoption sweep is done in parallel by sibling work.
 *
 * Pairs with the shared pieces already merged:
 *   - hud.js (<benny-hud>) emits `app:requestPause`; a game listens for that
 *     intent and calls `overlay.show()` to open this menu.
 *   - scan-core.js (ScanController) — the overlay's action buttons are scan
 *     targets. `getTargets()` returns them in render order while open and
 *     `activate(target)` runs one, so a game points its existing controller at
 *     the overlay for the duration it is open:
 *       `getTargets: () => overlay.isOpen() ? overlay.getTargets() : gameTargets()`
 *       `onSelect:   (t) => overlay.isOpen() ? overlay.activate(t) : selectGame(t)`
 *   - scan-manager.js / voice-manager.js — optional injected collaborators
 *     (`scanManager`, `voice`); when a `voice` is supplied the overlay speaks
 *     "Paused" and the focused action's label, matching the spoken-feedback
 *     convention of the other shared surfaces.
 *
 * Loaded as an IIFE-style global via <script src>, matching the other shared
 * modules (Nav, ScanController, BennyHud, Themes, SettingsStore). Apps read
 * window.BennyPauseOverlay. A dual CommonJS export is provided so jsdom/node
 * tests can require() it.
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

  // The canonical default action list when a game supplies none. Games pass
  // their own (e.g. inserting { id: 'restart', label: 'Restart' }).
  var DEFAULT_ACTIONS = [
    { id: "resume", label: "Resume" },
    { id: "settings", label: "Settings" },
    { id: "exit", label: "Exit" },
  ];

  // Actions that auto-close the overlay after running, unless the handler
  // prevents it (via the cancelable `pause-action` event).
  var AUTO_HIDE = { resume: true, exit: true };

  // Single, idempotently-injected stylesheet id so the overlay works standalone
  // without the host shipping any CSS.
  var STYLE_ID = "benny-pause-overlay-styles";

  var STYLES =
    "benny-pause-overlay{position:fixed;inset:0;z-index:2147483600;" +
    "display:none;align-items:center;justify-content:center;" +
    "background:rgba(0,0,0,0.6);font-family:inherit;}" +
    "benny-pause-overlay.benny-pause-open{display:flex;}" +
    ".benny-pause-panel{background:#fff;color:#111;border-radius:16px;" +
    "padding:24px;min-width:260px;max-width:90vw;box-shadow:0 12px 48px " +
    "rgba(0,0,0,0.45);display:flex;flex-direction:column;gap:12px;}" +
    ".benny-pause-title{margin:0 0 8px;font-size:1.5rem;font-weight:700;" +
    "text-align:center;}" +
    ".benny-pause-action{display:block;width:100%;box-sizing:border-box;" +
    "padding:16px 20px;font-size:1.25rem;font-weight:600;text-align:center;" +
    "border:3px solid transparent;border-radius:12px;background:#1565c0;" +
    "color:#fff;cursor:pointer;}" +
    ".benny-pause-action:focus{outline:none;border-color:#ffeb3b;" +
    "box-shadow:0 0 0 4px rgba(255,235,59,0.6);}";

  /**
   * Normalise a caller-supplied actions array into validated descriptors. Each
   * entry must have an `id`; `label` defaults to the id and `onSelect` is kept
   * if it is a function. Non-array / empty input falls back to the defaults.
   *
   * @param {Array<{id:string,label?:string,onSelect?:Function}>} actions
   * @returns {Array<{id:string,label:string,onSelect:(Function|null)}>}
   */
  function normalizeActions(actions) {
    var source =
      Array.isArray(actions) && actions.length ? actions : DEFAULT_ACTIONS;
    var seen = {};
    var out = [];
    source.forEach(function (a) {
      if (!a || a.id === undefined || a.id === null) return;
      var id = String(a.id);
      if (seen[id]) return;
      seen[id] = true;
      out.push({
        id: id,
        label: a.label !== undefined && a.label !== null ? String(a.label) : id,
        onSelect: typeof a.onSelect === "function" ? a.onSelect : null,
      });
    });
    // If the caller passed an all-invalid array, fall back to defaults so the
    // overlay is never empty.
    return out.length ? out : normalizeActions(DEFAULT_ACTIONS);
  }

  /**
   * Inject the scoped stylesheet once per document. No-op when there is no DOM
   * (pure node) or the style tag already exists.
   * @param {Document} doc
   */
  function ensureStyles(doc) {
    if (!doc || typeof doc.createElement !== "function" || !doc.head) return;
    if (doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLES;
    doc.head.appendChild(style);
  }

  var BennyPauseOverlayElement = null;

  // Guard the class definition: in a pure (non-DOM) node env HTMLElement is
  // undefined and `class extends HTMLElement` would throw at parse/eval time.
  if (typeof HTMLElement !== "undefined") {
    BennyPauseOverlayElement = class BennyPauseOverlay extends HTMLElement {
      constructor() {
        super();

        // Injectable collaborators (optional; logic guards their absence).
        //   scanManager — the shared NarbeScanManager (settings/timing); kept
        //                 for parity so a host can hand it through `create()`.
        //   voice       — NarbeVoiceManager-like { speak(text) } for spoken
        //                 feedback on open and focus moves.
        this.scanManager = null;
        this.voice = null;

        this._actions = normalizeActions(null);
        this._buttons = []; // visible action buttons, in render order
        this._panel = null;
        this._open = false;
        this._rendered = false;
        this._previousFocus = null;

        // Bind once so add/removeEventListener reference the same function.
        this._onClick = this._onClick.bind(this);
        this._onKeydown = this._onKeydown.bind(this);
      }

      connectedCallback() {
        if (!this.hasAttribute("role")) this.setAttribute("role", "dialog");
        if (!this.hasAttribute("aria-modal")) {
          this.setAttribute("aria-modal", "true");
        }
        if (!this.hasAttribute("aria-label")) {
          this.setAttribute("aria-label", "Paused");
        }
        ensureStyles(this.ownerDocument || GLOBAL.document);
        this.render();
        this.addEventListener("click", this._onClick);
        this.addEventListener("keydown", this._onKeydown);
      }

      disconnectedCallback() {
        this.removeEventListener("click", this._onClick);
        this.removeEventListener("keydown", this._onKeydown);
      }

      // ---- Rendering ------------------------------------------------------

      /**
       * (Re)build the panel and action buttons from `this._actions`. Idempotent:
       * each call clears and rebuilds children. String-injection free (no
       * innerHTML).
       */
      render() {
        var doc = this.ownerDocument || GLOBAL.document;
        if (!doc || typeof doc.createElement !== "function") return;

        ensureStyles(doc);

        while (this.firstChild) this.removeChild(this.firstChild);
        this._buttons = [];

        var panel = doc.createElement("div");
        panel.className = "benny-pause-panel";
        panel.setAttribute("role", "document");

        var title = doc.createElement("h2");
        title.className = "benny-pause-title";
        title.textContent = "Paused";
        panel.appendChild(title);
        if (!this.getAttribute("aria-labelledby")) {
          if (!title.id) title.id = "benny-pause-title";
          this.setAttribute("aria-labelledby", title.id);
        }

        this._actions.forEach(
          function (action) {
            var btn = doc.createElement("button");
            btn.type = "button";
            btn.className = "benny-pause-action benny-pause-" + action.id;
            btn.setAttribute("data-action-id", action.id);
            // Native <button> is focusable; explicit role+tabindex keeps the
            // scan/keyboard contract identical to the other shared surfaces.
            btn.setAttribute("role", "button");
            btn.setAttribute("tabindex", "0");
            btn.setAttribute("aria-label", action.label);
            btn.textContent = action.label;
            panel.appendChild(btn);
            this._buttons.push(btn);
          }.bind(this),
        );

        this.appendChild(panel);
        this._panel = panel;
        this._rendered = true;
      }

      // ---- Open / close ---------------------------------------------------

      /**
       * Render (if needed), open the overlay, and focus the first action.
       * Records the previously-focused element so it can be restored on hide().
       */
      show() {
        if (this._open) return;
        if (!this._rendered) this.render();

        var doc = this.ownerDocument || GLOBAL.document;
        this._previousFocus =
          doc && doc.activeElement ? doc.activeElement : null;

        this.classList.add("benny-pause-open");
        this.removeAttribute("hidden");
        this.setAttribute("aria-hidden", "false");
        this._open = true;

        this._announce("Paused");
        this._focusIndex(0, false);
      }

      /** Close the overlay and restore focus to the pre-open element. */
      hide() {
        if (!this._open) return;
        this.classList.remove("benny-pause-open");
        this.setAttribute("hidden", "");
        this.setAttribute("aria-hidden", "true");
        this._open = false;

        var prev = this._previousFocus;
        this._previousFocus = null;
        if (prev && typeof prev.focus === "function") {
          try {
            prev.focus();
          } catch (e) {
            /* element gone / not focusable: ignore */
          }
        }
      }

      /** @returns {boolean} whether the overlay is currently open. */
      isOpen() {
        return this._open;
      }

      /**
       * Replace the action list and re-render. When open, focus moves back to
       * the first action so a scan pass starts cleanly.
       * @param {Array<{id:string,label?:string,onSelect?:Function}>} actions
       */
      setActions(actions) {
        this._actions = normalizeActions(actions);
        if (this._rendered) this.render();
        if (this._open) this._focusIndex(0, false);
      }

      // ---- Scannability (ScanController integration) ----------------------

      /**
       * The visible action buttons, in render order, as ScanController targets.
       * Returns an empty list while closed so a host can safely union it with
       * its own targets.
       * @returns {HTMLElement[]}
       */
      getTargets() {
        return this._open ? this._buttons.slice() : [];
      }

      /**
       * Run an action. Accepts the button element (what a ScanController hands
       * back via onSelect) or the action id string. Dispatches a cancelable
       * `pause-action` CustomEvent and calls the action's onSelect; resume/exit
       * then auto-hide unless either prevented the default.
       * @param {HTMLElement|string} target
       * @returns {boolean} true if an action was dispatched.
       */
      activate(target) {
        var action = this._resolveAction(target);
        if (!action) return false;

        var Ctor = this._eventCtor();
        var event = Ctor
          ? new Ctor("pause-action", {
              bubbles: true,
              composed: true,
              cancelable: true,
              detail: { id: action.id },
            })
          : null;

        if (action.onSelect) {
          try {
            action.onSelect(event);
          } catch (e) {
            /* host handler threw: don't let it break the overlay */
          }
        }
        if (event) this.dispatchEvent(event);

        var prevented = event ? event.defaultPrevented : false;
        if (AUTO_HIDE[action.id] && !prevented) this.hide();
        return true;
      }

      // ---- Event handling -------------------------------------------------

      _onClick(event) {
        var btn = this._closestButton(event.target);
        if (btn) this.activate(btn);
      }

      _onKeydown(event) {
        var key = event.key;
        if (key === "Enter" || key === " " || key === "Spacebar") {
          var btn = this._closestButton(event.target);
          if (btn) {
            event.preventDefault();
            this.activate(btn);
          }
          return;
        }
        if (key === "Escape" || key === "Esc") {
          // Standard dialog dismissal: run resume if present, else just close.
          event.preventDefault();
          if (this._findAction("resume")) this.activate("resume");
          else this.hide();
          return;
        }
        if (key === "Tab") {
          // Trap focus within the action buttons while open.
          if (!this._open || !this._buttons.length) return;
          event.preventDefault();
          var current = this._buttons.indexOf(
            this.ownerDocument ? this.ownerDocument.activeElement : null,
          );
          var delta = event.shiftKey ? -1 : 1;
          var next =
            (current + delta + this._buttons.length) % this._buttons.length;
          this._focusIndex(next, true);
        }
      }

      /**
       * Walk up from an event target to the owning action button (so clicks on
       * nested glyphs still resolve), stopping at the overlay element.
       * @param {EventTarget} node
       * @returns {HTMLElement|null}
       * @protected
       */
      _closestButton(node) {
        var el = node;
        while (el && el !== this) {
          if (el.getAttribute && el.getAttribute("data-action-id")) return el;
          el = el.parentNode;
        }
        return null;
      }

      // ---- Helpers --------------------------------------------------------

      /** @protected */
      _resolveAction(target) {
        var id =
          typeof target === "string"
            ? target
            : target && target.getAttribute
              ? target.getAttribute("data-action-id")
              : null;
        return id ? this._findAction(id) : null;
      }

      /** @protected */
      _findAction(id) {
        for (var i = 0; i < this._actions.length; i++) {
          if (this._actions[i].id === id) return this._actions[i];
        }
        return null;
      }

      /**
       * Focus the button at `index` and (optionally) speak its label.
       * @protected
       */
      _focusIndex(index, announce) {
        var btn = this._buttons[index];
        if (!btn) return;
        if (typeof btn.focus === "function") {
          try {
            btn.focus();
          } catch (e) {
            /* ignore */
          }
        }
        if (announce) this._announce(btn.getAttribute("aria-label") || "");
      }

      /**
       * Speak via the injected voice manager when present. Always a no-op-safe
       * convenience so standalone (no-voice) games still work.
       * @protected
       */
      _announce(text) {
        var voice = this.voice || GLOBAL.NarbeVoiceManager;
        if (voice && typeof voice.speak === "function" && text) {
          try {
            voice.speak(text);
          } catch (e) {
            /* speech unavailable: ignore */
          }
        }
      }

      /** @protected */
      _eventCtor() {
        return (
          (this.ownerDocument && this.ownerDocument.defaultView
            ? this.ownerDocument.defaultView.CustomEvent
            : GLOBAL.CustomEvent) || GLOBAL.CustomEvent
        );
      }
    };
  }

  /**
   * Register the <benny-pause-overlay> custom element when the platform
   * supports it. Safe to call repeatedly and in non-DOM/test environments.
   *
   * @returns {boolean} true if the element is defined (now or already), false
   *   if custom elements are unavailable in this environment.
   */
  function definePauseOverlay() {
    if (
      typeof customElements === "undefined" ||
      typeof customElements.define !== "function" ||
      !BennyPauseOverlayElement
    ) {
      return false;
    }
    if (!customElements.get("benny-pause-overlay")) {
      customElements.define("benny-pause-overlay", BennyPauseOverlayElement);
    }
    return true;
  }

  // Auto-register on load when running in a real DOM.
  definePauseOverlay();

  /**
   * Convenience factory: create, configure and mount a <benny-pause-overlay>.
   *
   * @param {object} [opts]
   * @param {Array<{id:string,label?:string,onSelect?:Function}>} [opts.actions]
   *   Action list; defaults to Resume / Settings / Exit.
   * @param {object} [opts.scanManager] Optional shared scan manager.
   * @param {object} [opts.voice] Optional voice manager ({ speak(text) }).
   * @param {HTMLElement} [opts.host] Where to mount; defaults to document.body.
   * @param {Document} [opts.document] Document to use; defaults to the global.
   * @returns {BennyPauseOverlayElement}
   */
  function create(opts) {
    opts = opts || {};
    var doc = opts.document || GLOBAL.document;

    var el;
    if (
      doc &&
      typeof doc.createElement === "function" &&
      definePauseOverlay()
    ) {
      el = doc.createElement("benny-pause-overlay");
    } else if (BennyPauseOverlayElement) {
      el = new BennyPauseOverlayElement();
    } else {
      throw new Error(
        "BennyPauseOverlay.create requires a DOM environment with custom elements",
      );
    }

    el.scanManager = opts.scanManager || null;
    el.voice = opts.voice || null;
    if (opts.actions) el.setActions(opts.actions);

    var host = opts.host || (doc && doc.body) || null;
    if (
      host &&
      typeof host.appendChild === "function" &&
      el.parentNode !== host
    ) {
      host.appendChild(el);
    }
    return el;
  }

  var BennyPauseOverlay = {
    create: create,
    definePauseOverlay: definePauseOverlay,
    BennyPauseOverlayElement: BennyPauseOverlayElement,
    normalizeActions: normalizeActions,
    DEFAULT_ACTIONS: DEFAULT_ACTIONS,
  };

  if (typeof window !== "undefined") {
    window.BennyPauseOverlay = BennyPauseOverlay;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = BennyPauseOverlay;
  }
})();
