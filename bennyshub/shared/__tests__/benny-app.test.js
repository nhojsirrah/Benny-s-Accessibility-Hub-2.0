/**
 * @jest-environment jsdom
 *
 * Tests for the BennyApp / BennyGame base classes. The ScanController is
 * stubbed and injected via options.ScanController so these tests stand alone
 * without the sibling scan-core implementation.
 */

const { BennyApp, BennyGame } = require("../benny-app");

/**
 * Minimal ScanController stub. Captures the options it was constructed with and
 * records lifecycle calls so tests can drive focus/select/pause directly.
 */
function makeStubController() {
  const calls = { attach: 0, detach: 0, destroy: 0, focusIndex: [] };
  class StubController {
    constructor(options) {
      this.options = options;
      StubController.lastInstance = this;
    }
    attach() {
      calls.attach += 1;
    }
    detach() {
      calls.detach += 1;
    }
    destroy() {
      calls.destroy += 1;
    }
    focusIndex(i) {
      calls.focusIndex.push(i);
    }
    // Test helpers that simulate the controller invoking app hooks.
    simulateFocus(i) {
      const t = this.options.getTargets()[i];
      this.options.onFocus(t, i);
      this.options.onAnnounce(t, i);
      return t;
    }
    simulateSelect(i) {
      const t = this.options.getTargets()[i];
      this.options.onSelect(t, i);
      return t;
    }
    simulatePause() {
      this.options.onPause();
    }
  }
  StubController.calls = calls;
  return StubController;
}

