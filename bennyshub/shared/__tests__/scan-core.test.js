/**
 * Conformance tests for ScanController (scan-core.js).
 *
 * Runs in jsdom with jest fake timers and injected mock scanManager / voice,
 * so no real DOM globals or shared modules are required.
 */

const ScanController = require("../scan-core.js");

// ---- Test helpers --------------------------------------------------------

function makeTarget(label) {
  const el = document.createElement("button");
  el.setAttribute("aria-label", label);
  el.textContent = label;
  return el;
}

function makeTargets(labels) {
  return labels.map(makeTarget);
}

function dispatchKey(type, code, opts = {}) {
  const event = new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
    repeat: !!opts.repeat,
  });
  document.dispatchEvent(event);
  return event;
}

function makeMockScanManager(overrides = {}) {
  const subscribers = [];
  return {
    autoScan: overrides.autoScan || false,
    interval: overrides.interval || 2000,
    getSettings() {
      return {
        autoScan: this.autoScan,
        scanSpeedIndex: 1,
        scanInterval: this.interval,
      };
    },
    getScanInterval() {
      return this.interval;
    },
    subscribe(cb) {
      subscribers.push(cb);
    },
    unsubscribe(cb) {
      const i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    },
    _emit() {
      subscribers.forEach((cb) => cb());
    },
    _subscriberCount() {
      return subscribers.length;
    },
  };
}

function buildController(extra = {}) {
  const onFocus = jest.fn();
  const onBlur = jest.fn();
  const onSelect = jest.fn();
  const onAnnounce = jest.fn();
  const onPause = jest.fn();
  const voice = { speak: jest.fn() };
  const scanManager = extra.scanManager || makeMockScanManager();
  const targets =
    extra.targets !== undefined ? extra.targets : makeTargets(["A", "B", "C"]);

  const controller = new ScanController({
    getTargets: () => targets,
    onFocus,
    onBlur,
    onSelect,
    onAnnounce: extra.useDefaultAnnounce ? undefined : onAnnounce,
    onPause,
    voice,
    scanManager,
    ...(extra.options || {}),
  });

  return {
    controller,
    onFocus,
    onBlur,
    onSelect,
    onAnnounce,
    onPause,
    voice,
    scanManager,
    targets,
  };
}

// ---- Setup / teardown ----------------------------------------------------

let active = [];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  active = [];
});

afterEach(() => {
  active.forEach((c) => c.destroy());
  jest.clearAllTimers();
  jest.useRealTimers();
});

function track(controller) {
  active.push(controller);
  return controller;
}

// ---- Tests ---------------------------------------------------------------

describe("Space (short press) scanning", () => {
  test("short Space press advances forward", () => {
    const { controller, onFocus } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space");

    expect(controller.getIndex()).toBe(0);
    expect(onFocus).toHaveBeenLastCalledWith(expect.anything(), 0);

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space");
    expect(controller.getIndex()).toBe(1);
  });

  test("forward wrap-around", () => {
    const { controller } = buildController();
    track(controller).attach();

    for (let i = 0; i < 3; i++) {
      dispatchKey("keydown", "Space");
      dispatchKey("keyup", "Space");
    }
    expect(controller.getIndex()).toBe(2); // A,B,C -> index 2

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space");
    expect(controller.getIndex()).toBe(0); // wrapped
  });

  test("backward wrap-around via back()", () => {
    const { controller } = buildController();
    track(controller).attach();

    controller.back(); // from -1, lands on last
    expect(controller.getIndex()).toBe(2);
    controller.back();
    expect(controller.getIndex()).toBe(1);
  });

  test("wrap=false clamps instead of wrapping", () => {
    const { controller } = buildController({ options: { wrap: false } });
    track(controller).attach();

    controller.setIndex(2);
    controller.advance();
    expect(controller.getIndex()).toBe(2); // clamped at end

    controller.setIndex(0);
    controller.back();
    expect(controller.getIndex()).toBe(0); // clamped at start
  });
});

