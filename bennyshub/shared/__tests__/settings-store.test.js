/**
 * Conformance tests for SettingsStore (settings-store.js).
 *
 * Runs in jsdom, which supplies window + localStorage. Each test starts from a
 * clean localStorage and fresh in-memory singletons (via _reset()).
 */

const SettingsStore = require("../settings-store.js");

beforeEach(() => {
  localStorage.clear();
  SettingsStore._reset();
});

// ---- get / set / getAll --------------------------------------------------

describe("get / set / getAll", () => {
  test("set then get round-trips a valid global value", () => {
    const ok = SettingsStore.global.set("scanSpeedIndex", 2);
    expect(ok).toBe(true);
    expect(SettingsStore.global.get("scanSpeedIndex")).toBe(2);
  });

  test("getAll returns a snapshot copy, not the live cache", () => {
    SettingsStore.global.set("autoScan", true);
    const all = SettingsStore.global.getAll();
    expect(all).toEqual({ autoScan: true });
    all.autoScan = false; // mutate the copy
    expect(SettingsStore.global.get("autoScan")).toBe(true);
  });

  test("set persists to the canonical localStorage key", () => {
    SettingsStore.global.set("highlightStyle", "full");
    const raw = JSON.parse(localStorage.getItem("narbe.settings.global"));
    expect(raw.highlightStyle).toBe("full");
  });

  test("get returns undefined for an unset key", () => {
    expect(SettingsStore.global.get("rate")).toBeUndefined();
  });
});

// ---- schema validation ---------------------------------------------------

describe("schema validation", () => {
  test("rejects an unknown key", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const ok = SettingsStore.global.set("notARealKey", 1);
    expect(ok).toBe(false);
    expect(SettingsStore.global.get("notARealKey")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("rejects a wrong-typed value", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(SettingsStore.global.set("scanSpeedIndex", "fast")).toBe(false);
    expect(SettingsStore.global.set("autoScan", "yes")).toBe(false);
    warn.mockRestore();
  });

  test("rejects an enum value outside the allowed set", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(SettingsStore.global.set("highlightStyle", "fill")).toBe(false); // 'fill' is legacy-only
    expect(SettingsStore.global.set("highlightStyle", "outline")).toBe(true);
    warn.mockRestore();
  });

  test("per-app schema extends globals: global keys accepted on app store", () => {
    expect(SettingsStore.app("tictactoe").set("scanSpeedIndex", 1)).toBe(true);
    expect(SettingsStore.app("tictactoe").set("p1Color", "Red")).toBe(true);
  });

  test("app-specific key is rejected on the global store", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(SettingsStore.global.set("p1Color", "Red")).toBe(false);
    warn.mockRestore();
  });
});

// ---- global vs per-app key separation ------------------------------------

describe("global vs per-app separation", () => {
  test("global and app stores use distinct localStorage keys", () => {
    SettingsStore.global.set("scanSpeedIndex", 3);
    SettingsStore.app("tictactoe").set("scanSpeedIndex", 0);

    expect(SettingsStore.global.get("scanSpeedIndex")).toBe(3);
    expect(SettingsStore.app("tictactoe").get("scanSpeedIndex")).toBe(0);

    expect(localStorage.getItem("narbe.settings.global")).toBeTruthy();
    expect(localStorage.getItem("narbe.settings.tictactoe")).toBeTruthy();
  });

  test("two different apps do not share storage", () => {
    SettingsStore.app("tictactoe").set("themeIndex", 1);
    SettingsStore.app("matchy").set("themeIndex", 5);
    expect(SettingsStore.app("tictactoe").get("themeIndex")).toBe(1);
    expect(SettingsStore.app("matchy").get("themeIndex")).toBe(5);
  });
});

// ---- subscribe / unsubscribe ---------------------------------------------

