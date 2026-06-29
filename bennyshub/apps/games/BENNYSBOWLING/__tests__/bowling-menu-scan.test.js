/**
 * Tests for BENNYSBOWLING after the MENU/SETTINGS scan migration.
 *
 * SCOPE: only the MENU / PAUSE / SETTINGS (single-axis list) scanning is driven
 * by the shared ScanController (shared/scan-core.js). It is used as a movement +
 * announce + select ENGINE and is intentionally NOT attached to the document by
 * the app, because the same Space/Enter keys drive the 3D aiming / throw gameplay
 * (Three.js + ammo.js), which is left entirely on its own untouched key path.
 * That 3D gameplay path is out of scope for these tests.
 *
 * bowlchallenge.js is a plain <script> in the browser but, under this CommonJS
 * harness, skips its `init()` 3D boot (the engine is only ever touched inside
 * init()/animate(), never at module scope) and instead exposes a small surface:
 *   - createMenuScanController(getActiveMenu) — the factory the app wires up.
 *   - exitGame() — exercises the shared Nav.goBack() back-contract adoption.
 *
 * Because nothing at module scope touches Three.js / ammo.js, the file requires
 * headless with no engine stubs at all.
 */

const ScanController = require("../../../../shared/scan-core.js");
const Nav = require("../../../../shared/nav.js");

// A fake single-axis menu context matching the shape the app's
// currentMenuContext() returns: a live item list, get/set index, the existing
// highlight+speak (applyFocus) and the existing select action (selectAt).
function makeMenu(n) {
  let index = -1;
  return {
    items: Array.from({ length: n }, (_, i) => ({ id: i })),
    getIndex: () => index,
    setIndex: (x) => {
      index = x;
    },
    applyFocus: jest.fn(),
    selectAt: jest.fn(),
  };
}

let bowling;

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = "";

  // bowlphysics.js (loaded before bowlchallenge.js in the browser) defines these
  // physics globals. Headless, only bowlchallenge.js's module-scope derived
  // consts reference them (GRAB_BALL_ROLL_POS_RATIO, TRACK_DISTANCE) — both
  // unused by the menu scanning under test — so any finite value keeps require()
  // from throwing on the module-scope const block.
  global.BALL_ANGLE_MAX = Math.PI / 12.0;
  global.TRACK_WIDTH = 1.54;

  window.ScanController = ScanController;
  window.Nav = Nav;
  window.NarbeVoiceManager = {
    speak: jest.fn(),
    getSettings: () => ({ ttsEnabled: true }),
  };
  delete window.NarbeScanManager;
  bowling = require("../js/bowlchallenge.js");
});

// The app keeps ownership of WHEN to move/select; it syncs the controller cursor
// to the active menu's index before each move. This mirrors that contract.
function step(scan, m, fn) {
  scan.setIndex(m.getIndex());
  scan[fn]();
}

describe("the menu is driven by the shared ScanController", () => {
  test("createMenuScanController returns a shared ScanController instance", () => {
    const scan = bowling.createMenuScanController(() => makeMenu(3));
    expect(scan).toBeInstanceOf(ScanController);
  });

  test("returns null when the shared ScanController is unavailable", () => {
    delete window.ScanController;
    expect(bowling.createMenuScanController(() => makeMenu(3))).toBeNull();
  });
});

describe("MENU forward scanning advances and wraps", () => {
  test("advances 0 -> 1 -> 2 then wraps 2 -> 0 and applies the highlight", () => {
    const m = makeMenu(3);
    const scan = bowling.createMenuScanController(() => m);

    step(scan, m, "advance");
    expect(m.getIndex()).toBe(0);
    step(scan, m, "advance");
    expect(m.getIndex()).toBe(1);
    step(scan, m, "advance");
    expect(m.getIndex()).toBe(2);
    step(scan, m, "advance");
    expect(m.getIndex()).toBe(0); // wrapped (3 items)

    expect(m.applyFocus).toHaveBeenCalled();
  });
});

describe("reverse (Space-hold) scanning steps backward with wrap", () => {
  test("from index 0, back() wraps to the last item", () => {
    const m = makeMenu(3);
    const scan = bowling.createMenuScanController(() => m);
    m.setIndex(0);
    step(scan, m, "back");
    expect(m.getIndex()).toBe(2);
  });
});

describe("selection runs the focused menu item's action via onSelect", () => {
  test("select() routes to the active menu's selectAt with the focused index", () => {
    const m = makeMenu(3);
    const scan = bowling.createMenuScanController(() => m);
    step(scan, m, "advance"); // 0
    step(scan, m, "advance"); // 1
    scan.setIndex(m.getIndex());
    scan.select();
    expect(m.selectAt).toHaveBeenCalledWith(1);
  });
});

describe("NumpadEnter parity (shared isSelect predicate)", () => {
  test("isSelect matches Enter and NumpadEnter only; isScan matches Space", () => {
    const scan = bowling.createMenuScanController(() => makeMenu(3));
    expect(scan.isSelect({ code: "Enter" })).toBe(true);
    expect(scan.isSelect({ code: "NumpadEnter" })).toBe(true);
    expect(scan.isSelect({ code: "Space" })).toBe(false);
    expect(scan.isScan({ code: "Space" })).toBe(true);
  });

  test("a dispatched NumpadEnter keyup selects identically to Enter", () => {
    jest.useFakeTimers();
    const m = makeMenu(3);
    const scan = bowling.createMenuScanController(() => m);
    scan.attach(document);

    // Move onto index 0, then select via the numpad enter key.
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    document.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
    expect(m.getIndex()).toBe(0);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { code: "NumpadEnter" }),
    );
    document.dispatchEvent(new KeyboardEvent("keyup", { code: "NumpadEnter" }));
    expect(m.selectAt).toHaveBeenCalledWith(0);

    scan.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe("anti-tremor gate", () => {
  // Bowling never had a min-press / sensitivity / Date.now() input gate (only OS
  // key-repeat guards). The debounce floors are therefore left at 0 (off), and
  // the 3.0s hold-to-reverse threshold is preserved as spaceHoldMs = 3000.
  test("the controller is configured with no debounce floors", () => {
    const scan = bowling.createMenuScanController(() => makeMenu(3));
    expect(scan.minPressMs).toBe(0);
    expect(scan.minSelectMs).toBe(0);
    expect(scan.minIntervalMs).toBe(0);
    expect(scan.spaceHoldMs).toBe(3000);
  });

  test("with no gate, even a ~0ms Space press still advances", () => {
    jest.useFakeTimers();
    const m = makeMenu(3);
    const scan = bowling.createMenuScanController(() => m);
    scan.attach(document);

    // keydown immediately followed by keyup => ~0ms hold; not suppressed.
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    document.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
    expect(m.getIndex()).toBe(0);

    scan.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe("Exit Game adopts the shared Nav back-contract", () => {
  test("exitGame() routes through Nav.goBack()", () => {
    const spy = jest.spyOn(window.Nav, "goBack").mockReturnValue(true);
    bowling.exitGame();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
