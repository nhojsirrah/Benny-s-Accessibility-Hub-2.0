/**
 * menuScan.js — Benny's Baseball MENU scanning on the shared ScanController.
 *
 * The game's menu modes (main / play / settings / reset-confirmation / color
 * select / the pause overlay) used to compute their scan cursor by hand inside
 * InputHandler ((index + 1) % length, etc.). This factory moves that single-axis
 * cursor movement and the selection dispatch onto the shared ScanController
 * (shared/scan-core.js) so every app shares one scan contract (forward / reverse
 * wrap, NumpadEnter == Enter via the isSelect predicate, the debounce knobs).
 *
 * It is used as a movement + select ENGINE and is deliberately NOT attached to
 * the document: the same Space / Enter keys also drive the gameplay timing
 * (pitch-grid selection, the real-time interactive-batting swing, the field
 * fielder scan) which stays on InputHandler's own path. InputHandler keeps
 * owning the keyboard, the auto-scan timer and the (dynamic-cadence) hold-to-
 * reverse timer, and calls advance() / back() / select() here for menu modes.
 *
 *   - getTargets : the live menu list (COLOR_SELECT is a fixed two-item axis,
 *     matching the original % 2 walk).
 *   - onFocus    : publishes the new cursor to gameState.selectedIndex; the
 *     existing per-mode draw functions (drawMainMenu, …) read that index, so the
 *     existing highlight + voice are reused unchanged by the caller after a move.
 *   - onSelect   : runs the existing actions — canvas menus go through
 *     MenuSystem.handleMenuSelection(); the pause overlay clicks its DOM buttons.
 *
 * Anti-tremor: minIntervalMs mirrors the original SPACE_SCAN_DELAY scan rate
 * limit onto the shared contract so the gate is preserved, not dropped. The live
 * enforcement also remains at the InputHandler keyboard layer (SPACE_SCAN_DELAY
 * scan gate + ACTION_COOLDOWN select gate), which is what fires while the engine
 * is used unattached.
 *
 * Loaded as an IIFE-style global via <script src> (apps read
 * window.createBaseballMenuScan); a dual CommonJS export lets jsdom tests
 * require() it.
 */
