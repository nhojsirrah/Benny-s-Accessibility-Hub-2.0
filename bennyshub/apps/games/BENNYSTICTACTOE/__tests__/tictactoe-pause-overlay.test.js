/**
 * Tests for BENNYSTICTACTOE's adoption of the shared <benny-pause-overlay>.
 *
 * Runs in jsdom with jest fake timers. The shared pause overlay (shipping in a
 * sibling PR) is mocked against PAUSE-OVERLAY CONTRACT v1 and exposed on window
 * exactly as the real <script src="../../../shared/pause-overlay.js"> would. The
 * game's own ScanController drives stepping/selection; the overlay only supplies
 * getTargets()/activate(). The existing scan + contract suites cover the absent-API
 * fallback path (they never define window.BennyPauseOverlay).
 */

const ScanController = require("../../../../shared/scan-core.js");

// ---- Helpers -------------------------------------------------------------

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

// Short press = keydown immediately followed by keyup (advances on Space,
// selects on Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
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

// Minimal CONTRACT v1 mock: create({actions,scanManager,voice}) -> overlay with
// show/hide/isOpen/setActions/getTargets/activate. getTargets() returns the action
// buttons; activate(target) runs that action's onSelect and emits a pause-action
// CustomEvent {id}.
let lastOverlay = null;
function installMockPauseOverlay() {
  window.BennyPauseOverlay = {
    create({ actions }) {
      let current = actions || [];
      let open = false;
      const root = document.createElement("div");
      root.className = "benny-pause-overlay-mock";
      document.body.appendChild(root);

      function render() {
        root.innerHTML = "";
        current.forEach((act, i) => {
          const btn = document.createElement("button");
          btn.className = "benny-pause-action";
          btn.dataset.actionId = act.id;
          btn.textContent = act.label;
          root.appendChild(btn);
        });
      }

      const api = {
        show() {
          open = true;
          root.style.display = "flex";
          render();
        },
        hide() {
          open = false;
          root.style.display = "none";
        },
        isOpen() {
          return open;
        },
        setActions(a) {
          current = a || [];
          if (open) render();
        },
        getTargets() {
          return Array.from(root.querySelectorAll("button"));
        },
        activate(target) {
          const btns = Array.from(root.querySelectorAll("button"));
          const i = btns.indexOf(target);
          if (i < 0 || !current[i]) return;
          root.dispatchEvent(
            new CustomEvent("pause-action", { detail: { id: current[i].id } }),
          );
          if (current[i].onSelect) current[i].onSelect();
        },
      };
      lastOverlay = api;
      return api;
    },
  };
}

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

  localStorage.clear();
  document.body.innerHTML =
    '<div id="header"></div><div id="main-content"></div>';

  lastOverlay = null;
  installMockPauseOverlay();

  window.ScanController = ScanController;
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };

  jest.resetModules();
  window.Themes = require("../../../../shared/themes.js");
  window.SettingsStore = require("../../../../shared/settings-store.js");
  window.Nav = require("../../../../shared/nav.js");
  app = require("../script.js");
  app.init();
});

afterEach(() => {
  try {
    app.getScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  delete window.BennyPauseOverlay;
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Tests ---------------------------------------------------------------

describe("opening pause shows the shared overlay with the right actions", () => {
  test("showPauseMenu builds and shows the overlay", () => {
    app.startGame("two");
    app.showPauseMenu();

    expect(app.state.mode).toBe("pause");
    const overlay = app.getPauseOverlay();
    expect(overlay).toBe(lastOverlay);
    expect(overlay.isOpen()).toBe(true);
  });

  test("overlay carries the same labels as the bespoke pause menu", () => {
    app.startGame("two");
    app.showPauseMenu();

    const labels = app
      .getPauseOverlay()
      .getTargets()
      .map((b) => b.textContent);
    expect(labels).toEqual([
      "Continue Game",
      "Settings",
      "Return to Menu",
      "Exit",
    ]);
  });

  test("the ScanController scans the overlay's action buttons while open", () => {
    app.startGame("two");
    app.showPauseMenu();

    const targets = app.getScanTargets();
    expect(targets).toEqual(app.getPauseOverlay().getTargets());
    expect(targets).toHaveLength(4);
    // Seated on the first action (Continue Game).
    expect(app.getScan().getCurrentTarget()).toBe(targets[0]);
  });
});

describe("scanning + selecting closes / routes correctly", () => {
  test("selecting Resume (Enter) closes the overlay and resumes the game", () => {
    app.startGame("two");
    app.showPauseMenu();
    expect(app.getPauseOverlay().isOpen()).toBe(true);

    tap("Enter"); // index 0 -> Continue Game -> resumeGame
    expect(app.state.mode).toBe("game");
    expect(app.getPauseOverlay().isOpen()).toBe(false);
  });

  test("NumpadEnter selects identically to Enter", () => {
    app.startGame("two");
    app.showPauseMenu();

    tap("NumpadEnter"); // index 0 -> Continue Game -> resumeGame
    expect(app.state.mode).toBe("game");
    expect(app.getPauseOverlay().isOpen()).toBe(false);
  });

  test("selecting Exit runs the exit path (Nav.goBack)", () => {
    const goBack = jest
      .spyOn(window.Nav, "goBack")
      .mockImplementation(() => {});

    app.startGame("two");
    app.showPauseMenu();

    tap("Space"); // -> Settings
    tap("Space"); // -> Return to Menu
    tap("Space"); // -> Exit
    expect(app.getScan().getIndex()).toBe(3);

    tap("Enter"); // activate Exit -> exitToHub
    expect(goBack).not.toHaveBeenCalled(); // deferred 500ms behind the TTS
    jest.advanceTimersByTime(500);
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  test("activate emits a pause-action CustomEvent carrying the action id", () => {
    app.startGame("two");
    app.showPauseMenu();

    const overlay = app.getPauseOverlay();
    const seen = [];
    overlay
      .getTargets()[0]
      .parentElement.addEventListener("pause-action", (e) =>
        seen.push(e.detail.id),
      );

    tap("Enter"); // index 0
    expect(seen).toEqual(["0"]);
  });
});

describe("pause settings submenu still works alongside the shared overlay", () => {
  test("Settings hides the overlay and shows the bespoke settings grid", () => {
    app.startGame("two");
    app.showPauseMenu();

    tap("Space"); // -> Settings (index 1)
    tap("Enter"); // activate Settings -> showPauseSettings

    expect(app.state.mode).toBe("pause");
    expect(app.state.pauseMenuState).toBe("settings");
    expect(app.getPauseOverlay().isOpen()).toBe(false);
    // The bespoke settings grid (btn-pause-overlay-N) is now the scan target set.
    const ids = app.getScanTargets().map((el) => el.id);
    expect(ids.every((id) => /^btn-pause-overlay-\d+$/.test(id))).toBe(true);
  });

  test("Back from pause settings reopens the shared overlay", () => {
    app.startGame("two");
    app.showPauseMenu();
    app.showPauseSettings();
    expect(app.getPauseOverlay().isOpen()).toBe(false);

    // "Back" is the last pauseSettings item -> showPauseMenu.
    const back = app.menus.pauseSettings.find((m) => m.text === "Back");
    expect(back).toBeDefined();
    back.action();

    expect(app.state.pauseMenuState).toBe("main");
    expect(app.getPauseOverlay().isOpen()).toBe(true);
  });
});
