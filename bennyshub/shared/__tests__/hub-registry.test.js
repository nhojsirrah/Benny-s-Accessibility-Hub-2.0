/**
 * Tests for HubRegistry (hub-registry.js) — the typed registry over the hub's
 * games.json / tools.json manifests used by bennyshub/index.html (IP-7).
 *
 * The registry is a behaviour-preserving refactor of the launcher's old raw
 * `appsData` arrays, so the tests pin the behaviours index.html relies on:
 *   - entries are wrapped with typed accessors (id/title/type/path/capabilities)
 *   - title sort, genre listing and genre filtering match the old helpers
 *   - title lookup mirrors the auto-launch / nav-signal resolution order
 *   - it stays consistent against the ACTUAL on-disk manifests
 */

const fs = require("fs");
const path = require("path");

const {
  createHubRegistry,
  HubRegistry,
  HubCategory,
  HubAppEntry,
  CATEGORY_TYPE,
} = require("../hub-registry.js");

const GAMES_PATH = path.join(
  __dirname,
  "..",
  "..",
  "apps",
  "games",
  "games.json",
);
const TOOLS_PATH = path.join(
  __dirname,
  "..",
  "..",
  "apps",
  "tools",
  "tools.json",
);

function gameEntry(overrides) {
  return Object.assign(
    {
      id: "sample-game",
      title: "Sample Game",
      description: "A sample game entry.",
      path: "apps/games/SAMPLE/index.html",
      image: "images/games/sample.png",
      genres: ["Memory", "Arcade"],
    },
    overrides || {},
  );
}

describe("HubAppEntry: typed accessors", () => {
  test("surfaces the manifest fields and keeps the raw record", () => {
    const raw = gameEntry({
      capabilities: { needsElectron: true, twoPlayer: true },
    });
    const entry = new HubAppEntry(raw, "games");

    expect(entry.id).toBe("sample-game");
    expect(entry.title).toBe("Sample Game");
    expect(entry.description).toBe("A sample game entry.");
    expect(entry.path).toBe("apps/games/SAMPLE/index.html");
    expect(entry.image).toBe("images/games/sample.png");
    expect(entry.genres).toEqual(["Memory", "Arcade"]);
    expect(entry.capabilities).toEqual({
      needsElectron: true,
      twoPlayer: true,
    });
    expect(entry.raw).toBe(raw);
  });

  test("type derives from category, but an explicit type wins", () => {
    expect(new HubAppEntry(gameEntry(), "games").type).toBe("game");
    expect(new HubAppEntry({ id: "x" }, "tools").type).toBe("tool");
    expect(new HubAppEntry(gameEntry({ type: "tool" }), "games").type).toBe(
      "tool",
    );
  });

  test("safe fallbacks for missing fields", () => {
    const entry = new HubAppEntry({ id: "bare" }, "tools");
    expect(entry.title).toBe("");
    expect(entry.genres).toEqual([]);
    expect(entry.capabilities).toEqual({});
    expect(entry.path).toBeNull();
    expect(entry.launchExternal).toBeNull();
  });

  test("mirrors the alternate launch-target fields the launcher branches on", () => {
    const entry = new HubAppEntry(
      {
        id: "stream",
        title: "Streaming",
        launchExternal: "streaming",
        externalUrl: "https://example.test",
        serverPort: 8123,
        serverApp: { url: "http://localhost:8123" },
      },
      "tools",
    );
    expect(entry.launchExternal).toBe("streaming");
    expect(entry.externalUrl).toBe("https://example.test");
    expect(entry.serverPort).toBe(8123);
    expect(entry.serverApp).toEqual({ url: "http://localhost:8123" });
  });
});

