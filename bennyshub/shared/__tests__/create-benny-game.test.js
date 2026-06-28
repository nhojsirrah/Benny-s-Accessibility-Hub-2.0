/**
 * @jest-environment jsdom
 *
 * Meta-test for the create-benny-game scaffolder. It runs the CLI into a temp
 * dir and asserts the emitted game is accessible-by-default: the expected files
 * exist, app.js extends BennyGame + defines the two required overrides, the
 * generated conformance test is present, and the generated app constructs and
 * mounts against the real shared stack.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CLI = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "tools",
  "create-benny-game",
  "index.js",
);

let outDir;

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "benny-game-"));
  execFileSync(
    process.execPath,
    [CLI, "--id", "testgame", "--family", "grid", "--out", outDir, "--force"],
    { stdio: "pipe" },
  );
});

afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

describe("create-benny-game scaffold output", () => {
  test("emits the expected files", () => {
    const expected = [
      "index.html",
      "style.css",
      "js/app.js",
      "js/app.conformance.test.js",
      "games.entry.json",
    ];
    for (const rel of expected) {
      expect(fs.existsSync(path.join(outDir, rel))).toBe(true);
    }
  });

  test("index.html loads the shared stack, scan-core, benny-app, then app.js", () => {
    const html = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
    expect(html).toContain("../../../shared/scan-core.js");
    expect(html).toContain("../../../shared/benny-app.js");
    expect(html).toContain("js/app.js");
    // benny-app must load before the game that extends BennyGame.
    expect(html.indexOf("benny-app.js")).toBeLessThan(
      html.indexOf("js/app.js"),
    );
  });

  test("app.js extends BennyGame and overrides getScanTargets + onSelect", () => {
    const app = fs.readFileSync(path.join(outDir, "js", "app.js"), "utf8");
    expect(app).toMatch(/class\s+Testgame\s+extends\s+BennyGame/);
    expect(app).toMatch(/getScanTargets\s*\(/);
    expect(app).toMatch(/onSelect\s*\(/);
    // It must resolve ScanController/BennyGame from globals (the wiring source).
    expect(app).toContain("BennyGame");
  });

  test("the games.json stub entry uses the current manifest shape", () => {
    const entry = JSON.parse(
      fs.readFileSync(path.join(outDir, "games.entry.json"), "utf8"),
    );
    expect(entry).toMatchObject({
      id: "testgame",
      path: "apps/games/TESTGAME/index.html",
      launchExternal: false,
    });
    expect(Array.isArray(entry.genres)).toBe(true);
  });

  test("the generated conformance test references the real shared stack", () => {
    const conf = fs.readFileSync(
      path.join(outDir, "js", "app.conformance.test.js"),
      "utf8",
    );
    expect(conf).toContain("scan-core");
    expect(conf).toContain("benny-app");
    expect(conf).toContain("ScanController");
  });

  test("the generated app.js constructs and mounts against the real stack", () => {
    // Populate window.ScanController / window.BennyGame the way the script tags
    // would, then require the generated app (which extends window.BennyGame).
    require("../scan-core");
    require("../benny-app");

    // eslint-disable-next-line global-require, import/no-dynamic-require
    const TestGame = require(path.join(outDir, "js", "app.js"));
    expect(typeof TestGame).toBe("function");

    document.body.innerHTML = '<main id="game-root"></main>';
    const game = new TestGame();
    game.mount(document.getElementById("game-root"));

    expect(game.scan).toBeInstanceOf(window.ScanController);
    expect(Array.isArray(game.getScanTargets())).toBe(true);
    expect(() => game.onSelect(game.getScanTargets()[0], 0)).not.toThrow();

    game.teardown();
  });
});
