/**
 * Conformance tests for the platform facade (platform.js).
 *
 * The same storage contract suite is run against WebPlatform (backed by jsdom's
 * localStorage) and a mock-electronAPI-backed ElectronPlatform, then their
 * outputs are checked for parity. detect() is exercised for both branches.
 */

const {
  WebPlatform,
  ElectronPlatform,
  ServerPlatform,
  detect,
} = require("../platform/platform.js");

// ---- Test helpers --------------------------------------------------------

/**
 * Build a mock `window.electronAPI` whose `storage` namespace is backed by an
 * in-memory map, so ElectronPlatform.storage exercises the IPC path (not the
 * localStorage fallback). Values cross "IPC" by structured-clone semantics, so
 * they are deep-copied in and out to catch any accidental aliasing.
 */
function makeMockElectronAPI() {
  const map = new Map();
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    isElectron: true,
    storage: {
      async get(key) {
        return map.has(key) ? clone(map.get(key)) : null;
      },
      async set(key, value) {
        map.set(key, clone(value));
      },
      async remove(key) {
        map.delete(key);
      },
      async keys() {
        return Array.from(map.keys());
      },
      async clear() {
        map.clear();
      },
    },
  };
}

const SAMPLE_VALUES = [
  ["string", "hello"],
  ["number", 42],
  ["boolean", true],
  ["null", null],
  ["object", { a: 1, nested: { b: [2, 3] } }],
  ["array", [1, "two", { three: 3 }]],
];

/**
 * The shared storage contract. Every Platform implementation must satisfy it.
 * @param {string} label
 * @param {() => import("../platform/platform.js").WebPlatform} makePlatform
 */
function describeStorageContract(label, makePlatform) {
  describe(`storage contract: ${label}`, () => {
    let storage;

    beforeEach(async () => {
      storage = makePlatform().storage;
      await storage.clear();
    });

    test.each(SAMPLE_VALUES)("round-trips a %s value", async (_kind, value) => {
      await storage.set("k", value);
      expect(await storage.get("k")).toEqual(value);
    });

    test("returns null for a missing key", async () => {
      expect(await storage.get("nope")).toBeNull();
    });

    test("overwrites an existing key", async () => {
      await storage.set("k", "first");
      await storage.set("k", "second");
      expect(await storage.get("k")).toBe("second");
    });

    test("remove deletes a key", async () => {
      await storage.set("k", "v");
      await storage.remove("k");
      expect(await storage.get("k")).toBeNull();
    });

    test("keys lists every stored key", async () => {
      await storage.set("a", 1);
      await storage.set("b", 2);
      expect((await storage.keys()).sort()).toEqual(["a", "b"]);
    });

    test("clear empties the store", async () => {
      await storage.set("a", 1);
      await storage.set("b", 2);
      await storage.clear();
      expect(await storage.keys()).toEqual([]);
    });

    test("does not alias stored objects", async () => {
      const obj = { count: 1 };
      await storage.set("k", obj);
      obj.count = 999;
      expect((await storage.get("k")).count).toBe(1);
    });
  });
}

// ---- Contract suites -----------------------------------------------------

describeStorageContract("WebPlatform", () => new WebPlatform());

describeStorageContract(
  "ElectronPlatform",
  () => new ElectronPlatform({ electronAPI: makeMockElectronAPI() }),
);

// ---- Cross-implementation parity ----------------------------------------

describe("storage parity: Web vs Electron", () => {
  test.each(SAMPLE_VALUES)(
    "both hosts round-trip a %s value identically",
    async (_kind, value) => {
      const web = new WebPlatform().storage;
      const electron = new ElectronPlatform({
        electronAPI: makeMockElectronAPI(),
      }).storage;
      await web.clear();
      await electron.clear();

      await web.set("k", value);
      await electron.set("k", value);

      const fromWeb = await web.get("k");
      const fromElectron = await electron.get("k");
      expect(fromWeb).toEqual(value);
      expect(fromElectron).toEqual(value);
      expect(fromWeb).toEqual(fromElectron);
    },
  );

  test("keys() agree across hosts after the same writes", async () => {
    const web = new WebPlatform().storage;
    const electron = new ElectronPlatform({
      electronAPI: makeMockElectronAPI(),
    }).storage;
    await web.clear();
    await electron.clear();

    for (const [, v] of SAMPLE_VALUES) {
      await web.set("key-" + String(v).slice(0, 4), v);
      await electron.set("key-" + String(v).slice(0, 4), v);
    }
    expect((await web.keys()).sort()).toEqual((await electron.keys()).sort());
  });
});

