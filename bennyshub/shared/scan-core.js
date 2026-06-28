/**
 * ScanController — single-switch scanning core for Narbehouse Accessibility Hub.
 *
 * Centralizes the switch-scanning contract that every app reimplemented by hand:
 *   - Space scans forward (short press advances; hold begins reverse scanning).
 *   - Enter (and NumpadEnter) selects (short press selects; hold pauses).
 *   - Optional auto-scan driven by NarbeScanManager settings/cadence.
 *
 * This is a clean-room implementation of the documented single-switch behavior
 * (short-press scan, hold-to-reverse, hold-to-pause, TTS announcements). It does
 * not contain or derive from any GPLv3 source — only behavior, expressed fresh.
 *
 * Loaded as an IIFE-style global via <script src>, matching the other shared
 * modules (NarbeScanManager, NarbeVoiceManager). Apps read window.ScanController.
 * A dual CommonJS export is provided so jsdom tests can require() the class.
 *
 * Design notes:
 *   - scanManager and voice are INJECTABLE fields. Logic never references the
 *     window globals directly — it reads this.scanManager / this.voice — so tests
 *     can pass mocks and apps get the real managers by default.
 *   - All timers go through the global setTimeout/setInterval/clearTimeout/
 *     clearInterval so jest fake timers control them.
 *   - Listeners are attached in the capture phase and are fully removable; there
 *     is no focus trap and no global state left behind after detach()/destroy().
 */

class ScanController {
  constructor(options = {}) {
    const opts = options || {};

    if (typeof opts.getTargets !== "function") {
      throw new Error(
        "ScanController: getTargets is required and must be a function",
      );
    }
    if (typeof opts.onFocus !== "function") {
      throw new Error(
        "ScanController: onFocus is required and must be a function",
      );
    }
    if (typeof opts.onSelect !== "function") {
      throw new Error(
        "ScanController: onSelect is required and must be a function",
      );
    }

    // Required callbacks.
    this.getTargets = opts.getTargets;
    this.onFocus = opts.onFocus;
    this.onSelect = opts.onSelect;

    // Optional callbacks.
    this.onBlur = typeof opts.onBlur === "function" ? opts.onBlur : null;
    this.onAnnounce =
      typeof opts.onAnnounce === "function" ? opts.onAnnounce : null;
    this.onPause = typeof opts.onPause === "function" ? opts.onPause : null;

    // Behavior options.
    this.wrap = opts.wrap !== undefined ? !!opts.wrap : true;
    this.spaceHoldMs = opts.spaceHoldMs !== undefined ? opts.spaceHoldMs : 3000;
    this.reverseCadenceMs =
      opts.reverseCadenceMs !== undefined ? opts.reverseCadenceMs : 2000;
    this.enterHoldMs = opts.enterHoldMs !== undefined ? opts.enterHoldMs : 5000;

    // Injectable collaborators. Read these fields in logic — never the globals.
    this.scanManager =
      opts.scanManager !== undefined
        ? opts.scanManager
        : typeof window !== "undefined"
          ? window.NarbeScanManager
          : undefined;
    this.voice =
      opts.voice !== undefined
        ? opts.voice
        : typeof window !== "undefined"
          ? window.NarbeVoiceManager
          : undefined;

    // Interval resolver — defaults to the scan manager's cadence, falling back to 2000ms.
    this.getInterval =
      typeof opts.getInterval === "function"
        ? opts.getInterval
        : () => this.scanManager?.getScanInterval?.() ?? 2000;

    // Allow option override of autoScan; otherwise derived from scanManager at start().
    this._autoScanOption = opts.autoScan; // boolean | undefined

    // Index state.
    this._index = -1;

    // Attachment state.
    this._attachedEl = null;
    this._boundKeyDown = (e) => this._handleKeyDown(e);
    this._boundKeyUp = (e) => this._handleKeyUp(e);

    // Space (scan) press tracking.
    this._spaceDownTime = 0;
    this._spaceHeld = false;
    this._spaceHoldTimer = null;
    this._reverseInterval = null;
    this._reverseStarted = false;

    // Enter (select) press tracking.
    this._enterDownTime = 0;
    this._enterHeld = false;
    this._enterHoldTimer = null;
    this._pauseTriggered = false;

    // Auto-scan state.
    this._autoScanInterval = null;
    this._boundSettingsChanged = () => this._onSettingsChanged();
    this._subscribed = false;
  }

