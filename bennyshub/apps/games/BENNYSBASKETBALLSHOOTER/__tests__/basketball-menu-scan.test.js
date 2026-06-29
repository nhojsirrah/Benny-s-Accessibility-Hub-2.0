/**
 * Tests for BENNYSBASKETBALLSHOOTER after:
 *   1. Entry normalization (IP-4): the inline <script> was extracted verbatim to
 *      js/app.js and loaded via <script src>.
 *   2. Menu/scan migration: the MENU / SETTINGS (single-axis list) scanning is
 *      driven by the shared ScanController (shared/scan-core.js). It is used as a
 *      movement + announce engine only and is intentionally NOT attached to the
 *      document, because the same Space / Enter keys drive the app-specific
 *      aiming / charging shot-timing during play (that gameplay path is left
 *      exactly as-is by design -- it is out of scope for these tests).
 *   3. Adoption: the "Exit Game" action routes through the shared Nav.goBack()
 *      back-contract.
 *
 * Runs in jsdom with jest fake timers. app.js is a plain <script> in the browser
 * but exposes a CommonJS surface here and skips its window 'load' auto-start when
 * module.exports is present. The 3D engine (Three.js + Cannon.js) it boots at
 * module scope is replaced with deep no-op stubs so the file can be require()'d
 * headless without a WebGL context.
 *
 * SCOPE NOTE: only the MENU / SETTINGS scanning is driven by ScanController. The
 * in-game aiming oscillation + charge/release shot timing is app-specific and is
 * intentionally left on its own Space/Enter path.
 */

const ScanController = require("../../../../shared/scan-core.js");
const Themes = require("../../../../shared/themes.js");
const Nav = require("../../../../shared/nav.js");

// ---- Deep no-op stub for Three.js / Cannon.js / AudioContext --------------
// Returns a single self-similar Proxy: callable, new-able, every property read
// returns the same stub, every write is accepted. A few coercions are made safe
// (toPrimitive -> 0, length -> 0, iterator -> empty) so any module-scope numeric
// or loop usage degrades to a no-op rather than throwing. `domElement` returns a
// real <canvas> so the module-scope appendChild(renderer.domElement) works.
function makeDeepStub() {
  const canvas = document.createElement("canvas");
  const base = function () {};
  const handler = {
    get(_t, prop) {
      if (prop === "domElement") return canvas;
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "length") return 0;
      if (prop === "then") return undefined; // not a thenable
      if (prop === "toString") return () => "";
      if (prop === "valueOf") return () => 0;
      return stub;
    },
    apply: () => stub,
    construct: () => stub,
    set: () => true,
    has: () => true,
  };
  const stub = new Proxy(base, handler);
  return stub;
}

// ---- Helpers --------------------------------------------------------------

// Drive the key-up handler on the CURRENT app's InputHandler directly. We invoke
// the handler instead of dispatching a real window event because re-require()ing
// the module each test leaves prior modules' window listeners attached (each is
// a closure over its own dead state); calling the live instance exercises the
// migrated select path without that cross-test noise.
function keyUp(code) {
  app.Input.handleKeyUp({ code });
}

function menuDom() {
  return `
    <div id="canvas-container"></div>
    <div id="start-screen" class="screen">
      <div class="menu-items-list" id="main-menu-list">
        <div class="menu-item selected" data-action="start">START GAME</div>
        <div class="menu-item" data-action="settings">SETTINGS</div>
        <div class="menu-item" data-action="exit">EXIT GAME</div>
      </div>
    </div>
    <div id="settings-screen" class="screen" style="display:none;">
      <div class="menu-items-list" id="settings-menu-list"></div>
    </div>
    <div id="pause-screen" class="screen" style="display:none;">
      <div class="menu-items-list" id="pause-menu-list">
        <div class="menu-item selected" data-action="resume">CONTINUE GAME</div>
        <div class="menu-item" data-action="restart">RESTART GAME</div>
        <div class="menu-item" data-action="settings">SETTINGS</div>
        <div class="menu-item" data-action="menu">MAIN MENU</div>
      </div>
    </div>
    <div id="game-over-screen" class="screen" style="display:none;">
      <div id="final-score"></div>
      <div class="menu-items-list" id="gameover-menu-list">
        <div class="menu-item selected" data-action="restart">PLAY AGAIN</div>
        <div class="menu-item" data-action="menu">MAIN MENU</div>
      </div>
    </div>
  `;
}

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

  localStorage.clear();
  document.body.innerHTML = menuDom();

  // Engine + audio stubs (must exist before require -- module scope boots them).
  global.THREE = window.THREE = makeDeepStub();
  global.CANNON = window.CANNON = makeDeepStub();
  window.AudioContext = window.webkitAudioContext = function () {
    return makeDeepStub();
  };
  window.HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue();
  window.HTMLMediaElement.prototype.pause = jest.fn();
  // jsdom has no 2D canvas backend; the module-scope texture builders draw into
  // a 2D context. A deep stub keeps those calls no-op rather than throwing.
  window.HTMLCanvasElement.prototype.getContext = jest.fn(() => makeDeepStub());

  // Shared modules exposed exactly as the real page exposes them via <script src>.
  window.ScanController = ScanController;
  window.Themes = Themes;
  window.Nav = Nav;
  window.NarbeVoiceManager = { speak: jest.fn() };
  // No NarbeScanManager: the app falls back to its local GameSettings, which is
  // a supported branch and keeps these tests independent of the manager.
  delete window.NarbeScanManager;

  jest.resetModules();
  app = require("../js/app.js");
  app.getMenu().init();
});

