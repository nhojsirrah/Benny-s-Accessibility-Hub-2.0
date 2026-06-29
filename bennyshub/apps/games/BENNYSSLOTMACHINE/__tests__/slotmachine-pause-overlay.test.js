/**
 * Tests for BENNYSSLOTMACHINE's adoption of the shared <benny-pause-overlay>.
 *
 * The slot machine retires its bespoke MAIN pause menu in favour of the shared
 * overlay (window.BennyPauseOverlay, shared/pause-overlay.js). The game's own
 * single-axis ScanController still drives stepping/selection: while the overlay is
 * open getScanTargets() returns the overlay's action buttons and a select runs
 * through overlay.activate(). The pause-settings sub-page (a grid of settings
 * toggles, out of the simple action-list shape) stays bespoke and keeps rendering
 * into the legacy in-page #pause-overlay container.
 *
 * Runs in jsdom with jest fake timers. The shared overlay is mocked here against
 * PAUSE-OVERLAY CONTRACT v1 and exposed on window exactly as the shipped
 * <script src="../../../shared/pause-overlay.js"> would. Selecting/advancing goes
 * through the real ScanController, whose 200ms anti-tremor floor means taps must
 * clear the cooldown (advance the clock) to be accepted.
 */

const fs = require("fs");
const pathlib = require("path");

const ScanController = require("../../../../shared/scan-core.js");
const SettingsStore = require("../../../../shared/settings-store.js");
const Nav = require("../../../../shared/nav.js");

// ---- Helpers -------------------------------------------------------------

let now = 0;

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

// Short press = keydown immediately followed by keyup (advances on Space, selects
// on Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

// Advance past the 200ms anti-tremor floor, then tap — the normal deliberate press.
function tapAfterCooldown(code) {
  now += 250;
  jest.setSystemTime(now);
  tap(code);
}

function makeMockScanManager() {
  const subscribers = [];
  return {
    autoScan: false,
    interval: 2000,
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
    cycleScanSpeed() {},
    setAutoScan(v) {
      this.autoScan = !!v;
    },
    subscribe(cb) {
      subscribers.push(cb);
    },
    unsubscribe(cb) {
      const i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    },
  };
}

// Minimal AudioContext stub — startGame() calls initAudio(), which jsdom cannot do.
function makeAudioContextStub() {
  return class {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
    }
    resume() {
      return Promise.resolve();
    }
    createOscillator() {
      return {
        type: "",
        frequency: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        start() {},
        stop() {},
      };
    }
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    }
    createBiquadFilter() {
      return {
        type: "",
        frequency: { value: 0, setValueAtTime() {} },
        connect() {},
      };
    }
  };
}

// Faithful mock of PAUSE-OVERLAY CONTRACT v1: create({actions,scanManager,voice})
// -> { show/hide/isOpen/setActions/getTargets/activate }. getTargets() returns real
// <button> elements (in render order) so the app's ScanController can scan/activate
// them just as it would the shipped <benny-pause-overlay>. activate(target) emits a
// `pause-action` CustomEvent {id} then runs the action's onSelect.
function makeMockPauseOverlay() {
  let last = null;
  return {
    create(opts) {
      const el = document.createElement("div");
      el.id = "benny-pause-overlay-mock";
      el.style.display = "none";
      document.body.appendChild(el);

      let actions = [];
      let buttons = [];
      let open = false;

      function render() {
        el.innerHTML = "";
        buttons = actions.map((a) => {
          const btn = document.createElement("button");
          btn.className = "benny-pause-action";
          btn.textContent = a.label;
          btn.dataset.actionId = a.id;
          btn.onclick = () => instance.activate(btn);
          el.appendChild(btn);
          return btn;
        });
      }

      const instance = {
        el,
        scanManager: opts.scanManager,
        voice: opts.voice,
        setActions(next) {
          actions = (next || []).slice();
          if (open) render();
        },
        getTargets() {
          return buttons.slice();
        },
        isOpen() {
          return open;
        },
        show() {
          open = true;
          el.style.display = "flex";
          render();
        },
        hide() {
          open = false;
          el.style.display = "none";
        },
        activate(target) {
          const idx = buttons.indexOf(target);
          if (idx < 0) return;
          const action = actions[idx];
          el.dispatchEvent(
            new CustomEvent("pause-action", { detail: { id: action.id } }),
          );
          if (action && typeof action.onSelect === "function")
            action.onSelect();
        },
      };

      instance.setActions(opts.actions || []);
      last = instance;
      return instance;
    },
    last() {
      return last;
    },
  };
}

