/**
 * Contract-adoption tests for BENNYSWORDJUMBLE after wiring it onto the shared
 * Themes / SettingsStore / Nav modules.
 *
 * Runs in jsdom. The shared modules are exposed on window exactly as the page
 * exposes them via <script src>; game.js exports the WordJumbleGame class under
 * CommonJS so jest can construct an instance with mocks.
 */

function setGlobals() {
  window.Themes = require("../../../../shared/themes.js");
  window.SettingsStore = require("../../../../shared/settings-store.js");
  window.Nav = require("../../../../shared/nav.js");
  window.NarbeVoiceManager = { speak: jest.fn() };
  window.NarbeScanManager = {
    getSettings: () => ({ autoScan: false, scanSpeedIndex: 1 }),
    getScanInterval: () => 2000,
    cycleScanSpeed() {},
    setAutoScan() {},
    subscribe() {},
    unsubscribe() {},
  };
}

function makeGame() {
  setGlobals();
  const { WordJumbleGame } = require("../game.js");
  return new WordJumbleGame();
}

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  // jsdom doesn't implement scrollIntoView; the menu renderer calls it.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  document.body.innerHTML =
    '<div id="game-container"><div id="main-content"></div></div>';
  // init() fetches words.json; resolve it to an empty list so the async path
  // settles quietly under jsdom.
  global.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve([]) }),
  );
  jest.resetModules();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete global.fetch;
});

// ---- Themes --------------------------------------------------------------

describe("themes: theme palette sourced from shared Themes", () => {
  test("the theme list is Themes.THEMES (names + per-theme highlight)", () => {
    const game = makeGame();
    const { THEMES } = window.Themes;
    THEMES.forEach((theme, ti) => {
      game.settings.themeIndex = ti;
      game.applyTheme();
      expect(
        document.documentElement.style.getPropertyValue("--theme-highlight"),
      ).toBe(theme.highlight);
    });
  });

  test('"Theme Default" highlight resolves via Themes.getThemeHighlight', () => {
    const game = makeGame();
    const { THEMES, getThemeHighlight } = window.Themes;
    // highlightColorIndex 0 is WordJumble's "Theme Default" sentinel.
    game.settings.highlightColorIndex = 0;
    THEMES.forEach((theme, ti) => {
      game.settings.themeIndex = ti;
      game.applyTheme();
      expect(
        document.documentElement.style.getPropertyValue("--highlight-color"),
      ).toBe(getThemeHighlight(theme, 0));
      expect(getThemeHighlight(theme, 0)).toBe(theme.highlight);
    });
  });
});

// ---- Settings ------------------------------------------------------------

describe("settings: round-trip through SettingsStore", () => {
  test("saveSettings splits global vs per-app keys into the right stores", () => {
    const game = makeGame();
    game.settings.themeIndex = 5; // app key
    game.settings.tts = false; // app key
    game.settings.dataSource = "local"; // app key
    game.settings.highlightStyle = "full"; // global key
    game.settings.scanSpeedIndex = 3; // global key
    game.saveSettings();

    const appStore = window.SettingsStore.app("wordjumble");
    const globalStore = window.SettingsStore.global;
    expect(appStore.get("themeIndex")).toBe(5);
    expect(appStore.get("tts")).toBe(false);
    expect(appStore.get("dataSource")).toBe("local");
    expect(globalStore.get("highlightStyle")).toBe("full");
    expect(globalStore.get("scanSpeedIndex")).toBe(3);
  });

  test("loadSettings reads values back out of the stores", () => {
    const game = makeGame();
    window.SettingsStore.app("wordjumble").set("themeIndex", 6);
    window.SettingsStore.app("wordjumble").set("dataSource", "all");
    window.SettingsStore.global.set("highlightStyle", "full");

    game.loadSettings();
    expect(game.settings.themeIndex).toBe(6);
    expect(game.settings.dataSource).toBe("all");
    expect(game.settings.highlightStyle).toBe("full");
  });

  test("legacy wordjumble_settings_v2 blob is migrated on first load", () => {
    localStorage.setItem(
      "wordjumble_settings_v2",
      JSON.stringify({
        themeIndex: 4,
        tts: false,
        dataSource: "local",
        autoScan: true,
        scanSpeedIndex: 2,
        highlightStyle: "full",
        highlightColorIndex: 3,
      }),
    );

    const game = makeGame();

    // App-specific keys land in the per-app store + in-memory settings.
    expect(game.settings.themeIndex).toBe(4);
    expect(game.settings.tts).toBe(false);
    expect(game.settings.dataSource).toBe("local");
    expect(window.SettingsStore.app("wordjumble").get("themeIndex")).toBe(4);

    // Cross-app keys land in the global store.
    expect(game.settings.autoScan).toBe(true);
    expect(game.settings.scanSpeedIndex).toBe(2);
    expect(game.settings.highlightStyle).toBe("full");
    expect(game.settings.highlightColorIndex).toBe(3);
    expect(window.SettingsStore.global.get("scanSpeedIndex")).toBe(2);
    expect(window.SettingsStore.global.get("highlightColorIndex")).toBe(3);
  });
});

// ---- Nav -----------------------------------------------------------------

describe("nav: back path delegates to the shared Nav closeApp contract", () => {
  test("exitGame calls Nav.goBack after the announce delay", () => {
    const game = makeGame();
    const goBack = jest
      .spyOn(window.Nav, "goBack")
      .mockImplementation(() => {});

    game.exitGame();
    expect(goBack).not.toHaveBeenCalled(); // deferred 500ms behind the TTS
    jest.advanceTimersByTime(500);
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  test("Nav.goBack posts the closeApp message when framed", () => {
    const post = jest.fn();
    const realParent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage: post },
    });
    try {
      makeGame();
      expect(window.Nav.goBack()).toBe(true);
      expect(post).toHaveBeenCalledWith({ action: "closeApp" }, "*");
    } finally {
      if (realParent) Object.defineProperty(window, "parent", realParent);
    }
  });
});
