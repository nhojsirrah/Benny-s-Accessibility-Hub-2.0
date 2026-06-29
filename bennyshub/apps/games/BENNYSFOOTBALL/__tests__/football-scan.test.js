/**
 * Tests for BENNYSFOOTBALL after the scan migration:
 *
 *   1. Menu / scan migration: the MENU (single-axis ScanList) scanning is driven
 *      by the shared ScanController (shared/scan-core.js), used as a movement +
 *      announce + select ENGINE only. It is intentionally NOT attached to the
 *      document — the same Space / Enter keys also drive the app-specific
 *      hold-to-charge passing / kicking + field-goal aim timing during play, which
 *      stays on its own app-bound path (ScanInput). That gameplay timing is out of
 *      scope here by design.
 *   2. NumpadEnter parity: ScanInput now recognizes NumpadEnter alongside Enter
 *      via the shared ScanController.isSelect predicate.
 *   3. Preserved anti-tremor: this game never had a press-duration / interval
 *      input gate (no Date.now()/sensitivity/min-press check), so no minPressMs /
 *      minSelectMs / minIntervalMs floor is introduced. Its anti-tremor protection
 *      is the OS-auto-repeat (e.repeat) ignore + the awaitingSpaceRelease re-fire
 *      guard in ScanInput — both retained verbatim and asserted below.
 *
 * Runs in jsdom. ui.js is a plain <script> in the browser but exposes a CommonJS
 * surface here. Phaser is stubbed with chainable no-op display objects so the file
 * can be require()'d headless without a WebGL context.
 */

const ScanController = require("../../../../shared/scan-core.js");
require("../../../../shared/nav.js"); // registers window.Nav (used by the exit path)

// ---- Phaser + global stubs (must exist before requiring ui.js) -------------
global.Phaser = {
  Input: { Keyboard: { KeyCodes: { SPACE: 32 } } },
  Math: { Clamp: (v, a, b) => Math.min(Math.max(v, a), b) },
};
global.W = 1000;
global.H = 600;

const { ScanList, ScanInput } = require("../js/ui.js");

// A chainable no-op display object: every method returns itself; assigned
// properties (e.g. text._cx) persist and read back as their real values.
function makeChain() {
  const store = {};
  const obj = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop in store) return store[prop];
      if (prop === "isDown") return false;
      if (prop === Symbol.toPrimitive) return () => 0;
      return () => obj;
    },
    set(_t, prop, val) {
      store[prop] = val;
      return true;
    },
  });
  return obj;
}

function makeScene() {
  return {
    add: new Proxy({}, { get: () => () => makeChain() }),
    time: { addEvent: () => makeChain() },
    input: { keyboard: { addKey: () => ({ isDown: false }) }, on: () => {} },
    events: { once: () => {} },
  };
}