describe("Enter / NumpadEnter selection", () => {
  test("short Enter selects current target", () => {
    const { controller, onSelect } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space"); // index 0
    dispatchKey("keydown", "Enter");
    dispatchKey("keyup", "Enter");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.anything(), 0);
  });

  test("NumpadEnter selects identically to Enter (parity)", () => {
    const { controller, onSelect } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space"); // index 0
    dispatchKey("keydown", "NumpadEnter");
    dispatchKey("keyup", "NumpadEnter");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.anything(), 0);
  });

  test("Space is a scan key, not a select key", () => {
    const { controller, onSelect } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space");

    expect(onSelect).not.toHaveBeenCalled();
  });

  test("predicates: isScan/isSelect", () => {
    const { controller } = buildController();
    track(controller);
    expect(controller.isScan({ code: "Space" })).toBe(true);
    expect(controller.isScan({ code: "Enter" })).toBe(false);
    expect(controller.isSelect({ code: "Enter" })).toBe(true);
    expect(controller.isSelect({ code: "NumpadEnter" })).toBe(true);
    expect(controller.isSelect({ code: "Space" })).toBe(false);
  });
});

describe("e.repeat handling", () => {
  test("repeat keydown is ignored (no advance, no hold start)", () => {
    const { controller, onFocus } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Space", { repeat: true });
    dispatchKey("keyup", "Space");
    expect(onFocus).not.toHaveBeenCalled();
    expect(controller.getIndex()).toBe(-1);

    // And a repeat does not start the reverse hold timer.
    jest.advanceTimersByTime(10000);
    expect(onFocus).not.toHaveBeenCalled();
  });

  test("repeat Enter keydown does not select or arm pause", () => {
    const { controller, onSelect, onPause } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Enter", { repeat: true });
    jest.advanceTimersByTime(10000);
    dispatchKey("keyup", "Enter");

    expect(onSelect).not.toHaveBeenCalled();
    expect(onPause).not.toHaveBeenCalled();
  });
});

describe("Hold Space -> reverse scanning", () => {
  test("holding Space >= spaceHoldMs begins reverse, then back() every reverseCadenceMs", () => {
    const { controller, onFocus } = buildController();
    track(controller).attach();

    // Seed an index so reverse movement is observable.
    controller.setIndex(2);

    dispatchKey("keydown", "Space");
    // Just before threshold: nothing yet.
    jest.advanceTimersByTime(2999);
    expect(onFocus).not.toHaveBeenCalled();

    // Cross the hold threshold -> immediate back().
    jest.advanceTimersByTime(1); // total 3000
    expect(controller.getIndex()).toBe(1);
    expect(onFocus).toHaveBeenCalledTimes(1);

    // Then back() every reverseCadenceMs (2000).
    jest.advanceTimersByTime(2000);
    expect(controller.getIndex()).toBe(0);
    jest.advanceTimersByTime(2000);
    expect(controller.getIndex()).toBe(2); // wrapped backward

    expect(onFocus).toHaveBeenCalledTimes(3);
  });

  test("releasing after reverse started does NOT fire an extra advance", () => {
    const { controller } = buildController();
    track(controller).attach();
    controller.setIndex(2);

    dispatchKey("keydown", "Space");
    jest.advanceTimersByTime(3000); // reverse begins -> index 1
    expect(controller.getIndex()).toBe(1);

    jest.setSystemTime(3000);
    dispatchKey("keyup", "Space");
    // No forward advance on release.
    expect(controller.getIndex()).toBe(1);
  });
});

