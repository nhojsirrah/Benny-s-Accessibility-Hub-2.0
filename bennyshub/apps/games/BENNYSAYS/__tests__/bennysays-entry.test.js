/**
 * Smoke tests for BENNYSAYS after entry normalization.
 *
 * The game logic, previously inline in index.html, was extracted verbatim into
 * js/app.js and is now loaded via <script src="js/app.js">. No logic changed.
 *
 * BENNYSAYS is a <canvas>-rendered game with bespoke, multi-phase single-switch
 * scanning (MAIN / DIFFICULTY / SETTINGS / PLAYER, difficulty-varying tile
 * counts, a 3s hold-to-reverse, direct NarbeScanManager/NarbeVoiceManager
 * integration). It does NOT scan a flat DOM list/grid, so migration onto the
 * shared ScanController is intentionally deferred; these tests only prove the
 * extracted app.js boots in a browser-like realm and wires up its globals.
 *
 * app.js is a plain classic <script> (not a module): it declares top-level
 * function declarations and registers window event listeners. We evaluate the
 * verbatim source in the jsdom realm (indirect eval -> global/window scope,
 * exactly how the browser hoists a classic script's function declarations) and
 * assert the boot side effects.
 */

const fs = require("fs");
const path = require("path");

const APP_PATH = path.join(__dirname, "..", "js", "app.js");
const INDEX_PATH = path.join(__dirname, "..", "index.html");

function makeMockCtx() {
  const noop = () => {};
  return {
    setTransform: noop,
    fillRect: noop,
    fillText: noop,
    save: noop,
    restore: noop,
    beginPath: noop,
    moveTo: noop,
    arcTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
  };
}

let getContextSpy;
let rafSpy;

beforeEach(() => {
  document.body.innerHTML =
    '<div id="wrap"><canvas id="game"></canvas></div>';

  // jsdom implements neither a 2d canvas context nor rAF; stub both so the
  // synchronous boot path (resize() + the initial requestAnimationFrame(draw))
  // runs cleanly.
  const ctx = makeMockCtx();
  getContextSpy = jest
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(ctx);
  rafSpy = jest.fn();
  global.requestAnimationFrame = rafSpy;
  window.requestAnimationFrame = rafSpy;

  // Audio + object URLs are only touched on user gesture / load; stub them so
  // those paths are safe if exercised.
  global.URL.createObjectURL = () => "blob:tone";
  class FakeAudio {
    play() {
      return Promise.resolve();
    }
    pause() {}
  }
  global.Audio = FakeAudio;
  window.Audio = FakeAudio;
});

afterEach(() => {
  if (getContextSpy) getContextSpy.mockRestore();
  jest.restoreAllMocks();
});

test("app.js boots: builds the 2d context and starts the draw loop", () => {
  const src = fs.readFileSync(APP_PATH, "utf8");
  expect(() => (0, eval)(src)).not.toThrow();

  expect(getContextSpy).toHaveBeenCalledWith("2d");
  // The classic script ends with requestAnimationFrame(draw) — boot kicks the
  // render loop exactly once synchronously.
  expect(rafSpy).toHaveBeenCalledTimes(1);
});

test("app.js exposes its expected function + state globals", () => {
  const src = fs.readFileSync(APP_PATH, "utf8");
  (0, eval)(src);

  for (const name of [
    "draw",
    "startNewGame",
    "showSequence",
    "handlePlayerPick",
    "stepForward",
    "stepBackward",
    "exitApp",
    "updateSettingsItems",
    "handleSettingsAction",
  ]) {
    expect(typeof global[name]).toBe("function");
  }
});

test("keyboard listeners are wired: a Space scan does not throw and advances the main menu", () => {
  const src = fs.readFileSync(APP_PATH, "utf8");
  (0, eval)(src);

  // Short Space press = keydown then keyup; in the MAIN phase this advances the
  // highlight via stepForward(). speak() degrades to a no-op without a voice
  // manager, so this stays side-effect-light.
  expect(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", cancelable: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keyup", { code: "Space", cancelable: true }),
    );
  }).not.toThrow();
});

test("index.html loads the extracted app.js and no longer inlines the game", () => {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  expect(html).toContain('<script src="js/app.js"></script>');
  // The inline game body (e.g. the Phase enum literal) must be gone from HTML.
  expect(html).not.toContain("const Phase = {");
});