// ---- ScanInput lifecycle (track instances so window listeners don't leak) ---
const liveInputs = [];
function makeScanInput(handlers) {
  const si = new ScanInput(makeScene(), handlers);
  liveInputs.push(si);
  return si;
}
function dispatch(type, code, extra) {
  window.dispatchEvent(
    new window.KeyboardEvent(type, Object.assign({ code }, extra || {})),
  );
}
function pressKey(code) {
  dispatch("keydown", code);
  dispatch("keyup", code);
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  while (liveInputs.length) liveInputs.pop().destroy();
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("ScanList menu scanning (migrated onto ScanController)", () => {
  test("is backed by the shared ScanController", () => {
    const list = new ScanList(makeScene(), {
      x: 500,
      y: 300,
      options: [{ label: "A", value: "a" }],
      audio: { play: jest.fn(), speak: jest.fn() },
      onSelect: jest.fn(),
    });
    expect(list.scan).toBeInstanceOf(ScanController);
  });

  test("scans forward, wraps, scans back, and selects through the controller", () => {
    const onSelect = jest.fn();
    const audio = { play: jest.fn(), speak: jest.fn() };
    const list = new ScanList(makeScene(), {
      x: 500,
      y: 300,
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
        { label: "C", value: "c" },
      ],
      audio,
      onSelect,
    });

    expect(list.index).toBe(-1);

    list.next(false); // -1 -> 0
    expect(list.index).toBe(0);
    expect(audio.play).toHaveBeenCalledWith("scan");
    expect(audio.speak).toHaveBeenLastCalledWith("A", true);

    list.next(false); // 0 -> 1
    list.next(false); // 1 -> 2
    expect(list.index).toBe(2);

    list.next(false); // 2 -> 0 (wrap forward)
    expect(list.index).toBe(0);

    list.prev(false); // 0 -> 2 (wrap backward)
    expect(list.index).toBe(2);

    list.select();
    expect(audio.play).toHaveBeenLastCalledWith("select");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ label: "C", value: "c" }, 2);
  });

  test("select with nothing highlighted is a no-op", () => {
    const onSelect = jest.fn();
    const list = new ScanList(makeScene(), {
      x: 500,
      y: 300,
      options: [{ label: "A", value: "a" }],
      audio: { play: jest.fn(), speak: jest.fn() },
      onSelect,
    });
    list.select(); // index is -1
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("ScanInput key handling", () => {
  test("select fires for Enter AND NumpadEnter (NumpadEnter parity)", () => {
    const h = { forward: jest.fn(), backward: jest.fn(), select: jest.fn() };
    makeScanInput(h);

    pressKey("Enter");
    expect(h.select).toHaveBeenCalledTimes(1);

    pressKey("NumpadEnter");
    expect(h.select).toHaveBeenCalledTimes(2); // parity: NumpadEnter == Enter

    pressKey("KeyA"); // a non-select key does nothing
    expect(h.select).toHaveBeenCalledTimes(2);
  });

  test("a Space tap (press + release) advances exactly once", () => {
    const h = { forward: jest.fn(), backward: jest.fn(), select: jest.fn() };
    makeScanInput(h);
    pressKey("Space");
    expect(h.forward).toHaveBeenCalledTimes(1);
    expect(h.backward).not.toHaveBeenCalled();
  });
});

describe("anti-tremor guards preserved (no min-press floor; e.repeat + re-fire)", () => {
  test("OS auto-repeat keydowns are ignored — a held Space does not machine-gun", () => {
    const h = { forward: jest.fn(), backward: jest.fn(), select: jest.fn() };
    makeScanInput(h);

    dispatch("keydown", "Space"); // genuine press
    dispatch("keydown", "Space", { repeat: true }); // auto-repeat -> ignored
    dispatch("keydown", "Space", { repeat: true }); // auto-repeat -> ignored
    dispatch("keyup", "Space"); // release -> a single forward

    expect(h.forward).toHaveBeenCalledTimes(1);
    expect(h.backward).not.toHaveBeenCalled();
  });

  test("after focus loss, a re-fired Space keydown is ignored until a real keyup", () => {
    const h = { forward: jest.fn(), backward: jest.fn(), select: jest.fn() };
    makeScanInput(h);

    dispatch("keydown", "Space"); // press and hold
    window.dispatchEvent(new window.Event("blur")); // focus lost -> clears + arms guard

    // Adaptive switch re-fires a fresh (non-repeat) keydown while still held:
    dispatch("keydown", "Space"); // guarded by awaitingSpaceRelease -> no new timer
    jest.advanceTimersByTime(5000); // would trigger backward if a timer were armed
    expect(h.backward).not.toHaveBeenCalled();

    dispatch("keyup", "Space"); // genuine keyup clears the guard...
    expect(h.forward).not.toHaveBeenCalled(); // ...and the guarded press never advanced

    // Subsequent presses work normally again.
    pressKey("Space");
    expect(h.forward).toHaveBeenCalledTimes(1);
  });
});