  // ---- Key predicates (centralized so NumpadEnter is fixed once, everywhere) ----

  isScan(e) {
    return e.code === "Space";
  }

  isSelect(e) {
    return e.code === "Enter" || e.code === "NumpadEnter";
  }

  // ---- Attachment lifecycle ----

  attach(el = document) {
    if (this._attachedEl) {
      this.detach();
    }
    this._attachedEl = el;
    el.addEventListener("keydown", this._boundKeyDown, true);
    el.addEventListener("keyup", this._boundKeyUp, true);
    return this;
  }

  detach() {
    if (!this._attachedEl) return this;
    this._attachedEl.removeEventListener("keydown", this._boundKeyDown, true);
    this._attachedEl.removeEventListener("keyup", this._boundKeyUp, true);
    this._attachedEl = null;
    return this;
  }

  destroy() {
    this.detach();
    this.stop();
    this._clearSpaceTimers();
    this._clearEnterTimers();
    this._spaceHeld = false;
    this._enterHeld = false;
    return this;
  }

  // ---- Internal: any switch currently held? (gate auto-scan) ----

  get _anyKeyHeld() {
    return this._spaceHeld || this._enterHeld;
  }

  // ---- Keyboard handling ----

  _handleKeyDown(e) {
    // Ignore OS auto-repeat: a held switch must not machine-gun advances or
    // restart the hold timers.
    if (e.repeat) return;

    if (this.isScan(e)) {
      e.preventDefault();
      this._spaceHeld = true;
      this._spaceDownTime = Date.now();
      this._reverseStarted = false;
      this._clearSpaceTimers();
      this._spaceHoldTimer = setTimeout(() => {
        // Hold threshold reached: enter reverse mode.
        this._reverseStarted = true;
        this.back();
        this._reverseInterval = setInterval(
          () => this.back(),
          this.reverseCadenceMs,
        );
      }, this.spaceHoldMs);
      return;
    }

    if (this.isSelect(e)) {
      this._enterHeld = true;
      this._enterDownTime = Date.now();
      this._pauseTriggered = false;
      this._clearEnterTimers();
      this._enterHoldTimer = setTimeout(() => {
        this._pauseTriggered = true;
        if (this.onPause) this.onPause();
      }, this.enterHoldMs);
      return;
    }
  }

  _handleKeyUp(e) {
    if (this.isScan(e)) {
      if (!this._spaceHeld) return; // keyup without a tracked keydown
      const duration = Date.now() - this._spaceDownTime;
      const wasReverse = this._reverseStarted;
      this._spaceHeld = false;
      this._clearSpaceTimers();
      // Short press that never tipped into reverse => advance once.
      if (!wasReverse && duration < this.spaceHoldMs) {
        this.advance();
      }
      this._reverseStarted = false;
      return;
    }

    if (this.isSelect(e)) {
      if (!this._enterHeld) return;
      const duration = Date.now() - this._enterDownTime;
      const wasPause = this._pauseTriggered;
      this._enterHeld = false;
      this._clearEnterTimers();
      // Short press that never triggered pause => select.
      if (!wasPause && duration < this.enterHoldMs) {
        this.select();
      }
      this._pauseTriggered = false;
      return;
    }
  }

  _clearSpaceTimers() {
    if (this._spaceHoldTimer !== null) {
      clearTimeout(this._spaceHoldTimer);
      this._spaceHoldTimer = null;
    }
    if (this._reverseInterval !== null) {
      clearInterval(this._reverseInterval);
      this._reverseInterval = null;
    }
  }

  _clearEnterTimers() {
    if (this._enterHoldTimer !== null) {
      clearTimeout(this._enterHoldTimer);
      this._enterHoldTimer = null;
    }
  }

