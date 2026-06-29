/**
 * pauseOverlay.js — Benny's Baseball adoption of the shared pause menu.
 *
 * The game used to hand-roll its pause menu as the bespoke #pauseOverlay /
 * #pauseMenu markup in index.html (Resume Game / Settings / Restart Game /
 * Main Menu), with its own highlight + DOM-button-click scan handling. This
 * factory retires that top-level menu in favour of the shared
 * <benny-pause-overlay> (shared/pause-overlay.js, window.BennyPauseOverlay),
 * configured with the SAME four actions and their original onclick handlers.
 *
 * The action handlers are reused verbatim: the shared overlay's onSelect simply
 * calls the existing window.resumeGame / window.showPauseSettings /
 * window.restartGame / window.quitToMenu functions that Game.setupPauseMenu
 * still defines. Action ids use the shared overlay's resume/exit convention so
 * Resume and Main Menu auto-hide the overlay; Settings and Restart are closed by
 * their own handlers (Game.js). The flat overlay has no sub-menu, so the pause
 * Settings list and the Reset-Season confirmation keep rendering into the legacy
 * #pauseOverlay host (see Game.showPauseSettings / backToPauseMenu).
 *
 * Guarded for absence (PAUSE-OVERLAY CONTRACT v1): when window.BennyPauseOverlay
 * is unavailable this returns null and the caller falls back to the original
 * bespoke #pauseOverlay menu.
 *
 * Loaded as an IIFE-style global via <script src> (apps read
 * window.createBaseballPauseOverlay), matching menuScan.js; a dual CommonJS
 * export lets jsdom tests require() it.
 */
(function () {
  "use strict";

  function resolveOverlayApi() {
    if (typeof window !== "undefined" && window.BennyPauseOverlay) {
      return window.BennyPauseOverlay;
    }
    if (typeof BennyPauseOverlay !== "undefined") {
      return BennyPauseOverlay;
    }
    return null;
  }

  // The four pause actions, migrated 1:1 from the bespoke #pauseMenu markup:
  //   <button onclick="resumeGame()">Resume Game</button>
  //   <button onclick="showPauseSettings()">Settings</button>
  //   <button onclick="restartGame()">Restart Game</button>
  //   <button onclick="quitToMenu()">Main Menu</button>
  // Labels are identical; each onSelect calls the original window handler
  // (resolved lazily so it works regardless of script-load order).
  function buildActions(win) {
    var w = win || (typeof window !== "undefined" ? window : {});
    function call(name) {
      if (typeof w[name] === "function") w[name]();
    }
    return [
      {
        id: "resume",
        label: "Resume Game",
        onSelect: function () {
          call("resumeGame");
        },
      },
      {
        id: "settings",
        label: "Settings",
        onSelect: function () {
          call("showPauseSettings");
        },
      },
      {
        id: "restart",
        label: "Restart Game",
        onSelect: function () {
          call("restartGame");
        },
      },
      {
        id: "exit",
        label: "Main Menu",
        onSelect: function () {
          call("quitToMenu");
        },
      },
    ];
  }

  // Create + mount the shared overlay configured with the migrated actions, or
  // return null when the shared module is unavailable (legacy fallback).
  function createBaseballPauseOverlay() {
    var api = resolveOverlayApi();
    if (!api || typeof api.create !== "function") return null;

    var win = typeof window !== "undefined" ? window : {};
    try {
      return api.create({
        actions: buildActions(win),
        scanManager: win.NarbeScanManager || null,
        voice: win.NarbeVoiceManager || null,
      });
    } catch (e) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn(
          "BennyPauseOverlay.create failed; using legacy pause menu:",
          e,
        );
      }
      return null;
    }
  }

  if (typeof window !== "undefined") {
    window.createBaseballPauseOverlay = createBaseballPauseOverlay;
    // Exposed for tests so the migrated action list can be asserted directly.
    window.buildBaseballPauseActions = buildActions;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = createBaseballPauseOverlay;
    module.exports.buildActions = buildActions;
  }
})();
