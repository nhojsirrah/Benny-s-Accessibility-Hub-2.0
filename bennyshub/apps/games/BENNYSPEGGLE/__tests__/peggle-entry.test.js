/**
 * Smoke test for BENNYSPEGGLE after extracting the inline <script> from
 * index.html into js/app.js (behavior-preserving move, IP-4 step 1).
 *
 * js/app.js is a plain classic <script> in the browser (NOT a module): it runs
 * in global scope and, at the very end, instantiates the game (`const game =
 * new Game()`) and kicks off level loading (`LevelLoader.init()`). This test
 * loads the extracted file in jsdom with the minimal DOM/global surface stubbed
 * (a fake #gameCanvas + 2D context, no-op requestAnimationFrame, a fetch that
 * declines so LevelLoader falls back), then evaluates it in global scope and
 * asserts the expected top-level entrypoint/globals are defined.
 *
 * Purpose: prove the extraction did not break loading. It is intentionally NOT
 * a behavioral test of gameplay — scan migration and contract adoption are
 * separate follow-up PRs.
 */

const fs = require("fs");
const path = require("path");

const APP_PATH = path.join(__dirname, "..", "js", "app.js");

// A self-returning, callable Proxy. Any property access or call yields the same
// proxy, and numeric coercion yields 0 — enough to stand in for a 2D canvas
// context (e.g. ctx.setTransform(...), ctx.createLinearGradient().addColorStop)
// without throwing during the first synchronous render frame.
function makeSelfProxy() {
  const fn = function () {
    return proxy;
  };
  const proxy = new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      return proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

describe("BENNYSPEGGLE entry extraction (js/app.js)", () => {
  let source;

  beforeAll(() => {
    source = fs.readFileSync(APP_PATH, "utf8");

    const ctx = makeSelfProxy();
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      addEventListener: () => {},
      removeEventListener: () => {},
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 820,
        height: 540,
        right: 820,
        bottom: 540,
      }),
      style: {},
    };

    // Only #gameCanvas is referenced via getElementById in the script.
    document.getElementById = (id) => (id === "gameCanvas" ? fakeCanvas : null);

    // Keep the render loop from recursing during the single boot frame.
    global.requestAnimationFrame = () => 0;
    global.cancelAnimationFrame = () => {};

    // LevelLoader.init() fetches a manifest; decline so it takes its fallback
    // path instead of hitting the network.
    global.fetch = () =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      });
  });

  test("file is non-trivial and free of any nested </script> terminator", () => {
    expect(source.length).toBeGreaterThan(10000);
    expect(source).not.toContain("</script");
  });

  test("parses and defines the expected top-level globals when loaded", () => {
    // Indirect eval runs the source in global scope, exactly like a classic
    // <script>. The appended probe runs in the same program, so it can observe
    // the top-level `const`/`class` lexical bindings and surface them.
    const probe = `
;globalThis.__PEGGLE_PROBE__ = {
  Game: typeof Game,
  LevelLoader: typeof LevelLoader,
  TUNING: typeof TUNING,
  game: typeof game,
  isGameInstance: (typeof game !== 'undefined') && (typeof Game === 'function') && (game instanceof Game),
};`;

    const indirectEval = eval;
    expect(() => indirectEval(source + probe)).not.toThrow();

    const probed = globalThis.__PEGGLE_PROBE__;
    expect(probed.Game).toBe("function"); // class Game
    expect(probed.LevelLoader).toBe("object");
    expect(probed.TUNING).toBe("object");
    expect(probed.game).toBe("object");
    expect(probed.isGameInstance).toBe(true);
  });
});
