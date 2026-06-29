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
 * Two-level (nested) scanning:
 *   - The default is single-axis: pass getTargets and one flat list is scanned.
 *   - Optionally, pass getGroups + getItems(group) to scan TWO levels (e.g. the
 *     keyboard's rows -> buttons-in-row). Space scans the current level; a short
 *     Enter at the group level DESCENDS into the focused group (its items become
 *     the scan targets); a short Enter at the item level SELECTS, calling
 *     onSelect(item, { group, itemIndex }). ascend() returns to the group level
 *     (descend() is also exposed). onFocus / onAnnounce fire at BOTH levels. When
 *     getGroups is not provided the controller behaves exactly as the single-axis
 *     version — the default is fully backward-compatible.
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

    // Nested (two-level) mode is enabled by providing getGroups. In that mode
    // getItems(group) is also required and getTargets is not used (the active
    // targets are derived per level). Single-axis mode is unchanged: getTargets
    // is required.
    const nested = typeof opts.getGroups === "function";
    if (nested) {
      if (typeof opts.getItems !== "function") {
        throw new Error(
          "ScanController: getItems is required (and must be a function) when getGroups is provided",
        );
      }
    } else if (typeof opts.getTargets !== "function") {
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

    // Nested-mode collaborators (null in single-axis mode).
    this.nested = nested;
    this.getGroups = nested ? opts.getGroups : null;
    this.getItems = nested ? opts.getItems : null;

    // Optional callbacks.
    this.onBlur = typeof opts.onBlur === "function" ? opts.onBlur : null;
    this.onAnnounce =
      typeof opts.onAnnounce === "function" ? opts.onAnnounce : null;
    this.onPause = typeof opts.onPause === "function" ? opts.onPause : null;

    // Optional repeat for the Enter-hold pause: when set (a number) AND onPause
    // is provided, onPause fires once at the hold threshold and then repeats
    // every onPauseRepeatMs while Enter stays held. Undefined => fire once only.
    this.onPauseRepeatMs =
      typeof opts.onPauseRepeatMs === "number"
        ? opts.onPauseRepeatMs
        : undefined;

    // Behavior options.
    this.wrap = opts.wrap !== undefined ? !!opts.wrap : true;
    this.spaceHoldMs = opts.spaceHoldMs !== undefined ? opts.spaceHoldMs : 3000;
    this.reverseCadenceMs =
      opts.reverseCadenceMs !== undefined ? opts.reverseCadenceMs : 2000;
    this.enterHoldMs = opts.enterHoldMs !== undefined ? opts.enterHoldMs : 5000;

    // Optional debounce floors (ms): a Space/Enter tap SHORTER than this is
    // ignored. For switch/AAC users this rejects accidental brief presses
    // (tremor, spasticity). Default 0 = off => no behavior change for adopters
    // that don't set it. minPressMs gates the Space short-press advance;
    // minSelectMs gates the Enter short-press select.
    this.minPressMs = opts.minPressMs !== undefined ? opts.minPressMs : 0;
    this.minSelectMs = opts.minSelectMs !== undefined ? opts.minSelectMs : 0;

    // Optional anti-tremor rate limit (ms): ignore an accepted advance/select that
    // lands LESS than this after the previous one. Unlike minPressMs (a per-press
    // hold floor), this debounces by interval BETWEEN inputs. Default 0 = off.
    this.minIntervalMs =
      opts.minIntervalMs !== undefined ? opts.minIntervalMs : 0;
    this._lastActionMs = -Infinity;

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

    // Index state. In nested mode, _index always tracks the ACTIVE level's
    // cursor (group level or item level) so all movement code is shared.
    this._index = -1;

    // Nested-level state. _level is "group" or "item"; _groupIndex remembers the
    // selected group so ascend() can restore the group cursor; _currentGroup is
    // the group whose items are currently being scanned.
    this._level = "group";
    this._groupIndex = -1;
    this._currentGroup = undefined;

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
    this._pauseRepeatInterval = null;

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
    // Stop any in-flight pause repeat so a detach mid-hold leaves no timer.
    this._clearPauseRepeat();
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
        if (this.onPause) {
          this.onPause();
          // Optional repeat: keep firing onPause while Enter stays held.
          if (this.onPauseRepeatMs !== undefined) {
            this._pauseRepeatInterval = setInterval(
              () => this.onPause(),
              this.onPauseRepeatMs,
            );
          }
        }
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
      // Short press that never tipped into reverse => advance once, unless it
      // was shorter than the debounce floor (an accidental brief tap).
      if (
        !wasReverse &&
        duration >= this.minPressMs &&
        duration < this.spaceHoldMs &&
        this._rateOk()
      ) {
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
      // Short press that never triggered pause => select, unless it was shorter
      // than the debounce floor (an accidental brief tap).
      if (
        !wasPause &&
        duration >= this.minSelectMs &&
        duration < this.enterHoldMs &&
        this._rateOk()
      ) {
        this.select();
      }
      this._pauseTriggered = false;
      return;
    }
  }

  // Anti-tremor rate limit: true (and records the timestamp) when at least
  // minIntervalMs has elapsed since the last accepted action. With the default
  // minIntervalMs of 0 this is always true, so it's a no-op unless configured.
  _rateOk() {
    const now = Date.now();
    if (now - this._lastActionMs < this.minIntervalMs) return false;
    this._lastActionMs = now;
    return true;
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
    this._clearPauseRepeat();
  }

  _clearPauseRepeat() {
    if (this._pauseRepeatInterval !== null) {
      clearInterval(this._pauseRepeatInterval);
      this._pauseRepeatInterval = null;
    }
  }

  // ---- Active targets (level-aware) ----

  // Resolves the list that the cursor is currently scanning. Single-axis mode
  // returns getTargets(); nested mode returns the groups at the group level and
  // the current group's items at the item level. Everything downstream (_move,
  // _focusTo, focusIndex, getCurrentTarget) reads through here so the movement,
  // wrap, focus and announce logic is shared across both levels.
  _activeTargets() {
    if (!this.nested) return this.getTargets() || [];
    if (this._level === "item") {
      if (this._currentGroup === undefined) return [];
      return this.getItems(this._currentGroup) || [];
    }
    return this.getGroups() || [];
  }

  // ---- Nested level navigation ----

  getLevel() {
    return this._level;
  }

  getCurrentGroup() {
    return this._currentGroup;
  }

  getGroupIndex() {
    return this._groupIndex;
  }

  // Descend into the currently-focused group: its items become the scan targets.
  // No-op outside nested mode, already at the item level, or with no group
  // focused. Leaves the item cursor at -1 so the next scan lands on the first
  // item (matching the keyboard's row -> drill-in -> scan flow).
  descend() {
    if (!this.nested || this._level !== "group") return this;
    const groups = this.getGroups() || [];
    if (this._index < 0 || this._index >= groups.length) return this;
    this._groupIndex = this._index;
    this._currentGroup = groups[this._index];
    this._level = "item";
    this._index = -1;
    return this;
  }

  // Return to the group level, restoring the previously-focused group cursor.
  // No-op outside nested mode or when already at the group level.
  ascend() {
    if (!this.nested || this._level !== "item") return this;
    this._level = "group";
    this._currentGroup = undefined;
    this._index = this._groupIndex;
    return this;
  }

  // ---- Movement ----

  advance() {
    this._move(1);
  }

  back() {
    this._move(-1);
  }

  _move(delta) {
    const targets = this._activeTargets();
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
    const list = targets || this._activeTargets();
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
    // Single-axis: select the focused target.
    if (!this.nested) {
      const target = this.getCurrentTarget();
      this.onSelect(target, this._index);
      return;
    }

    // Nested, group level: a short select DESCENDS into the focused group rather
    // than selecting it (matching the keyboard's Enter-to-drill-in flow). With no
    // group focused there is nothing to descend into, so this is a no-op.
    if (this._level === "group") {
      this.descend();
      return;
    }

    // Nested, item level: select the focused item, reporting the owning group and
    // the item index.
    const item = this.getCurrentTarget();
    this.onSelect(item, {
      group: this._currentGroup,
      itemIndex: this._index,
    });
  }

  // ---- Index helpers ----

  focusIndex(i) {
    const targets = this._activeTargets();
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
    const targets = this._activeTargets();
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