describe("Hold Enter -> pause", () => {
  test("holding Enter >= enterHoldMs fires onPause once", () => {
    const { controller, onPause, onSelect } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Enter");
    jest.advanceTimersByTime(4999);
    expect(onPause).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1); // 5000
    expect(onPause).toHaveBeenCalledTimes(1);

    // Continued hold does not fire again.
    jest.advanceTimersByTime(10000);
    expect(onPause).toHaveBeenCalledTimes(1);

    // Release after a pause does NOT also select.
    jest.setSystemTime(15001);
    dispatchKey("keyup", "Enter");
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("short Enter does NOT pause", () => {
    const { controller, onPause, onSelect } = buildController();
    track(controller).attach();
    controller.setIndex(0);

    dispatchKey("keydown", "Enter");
    jest.setSystemTime(100);
    dispatchKey("keyup", "Enter");

    expect(onPause).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("Hold Enter -> pause repeat (onPauseRepeatMs)", () => {
  test("with onPauseRepeatMs set, onPause fires once then repeats while held", () => {
    const { controller, onPause } = buildController({
      options: { onPauseRepeatMs: 2000 },
    });
    track(controller).attach();

    dispatchKey("keydown", "Enter");
    jest.advanceTimersByTime(4999);
    expect(onPause).not.toHaveBeenCalled();

    // Cross the hold threshold -> first onPause.
    jest.advanceTimersByTime(1); // total 5000
    expect(onPause).toHaveBeenCalledTimes(1);

    // Then onPause every onPauseRepeatMs (2000) while Enter stays held.
    jest.advanceTimersByTime(2000);
    expect(onPause).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(2000);
    expect(onPause).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(4000); // two more ticks
    expect(onPause).toHaveBeenCalledTimes(5);
  });

  test("Enter keyup stops the pause repeat (and does not also select)", () => {
    const { controller, onPause, onSelect } = buildController({
      options: { onPauseRepeatMs: 2000 },
    });
    track(controller).attach();

    dispatchKey("keydown", "Enter");
    jest.advanceTimersByTime(5000); // first onPause
    jest.advanceTimersByTime(2000); // one repeat
    expect(onPause).toHaveBeenCalledTimes(2);

    dispatchKey("keyup", "Enter");
    jest.advanceTimersByTime(10000);
    expect(onPause).toHaveBeenCalledTimes(2); // no further repeats
    expect(onSelect).not.toHaveBeenCalled(); // pause already consumed the press
  });

  test("detach stops the pause repeat", () => {
    const { controller, onPause } = buildController({
      options: { onPauseRepeatMs: 2000 },
    });
    track(controller).attach();

    dispatchKey("keydown", "Enter");
    jest.advanceTimersByTime(5000);
    expect(onPause).toHaveBeenCalledTimes(1);

    controller.detach();
    jest.advanceTimersByTime(10000);
    expect(onPause).toHaveBeenCalledTimes(1); // repeat stopped on detach
  });

  test("without onPauseRepeatMs, onPause fires exactly once (regression)", () => {
    const { controller, onPause } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Enter");
    jest.advanceTimersByTime(5000);
    expect(onPause).toHaveBeenCalledTimes(1);

    // Even a long continued hold fires only once.
    jest.advanceTimersByTime(20000);
    expect(onPause).toHaveBeenCalledTimes(1);
  });
});

describe("Focus / announce callbacks", () => {
  test("onFocus and onAnnounce receive the right target and index", () => {
    const { controller, onFocus, onAnnounce, targets } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space");

    expect(onFocus).toHaveBeenCalledWith(targets[0], 0);
    expect(onAnnounce).toHaveBeenCalledWith(targets[0], 0);
  });

  test("onBlur fires for the previous target before focusing a new one", () => {
    const { controller, onBlur, targets } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space"); // index 0, no blur yet
    expect(onBlur).not.toHaveBeenCalled();

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space"); // index 1, blur of 0
    expect(onBlur).toHaveBeenCalledWith(targets[0], 0);
  });

  test("default announce uses injected voice with aria-label", () => {
    const { controller, voice, targets } = buildController({
      useDefaultAnnounce: true,
    });
    track(controller).attach();

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space");

    expect(voice.speak).toHaveBeenCalledWith("A");
    expect(controller.getCurrentTarget()).toBe(targets[0]);
  });

  test("default announce skips empty labels and missing voice", () => {
    const blank = document.createElement("div"); // no label/text
    const { controller, voice } = buildController({
      targets: [blank],
      useDefaultAnnounce: true,
    });
    track(controller).attach();

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space");

    expect(voice.speak).not.toHaveBeenCalled();
  });

  test("advance() on empty targets is a no-op", () => {
    const { controller, onFocus } = buildController({ targets: [] });
    track(controller).attach();

    controller.advance();
    controller.back();
    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space");

    expect(onFocus).not.toHaveBeenCalled();
    expect(controller.getIndex()).toBe(-1);
  });
});

describe("detach / lifecycle", () => {
  test("detach removes listeners (no leak, no focus-trap)", () => {
    const { controller, onFocus } = buildController();
    track(controller).attach();

    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space");
    expect(onFocus).toHaveBeenCalledTimes(1);

    controller.detach();
    dispatchKey("keydown", "Space");
    dispatchKey("keyup", "Space");
    expect(onFocus).toHaveBeenCalledTimes(1); // unchanged
  });

  test("destroy clears auto-scan and timers", () => {
    const scanManager = makeMockScanManager({ autoScan: true });
    const { controller, onFocus } = buildController({ scanManager });
    track(controller).attach();
    controller.start();

    controller.destroy();
    jest.advanceTimersByTime(10000);
    expect(onFocus).not.toHaveBeenCalled();
    expect(scanManager._subscriberCount()).toBe(0);
  });
});

describe("Auto-scan", () => {
  test("with scanManager.autoScan=true, advances on each interval tick", () => {
    const scanManager = makeMockScanManager({ autoScan: true, interval: 2000 });
    const { controller, onFocus } = buildController({ scanManager });
    track(controller).attach();
    controller.start();

    jest.advanceTimersByTime(2000);
    expect(controller.getIndex()).toBe(0);
    jest.advanceTimersByTime(2000);
    expect(controller.getIndex()).toBe(1);
    expect(onFocus).toHaveBeenCalledTimes(2);
  });

  test("does not auto-advance while a switch is held", () => {
    const scanManager = makeMockScanManager({ autoScan: true, interval: 2000 });
    const { controller } = buildController({ scanManager });
    track(controller).attach();
    controller.start();

    dispatchKey("keydown", "Space"); // key held
    jest.advanceTimersByTime(2000);
    // The hold has not crossed spaceHoldMs (3000), and auto-scan is gated.
    expect(controller.getIndex()).toBe(-1);
  });

  test("honors getScanInterval() cadence", () => {
    const scanManager = makeMockScanManager({ autoScan: true, interval: 1000 });
    const { controller } = buildController({ scanManager });
    track(controller).attach();
    controller.start();

    jest.advanceTimersByTime(1000);
    expect(controller.getIndex()).toBe(0);
    jest.advanceTimersByTime(1000);
    expect(controller.getIndex()).toBe(1);
  });

  test("autoScan=false means no auto-advance", () => {
    const scanManager = makeMockScanManager({ autoScan: false });
    const { controller, onFocus } = buildController({ scanManager });
    track(controller).attach();
    controller.start();

    jest.advanceTimersByTime(10000);
    expect(onFocus).not.toHaveBeenCalled();
  });

  test("settings change restarts the timer with new cadence", () => {
    const scanManager = makeMockScanManager({ autoScan: true, interval: 2000 });
    const { controller } = buildController({ scanManager });
    track(controller).attach();
    controller.start();

    jest.advanceTimersByTime(2000);
    expect(controller.getIndex()).toBe(0);

    // Speed up cadence and notify subscribers.
    scanManager.interval = 1000;
    scanManager._emit();

    jest.advanceTimersByTime(1000);
    expect(controller.getIndex()).toBe(1);
  });

  test("option autoScan overrides scanManager setting", () => {
    const scanManager = makeMockScanManager({
      autoScan: false,
      interval: 1000,
    });
    const { controller } = buildController({
      scanManager,
      options: { autoScan: true },
    });
    track(controller).attach();
    controller.start();

    jest.advanceTimersByTime(1000);
    expect(controller.getIndex()).toBe(0);
  });
});

describe("Constructor validation", () => {
  test("throws without required callbacks", () => {
    expect(() => new ScanController({})).toThrow(/getTargets/);
    expect(() => new ScanController({ getTargets: () => [] })).toThrow(
      /onFocus/,
    );
    expect(
      () => new ScanController({ getTargets: () => [], onFocus: () => {} }),
    ).toThrow(/onSelect/);
  });
});