afterEach(() => {
  try {
    app.getMenu().stopAutoScan();
    app.getScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Controller identity --------------------------------------------------

describe("the menu is driven by the shared ScanController", () => {
  test("getScan() returns a shared ScanController instance", () => {
    expect(app.getScan()).toBeInstanceOf(ScanController);
  });
});

// ---- Forward scanning + wrap (via ScanController) -------------------------

describe("MAIN MENU forward scanning advances and wraps", () => {
  beforeEach(() => {
    app.setGameState("MENU");
    app.getMenu().setActiveMenu("start"); // seeds activeIndex = 0
  });

  test("advances 0 -> 1 -> 2 then wraps 2 -> 0", () => {
    const menu = app.getMenu();
    expect(menu.activeIndex).toBe(0);

    menu.scanNext();
    expect(menu.activeIndex).toBe(1);

    menu.scanNext();
    expect(menu.activeIndex).toBe(2);

    menu.scanNext();
    expect(menu.activeIndex).toBe(0); // wrapped (3 items)
  });

  test("the focused item carries the 'selected' highlight class", () => {
    const menu = app.getMenu();
    menu.scanNext(); // -> index 1 (SETTINGS)
    const items = document.querySelectorAll("#main-menu-list .menu-item");
    expect(items[1].classList.contains("selected")).toBe(true);
    expect(items[0].classList.contains("selected")).toBe(false);
  });
});

// ---- Reverse scanning (Space-hold path) ----------------------------------

describe("reverse scanning steps backward with wrap", () => {
  test("from index 0, scanPrev wraps to the last item", () => {
    const menu = app.getMenu();
    app.setGameState("MENU");
    menu.setActiveMenu("start"); // activeIndex = 0
    menu.scanPrev();
    expect(menu.activeIndex).toBe(2); // 3-item menu wraps 0 -> 2
  });
});

// ---- Selection runs the focused item's action (via onSelect) -------------

describe("selection runs the focused menu item's action", () => {
  test("SETTINGS: selecting TTS toggles GameSettings.tts", () => {
    const menu = app.getMenu();
    app.setGameState("MENU");
    menu.setActiveMenu("settings");
    menu.scanNext(); // focus index 0 (TTS)

    const before = app.GameSettings.tts;
    menu.selectCurrent();
    expect(app.GameSettings.tts).toBe(!before);
  });

  test("MAIN MENU: selecting Exit Game routes through Nav.goBack (deferred 500ms)", () => {
    const goBack = jest
      .spyOn(window.Nav, "goBack")
      .mockImplementation(() => true);
    const menu = app.getMenu();
    app.setGameState("MENU");
    menu.setActiveMenu("start");
    menu.scanNext(); // 1
    menu.scanNext(); // 2 (EXIT GAME)

    menu.selectCurrent();
    expect(goBack).not.toHaveBeenCalled(); // deferred behind the TTS announce
    jest.advanceTimersByTime(500);
    expect(goBack).toHaveBeenCalledTimes(1);
  });
});

// ---- NumpadEnter parity (shared isSelect predicate) ----------------------

describe("NumpadEnter selects identically to Enter in menus", () => {
  test("Enter and NumpadEnter both fire the focused menu selection", () => {
    const menu = app.getMenu();
    app.setGameState("MENU");
    menu.setActiveMenu("settings");
    menu.scanNext(); // 0 TTS
    menu.scanNext(); // 1 SFX

    const base = app.GameSettings.sfx;

    keyUp("Enter"); // -> selectCurrent -> toggle SFX
    expect(app.GameSettings.sfx).toBe(!base);

    // SFX selection does not move the cursor; toggle back via the numpad key.
    keyUp("NumpadEnter");
    expect(app.GameSettings.sfx).toBe(base);
  });

  test("the shared isSelect predicate matches Enter and NumpadEnter only", () => {
    const scan = app.getScan();
    expect(scan.isSelect({ code: "Enter" })).toBe(true);
    expect(scan.isSelect({ code: "NumpadEnter" })).toBe(true);
    expect(scan.isSelect({ code: "Space" })).toBe(false);
    expect(scan.isScan({ code: "Space" })).toBe(true);
  });
});

// ---- Themes contract (shared module) -------------------------------------
//
// Basketball's visual settings (ball color, aimer color, background arena) are
// app-specific cosmetics, NOT the shared menu-highlight / UI THEMES palette, so
// there is no app-vs-shared theme parity to reconcile -- the local settings are
// kept as-is (see PR notes). This pins the shared Themes resolution contract the
// standard-cluster games rely on, confirming it resolves consistently.
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