// The app shell markup, pulled from index.html (scripts stripped) so the test DOM
// stays in sync with the real page's element IDs.
function loadAppShell() {
  const html = fs.readFileSync(
    pathlib.join(__dirname, "..", "index.html"),
    "utf8",
  );
  const body = html
    .replace(/[\s\S]*<body[^>]*>/i, "")
    .replace(/<\/body>[\s\S]*/i, "");
  return body.replace(/<script[\s\S]*?<\/script>/gi, "");
}

const APP_SHELL = loadAppShell();

// menus.pause labels as the user sees them, resolved through the dynamic text fns.
function liveMenuLabels(app) {
  return app.menus.pause.map((m) =>
    typeof m.text === "function" ? m.text() : m.text,
  );
}

// Stand up the shared-module globals + DOM and (re)load the app fresh. Pass
// withOverlay=false to exercise the no-contract fallback.
function bootApp({ withOverlay = true } = {}) {
  localStorage.clear();
  SettingsStore._reset();

  document.body.innerHTML = APP_SHELL;

  // jsdom has no 2D canvas context; the game guards on a null context.
  if (!HTMLCanvasElement.prototype.getContext.__stubbed) {
    HTMLCanvasElement.prototype.getContext = function () {
      return null;
    };
    HTMLCanvasElement.prototype.getContext.__stubbed = true;
  }

  window.ScanController = ScanController;
  window.SettingsStore = SettingsStore;
  window.Nav = Nav;
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };
  window.AudioContext = makeAudioContextStub();

  if (withOverlay) {
    window.BennyPauseOverlay = makeMockPauseOverlay();
  } else {
    delete window.BennyPauseOverlay;
  }

  jest.resetModules();
  const app = require("../script.js");
  app.init();
  return app;
}

let app;

beforeEach(() => {
  jest.useFakeTimers();
  // Start well past the 24h buy/refill cooldowns so the dynamic "Buy 500 Credits"
  // label is stable across runs.
  now = 100 * 60 * 60 * 1000;
  jest.setSystemTime(now);
});