describe("HubCategory: list / sort / genres / filter", () => {
  test("setEntries wraps and title-sorts (case-insensitive)", () => {
    const cat = new HubCategory("games").setEntries([
      gameEntry({ id: "z", title: "Zebra" }),
      gameEntry({ id: "a", title: "apple" }),
      gameEntry({ id: "m", title: "Mango" }),
    ]);
    expect(cat.list().map((e) => e.title)).toEqual(["apple", "Mango", "Zebra"]);
    expect(cat.list().every((e) => e instanceof HubAppEntry)).toBe(true);
    expect(cat.size()).toBe(3);
  });

  test("non-array input yields an empty category", () => {
    expect(new HubCategory("games").setEntries(undefined).list()).toEqual([]);
    expect(new HubCategory("games").setEntries(null).size()).toBe(0);
  });

  test("genres are unique and sorted", () => {
    const cat = new HubCategory("games").setEntries([
      gameEntry({ id: "1", title: "A", genres: ["Sports", "Arcade"] }),
      gameEntry({ id: "2", title: "B", genres: ["Arcade", "Memory"] }),
      gameEntry({ id: "3", title: "C", genres: [] }),
    ]);
    expect(cat.genres()).toEqual(["Arcade", "Memory", "Sports"]);
  });

  test("filterByGenre matches; 'all'/falsy returns everything in order", () => {
    const cat = new HubCategory("games").setEntries([
      gameEntry({ id: "1", title: "Beta", genres: ["Sports"] }),
      gameEntry({ id: "2", title: "Alpha", genres: ["Memory"] }),
    ]);
    expect(cat.filterByGenre("Sports").map((e) => e.id)).toEqual(["1"]);
    expect(cat.filterByGenre("all").map((e) => e.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(cat.filterByGenre("").map((e) => e.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(cat.filterByGenre("Nope")).toEqual([]);
  });

  test("list() returns a defensive copy", () => {
    const cat = new HubCategory("games").setEntries([gameEntry()]);
    cat.list().pop();
    expect(cat.size()).toBe(1);
  });
});

describe("HubCategory.findByTitle: exact-then-substring", () => {
  const cat = new HubCategory("games").setEntries([
    gameEntry({ id: "bball", title: "Benny's Basketball Shooter" }),
    gameEntry({ id: "bbase", title: "Benny's Baseball" }),
  ]);

  test("prefers an exact (case-insensitive) match", () => {
    expect(cat.findByTitle("benny's baseball").id).toBe("bbase");
  });

  test("falls back to the first substring match", () => {
    // "Basketball" only appears in the shooter title.
    expect(cat.findByTitle("basketball").id).toBe("bball");
  });

  test("returns null for no match / empty query", () => {
    expect(cat.findByTitle("nonexistent")).toBeNull();
    expect(cat.findByTitle("")).toBeNull();
  });
});

describe("HubRegistry: cross-category behaviour", () => {
  function registry() {
    const reg = createHubRegistry();
    reg.setCategory("tools", [
      gameEntry({ id: "kb", title: "Keyboard", genres: ["Communication"] }),
    ]);
    reg.setCategory("games", [
      gameEntry({ id: "says", title: "Benny Says", genres: ["Memory"] }),
    ]);
    return reg;
  }

  test("createHubRegistry returns a HubRegistry with both categories", () => {
    const reg = createHubRegistry();
    expect(reg).toBeInstanceOf(HubRegistry);
    expect(reg.list("tools")).toEqual([]);
    expect(reg.list("games")).toEqual([]);
  });

  test("delegates list/genres/filter to the category", () => {
    const reg = registry();
    expect(reg.list("tools").map((e) => e.id)).toEqual(["kb"]);
    expect(reg.genres("games")).toEqual(["Memory"]);
    expect(
      reg.filterByGenre("tools", "Communication").map((e) => e.id),
    ).toEqual(["kb"]);
  });

  test("findByTitle searches tools before games", () => {
    const reg = createHubRegistry();
    reg.setCategory("tools", [gameEntry({ id: "t", title: "Shared Name" })]);
    reg.setCategory("games", [gameEntry({ id: "g", title: "Shared Name" })]);
    expect(reg.findByTitle("Shared Name").id).toBe("t");
    // An explicit order flips the precedence.
    expect(reg.findByTitle("Shared Name", ["games", "tools"]).id).toBe("g");
  });

  test("unknown category resolves to an empty, non-crashing category", () => {
    const reg = createHubRegistry();
    expect(reg.list("nope")).toEqual([]);
    expect(reg.genres("nope")).toEqual([]);
    expect(reg.findByTitle("anything")).toBeNull();
  });

  test("CATEGORY_TYPE maps categories to singular app types", () => {
    expect(CATEGORY_TYPE).toEqual({ tools: "tool", games: "game" });
  });
});

describe("HubRegistry: against the real on-disk manifests", () => {
  const tools = JSON.parse(fs.readFileSync(TOOLS_PATH, "utf8")).tools;
  const games = JSON.parse(fs.readFileSync(GAMES_PATH, "utf8")).games;

  test("loads, title-sorts and types the actual entries", () => {
    const reg = createHubRegistry();
    reg.setCategory("tools", tools);
    reg.setCategory("games", games);

    expect(reg.list("tools").length).toBe(tools.length);
    expect(reg.list("games").length).toBe(games.length);

    const titles = reg.list("games").map((e) => e.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));

    reg.list("tools").forEach((e) => expect(e.type).toBe("tool"));
    reg.list("games").forEach((e) => expect(e.type).toBe("game"));

    // Every real entry exposes the fields the card renderer reads.
    reg.list("games").forEach((e) => {
      expect(typeof e.id).toBe("string");
      expect(typeof e.title).toBe("string");
      expect(Array.isArray(e.genres)).toBe(true);
    });
  });
});
