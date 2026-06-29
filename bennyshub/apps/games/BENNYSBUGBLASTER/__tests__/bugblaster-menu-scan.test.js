/**
 * Tests for BENNYSBUGBLASTER after migrating its MENU / settings (linear-list)
 * scanning onto the shared ScanController (shared/scan-core.js) and adopting the
 * shared Nav back-contract.
 *
 * Runs in jsdom with jest fake timers. game.js is a plain <script> (not a
 * module) in the browser; for tests it exposes a CommonJS surface and skips its
 * requestAnimationFrame auto-start when module.exports is present. The shared
 * scan/voice managers + ScanController + Nav are exposed on window exactly as
 * the real page exposes them via <script src>.
 *
 * SCOPE NOTE: only the MENU/settings scanning is driven by ScanController. The
 * in-game stomp-target cycling (PLAYING -> cycle_stomp_target / 500ms cadence)
 * is app-specific and is intentionally left on its own path; it is out of scope
 * for these tests by design.
 */

const ScanController = require("../../../../shared/scan-core.js");
const Themes = require("../../../../shared/themes.js");
const Nav = require("../../../../shared/nav.js");

// ---- Helpers -------------------------------------------------------------

function dispatchKey(type, code) {
  const event = new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

// Short press = keydown immediately followed by keyup (duration 0 < hold
// thresholds), which advances (Space) or selects (Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

function makeMockScanManager(overrides = {}) {
  return {
    autoScan: overrides.autoScan || false,
    interval: overrides.interval || 2000,
    getSettings() {
      return { autoScan: this.autoScan, scanInterval: this.interval };
    },
    getScanInterval() {
      return this.interval;
    },
    cycleScanSpeed() {},
    updateSettings(p) {
      if (typeof p.autoScan === "boolean") this.autoScan = p.autoScan;
    },
    subscribe() {},
    unsubscribe() {},
  };
}

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

  localStorage.clear();
  document.body.innerHTML = '<canvas id="gameCanvas"></canvas>';

  // jsdom implements neither a 2d canvas context nor media playback. game.js
  // only draws inside the (test-skipped) rAF loop, so a null context is fine;
  // stub getContext to avoid jsdom's noisy "not implemented" console output.
  window.HTMLCanvasElement.prototype.getContext = jest.fn(() => null);
  // Make play() a resolved promise so game.js's startMusic() .play().catch()
  // chain is safe under test.
  window.HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue();
  window.HTMLMediaElement.prototype.pause = jest.fn();
  window.speechSynthesis = { cancel: jest.fn() };

  window.ScanController = ScanController;
  window.Themes = Themes;
  window.Nav = Nav;
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };

  jest.resetModules();
  app = require("../game.js");
});