  // ---- Movement ----

  advance() {
    this._move(1);
  }

  back() {
    this._move(-1);
  }

  _move(delta) {
    const targets = this.getTargets() || [];
    const n = targets.length;
    if (n === 0) return; // no-op on empty targets

    let next;
    if (this._index < 0) {
      // First movement lands on the first (forward) or last (backward) target.
      next = delta > 0 ? 0 : n - 1;
    } else {
      next = this._index + delta;
      if (this.wrap) {
        next = ((next % n) + n) % n;
      } else {
        if (next < 0) next = 0;
        if (next > n - 1) next = n - 1;
      }
    }

    this._focusTo(next, targets);
  }

  _focusTo(nextIndex, targets) {
    const list = targets || this.getTargets() || [];
    if (list.length === 0) return;

    // Blur the previously-focused target (if any and still valid).
    if (this.onBlur && this._index >= 0 && this._index < list.length) {
      this.onBlur(list[this._index], this._index);
    }

    this._index = nextIndex;
    const target = list[this._index];

    this.onFocus(target, this._index);
    this._announce(target, this._index);
  }

  _announce(target, index) {
    if (this.onAnnounce) {
      this.onAnnounce(target, index);
      return;
    }
    // Default announcement via injected voice manager.
    if (!this.voice || typeof this.voice.speak !== "function") return;
    const text =
      target?.getAttribute?.("aria-label") ||
      target?.dataset?.label ||
      target?.textContent ||
      "";
    if (text && String(text).trim() !== "") {
      this.voice.speak(String(text));
    }
  }

  select() {
    const target = this.getCurrentTarget();
    this.onSelect(target, this._index);
  }

  // ---- Index helpers ----

  focusIndex(i) {
    const targets = this.getTargets() || [];
    if (targets.length === 0) return;
    let idx = i;
    if (idx < 0) idx = 0;
    if (idx > targets.length - 1) idx = targets.length - 1;
    this._focusTo(idx, targets);
  }

  getIndex() {
    return this._index;
  }

  setIndex(i) {
    this._index = i;
  }

  getCurrentTarget() {
    const targets = this.getTargets() || [];
    if (this._index < 0 || this._index >= targets.length) return undefined;
    return targets[this._index];
  }

  // ---- Auto-scan ----

  start() {
    const autoScan =
      this._autoScanOption !== undefined
        ? !!this._autoScanOption
        : !!this.scanManager?.getSettings?.().autoScan;

    // Always (re)subscribe so cadence/autoScan changes restart the timer.
    if (
      !this._subscribed &&
      typeof this.scanManager?.subscribe === "function"
    ) {
      this.scanManager.subscribe(this._boundSettingsChanged);
      this._subscribed = true;
    }

    this._stopAutoInterval();
    if (autoScan) {
      this._autoScanInterval = setInterval(() => {
        if (!this._anyKeyHeld) this.advance();
      }, this.getInterval());
    }
    return this;
  }

  stop() {
    this._stopAutoInterval();
    if (
      this._subscribed &&
      typeof this.scanManager?.unsubscribe === "function"
    ) {
      this.scanManager.unsubscribe(this._boundSettingsChanged);
    }
    this._subscribed = false;
    return this;
  }

  _stopAutoInterval() {
    if (this._autoScanInterval !== null) {
      clearInterval(this._autoScanInterval);
      this._autoScanInterval = null;
    }
  }

  _onSettingsChanged() {
    // A settings change (cadence or autoScan toggle) restarts the auto-scan timer
    // so the new interval / enabled-state takes effect immediately.
    const autoScan =
      this._autoScanOption !== undefined
        ? !!this._autoScanOption
        : !!this.scanManager?.getSettings?.().autoScan;

    this._stopAutoInterval();
    if (autoScan) {
      this._autoScanInterval = setInterval(() => {
        if (!this._anyKeyHeld) this.advance();
      }, this.getInterval());
    }
  }
}

if (typeof window !== "undefined") {
  window.ScanController = ScanController;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = ScanController;
}
