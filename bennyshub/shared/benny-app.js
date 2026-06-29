/**
 * BennyApp / BennyGame base classes for the Narbehouse Accessibility Hub.
 *
 * These are lightweight, framework-free base classes that compose the shared
 * ScanController (switch-access scanning) with the shared scan and voice
 * managers. An app subclasses BennyApp; a switch-accessible game subclasses
 * BennyGame, which adds a standard pause/back overlay.
 *
 * Loaded as an IIFE global via <script src> (no bundler, no ES modules), and
 * also exported via CommonJS so it can be exercised under jest + jsdom.
 */
(function () {
  "use strict";

  // Resolve a global object that works in the browser, in jsdom, and in plain
  // Node without throwing a ReferenceError when `window` is absent.
  const GLOBAL =
    typeof window !== "undefined"
      ? window
      : typeof globalThis !== "undefined"
        ? globalThis
        : {};

  /**
   * Base class for every switch-accessible app in the hub.
   *
   * Lifecycle: `init()` (optional setup) -> `mount(rootEl)` (wire up scanning)
   * -> `teardown()` (release scanning). Subclasses customise behaviour through
   * the overridable hooks documented below rather than touching the
   * ScanController directly.
   */
  class BennyApp {
    /**
     * @param {object} [options]
     * @param {object} [options.scanManager]    Defaults to window.NarbeScanManager.
     * @param {object} [options.voice]          Defaults to window.NarbeVoiceManager.
     * @param {Function} [options.ScanController] Defaults to window.ScanController.
     * @param {object} [options.settings]       App-specific settings bag.
     * @param {object} [options.theme]          Optional theme object.
     */
    constructor(options = {}) {
      this.scanManager = options.scanManager ?? GLOBAL.NarbeScanManager;
      this.voice = options.voice ?? GLOBAL.NarbeVoiceManager;
      this.ScanControllerClass =
        options.ScanController ?? GLOBAL.ScanController;
      this.settings = options.settings ?? {};
      this.theme = options.theme ?? null;
      this.electron = options.electron ?? null;
      this.root = null;
      this.scan = null;
      // Whether scanning wraps from the last target back to the first.
      this.wrap = true;

      // Lifecycle handshake plumbing. `hub` is the postMessage target the app
      // talks back to (the embedding hub window); injectable for tests. We
      // listen for the hub's `app:init` on our own window via a bound handler so
      // teardown() can remove exactly that listener.
      this.hub = options.hub ?? GLOBAL.parent ?? GLOBAL;
      this._onHubMessage = this._handleHubMessage.bind(this);
    }

    /**
     * Optional one-time setup hook. Call before mount(). Default is a no-op.
     * Overridable.
     */
    init() {}

    /**
     * Wire the app into the DOM and start switch-access scanning.
     * @param {HTMLElement} [rootEl=document.body]
     * @returns {this}
     */
    mount(rootEl = document.body) {
      this.root = rootEl;
      this.scan = new this.ScanControllerClass(this._scanOptions());
      this.scan.attach(document);
      this._listenForHub();
      this.onMount();
      // Tell the embedding hub the app has finished mounting. Additive: a hub
      // that doesn't speak the handshake simply ignores the message.
      this.emitReady();
      return this;
    }

    /**
     * Tear down scanning and release resources.
     */
    teardown() {
      this._stopListeningForHub();
      this.scan?.destroy?.();
      this.onTeardown();
      this.scan = null;
    }

    // --- Lifecycle handshake (hub <-> app) --------------------------------

    /**
     * Post a message up to the embedding hub. No-op (swallowing errors) when no
     * usable postMessage target is available, so standalone apps still work.
     * @param {object} message
     * @protected
     */
    _postToHub(message) {
      const target = this.hub;
      if (target && typeof target.postMessage === "function") {
        try {
          target.postMessage(message, "*");
        } catch (e) {
          /* standalone / cross-origin: ignore */
        }
      }
    }

    /** Announce to the hub that the app has mounted and is ready. */
    emitReady() {
      this._postToHub({ type: "app:ready" });
    }

    /**
     * Ask the hub to display a title for the running app.
     * @param {string} title
     */
    emitTitle(title) {
      this._postToHub({ type: "app:title", title: String(title ?? "") });
    }

    /**
     * Ask the hub to close this app and return to the menu. Mirrors the legacy
     * `{ action: 'closeApp' }` path but uses the namespaced handshake message.
     */
    requestBack() {
      this._postToHub({ type: "app:requestBack" });
    }

    /** Ask the hub to pause/suspend the running app. */
    requestPause() {
      this._postToHub({ type: "app:requestPause" });
    }

    /**
     * Begin listening for hub -> app messages (currently `app:init`).
     * @protected
     */
    _listenForHub() {
      if (typeof GLOBAL.addEventListener === "function") {
        GLOBAL.addEventListener("message", this._onHubMessage);
      }
    }

    /** @protected */
    _stopListeningForHub() {
      if (typeof GLOBAL.removeEventListener === "function") {
        GLOBAL.removeEventListener("message", this._onHubMessage);
      }
    }

    /**
     * Handle a hub -> app message. Applies `app:init` (settings / theme /
     * electron flag) and forwards to the overridable onInit() hook. Other
     * message shapes are ignored so this coexists with the existing voice/scan
     * settings messages.
     * @param {MessageEvent} event
     * @protected
     */
    _handleHubMessage(event) {
      const data = event && event.data;
      if (!data || data.type !== "app:init") return;

      if (data.settings && typeof data.settings === "object") {
        this.settings = Object.assign({}, this.settings, data.settings);
      }
      if (Object.prototype.hasOwnProperty.call(data, "theme")) {
        this.theme = data.theme;
      }
      if (Object.prototype.hasOwnProperty.call(data, "electron")) {
        this.electron = data.electron;
      }
      this.onInit(data);
    }

    /**
     * Called after an `app:init` payload has been applied. Overridable; default
     * no-op. Subclasses use this to react to settings/theme handed down by the
     * hub.
     * @param {object} _payload
     */
    onInit(_payload) {}

    /**
     * Speak text through the injected voice manager (if available).
     * @param {string} text
     * @param {object} [opts]
     */
    speak(text, opts) {
      return this.voice?.speak?.(text, opts);
    }

    /**
     * Build the options object handed to the ScanController. Each callback
     * forwards to an overridable hook so subclasses never have to touch the
     * controller wiring.
     * @returns {object}
     * @protected
     */
    _scanOptions() {
      return {
        getTargets: () => this.getScanTargets(),
        onFocus: (t, i) => this.onFocus(t, i),
        onSelect: (t, i) => this.onSelect(t, i),
        onAnnounce: (t, i) => this.onAnnounce(t, i),
        onPause: () => this.onPause(),
        wrap: this.wrap,
      };
    }

    // --- Overridable hooks (sane defaults) -------------------------------

    /** Called at the end of mount(). Overridable. */
    onMount() {}

    /** Called during teardown(). Overridable. */
    onTeardown() {}

    /**
     * Return the ordered list of elements the scanner steps through.
     * Overridable. Default is an empty list.
     * @returns {HTMLElement[]}
     */
    getScanTargets() {
      return [];
    }

    /**
     * Default focus highlight: toggle a `scan-focus` class onto the focused
     * element and remove it from every previously-focused element. Overridable.
     * @param {HTMLElement} t
     */
    onFocus(t) {
      if (!t || !t.classList) return;
      const doc =
        t.ownerDocument || (typeof document !== "undefined" ? document : null);
      if (doc) {
        doc
          .querySelectorAll(".scan-focus")
          .forEach((el) => el.classList.remove("scan-focus"));
      }
      t.classList.add("scan-focus");
    }

    /**
     * Default announcement: speak the focused element's label. Overridable.
     * @param {HTMLElement} t
     */
    onAnnounce(t) {
      const label = this._labelFor(t);
      if (label) this.speak(label);
    }

    /** Called when the scanner selects a target. Overridable. Default no-op. */
    onSelect() {}

    /** Called when the scanner pauses. Overridable. Default no-op. */
    onPause() {}

    /**
     * Resolve a human-readable label for an element.
     * @param {HTMLElement} t
     * @returns {string}
     * @protected
     */
    _labelFor(t) {
      if (!t) return "";
      const aria = t.getAttribute?.("aria-label");
      if (aria) return aria;
      const data = t.getAttribute?.("data-label");
      if (data) return data;
      return (t.textContent || "").trim();
    }
  }

  /**
   * Base class for switch-accessible games. Adds a standard pause/back overlay:
   * when paused, the overlay's Continue / Back buttons become the scan targets,
   * Continue resumes play, and Back invokes onBack().
   *
   * The game contract — getScanTargets() and onSelect() — is abstract: a
   * concrete game MUST override both. While paused the base class takes over
   * scanning and selection so the overlay works without subclass cooperation.
   */
  class BennyGame extends BennyApp {
    constructor(options = {}) {
      super(options);
      this.paused = false;
      this.overlay = null;
      this._continueBtn = null;
      this._backBtn = null;
    }

    /**
     * While paused, route the scanner at the overlay buttons and handle their
     * selection internally; otherwise defer to the (abstract) game hooks.
     * @returns {object}
     * @protected
     * @override
     */
    _scanOptions() {
      return {
        getTargets: () =>
          this.paused ? this._overlayTargets() : this.getScanTargets(),
        onFocus: (t, i) => this.onFocus(t, i),
        onSelect: (t, i) =>
          this.paused ? this._overlaySelect(t, i) : this.onSelect(t, i),
        onAnnounce: (t, i) => this.onAnnounce(t, i),
        onPause: () => this.onPause(),
        wrap: this.wrap,
      };
    }

    /**
     * Abstract: a concrete game must return its scan targets.
     * @returns {HTMLElement[]}
     * @override
     */
    getScanTargets() {
      throw new Error(
        "BennyGame.getScanTargets() is abstract — override it in your game subclass.",
      );
    }

    /**
     * Abstract: a concrete game must handle target selection.
     * @override
     */
    onSelect() {
      throw new Error(
        "BennyGame.onSelect() is abstract — override it in your game subclass.",
      );
    }

    /**
     * Show the pause overlay and switch scanning to its buttons. Overridable,
     * but most games can rely on the default.
     * @override
     */
    onPause() {
      this._ensureOverlay();
      this.paused = true;
      this.overlay.style.display = "flex";
      // Re-seat the scanner at the first overlay button if the controller
      // supports it. Guarded for injected stubs that may not implement it.
      this.scan?.focusIndex?.(0);
    }

    /** Overridable hook fired when the player chooses Back. Default no-op. */
    onBack() {}

    /**
     * Create the pause overlay (idempotent) and cache its buttons.
     * @returns {HTMLElement}
     * @protected
     */
    _ensureOverlay() {
      const doc =
        (this.root && this.root.ownerDocument) ||
        (typeof document !== "undefined" ? document : null);
      if (!doc)
        throw new Error(
          "BennyGame: no document available to build the pause overlay.",
        );

      let overlay = doc.getElementById("benny-pause-overlay");
      if (!overlay) {
        overlay = doc.createElement("div");
        overlay.id = "benny-pause-overlay";
        overlay.style.display = "none";

        const cont = doc.createElement("button");
        cont.type = "button";
        cont.className = "benny-pause-continue";
        cont.setAttribute("data-action", "continue");
        cont.textContent = "Continue";

        const back = doc.createElement("button");
        back.type = "button";
        back.className = "benny-pause-back";
        back.setAttribute("data-action", "back");
        back.textContent = "Back";

        overlay.appendChild(cont);
        overlay.appendChild(back);
        (this.root || doc.body).appendChild(overlay);
      }

      this.overlay = overlay;
      this._continueBtn = overlay.querySelector('[data-action="continue"]');
      this._backBtn = overlay.querySelector('[data-action="back"]');
      return overlay;
    }

    /**
     * Scan targets while paused: the overlay buttons.
     * @returns {HTMLElement[]}
     * @protected
     */
    _overlayTargets() {
      this._ensureOverlay();
      return [this._continueBtn, this._backBtn].filter(Boolean);
    }

    /**
     * Handle selection of an overlay button while paused.
     * @param {HTMLElement} t
     * @protected
     */
    _overlaySelect(t) {
      const action = t?.getAttribute?.("data-action");
      if (t === this._continueBtn || action === "continue") {
        this._resume();
      } else if (t === this._backBtn || action === "back") {
        this.onBack();
      }
    }

    /**
     * Hide the overlay and return to normal game scanning.
     * @protected
     */
    _resume() {
      this.paused = false;
      if (this.overlay) this.overlay.style.display = "none";
      this.scan?.focusIndex?.(0);
    }
  }

  // --- Dual export: IIFE globals + CommonJS ------------------------------
  if (typeof window !== "undefined") {
    window.BennyApp = BennyApp;
    window.BennyGame = BennyGame;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { BennyApp, BennyGame };
  }
})();
