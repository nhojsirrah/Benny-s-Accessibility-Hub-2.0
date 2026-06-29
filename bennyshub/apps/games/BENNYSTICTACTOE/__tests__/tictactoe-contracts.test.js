/**
 * Contract-adoption tests for BENNYSTICTACTOE after wiring it onto the shared
 * Themes / SettingsStore / Nav modules.
 *
 * Runs in jsdom. The shared modules are exposed on window exactly as the real
 * page exposes them via <script src>, and the game's CommonJS export surface is
 * exercised through require().
 */

const SCAN_MANAGER = () => ({
  getSettings: () => ({ autoScan: false, scanSpeedIndex: 1 }),
  getScanInterval: () => 2000,
  cycleScanSpeed() {},
  setAutoScan() {},
  subscribe() {},
  unsubscribe() {},
});

function loadApp() {
  window.Themes = require("../../../../shared/themes.js");
  window.SettingsStore = require("../../../../shared/settings-store.js");
  window.Nav = require("../../../../shared/nav.js");
  window.ScanController = require("../../../../shared/scan-core.js");
  window.NarbeScanManager = SCAN_MANAGER();
  window.NarbeVoiceManager = { speak: jest.fn() };
  const app = require("../script.js");
  app.init();
  return app;
}

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  document.body.innerHTML =
    '<div id="header"></div><div id="main-content"></div>';
  jest.resetModules();
});

afterEach(() => {
  try {
    require("../script.js").getScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Themes --------------------------------------------------------------

describe("themes: resolves via shared Themes identically", () => {
  test("getHighlightColor matches Themes.getThemeHighlight across the full matrix", () => {
    const app = loadApp();
    const { THEMES, HIGHLIGHT_COLORS, getThemeHighlight } = window.Themes;

    THEMES.forEach((theme, ti) => {
      HIGHLIGHT_COLORS.forEach((_choice, hi) => {
        app.settings.themeIndex = ti;
        app.settings.highlightColorIndex = hi;
        expect(app.getHighlightColor()).toBe(getThemeHighlight(theme, hi));
      });
    });
  });

  test("the theme list is sourced from shared Themes.THEMES", () => {
    const app = loadApp();
    const { THEMES } = window.Themes;
    const themeLabel = app.menus.settings.find((m) =>
      String(typeof m.text === "function" ? m.text() : m.text).startsWith(
        "Change Theme",
      ),
    );
    expect(themeLabel).toBeDefined();
    THEMES.forEach((theme, ti) => {
      app.settings.themeIndex = ti;
      expect(themeLabel.text()).toBe(`Change Theme: ${theme.name}`);
    });
  });
});

// ---- Settings ------------------------------------------------------------

describe("settings: round-trip through SettingsStore", () => {
  test("saveSettings writes global keys to global store and app keys to app store", () => {
    const app = loadApp();
    app.settings.themeIndex = 3; // app key
    app.settings.p1Color = "Green"; // app key
    app.settings.highlightStyle = "full"; // global key
    app.settings.highlightColorIndex = 5; // global key
    app.saveSettings();

    const appStore = window.SettingsStore.app("tictactoe");
    const globalStore = window.SettingsStore.global;
    expect(appStore.get("themeIndex")).toBe(3);
    expect(appStore.get("p1Color")).toBe("Green");
    expect(globalStore.get("highlightStyle")).toBe("full");
    expect(globalStore.get("highlightColorIndex")).toBe(5);
  });

  test("loadSettings reads values back out of the stores", () => {
    const app = loadApp();
    window.SettingsStore.app("tictactoe").set("themeIndex", 6);
    window.SettingsStore.app("tictactoe").set("tts", false);
    window.SettingsStore.global.set("highlightStyle", "full");

    app.loadSettings();
    expect(app.settings.themeIndex).toBe(6);
    expect(app.settings.tts).toBe(false);
    expect(app.settings.highlightStyle).toBe("full");
  });

  test("legacy tictactoe_settings blob is migrated on first load", () => {
    // Seed the pre-adoption localStorage shape BEFORE the modules load.
    localStorage.setItem(
      "tictactoe_settings",
      JSON.stringify({
        themeIndex: 4,
        tts: false,
        p1Color: "Pink",
        scanSpeedIndex: 2,
        highlightStyle: "full",
        highlightColorIndex: 3,
      }),
    );

    const app = loadApp();

    // App-specific keys land in the per-app store and the in-memory settings.
    expect(app.settings.themeIndex).toBe(4);
    expect(app.settings.tts).toBe(false);
    expect(app.settings.p1Color).toBe("Pink");
    expect(window.SettingsStore.app("tictactoe").get("themeIndex")).toBe(4);

    // Cross-app keys land in the global store.
    expect(app.settings.highlightStyle).toBe("full");
    expect(app.settings.highlightColorIndex).toBe(3);
    expect(app.settings.scanSpeedIndex).toBe(2);
    expect(window.SettingsStore.global.get("highlightColorIndex")).toBe(3);
    expect(window.SettingsStore.global.get("scanSpeedIndex")).toBe(2);
  });
});

// ---- Nav -----------------------------------------------------------------

describe("nav: back path delegates to the shared Nav closeApp contract", () => {
  test("exitToHub calls Nav.goBack after the announce delay", () => {
    const app = loadApp();
    const goBack = jest
      .spyOn(window.Nav, "goBack")
      .mockImplementation(() => {});

    app.exitToHub();
    expect(goBack).not.toHaveBeenCalled(); // deferred 500ms behind the TTS
    jest.advanceTimersByTime(500);
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  test("the main-menu Exit item is wired to exitToHub -> Nav.goBack", () => {
    const app = loadApp();
    const goBack = jest
      .spyOn(window.Nav, "goBack")
      .mockImplementation(() => {});
    const exit = app.menus.main.find((m) => m.text === "Exit");
    expect(exit).toBeDefined();

    exit.action();
    jest.advanceTimersByTime(500);
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  test("Nav.goBack posts the closeApp message when framed", () => {
    // Direct proof of the hub contract the game now relies on.
    const post = jest.fn();
    const realParent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage: post },
    });
    try {
      loadApp();
      expect(window.Nav.goBack()).toBe(true);
      expect(post).toHaveBeenCalledWith({ action: "closeApp" }, "*");
    } finally {
      if (realParent) Object.defineProperty(window, "parent", realParent);
    }
  });
});
