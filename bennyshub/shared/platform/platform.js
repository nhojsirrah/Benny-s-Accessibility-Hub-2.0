/**
 * Platform facade for the Narbehouse Accessibility Hub (IP-6).
 *
 * The hub runs in three very different hosts:
 *   - Electron  — the desktop shell, where `window.electronAPI` (see preload.js)
 *                 exposes a ~40-handler IPC surface for storage, predictions,
 *                 system controls and external app launches.
 *   - Web       — a plain browser (or an iframe bridged via electron-bridge.js),
 *                 where persistence lives in localStorage and system/launch
 *                 actions are mostly unavailable.
 *   - Server    — the legacy Flask/standalone editor, reached over HTTP.
 *
 * Today every caller branches on `window.electronAPI` inline and reimplements
 * the fallbacks by hand. This module centralises that into a single `Platform`
 * shape — `{ storage, predictions, voice, system, launch }` — with one
 * implementation per host plus a `detect()` that picks the right one.
 *
 * Loaded as an IIFE-style global via <script src>, matching the other shared
 * modules (NarbeScanManager, NarbeVoiceManager, ScanController). Apps read
 * `window.platform` (set at load time below). A dual CommonJS export is also
 * provided so jsdom tests can require() the classes and the contract.
 *
 * Scope note: this lands the facade, adapters and types only. Existing call
 * sites (predictions.js, settings, journal, …) are intentionally NOT refactored
 * here — migrating them onto `window.platform` is a deliberate follow-up so it
 * doesn't collide with other in-flight work. Every implementation is built to
 * be a drop-in behind those call sites when that migration happens.
 *
 * Design notes:
 *   - All dependencies (`electronAPI`, the voice manager, the storage backing)
 *     are INJECTABLE so tests can pass mocks and apps get the real globals by
 *     default. Logic never reaches for `window.*` once constructed.
 *   - Every method returns a Promise so the three hosts present one uniform,
 *     async contract regardless of whether the backing is sync (localStorage)
 *     or async (IPC / HTTP).
 *   - Web/no-op-safe defaults never throw: on a host that can't perform an
 *     action (e.g. shutting the machine down from a browser tab) the method
 *     resolves quietly rather than exploding a caller that assumed Electron.
 */