(function () {
  "use strict";

  function resolveScanController() {
    if (typeof window !== "undefined" && window.ScanController) {
      return window.ScanController;
    }
    if (typeof ScanController !== "undefined") {
      return ScanController;
    }
    if (typeof require === "function") {
      try {
        return require("../../../../shared/scan-core.js");
      } catch (e) {
        /* not available in this environment */
      }
    }
    return null;
  }

  function resolveConstants() {
    if (typeof GAME_CONSTANTS !== "undefined") return GAME_CONSTANTS;
    if (typeof window !== "undefined" && window.GAME_CONSTANTS) {
      return window.GAME_CONSTANTS;
    }
    return null;
  }

  function createMenuScan(game) {
    const ScanCtrl = resolveScanController();
    const C = resolveConstants();
    if (!ScanCtrl || !C || !game) return null;

    const MODES = C.MODES;
    const MENU_MODES = [
      MODES.MAIN_MENU,
      MODES.PLAY_MENU,
      MODES.SETTINGS_MENU,
      MODES.RESET_CONFIRMATION,
      MODES.COLOR_SELECT,
      MODES.PAUSE_MENU,
    ];

    function mode() {
      return game.gameState.mode;
    }

    function isMenuMode() {
      return MENU_MODES.indexOf(mode()) !== -1;
    }

    // The shared pause overlay (shared/pause-overlay.js), when present and open,
    // owns the pause scan targets: the controller scans its action buttons
    // directly (CONTRACT: getTargets()) and a select activates the focused button
    // (CONTRACT: activate()). When the shared module is absent the overlay is
    // null and the legacy bespoke #pauseMenu path below is used instead.
    function sharedPauseOverlayOpen() {
      return !!(
        game.bennyPauseOverlay &&
        typeof game.bennyPauseOverlay.isOpen === "function" &&
        game.bennyPauseOverlay.isOpen()
      );
    }

    // COLOR_SELECT is a fixed two-item axis (color cycler + Play Ball), matching
    // the original handleColorSelectScan() % 2 walk. Every other menu scans the
    // live menuOptions list (kept correct per submenu by MenuSystem / Game).
    function getTargets() {
      // While the shared pause overlay is open it owns the targets (its action
      // buttons), so the cursor scans them in render order.
      if (sharedPauseOverlayOpen()) {
        return game.bennyPauseOverlay.getTargets() || [];
      }
      if (mode() === MODES.COLOR_SELECT) return ["color", "play"];
      return game.gameState.menuOptions || [];
    }

    // Click the focused button in whichever pause submenu is visible — the exact
    // DOM dispatch the original handleEnterRelease() performed for PAUSE_MENU.
    function clickPauseButton(index) {
      if (typeof document === "undefined") return;
      const pauseMenu = document.getElementById("pauseMenu");
      const resetConf = document.getElementById("resetSeasonConfirmation");
      let selector;
      if (pauseMenu && pauseMenu.style.display !== "none") {
        selector = "#pauseMenu button";
      } else if (resetConf && resetConf.style.display !== "none") {
        selector = "#resetSeasonConfirmation button";
      } else {
        selector = "#pauseSettingsMenu button";
      }
      const buttons = document.querySelectorAll(selector);
      if (buttons[index]) buttons[index].click();
    }

    const scan = new ScanCtrl({
      getTargets,
      // Highlight reuse: onFocus only publishes the new cursor. The caller
      // redraws (the existing highlight) and speaks (the existing voice) after a
      // move, exactly as before, so onAnnounce is intentionally a no-op.
      onFocus: (target, index) => {
        game.gameState.selectedIndex = index;
      },
      onAnnounce: () => {},
      // Selection runs the existing actions.
      onSelect: (target, index) => {
        if (index < 0) return;
        // Shared overlay open: run the focused overlay action (CONTRACT:
        // activate()), which calls that action's onSelect handler — the verbatim
        // resumeGame / showPauseSettings / restartGame / quitToMenu functions.
        if (sharedPauseOverlayOpen()) {
          game.bennyPauseOverlay.activate(target);
          return;
        }
        if (mode() === MODES.PAUSE_MENU) {
          clickPauseButton(index);
          return;
        }
        game.menuSystem.handleMenuSelection();
      },
      wrap: true,
      // Hold-to-reverse threshold matches the original 3s; the reverse cadence
      // itself stays on InputHandler's own timer (read live from NarbeScanManager
      // so a scan-speed change takes effect immediately).
      spaceHoldMs: 3000,
      reverseCadenceMs:
        typeof window !== "undefined" &&
        window.NarbeScanManager &&
        window.NarbeScanManager.getScanInterval
          ? window.NarbeScanManager.getScanInterval()
          : 2000,
      // Menus have no Enter-hold-to-pause (the original explicitly removed it).
      // A large finite threshold keeps a short Enter selecting even if this
      // engine is ever attached to the document.
      enterHoldMs: 2147483647,
      // Anti-tremor: mirror the original SPACE_SCAN_DELAY scan rate limit onto
      // the shared contract (preserved, not dropped). See InputHandler for the
      // live keyboard-layer enforcement (SPACE_SCAN_DELAY + ACTION_COOLDOWN).
      minIntervalMs:
        C.TIMING && typeof C.TIMING.SPACE_SCAN_DELAY === "number"
          ? C.TIMING.SPACE_SCAN_DELAY
          : 0,
      // Auto-scan stays on InputHandler's own timer (it also scans the gameplay
      // fielder list, so it cannot live on this menu-only engine).
      autoScan: false,
    });

    return {
      scan,
      isMenuMode,
      getTargets,
      // Align the controller cursor with the canvas/DOM-driven selectedIndex
      // before each move, so menu transitions that set selectedIndex directly
      // (showMainMenu, showResetConfirmation, …) are honored.
      syncIndex() {
        scan.setIndex(game.gameState.selectedIndex);
      },
      advance() {
        this.syncIndex();
        scan.advance();
      },
      back() {
        this.syncIndex();
        scan.back();
      },
      select() {
        this.syncIndex();
        scan.select();
      },
    };
  }

  if (typeof window !== "undefined") {
    window.createBaseballMenuScan = createMenuScan;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = createMenuScan;
  }
})();