function makeVoiceMock() {
  return { speak: jest.fn() };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("BennyApp lifecycle", () => {
  test("mount() constructs the ScanController wired to app hooks and attaches", () => {
    const Stub = makeStubController();
    const voice = makeVoiceMock();
    const app = new BennyApp({ ScanController: Stub, voice });

    const returned = app.mount(document.body);

    expect(returned).toBe(app);
    expect(app.scan).toBeInstanceOf(Stub);
    expect(Stub.calls.attach).toBe(1);

    const opts = app.scan.options;
    expect(typeof opts.getTargets).toBe("function");
    expect(typeof opts.onFocus).toBe("function");
    expect(typeof opts.onSelect).toBe("function");
    expect(typeof opts.onAnnounce).toBe("function");
    expect(typeof opts.onPause).toBe("function");
    expect(opts.wrap).toBe(true);
  });

  test("teardown() destroys the controller and nulls it out", () => {
    const Stub = makeStubController();
    const app = new BennyApp({ ScanController: Stub });
    app.mount(document.body);

    app.teardown();

    expect(Stub.calls.destroy).toBe(1);
    expect(app.scan).toBeNull();
  });

  test("lifecycle hooks fire", () => {
    const Stub = makeStubController();
    const onMount = jest.fn();
    const onTeardown = jest.fn();
    const app = new BennyApp({ ScanController: Stub });
    app.onMount = onMount;
    app.onTeardown = onTeardown;

    app.mount(document.body);
    expect(onMount).toHaveBeenCalledTimes(1);

    app.teardown();
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  test("speak() delegates to the injected voice mock", () => {
    const voice = makeVoiceMock();
    const app = new BennyApp({ ScanController: makeStubController(), voice });

    app.speak("hello", { rate: 1 });

    expect(voice.speak).toHaveBeenCalledWith("hello", { rate: 1 });
  });

  test("default onFocus toggles scan-focus and clears previous focus", () => {
    const app = new BennyApp({ ScanController: makeStubController() });
    const a = document.createElement("button");
    const b = document.createElement("button");
    document.body.append(a, b);

    app.onFocus(a);
    expect(a.classList.contains("scan-focus")).toBe(true);

    app.onFocus(b);
    expect(b.classList.contains("scan-focus")).toBe(true);
    expect(a.classList.contains("scan-focus")).toBe(false);
  });

  test("default onAnnounce speaks the element label", () => {
    const voice = makeVoiceMock();
    const app = new BennyApp({ ScanController: makeStubController(), voice });
    const el = document.createElement("button");
    el.setAttribute("aria-label", "Play");

    app.onAnnounce(el);

    expect(voice.speak).toHaveBeenCalledWith("Play", undefined);
  });
});

describe("BennyGame abstract contract", () => {
  test("getScanTargets() throws on the base game until overridden", () => {
    const game = new BennyGame({ ScanController: makeStubController() });
    expect(() => game.getScanTargets()).toThrow(/abstract/i);
  });

  test("onSelect() throws on the base game until overridden", () => {
    const game = new BennyGame({ ScanController: makeStubController() });
    expect(() => game.onSelect()).toThrow(/abstract/i);
  });

  test("a concrete subclass works end-to-end via the injected stub", () => {
    const Stub = makeStubController();
    const voice = makeVoiceMock();
    const selected = [];

    const tileA = document.createElement("button");
    tileA.setAttribute("aria-label", "Apple");
    const tileB = document.createElement("button");
    tileB.setAttribute("aria-label", "Banana");
    document.body.append(tileA, tileB);

    class FruitGame extends BennyGame {
      getScanTargets() {
        return [tileA, tileB];
      }
      onSelect(target, index) {
        selected.push(index);
      }
    }

    const game = new FruitGame({ ScanController: Stub, voice });
    game.mount(document.body);

    // Scanner steps to the second tile: highlight + announce.
    const focused = game.scan.simulateFocus(1);
    expect(focused).toBe(tileB);
    expect(tileB.classList.contains("scan-focus")).toBe(true);
    expect(voice.speak).toHaveBeenCalledWith("Banana", undefined);

    // Scanner selects the first tile.
    game.scan.simulateSelect(0);
    expect(selected).toEqual([0]);
  });
});

describe("BennyGame pause/back overlay", () => {
  test("onPause() builds and shows the overlay and switches targets to its buttons", () => {
    const Stub = makeStubController();

    class FruitGame extends BennyGame {
      getScanTargets() {
        return [document.createElement("button")];
      }
      onSelect() {}
    }

    const game = new FruitGame({ ScanController: Stub });
    game.mount(document.body);

    game.scan.simulatePause();

    const overlay = document.getElementById("benny-pause-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay.style.display).toBe("flex");
    expect(game.paused).toBe(true);

    const targets = game.scan.options.getTargets();
    expect(targets).toHaveLength(2);
    expect(targets[0].getAttribute("data-action")).toBe("continue");
    expect(targets[1].getAttribute("data-action")).toBe("back");
  });

  test("selecting Continue resumes and hides the overlay", () => {
    const Stub = makeStubController();

    class FruitGame extends BennyGame {
      getScanTargets() {
        return [];
      }
      onSelect() {}
    }

    const game = new FruitGame({ ScanController: Stub });
    game.mount(document.body);
    game.scan.simulatePause();

    // Continue is the first overlay target.
    game.scan.simulateSelect(0);

    expect(game.paused).toBe(false);
    expect(document.getElementById("benny-pause-overlay").style.display).toBe(
      "none",
    );
  });

  test("selecting Back invokes onBack()", () => {
    const Stub = makeStubController();
    const onBack = jest.fn();

    class FruitGame extends BennyGame {
      getScanTargets() {
        return [];
      }
      onSelect() {}
    }

    const game = new FruitGame({ ScanController: Stub });
    game.onBack = onBack;
    game.mount(document.body);
    game.scan.simulatePause();

    // Back is the second overlay target.
    game.scan.simulateSelect(1);

    expect(onBack).toHaveBeenCalledTimes(1);
    // Back does not auto-resume; the game owns navigation.
    expect(game.paused).toBe(true);
  });

  test("overlay buttons get the default scan-focus highlight while paused", () => {
    const Stub = makeStubController();

    class FruitGame extends BennyGame {
      getScanTargets() {
        return [];
      }
      onSelect() {}
    }

    const game = new FruitGame({ ScanController: Stub });
    game.mount(document.body);
    game.scan.simulatePause();

    const focused = game.scan.simulateFocus(0);
    expect(focused.getAttribute("data-action")).toBe("continue");
    expect(focused.classList.contains("scan-focus")).toBe(true);
  });
});