// ---- detect() ------------------------------------------------------------

describe("detect()", () => {
  const original = Object.getOwnPropertyDescriptor(window, "electronAPI");

  afterEach(() => {
    if (original) {
      Object.defineProperty(window, "electronAPI", original);
    } else {
      delete window.electronAPI;
    }
  });

  test("picks ElectronPlatform when window.electronAPI exists", () => {
    window.electronAPI = makeMockElectronAPI();
    const platform = detect();
    expect(platform).toBeInstanceOf(ElectronPlatform);
    expect(platform.kind).toBe("electron");
    expect(platform.isElectron).toBe(true);
  });

  test("picks WebPlatform when no electronAPI is present", () => {
    delete window.electronAPI;
    const platform = detect();
    expect(platform).toBeInstanceOf(WebPlatform);
    expect(platform.kind).toBe("web");
    expect(platform.isElectron).toBe(false);
  });

  test("honours an injected electronAPI option over the global", () => {
    delete window.electronAPI;
    const platform = detect({ electronAPI: makeMockElectronAPI() });
    expect(platform).toBeInstanceOf(ElectronPlatform);
  });
});

// ---- Facade shape --------------------------------------------------------

describe("Platform facade shape", () => {
  test.each([
    ["WebPlatform", () => new WebPlatform()],
    [
      "ElectronPlatform",
      () => new ElectronPlatform({ electronAPI: makeMockElectronAPI() }),
    ],
    ["ServerPlatform", () => new ServerPlatform()],
  ])("%s exposes the full facade", (_label, make) => {
    const p = make();
    for (const group of [
      "storage",
      "predictions",
      "voice",
      "system",
      "launch",
    ]) {
      expect(p[group]).toBeDefined();
    }
    expect(typeof p.storage.get).toBe("function");
    expect(typeof p.predictions.getPredictions).toBe("function");
    expect(typeof p.voice.speak).toBe("function");
    expect(typeof p.system.shutdown).toBe("function");
    expect(typeof p.launch.openExternal).toBe("function");
  });

  test("web no-op services resolve without throwing", async () => {
    const p = new WebPlatform();
    await expect(p.system.shutdown()).resolves.toBeUndefined();
    await expect(p.predictions.getPredictions()).resolves.toEqual([]);
    await expect(p.voice.getSettings()).resolves.toBeDefined();
  });

  test("Electron services forward to the IPC surface", async () => {
    const messenger = jest.fn().mockResolvedValue("launched");
    const volumeUp = jest.fn().mockResolvedValue("up");
    const getPredictions = jest.fn().mockResolvedValue(["a", "b"]);
    const api = {
      ...makeMockElectronAPI(),
      launch: { messenger },
      system: { volumeUp },
      keyboard: { getPredictions },
    };
    const p = new ElectronPlatform({ electronAPI: api, voiceManager: null });

    expect(await p.launch.messenger()).toBe("launched");
    expect(await p.system.volumeUp()).toBe("up");
    expect(await p.predictions.getPredictions()).toEqual(["a", "b"]);
    expect(messenger).toHaveBeenCalledTimes(1);
    expect(volumeUp).toHaveBeenCalledTimes(1);
    expect(getPredictions).toHaveBeenCalledTimes(1);
  });

  test("ElectronStorageAdapter falls back to localStorage without a storage namespace", async () => {
    // No `storage` namespace on the API → adapter uses localStorage and still
    // satisfies the round-trip contract.
    const p = new ElectronPlatform({ electronAPI: { isElectron: true } });
    await p.storage.clear();
    await p.storage.set("k", { ok: true });
    expect(await p.storage.get("k")).toEqual({ ok: true });
  });
});