afterEach(() => {
  try {
    app.getScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- getTargets ----------------------------------------------------------

describe("getMenuTargets() exposes the active menu as single-axis targets", () => {
  test("MAIN MENU -> Play / Instructions / Settings / Exit", () => {
    app.setGameState("MENU");
    expect(app.getMenuTargets().map((t) => t.label)).toEqual([
      "Play Game",
      "Instructions",
      "Settings",
      "Exit Game",
    ]);
  });

  test("SETTINGS -> 7 items ending in Back", () => {
    app.setGameState("SETTINGS");
    const labels = app.getMenuTargets().map((t) => t.label);
    expect(labels).toEqual([
      "TTS",
      "Auto Scan",
      "Scan Speed",
      "Auto Stomp",
      "SFX",
      "Music",
      "Back",
    ]);
  });

  test("CONFIRM_EXIT -> Cancel / Proceed; INSTRUCTIONS -> single Back", () => {
    app.setGameState("CONFIRM_EXIT");
    expect(app.getMenuTargets().map((t) => t.label)).toEqual([
      "Cancel",
      "Proceed",
    ]);
    app.setGameState("INSTRUCTIONS");
    expect(app.getMenuTargets().map((t) => t.label)).toEqual(["Back"]);
  });

  test("non-menu states (PLAYING / GAME_OVER) expose no targets", () => {
    app.setGameState("PLAYING");
    expect(app.getMenuTargets()).toEqual([]);
    app.setGameState("GAME_OVER");
    expect(app.getMenuTargets()).toEqual([]);
  });

  test("BUY targets mirror getVisibleBuyOptions()", () => {
    app.setGameState("BUY");
    app.setPoints(99999); // reveal the affordable store rows
    const values = app.getMenuTargets().map((t) => t.value);
    expect(values).toEqual(app.getVisibleBuyOptions());
  });
});

// ---- Forward scanning + wrap (via ScanController) -------------------------

describe("menu forward scanning advances and wraps via ScanController", () => {
  test("MAIN MENU advances 0 -> 1 -> ... and wraps 3 -> 0", () => {
    app.setGameState("MENU");
    app.setMenuIndex(0);

    app.scanForward();
    expect(app.getState().menu_selected_index).toBe(1);
    expect(app.getScan().getCurrentTarget().label).toBe("Instructions");

    app.setMenuIndex(3);
    app.scanForward();
    expect(app.getState().menu_selected_index).toBe(0); // wrapped
    expect(app.getScan().getCurrentTarget().label).toBe("Play Game");
  });

  test("SETTINGS wraps 6 -> 0", () => {
    app.setGameState("SETTINGS");
    app.setMenuIndex(6);
    app.scanForward();
    expect(app.getState().menu_selected_index).toBe(0);
  });

  test("the controller is the shared ScanController instance", () => {
    expect(app.getScan()).toBeInstanceOf(ScanController);
  });
});

// ---- Reverse scanning (BUY only — preserved boundary) --------------------

describe("reverse scanning stays scoped to the BUY store", () => {
  test("BUY back() steps backward through the visible options with wrap", () => {
    app.setGameState("BUY");
    app.setPoints(99999);
    const visible = app.getVisibleBuyOptions();

    app.setMenuIndex(visible[0]);
    app.scanBackward();
    expect(app.getState().menu_selected_index).toBe(
      visible[visible.length - 1],
    );
  });

  test("reverse is a no-op outside BUY (MAIN MENU unchanged)", () => {
    app.setGameState("MENU");
    app.setMenuIndex(2);
    app.scanBackward();
    expect(app.getState().menu_selected_index).toBe(2);
  });
});

// ---- Selection runs the menu action (via ScanController.onSelect) ---------

describe("selection runs the focused menu item's action", () => {
  test("SETTINGS: selecting TTS toggles tts_enabled", () => {
    app.setGameState("SETTINGS");
    app.setMenuIndex(0); // TTS
    const before = app.getState().tts_enabled;
    app.selectAction();
    expect(app.getState().tts_enabled).toBe(!before);
  });

  test("MAIN MENU: selecting Play Game enters the store (BUY)", () => {
    app.setGameState("MENU");
    app.setMenuIndex(0);
    app.selectAction();
    expect(app.getState().gameState).toBe("BUY");
  });

  test("MAIN MENU: selecting Exit Game routes through Nav.goBack", () => {
    const goBack = jest
      .spyOn(window.Nav, "goBack")
      .mockImplementation(() => {});
    app.setGameState("MENU");
    app.setMenuIndex(3); // Exit Game
    app.selectAction();
    expect(goBack).not.toHaveBeenCalled(); // deferred 500ms behind the TTS
    jest.advanceTimersByTime(500);
    expect(goBack).toHaveBeenCalledTimes(1);
  });
});

// ---- NumpadEnter parity (shared isSelect predicate) ----------------------

describe("NumpadEnter selects identically to Enter (shared key contract)", () => {
  test("Enter and NumpadEnter both fire the focused selection", () => {
    app.setGameState("SETTINGS");
    app.setMenuIndex(4); // SFX
    const base = app.getState().sfx_enabled;

    tap("Enter");
    expect(app.getState().sfx_enabled).toBe(!base);

    // Re-seat (SFX selection does not move the cursor) and toggle back with the
    // numpad key; equal effect proves NumpadEnter routes to the same selector.
    app.setGameState("SETTINGS");
    app.setMenuIndex(4);
    tap("NumpadEnter");
    expect(app.getState().sfx_enabled).toBe(base);
  });

  test("Space tap advances the menu (shared isScan predicate)", () => {
    app.setGameState("MENU");
    app.setMenuIndex(0);
    tap("Space");
    expect(app.getState().menu_selected_index).toBe(1);
  });
});

// ---- Themes contract (shared module) -------------------------------------
//
// BugBlaster is a fixed-visual canvas game with NO local theme / highlight-color
// array to reconcile, so there is no app-vs-shared parity to assert here. This
// pins the shared Themes resolution contract the standard-cluster games rely on,
// confirming the module resolves identically for any future adoption.

describe("shared Themes resolve consistently", () => {
  test("getThemeHighlight maps index 0 to the theme default, else the palette", () => {
    Themes.THEMES.forEach((theme) => {
      Themes.HIGHLIGHT_COLORS.forEach((choice, hi) => {
        const resolved = Themes.getThemeHighlight(theme, hi);
        if (hi === 0) expect(resolved).toBe(theme.highlight);
        else expect(resolved).toBe(choice);
      });
    });
  });
});