(function () {
  "use strict";

  // Resolve a global object that works in the browser, in jsdom, and in plain
  // Node without throwing a ReferenceError when `window` is absent.
  const GLOBAL =
    typeof window !== "undefined"
      ? window
      : typeof globalThis !== "undefined"
        ? globalThis
        : {};

  // ===================================================================== //
  //  Storage adapters                                                     //
  // ===================================================================== //

  /**
   * In-memory key/value store. Used as the last-resort backing when neither
   * localStorage nor an IPC storage namespace is available (e.g. plain Node,
   * a locked-down WebView). Values are held by reference-free JSON round-trip
   * so callers can't mutate stored state by holding the returned object.
   *
   * @implements {StorageAdapter}
   */
  class MemoryStorageAdapter {
    constructor() {
      /** @type {Map<string, string>} */
      this._map = new Map();
    }

    async get(key) {
      if (!this._map.has(String(key))) return null;
      try {
        return JSON.parse(this._map.get(String(key)));
      } catch {
        return null;
      }
    }

    async set(key, value) {
      this._map.set(String(key), JSON.stringify(value ?? null));
    }

    async remove(key) {
      this._map.delete(String(key));
    }

    async keys() {
      return Array.from(this._map.keys());
    }

    async clear() {
      this._map.clear();
    }
  }

  /**
   * Storage backed by a Web Storage object (window.localStorage by default).
   * Values are JSON-encoded on write and parsed on read, so callers store and
   * receive structured data rather than strings.
   *
   * This is the seam the web app grows into IndexedDB on: swap the constructor
   * argument for an IndexedDB-backed object exposing the same getItem/setItem/
   * removeItem/key/length surface (or a thin async adapter) and nothing above
   * this class changes. See `createWebStorageAdapter` for the selection point.
   *
   * @implements {StorageAdapter}
   */
  class LocalStorageAdapter {
    /**
     * @param {Storage} [backing] A Web Storage implementation. Defaults to
     *   the ambient localStorage; falls back to in-memory if unavailable.
     */
    constructor(backing) {
      this._store =
        backing ||
        (typeof GLOBAL.localStorage !== "undefined"
          ? GLOBAL.localStorage
          : null);
      // No real Web Storage on this host — degrade to memory rather than throw.
      this._memory = this._store ? null : new MemoryStorageAdapter();
    }

    async get(key) {
      if (this._memory) return this._memory.get(key);
      const raw = this._store.getItem(String(key));
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        // Legacy plain-string value written before this adapter existed.
        return raw;
      }
    }

    async set(key, value) {
      if (this._memory) return this._memory.set(key, value);
      this._store.setItem(String(key), JSON.stringify(value ?? null));
    }

    async remove(key) {
      if (this._memory) return this._memory.remove(key);
      this._store.removeItem(String(key));
    }

    async keys() {
      if (this._memory) return this._memory.keys();
      const out = [];
      for (let i = 0; i < this._store.length; i++) {
        out.push(this._store.key(i));
      }
      return out;
    }

    async clear() {
      if (this._memory) return this._memory.clear();
      this._store.clear();
    }
  }

  /**
   * Storage backed by the Electron IPC surface.
   *
   * The current preload.js does not yet expose a generic key/value storage
   * namespace (persistence is split across `keyboard`, `journal`, `voice`, …).
   * This adapter therefore prefers an `electronAPI.storage` namespace when the
   * host provides one — the forward-looking IPC contract that callers will be
   * migrated onto — and otherwise transparently falls back to localStorage,
   * which the Electron renderer always has. That keeps the adapter a genuine
   * drop-in today (falls back) while being mock-backed under test (namespace
   * supplied) and IPC-backed once preload grows the handlers.
   *
   * Values cross IPC via structured clone, so they are passed through as-is
   * (no JSON string wrapping) — symmetric with how the main process persists.
   *
   * @implements {StorageAdapter}
   */
  class ElectronStorageAdapter {
    /**
     * @param {ElectronAPI} electronAPI
     * @param {StorageAdapter} [fallback] Used when electronAPI has no `storage`
     *   namespace. Defaults to a localStorage-backed adapter.
     */
    constructor(electronAPI, fallback) {
      this._ipc =
        electronAPI && electronAPI.storage ? electronAPI.storage : null;
      this._fallback = this._ipc ? null : fallback || new LocalStorageAdapter();
    }

    async get(key) {
      if (this._fallback) return this._fallback.get(key);
      const value = await this._ipc.get(String(key));
      return value === undefined ? null : value;
    }

    async set(key, value) {
      if (this._fallback) return this._fallback.set(key, value);
      await this._ipc.set(String(key), value ?? null);
    }

    async remove(key) {
      if (this._fallback) return this._fallback.remove(key);
      await this._ipc.remove(String(key));
    }

    async keys() {
      if (this._fallback) return this._fallback.keys();
      return (await this._ipc.keys()) || [];
    }

    async clear() {
      if (this._fallback) return this._fallback.clear();
      if (typeof this._ipc.clear === "function") {
        await this._ipc.clear();
        return;
      }
      // No bulk clear over IPC — remove keys individually.
      const keys = await this.keys();
      await Promise.all(keys.map((k) => this._ipc.remove(k)));
    }
  }

  /**
   * Selection point for the web host's storage backing. Prefers localStorage
   * and is the single place to switch to IndexedDB later.
   * @param {Storage} [backing]
   * @returns {StorageAdapter}
   */
  function createWebStorageAdapter(backing) {
    return new LocalStorageAdapter(backing);
  }

  // ===================================================================== //
  //  Web / no-op-safe service defaults                                    //
  // ===================================================================== //

  /** No-op predictions service for hosts without an n-gram backend. */
  const webPredictions = {
    async getPredictions() {
      return [];
    },
    async savePrediction() {},
    async saveNgram() {},
    async clearPredictions() {},
  };

  /**
   * Browser voice service. Uses an injected voice manager (NarbeVoiceManager)
   * when present, otherwise the Web Speech API, otherwise a silent no-op — so
   * a caller can always `await platform.voice.speak(...)` without guarding.
   * @param {object} [voiceManager]
   */
  function createWebVoice(voiceManager) {
    const mgr =
      voiceManager !== undefined ? voiceManager : GLOBAL.NarbeVoiceManager;
    return {
      async getSettings() {
        if (mgr && typeof mgr.getSettings === "function") {
          return mgr.getSettings();
        }
        return {};
      },
      async saveSettings(settings) {
        if (mgr && typeof mgr.saveSettings === "function") {
          return mgr.saveSettings(settings);
        }
      },
      async speak(text, opts) {
        if (mgr && typeof mgr.speak === "function") {
          return mgr.speak(text, opts);
        }
        if (
          typeof GLOBAL.speechSynthesis !== "undefined" &&
          typeof GLOBAL.SpeechSynthesisUtterance !== "undefined"
        ) {
          GLOBAL.speechSynthesis.speak(
            new GLOBAL.SpeechSynthesisUtterance(text),
          );
          return;
        }
        // No speech backend on this host — quietly do nothing.
      },
    };
  }

  /** System controls are unavailable in a browser tab; resolve quietly. */
  const webSystem = {
    async volumeUp() {},
    async volumeDown() {},
    async volumeMute() {},
    async volumeMax() {},
    async shutdownTimer() {},
    async cancelShutdown() {},
    async restart() {},
    async shutdown() {},
    async closeApp() {},
  };

  /**
   * Web launch service. External URLs open in a new tab; native launchers
   * (messenger, editors, …) have no browser equivalent and resolve to null.
   */
  const webLaunch = {
    async messenger() {
      return null;
    },
    async search() {
      return null;
    },
    async editor() {
      return null;
    },
    async openWindow(data) {
      const url = data && (data.url || data.href);
      if (url && typeof GLOBAL.open === "function") {
        GLOBAL.open(url, "_blank");
      }
      return null;
    },
    async aiBridge() {
      return null;
    },
    async openExternal(url) {
      if (url && typeof GLOBAL.open === "function") {
        GLOBAL.open(url, "_blank", "noopener");
      }
      return null;
    },
  };

  // ===================================================================== //
  //  Platform implementations                                             //
  // ===================================================================== //

  /**
   * Browser implementation. Persistence over localStorage (IndexedDB-ready via
   * createWebStorageAdapter); predictions/voice/system/launch as web- or
   * no-op-safe defaults.
   *
   * @implements {Platform}
   */
  class WebPlatform {
    /**
     * @param {object} [options]
     * @param {StorageAdapter} [options.storage]
     * @param {Storage} [options.storageBacking] Backing for the default adapter.
     * @param {object} [options.voiceManager] Injected NarbeVoiceManager.
     */
    constructor(options = {}) {
      const opts = options || {};
      this.kind = "web";
      this.isElectron = false;
      this.storage =
        opts.storage || createWebStorageAdapter(opts.storageBacking);
      this.predictions = webPredictions;
      this.voice = createWebVoice(opts.voiceManager);
      this.system = webSystem;
      this.launch = webLaunch;
    }
  }

  /**
   * Electron implementation. Wraps `window.electronAPI` (see preload.js) for
   * storage, predictions, system and launch; voice goes through the injected
   * NarbeVoiceManager (settings persistence still rides electronAPI.voice).
   *
   * @implements {Platform}
   */
  class ElectronPlatform {
    /**
     * @param {object} [options]
     * @param {ElectronAPI} [options.electronAPI] Defaults to window.electronAPI.
     * @param {object} [options.voiceManager] Defaults to window.NarbeVoiceManager.
     * @param {StorageAdapter} [options.storage] Override the storage adapter.
     */
    constructor(options = {}) {
      const opts = options || {};
      const api = opts.electronAPI || GLOBAL.electronAPI || {};
      const voiceManager =
        opts.voiceManager !== undefined
          ? opts.voiceManager
          : GLOBAL.NarbeVoiceManager;

      this.kind = "electron";
      this.isElectron = true;

      this.storage = opts.storage || new ElectronStorageAdapter(api);

      const kb = api.keyboard || {};
      this.predictions = {
        async getPredictions() {
          return kb.getPredictions ? kb.getPredictions() : [];
        },
        async savePrediction(data) {
          if (kb.savePrediction) return kb.savePrediction(data);
        },
        async saveNgram(data) {
          if (kb.saveNgram) return kb.saveNgram(data);
        },
        async clearPredictions() {
          if (kb.clearPredictions) return kb.clearPredictions();
        },
      };

      const apiVoice = api.voice || {};
      this.voice = {
        async getSettings() {
          if (voiceManager && typeof voiceManager.getSettings === "function") {
            return voiceManager.getSettings();
          }
          return apiVoice.getSettings ? apiVoice.getSettings() : {};
        },
        async saveSettings(settings) {
          if (voiceManager && typeof voiceManager.saveSettings === "function") {
            return voiceManager.saveSettings(settings);
          }
          if (apiVoice.saveSettings) return apiVoice.saveSettings(settings);
        },
        async speak(text, speakOpts) {
          if (voiceManager && typeof voiceManager.speak === "function") {
            return voiceManager.speak(text, speakOpts);
          }
        },
      };

      const sys = api.system || {};
      // Every system control forwards to its IPC handler, or no-ops if a given
      // build doesn't register it — so callers don't have to feature-detect.
      this.system = {};
      for (const name of [
        "volumeUp",
        "volumeDown",
        "volumeMute",
        "volumeMax",
        "shutdownTimer",
        "cancelShutdown",
        "restart",
        "shutdown",
        "closeApp",
      ]) {
        this.system[name] = async (...args) =>
          typeof sys[name] === "function" ? sys[name](...args) : undefined;
      }

      const launch = api.launch || {};
      this.launch = {
        async messenger() {
          return launch.messenger ? launch.messenger() : null;
        },
        async search() {
          return launch.search ? launch.search() : null;
        },
        async editor(name) {
          return launch.editor ? launch.editor(name) : null;
        },
        async openWindow(data) {
          return launch.openWindow ? launch.openWindow(data) : null;
        },
        async aiBridge() {
          return launch.aiBridge ? launch.aiBridge() : null;
        },
        async openExternal(url) {
          return api.openExternal ? api.openExternal(url) : null;
        },
      };
    }
  }

  /**
   * Legacy Flask / standalone host reached over HTTP. Deliberately thin: it
   * gives the editor_server.py world a Platform-shaped object without pulling
   * in browser- or Electron-only assumptions. Storage defaults to in-memory
   * (callers that need durability inject an HTTP-backed adapter); the service
   * groups are no-op-safe until/unless the standalone server grows endpoints.
   *
   * @implements {Platform}
   */
  class ServerPlatform {
    /**
     * @param {object} [options]
     * @param {StorageAdapter} [options.storage]
     * @param {string} [options.baseUrl] Reserved for an HTTP-backed adapter.
     */
    constructor(options = {}) {
      const opts = options || {};
      this.kind = "server";
      this.isElectron = false;
      this.baseUrl = opts.baseUrl || "";
      this.storage = opts.storage || new MemoryStorageAdapter();
      this.predictions = webPredictions;
      this.voice = createWebVoice(opts.voiceManager);
      this.system = webSystem;
      this.launch = webLaunch;
    }
  }

  // ===================================================================== //
  //  Detection + singleton wiring                                         //
  // ===================================================================== //

  /**
   * Pick the implementation for the current host: Electron when an
   * `electronAPI` is exposed, otherwise Web. ServerPlatform is available for
   * explicit construction by the standalone server but is never auto-selected
   * from a browser/Electron context.
   *
   * @param {object} [options] Forwarded to the chosen implementation.
   * @returns {Platform}
   */
  function detect(options = {}) {
    const api =
      (options && options.electronAPI) ||
      (typeof GLOBAL.electronAPI !== "undefined" ? GLOBAL.electronAPI : null);
    if (api) {
      return new ElectronPlatform(options);
    }
    return new WebPlatform(options);
  }

  const exported = {
    WebPlatform,
    ElectronPlatform,
    ServerPlatform,
    MemoryStorageAdapter,
    LocalStorageAdapter,
    ElectronStorageAdapter,
    createWebStorageAdapter,
    detect,
  };

  // --- Dual export: IIFE globals + CommonJS ------------------------------
  if (typeof window !== "undefined") {
    window.WebPlatform = WebPlatform;
    window.ElectronPlatform = ElectronPlatform;
    window.ServerPlatform = ServerPlatform;
    window.PlatformDetect = detect;
    // Establish the singleton the apps read. Guarded so re-includes (and the
    // CommonJS require() path under jsdom) don't clobber an existing instance.
    if (!window.platform) {
      window.platform = detect();
    }
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
})();
