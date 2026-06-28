/**
 * Nav — canonical "go back" navigation for the Narbehouse Accessibility Hub apps.
 *
 * Every app in this hub runs as an <iframe> inside bennyshub/index.html. The
 * established convention for "leave this app / return to the hub" is for the app
 * to postMessage its parent:
 *
 *     window.parent.postMessage({ action: 'closeApp' }, '*');
 *
 * The hub listens for `event.data.action === 'closeApp'` (and the older
 * `'focusBackButton'` alias) and tears down the active iframe (see
 * bennyshub/index.html → `closeIframe()`). This module centralizes that
 * convention so the ~21 apps that currently hand-roll the postMessage can adopt
 * a single, tested entry point in a later sweep. This PR only establishes the
 * module + the <benny-back> element; the app adoption is deferred.
 *
 * Loaded as an IIFE-style global via <script src>, matching the other shared
 * modules (NarbeScanManager, NarbeVoiceManager, Themes, SettingsStore). Apps
 * read window.Nav. A dual CommonJS export is provided so jsdom/node tests can
 * require() it.
 */

(function () {
  "use strict";

  /**
   * Are we running inside a (hub) iframe?
   *
   * Cross-origin parents throw on the `window.parent !== window` comparison in
   * some engines; if access throws we are definitionally framed, so treat the
   * throw as "in an iframe".
   *
   * @returns {boolean}
   */
  function isInIframe() {
    if (typeof window === "undefined") return false;
    try {
      return !!window.parent && window.parent !== window;
    } catch (e) {
      return true;
    }
  }

  /**
   * Go back / leave the current app, honoring the hub iframe contract.
   *
   * Resolution order:
   *   1. Inside the hub iframe  → postMessage `{ action: 'closeApp' }` to the
   *      parent (the exact message the ~21 apps already send; the hub closes the
   *      iframe in response).
   *   2. Standalone Electron window (electronAPI present, not framed) → ask the
   *      bridge to close the window.
   *   3. Plain browser standalone → history.back().
   *
   * @returns {boolean} true if a back action was dispatched, false otherwise.
   */
  function goBack() {
    if (typeof window === "undefined") return false;

    // 1. Hub iframe contract — mirror the existing app convention exactly.
    if (isInIframe()) {
      window.parent.postMessage({ action: "closeApp" }, "*");
      return true;
    }

    // 2. Standalone Electron window — use the bridge's window close if present.
    var api = window.electronAPI;
    if (api && api.window && typeof api.window.close === "function") {
      api.window.close();
      return true;
    }

    // 3. Plain browser fallback.
    if (window.history && typeof window.history.back === "function") {
      window.history.back();
      return true;
    }

    return false;
  }

  // --- <benny-back> custom element -----------------------------------------
  //
  // A scannable, switch-accessible back button. It is exposed as role="button"
  // with tabindex="0" so the hub's scanning system and ordinary keyboard/AT
  // users can reach and activate it. Enter and Space (the native button
  // activation keys) call goBack(), as does a click/tap.

  var BennyBackElement = null;

  // Guard the class definition itself: in a pure (non-DOM) node env HTMLElement
  // is undefined and `class extends HTMLElement` would throw at parse/eval time.
  if (typeof HTMLElement !== "undefined") {
    BennyBackElement = class BennyBack extends HTMLElement {
      constructor() {
        super();
        // Bind once so add/removeEventListener reference the same function.
        this._onActivate = this._onActivate.bind(this);
        this._onKeydown = this._onKeydown.bind(this);
      }

      connectedCallback() {
        if (!this.hasAttribute("role")) this.setAttribute("role", "button");
        if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "0");

        var label = this.getAttribute("label") || "Back";
        if (!this.hasAttribute("aria-label")) {
          this.setAttribute("aria-label", label);
        }
        // Provide visible text if the author left the element empty.
        if (!this.textContent || !this.textContent.trim()) {
          this.textContent = label;
        }

        this.addEventListener("click", this._onActivate);
        this.addEventListener("keydown", this._onKeydown);
      }

      disconnectedCallback() {
        this.removeEventListener("click", this._onActivate);
        this.removeEventListener("keydown", this._onKeydown);
      }

      _onActivate() {
        goBack();
      }

      _onKeydown(event) {
        // Native button activation keys: Enter and Space.
        if (
          event.key === "Enter" ||
          event.key === " " ||
          event.key === "Spacebar"
        ) {
          event.preventDefault();
          goBack();
        }
      }
    };
  }

  /**
   * Register the <benny-back> custom element when the platform supports it.
   * Safe to call repeatedly and in non-DOM/test environments (it no-ops).
   *
   * @returns {boolean} true if the element is defined (now or already), false
   *   if custom elements are unavailable in this environment.
   */
  function defineBennyBack() {
    if (
      typeof customElements === "undefined" ||
      typeof customElements.define !== "function" ||
      !BennyBackElement
    ) {
      return false;
    }
    if (!customElements.get("benny-back")) {
      customElements.define("benny-back", BennyBackElement);
    }
    return true;
  }

  // Auto-register on load when running in a real DOM.
  defineBennyBack();

  var Nav = {
    goBack: goBack,
    isInIframe: isInIframe,
    defineBennyBack: defineBennyBack,
    BennyBackElement: BennyBackElement,
  };

  if (typeof window !== "undefined") {
    window.Nav = Nav;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Nav;
  }
})();
