/**
 * @jest-environment jsdom
 *
 * Conformance tests for BENNYSMATCHYMATCH after the IP-5 refactor:
 *   - it adopts the shared theme + highlight palettes (shared/themes.js),
 *   - its settings round-trip through the shared SettingsStore, and
 *   - its board is built by the shared grid-memory engine while its row/col scan
 *     + select behaviour is preserved (scan targets + selection still work).
 *
 * The shared stack is required first so the game resolves the real modules off
 * the window globals, exactly as the browser <script src> order does.
 */

const Themes = require("../../../../shared/themes.js");
const SettingsStore = require("../../../../shared/settings-store.js");
require("../../../../engines/grid-memory/grid-memory-pack.js");

function dummyCards(n) {
  const names = [
    "dog",
    "cat",
    "fish",
    "turtle",
    "lizard",
    "bird",
    "ferret",
    "rabbit",
  ];
  return names
    .slice(0, n)
    .map((t) => ({ title: t, image: `${t}.png`, altTitle: "" }));
}

function makeMockScanManager() {
  return {
    getSettings: () => ({ autoScan: false, scanInterval: 2000 }),
    getScanInterval: () => 2000,
    cycleScanSpeed() {},
    subscribe() {},
    unsubscribe() {},
  };
}

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  localStorage.clear();
  SettingsStore._reset();

  document.body.innerHTML =
    '<div id="header">' +
    '<div id="score-display" style="display:none"></div>' +
    '<div id="turn-display" style="display:none"></div>' +
    "</div>" +
    '<div id="main-content"></div>';

  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn(), onSettingsChange: jest.fn() };

  jest.resetModules();
  require("../../../../shared/themes.js");
  require("../../../../shared/settings-store.js");
  require("../../../../engines/grid-memory/grid-memory-pack.js");
  app = require("../script.js");
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("shared theme + palette adoption", () => {
  test("themes come from shared/themes.js (with Matchy's card-back overlay)", () => {
    expect(app.themes).toHaveLength(Themes.THEMES.length);
    app.themes.forEach((t, i) => {
      expect(t.name).toBe(Themes.THEMES[i].name);
      expect(t.bg).toBe(Themes.THEMES[i].bg);
      expect(t.highlight).toBe(Themes.THEMES[i].highlight);
      expect(typeof t.cardBack).toBe("string");
    });
    // First theme: canonical highlight + Matchy card back.
    expect(app.themes[0].highlight).toBe("#ffff00");
    expect(app.themes[0].cardBack).toBe("#444");
  });

  test("highlight palette is the canonical shared one", () => {
    expect(app.highlightColors).toEqual(Themes.HIGHLIGHT_COLORS);
  });
});

describe("settings round-trip through SettingsStore", () => {
  test("saveSettings writes app + global keys; loadSettings reads them back", () => {
    app.settings.themeIndex = 3;
    app.settings.sound = false;
    app.settings.p1Color = "Blue";
    app.settings.highlightColorIndex = 5;
    app.settings.highlightStyle = "full";
    app.saveSettings();

    // Per-app keys land in the matchy app store; shared keys in the global store.
    expect(SettingsStore.app("matchy").get("themeIndex")).toBe(3);
    expect(SettingsStore.app("matchy").get("sound")).toBe(false);
    expect(SettingsStore.app("matchy").get("p1Color")).toBe("Blue");
    expect(SettingsStore.global.get("highlightColorIndex")).toBe(5);
    expect(SettingsStore.global.get("highlightStyle")).toBe("full");

    // Mutate in memory, then reload from the store.
    app.settings.themeIndex = 0;
    app.settings.highlightStyle = "outline";
    app.loadSettings();
    expect(app.settings.themeIndex).toBe(3);
    expect(app.settings.highlightStyle).toBe("full");
  });
});

describe("engine-built board", () => {
  beforeEach(() => {
    app.state.assets = { categories: { Animals: dummyCards(8) } };
    app.state.category = "All";
    app.state.gameMode = "casual";
    app.state.players = 1;
  });

  test("startGame lays out a 4x4 board via the grid-memory engine", () => {
    app.startGame("easy");
    expect(app.state.rows).toBe(4);
    expect(app.state.cols).toBe(4);
    expect(app.state.grid).toHaveLength(16);

    // It is a memory board: every face appears exactly twice.
    const counts = {};
    app.state.grid.forEach((cell) => {
      if (!cell.inactive) counts[cell.name] = (counts[cell.name] || 0) + 1;
    });
    Object.values(counts).forEach((n) => expect(n).toBe(2));

    // Sound map is populated from the source cards (sound/TTS still resolve).
    expect(Object.keys(app.state.soundMap).length).toBeGreaterThan(0);
  });

  test("buildMatchyPack emits a valid grid-memory pack", () => {
    const GMP = require("../../../../engines/grid-memory/grid-memory-pack.js");
    app.state.difficulty = "easy";
    const pack = app.buildMatchyPack(4, 4, [
      { id: "a", label: "A", card: {} },
      { id: "b", label: "B", card: {} },
    ]);
    expect(GMP.validatePack(pack).valid).toBe(true);
    expect(pack.board).toEqual({ rows: 4, cols: 4 });
    expect(pack.scanOrder).toBe("row-col");
  });
});

describe("row/col scan targets + selection are preserved", () => {
  beforeEach(() => {
    app.state.assets = { categories: { Animals: dummyCards(8) } };
    app.state.category = "All";
    app.state.gameMode = "casual";
    app.state.players = 1;
    app.startGame("easy");
  });

  test("row scan lands on the first row with unmatched cells", () => {
    expect(app.state.scan.mode).toBe("row");
    app.moveGameScan(1);
    expect(app.state.scan.row).toBe(0);
    expect(app.state.scan.mode).toBe("row");
  });

  test("selecting a row drops into column scan, then a card reveals", () => {
    app.moveGameScan(1); // focus row 0
    app.selectGameOption(); // row -> col stage
    expect(app.state.scan.mode).toBe("col");
    expect(app.state.scan.col).toBe(0);

    app.selectGameOption(); // reveal the focused card
    expect(app.getCell(0, 0).revealed).toBe(true);
    expect(app.state.firstSelection).not.toBeNull();
    // After a reveal we return to row scanning.
    expect(app.state.scan.mode).toBe("row");
  });
});