afterEach(() => {
  try {
    app?.getScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  delete window.BennyPauseOverlay;
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Overlay adoption ----------------------------------------------------

describe("pause opens the shared overlay with the migrated actions", () => {
  beforeEach(() => {
    app = bootApp();
  });

  test("showPauseMenu shows the overlay populated with the five pause actions", () => {
    app.startGame();
    app.showPauseMenu();

    const overlay = app.getPauseOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay.isOpen()).toBe(true);
    expect(app.state.mode).toBe("pause");

    const targets = overlay.getTargets();
    expect(targets).toHaveLength(5);
    expect(targets[0].textContent).toBe("▶️ Continue");
    expect(targets[targets.length - 1].textContent).toBe("🚪 Exit");
  });

  test("the migrated actions mirror menus.pause verbatim (labels + ids)", () => {
    app.startGame();
    app.showPauseMenu();

    const overlayLabels = app
      .getPauseOverlay()
      .getTargets()
      .map((b) => b.textContent);
    expect(overlayLabels).toEqual(liveMenuLabels(app));

    expect(app.pauseOverlayActions().map((a) => a.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  test("the ScanController scans the overlay's buttons while it is open", () => {
    app.startGame();
    app.showPauseMenu();

    const overlayTargets = app.getPauseOverlay().getTargets();
    const scanned = app.getScanTargets();
    expect(scanned).toHaveLength(overlayTargets.length);
    scanned.forEach((node, i) => expect(node).toBe(overlayTargets[i]));
    // Seated on the first action (Continue).
    expect(app.getScan().getIndex()).toBe(0);
  });

  test("Space advances through the overlay targets", () => {
    app.startGame();
    app.showPauseMenu();
    expect(app.getScan().getIndex()).toBe(0);

    tapAfterCooldown("Space");
    expect(app.getScan().getIndex()).toBe(1);
    expect(app.state.pauseIndex).toBe(1);

    tapAfterCooldown("Space");
    expect(app.getScan().getIndex()).toBe(2);
    expect(app.state.pauseIndex).toBe(2);
  });
});

// ---- Selection routes through overlay.activate() -------------------------

describe("scanning + selecting routes through the overlay", () => {
  beforeEach(() => {
    app = bootApp();
  });

  test("selecting Continue (Enter) closes the overlay and resumes the game", () => {
    app.startGame();
    app.showPauseMenu();
    const overlay = app.getPauseOverlay();
    expect(overlay.isOpen()).toBe(true);

    // Seated on Continue (index 0) at open; select it.
    tapAfterCooldown("Enter");

    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("game");
    expect(document.getElementById("pause-overlay").style.display).toBe("none");
  });

  test("NumpadEnter selects identically to Enter (Continue resumes)", () => {
    app.startGame();
    app.showPauseMenu();
    const overlay = app.getPauseOverlay();

    tapAfterCooldown("NumpadEnter");

    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("game");
  });

  test("selecting Exit runs the exit path (Nav.goBack after the spoken cue)", () => {
    const goBack = jest.spyOn(Nav, "goBack").mockImplementation(() => {});

    app.startGame();
    app.showPauseMenu();

    // Scan to the last action (Exit, index 4).
    tapAfterCooldown("Space"); // 0 -> 1
    tapAfterCooldown("Space"); // 1 -> 2
    tapAfterCooldown("Space"); // 2 -> 3
    tapAfterCooldown("Space"); // 3 -> 4
    expect(app.getScan().getIndex()).toBe(4);
    expect(app.state.pauseIndex).toBe(4);

    tapAfterCooldown("Enter"); // activate Exit -> exitGame
    expect(goBack).not.toHaveBeenCalled(); // deferred 500ms behind the TTS cue
    jest.advanceTimersByTime(500);
    expect(goBack).toHaveBeenCalledTimes(1);

    goBack.mockRestore();
  });

  test("activate emits a `pause-action` event carrying the action id", () => {
    app.startGame();
    app.showPauseMenu();
    const overlay = app.getPauseOverlay();

    const seen = [];
    overlay.el.addEventListener("pause-action", (e) => seen.push(e.detail.id));

    // Scan to Buy 500 Credits (index 1) — it stays on the pause page after select.
    tapAfterCooldown("Space");
    tapAfterCooldown("Enter");

    expect(seen).toEqual(["1"]);
    // Still paused on the (refreshed) overlay.
    expect(app.state.mode).toBe("pause");
    expect(overlay.isOpen()).toBe(true);
  });
});

// ---- Pause settings sub-page (kept bespoke) ------------------------------

describe("pause settings sub-page stays bespoke", () => {
  beforeEach(() => {
    app = bootApp();
  });

  test("Settings hides the overlay and shows the legacy in-page settings grid", () => {
    app.startGame();
    app.showPauseMenu();
    const overlay = app.getPauseOverlay();

    // Scan to Settings (index 2) and select it.
    tapAfterCooldown("Space"); // 0 -> 1
    tapAfterCooldown("Space"); // 1 -> 2
    expect(app.state.pauseIndex).toBe(2);
    tapAfterCooldown("Enter"); // activate Settings -> showPauseSettings

    expect(overlay.isOpen()).toBe(false);
    expect(app.state.mode).toBe("pause");
    expect(app.state.pauseMenuState).toBe("settings");
    expect(document.getElementById("pause-overlay").style.display).toBe("flex");
    // Scan now reads the legacy settings menu, not the overlay buttons.
    expect(app.getScanTargets()).toBe(app.menus.pauseSettings);
  });

  test("Back from pause settings reopens the shared overlay", () => {
    app.startGame();
    app.showPauseMenu();
    app.showPauseSettings();
    expect(app.getPauseOverlay().isOpen()).toBe(false);

    // "Back" is the last pauseSettings item -> showPauseMenu.
    const back = app.menus.pauseSettings[app.menus.pauseSettings.length - 1];
    back.action();

    expect(app.state.pauseMenuState).toBe("main");
    expect(app.getPauseOverlay().isOpen()).toBe(true);
    expect(document.getElementById("pause-overlay").style.display).toBe("none");
  });
});

// ---- Fallback when the contract is absent --------------------------------

describe("fallback: legacy pause menu when BennyPauseOverlay is absent", () => {
  beforeEach(() => {
    app = bootApp({ withOverlay: false });
  });

  test("no overlay is created and the legacy in-page pause menu is used", () => {
    app.startGame();
    app.showPauseMenu();

    expect(app.getPauseOverlay()).toBeNull();
    expect(app.state.mode).toBe("pause");
    // Legacy scan targets + visible in-page overlay container.
    expect(app.getScanTargets()).toBe(app.menus.pause);
    expect(document.getElementById("pause-overlay").style.display).toBe("flex");
  });

  test("Enter still selects the focused legacy pause item (Continue resumes)", () => {
    app.startGame();
    app.showPauseMenu();
    expect(app.getScan().getIndex()).toBe(0); // Continue

    tapAfterCooldown("Enter");

    expect(app.state.mode).toBe("game");
    expect(document.getElementById("pause-overlay").style.display).toBe("none");
  });
});