describe("subscribe / unsubscribe", () => {
  test("subscriber fires with a snapshot on set", () => {
    const cb = jest.fn();
    SettingsStore.global.subscribe(cb);
    SettingsStore.global.set("autoScan", true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toEqual({ autoScan: true });
  });

  test("rejected set does not notify", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const cb = jest.fn();
    SettingsStore.global.subscribe(cb);
    SettingsStore.global.set("bogus", 1);
    expect(cb).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("unsubscribe stops notifications", () => {
    const cb = jest.fn();
    SettingsStore.global.subscribe(cb);
    SettingsStore.global.unsubscribe(cb);
    SettingsStore.global.set("autoScan", true);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ---- migrations ----------------------------------------------------------

describe("migrations (read-old / write-new)", () => {
  test("tictactoe blob lifts highlight + scan into global, residue into app", () => {
    localStorage.setItem(
      "tictactoe_settings",
      JSON.stringify({
        themeIndex: 2,
        tts: true,
        voiceIndex: 4,
        p1Color: "Red",
        scanSpeedIndex: 3,
        highlightColorIndex: 5,
        highlightStyle: "outline",
      }),
    );

    const ran = SettingsStore.runMigrations(true);
    expect(ran).toContain("tictactoe_settings");

    // Global lift
    expect(SettingsStore.global.get("scanSpeedIndex")).toBe(3);
    expect(SettingsStore.global.get("highlightColorIndex")).toBe(5);
    expect(SettingsStore.global.get("highlightStyle")).toBe("outline");

    // App residue
    expect(SettingsStore.app("tictactoe").get("themeIndex")).toBe(2);
    expect(SettingsStore.app("tictactoe").get("voiceIndex")).toBe(4);
    expect(SettingsStore.app("tictactoe").get("p1Color")).toBe("Red");

    // Old key kept for one release
    expect(localStorage.getItem("tictactoe_settings")).toBeTruthy();
  });

  test("streaming blob normalizes legacy 'fill' style and color-name -> index", () => {
    localStorage.setItem(
      "streaming_settings",
      JSON.stringify({
        theme: "dark",
        highlightStyle: "fill", // legacy spelling
        highlightColor: "yellow", // color name, not index
      }),
    );

    SettingsStore.runMigrations(true);

    expect(SettingsStore.global.get("highlightStyle")).toBe("full");
    // "Yellow" is index 1 in the canonical palette.
    expect(SettingsStore.global.get("highlightColorIndex")).toBe(
      SettingsStore.HIGHLIGHT_COLORS.indexOf("Yellow"),
    );
    expect(SettingsStore.app("streaming").get("theme")).toBe("dark");
    expect(localStorage.getItem("streaming_settings")).toBeTruthy();
  });

  test("migration never clobbers a value already set by the user", () => {
    SettingsStore.global.set("scanSpeedIndex", 1); // user choice
    localStorage.setItem(
      "tictactoe_settings",
      JSON.stringify({ scanSpeedIndex: 3 }),
    );
    SettingsStore.runMigrations(true);
    expect(SettingsStore.global.get("scanSpeedIndex")).toBe(1);
  });

  test("migrations are idempotent without force (recorded as done)", () => {
    localStorage.setItem(
      "journal_settings",
      JSON.stringify({ highlightColor: "white" }),
    );
    const first = SettingsStore.runMigrations();
    expect(first).toContain("journal_settings");
    const second = SettingsStore.runMigrations();
    expect(second).not.toContain("journal_settings");
  });

  test("there is one migration per documented legacy key", () => {
    const ids = SettingsStore.migrations.map((m) => m.id).sort();
    expect(ids).toEqual(
      [
        "benny_settings",
        "bensPeggleV4Settings",
        "bmg_settings",
        "journal_settings",
        "kb_settings",
        "matchy_settings",
        "streaming_settings",
        "tictactoe_settings",
        "wordjumble_settings_v2",
      ].sort(),
    );
  });
});

// ---- cross-iframe propagation --------------------------------------------

describe("cross-iframe propagation", () => {
  test("an incoming narbe-settings-changed message refreshes + notifies", () => {
    const store = SettingsStore.global; // create + register the store
    const cb = jest.fn();
    store.subscribe(cb);

    // Simulate a sibling frame's broadcast landing on this window.
    const event = new MessageEvent("message", {
      data: {
        type: "narbe-settings-changed",
        key: "narbe.settings.global",
        settings: { autoScan: true, scanSpeedIndex: 2 },
      },
    });
    window.dispatchEvent(event);

    expect(store.get("autoScan")).toBe(true);
    expect(store.get("scanSpeedIndex")).toBe(2);
    expect(cb).toHaveBeenCalled();
    // The remote snapshot was persisted locally.
    const raw = JSON.parse(localStorage.getItem("narbe.settings.global"));
    expect(raw.autoScan).toBe(true);
  });

  test("incoming message drops invalid fields", () => {
    const store = SettingsStore.app("tictactoe");
    const event = new MessageEvent("message", {
      data: {
        type: "narbe-settings-changed",
        key: "narbe.settings.tictactoe",
        settings: { p1Color: "Blue", bogus: 99 },
      },
    });
    window.dispatchEvent(event);
    expect(store.get("p1Color")).toBe("Blue");
    expect(store.get("bogus")).toBeUndefined();
  });

  test("a message for an unrelated key is ignored", () => {
    const store = SettingsStore.global;
    const cb = jest.fn();
    store.subscribe(cb);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "narbe-settings-changed",
          key: "narbe.settings.nope",
          settings: { autoScan: true },
        },
      }),
    );
    expect(cb).not.toHaveBeenCalled();
  });
});

// ---- profiles (IP-7) -----------------------------------------------------

describe("profiles: active profile + namespacing", () => {
  test("defaults to the 'default' profile", () => {
    expect(SettingsStore.getActiveProfile()).toBe("default");
  });

  test("default profile uses the LEGACY keys (back-compat, no migration)", () => {
    SettingsStore.global.set("scanSpeedIndex", 2);
    SettingsStore.app("tictactoe").set("p1Color", "Red");
    // Exactly the pre-IP-7 keys — existing users' data is untouched.
    expect(localStorage.getItem("narbe.settings.global")).toBeTruthy();
    expect(localStorage.getItem("narbe.settings.tictactoe")).toBeTruthy();
    expect(SettingsStore.activeKeyFor()).toBe("narbe.settings.global");
    expect(SettingsStore.activeKeyFor("tictactoe")).toBe(
      "narbe.settings.tictactoe",
    );
    // No profile-prefixed keys created for the default profile.
    expect(localStorage.getItem("narbe.profile.default.settings.global")).toBe(
      null,
    );
  });

  test("setActiveProfile persists the id under narbe.activeProfile", () => {
    SettingsStore.setActiveProfile("ben");
    expect(SettingsStore.getActiveProfile()).toBe("ben");
    expect(localStorage.getItem("narbe.activeProfile")).toBe("ben");
  });

  test("a non-default profile writes to narbe.profile.<p>.settings.* keys", () => {
    SettingsStore.setActiveProfile("ben");
    SettingsStore.global.set("scanSpeedIndex", 4);
    SettingsStore.app("tictactoe").set("p1Color", "Cyan");

    expect(SettingsStore.activeKeyFor()).toBe(
      "narbe.profile.ben.settings.global",
    );
    const g = JSON.parse(
      localStorage.getItem("narbe.profile.ben.settings.global"),
    );
    expect(g.scanSpeedIndex).toBe(4);
    const a = JSON.parse(
      localStorage.getItem("narbe.profile.ben.settings.tictactoe"),
    );
    expect(a.p1Color).toBe("Cyan");
  });

  test("PROFILE ISOLATION: no cross-profile data leak", () => {
    // Seed the default profile.
    SettingsStore.global.set("scanSpeedIndex", 1);
    SettingsStore.app("tictactoe").set("themeIndex", 7);

    // Switch to a new profile — it starts empty, default is invisible.
    SettingsStore.setActiveProfile("ben");
    expect(SettingsStore.global.get("scanSpeedIndex")).toBeUndefined();
    expect(SettingsStore.app("tictactoe").get("themeIndex")).toBeUndefined();

    // Write under the new profile.
    SettingsStore.global.set("scanSpeedIndex", 9);
    SettingsStore.app("tictactoe").set("themeIndex", 3);
    expect(SettingsStore.global.get("scanSpeedIndex")).toBe(9);

    // Switch back: the default profile's values are intact and unchanged.
    SettingsStore.setActiveProfile("default");
    expect(SettingsStore.global.get("scanSpeedIndex")).toBe(1);
    expect(SettingsStore.app("tictactoe").get("themeIndex")).toBe(7);

    // And the legacy default keys never absorbed the profile's values.
    const dg = JSON.parse(localStorage.getItem("narbe.settings.global"));
    expect(dg.scanSpeedIndex).toBe(1);
  });

  test("listProfiles returns 'default' first, then discovered profiles, de-duped", () => {
    expect(SettingsStore.listProfiles()).toEqual(["default"]);

    SettingsStore.setActiveProfile("ben");
    SettingsStore.global.set("scanSpeedIndex", 2); // creates narbe.profile.ben.*
    SettingsStore.app("tictactoe").set("themeIndex", 1); // another ben.* key

    SettingsStore.setActiveProfile("mum");
    SettingsStore.global.set("autoScan", true); // creates narbe.profile.mum.*

    const profiles = SettingsStore.listProfiles();
    expect(profiles[0]).toBe("default");
    expect(profiles).toContain("ben");
    expect(profiles).toContain("mum");
    // Each id appears once despite multiple keys.
    expect(profiles.filter((p) => p === "ben")).toHaveLength(1);
  });

  test("createProfile seeds an empty discoverable namespace", () => {
    SettingsStore.createProfile("guest");
    expect(SettingsStore.listProfiles()).toContain("guest");
    // Seeded empty — the global namespace exists but holds no values.
    const g = JSON.parse(
      localStorage.getItem("narbe.profile.guest.settings.global"),
    );
    expect(g).toEqual({});
  });

  test("deleteProfile removes that profile's keys and never the default", () => {
    SettingsStore.setActiveProfile("ben");
    SettingsStore.global.set("scanSpeedIndex", 5);
    SettingsStore.app("tictactoe").set("themeIndex", 2);
    SettingsStore.setActiveProfile("default");
    SettingsStore.global.set("scanSpeedIndex", 1);

    const removed = SettingsStore.deleteProfile("ben");
    expect(removed).toBeGreaterThan(0);
    expect(localStorage.getItem("narbe.profile.ben.settings.global")).toBe(
      null,
    );
    expect(localStorage.getItem("narbe.profile.ben.settings.tictactoe")).toBe(
      null,
    );
    expect(SettingsStore.listProfiles()).not.toContain("ben");

    // Default is untouched and protected.
    expect(SettingsStore.deleteProfile("default")).toBe(0);
    expect(SettingsStore.global.get("scanSpeedIndex")).toBe(1);
  });

  test("deleting the active profile falls back to default", () => {
    SettingsStore.setActiveProfile("ben");
    SettingsStore.global.set("scanSpeedIndex", 5);
    SettingsStore.deleteProfile("ben");
    expect(SettingsStore.getActiveProfile()).toBe("default");
  });
});

describe("profiles: notify + broadcast", () => {
  test("setActiveProfile notifies live subscribers so they re-read", () => {
    const cb = jest.fn();
    SettingsStore.global.subscribe(cb); // subscribed under the default store
    SettingsStore.setActiveProfile("ben");
    expect(cb).toHaveBeenCalled();
  });

  test("setActiveProfile broadcasts a narbe-profile-changed message to the parent", () => {
    const post = jest.fn();
    const realParent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", {
      value: { postMessage: post },
      configurable: true,
    });
    try {
      SettingsStore.setActiveProfile("ben");
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toEqual({
        type: "narbe-profile-changed",
        profile: "ben",
      });
    } finally {
      if (realParent) Object.defineProperty(window, "parent", realParent);
    }
  });

  test("an incoming narbe-profile-changed message switches the active profile", () => {
    const cb = jest.fn();
    SettingsStore.global.subscribe(cb);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "narbe-profile-changed", profile: "remote" },
      }),
    );
    expect(SettingsStore.getActiveProfile()).toBe("remote");
    expect(cb).toHaveBeenCalled();
    // Subsequent writes land in the remote profile's namespace.
    SettingsStore.global.set("autoScan", true);
    expect(
      localStorage.getItem("narbe.profile.remote.settings.global"),
    ).toBeTruthy();
  });
});
