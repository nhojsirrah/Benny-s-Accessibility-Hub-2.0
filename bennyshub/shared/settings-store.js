/**
 * SettingsStore — typed, shared settings for the Narbehouse Accessibility Hub.
 *
 * Provides one global settings store plus per-app stores, each backed by a
 * localStorage key. Mirrors scan-manager.js's cross-iframe sync pattern: a
 * `set` broadcasts a `narbe-settings-changed` postMessage, and every store
 * listens for that message to refresh from storage and notify subscribers.
 *
 * Authoring note: this is an IIFE global (loaded via <script src>) AND a
 * CommonJS module (so the jsdom jest harness can require() it). See the dual
 * export at the bottom.
 *
 * Storage keys:
 *   global  -> "narbe.settings.global"
 *   per-app -> "narbe.settings.<appId>"
 *
 * Profiles (IP-7):
 *   A profile namespaces every settings key so multiple users of the same
 *   machine keep separate setups. The active profile id lives under
 *   "narbe.activeProfile" and defaults to "default".
 *
 *   Back-compat is the load-bearing rule: when the active profile is "default"
 *   the keys are UNCHANGED from the above ("narbe.settings.global" /
 *   "narbe.settings.<appId>"), so existing users' data IS the default profile
 *   with no migration. For any other profile `p` the keys are prefixed:
 *     global  -> "narbe.profile.<p>.settings.global"
 *     per-app -> "narbe.profile.<p>.settings.<appId>"
 *
 *   `setActiveProfile` persists the new id, broadcasts a "narbe-profile-changed"
 *   postMessage (mirroring the settings broadcast), and re-notifies live stores
 *   so subscribers re-read through the now-active namespace.
 *
 * Schema:
 *   GlobalSettings is a fixed, typed contract. Per-app schemas EXTEND the
 *   global schema (they add app-specific keys) and never redefine global keys.
 *   `set` validates against the store's effective schema. Invalid writes
 *   (unknown key or wrong type) are REJECTED with a console.warn and `set`
 *   returns false — we reject rather than coerce so callers get a predictable,
 *   typed surface.
 *
 * Migrations:
 *   `SettingsStore.migrations` is a list of read-old / write-new functions for
 *   the real legacy localStorage blobs. They run on read (module init, and on
 *   demand via runMigrations()). Each migration reads the OLD key and fills the
 *   canonical global / per-app stores WITHOUT clobbering values already present,
 *   then records itself as done. The OLD key is intentionally left in place for
 *   one release so a rollback keeps working.
 *
 * Storage backing: localStorage is used directly for now.
 * // TODO(IP-6): route through platform.storage once the platform facade lands.
 *   A sibling agent is building that facade in parallel; do not depend on it yet.
 */
(function () {
  "use strict";

  // --- Constants ----------------------------------------------------------

  const KEY_PREFIX = "narbe.settings.";
  const GLOBAL_KEY = KEY_PREFIX + "global";
  const MIGRATED_KEY = KEY_PREFIX + "_migrated"; // array of completed migration ids
  const MESSAGE_TYPE = "narbe-settings-changed"; // mirrors scan-manager's message shape

  // --- Profiles (IP-7) ----------------------------------------------------

  const DEFAULT_PROFILE = "default";
  const ACTIVE_PROFILE_KEY = "narbe.activeProfile"; // persisted active profile id
  const PROFILE_PREFIX = "narbe.profile."; // namespace root for non-default profiles
  const PROFILE_MESSAGE_TYPE = "narbe-profile-changed"; // mirrors MESSAGE_TYPE shape

  /**
   * Namespace a base "narbe.*" storage key for a profile.
   *   default -> base key UNCHANGED (back-compat; existing data == default profile)
   *   p       -> "narbe.profile.<p>." + (base key with its leading "narbe." dropped)
   * e.g. "narbe.settings.global" -> "narbe.profile.p.settings.global".
   */
  function namespaceKey(baseKey, profile) {
    if (!profile || profile === DEFAULT_PROFILE) return baseKey;
    return PROFILE_PREFIX + profile + "." + baseKey.slice("narbe.".length);
  }

  // Canonical highlight-color palette (index-based, shared by the index-using
  // apps). String-color apps map their color name into this list, falling back
  // to index 0 ("Theme Default") for anything unrecognized.
  const HIGHLIGHT_COLORS = [
    "Theme Default",
    "Yellow",
    "White",
    "Cyan",
    "Lime",
    "Magenta",
    "Red",
    "Orange",
    "Pink",
    "Gold",
    "DeepSkyBlue",
    "SpringGreen",
    "Violet",
  ];

  // --- Schema -------------------------------------------------------------

  // A field spec is either a primitive type string ("number" | "boolean" |
  // "string") or { enum: [...] }.
  const GLOBAL_SCHEMA = {
    scanSpeedIndex: "number",
    autoScan: "boolean",
    highlightColorIndex: "number",
    highlightStyle: { enum: ["outline", "full"] },
    voiceName: "string",
    rate: "number",
    pitch: "number",
    volume: "number",
  };

  // Per-app schema EXTENSIONS. These are merged on top of GLOBAL_SCHEMA, never
  // replacing global keys. They give each migrated app a typed home for its
  // residual, app-specific settings (the non-global leftovers of its old blob).
  const APP_SCHEMAS = {
    tictactoe: {
      themeIndex: "number",
      tts: "boolean",
      locationTTS: "boolean",
      sound: "boolean",
      voiceIndex: "number",
      p1Color: "string",
      p2Color: "string",
    },
    wordjumble: {
      themeIndex: "number",
      tts: "boolean",
      dataSource: "string",
    },
    matchy: {
      themeIndex: "number",
      tts: "boolean",
      ttsLocation: "boolean",
      sound: "boolean",
      voiceIndex: "number",
      p1Color: "string",
      p2Color: "string",
    },
    bowling: {
      themeIndex: "number",
      tts: "boolean",
      music: "boolean",
      sfx: "boolean",
      voiceIndex: "number",
      ballStyleIndex: "number",
      aimerColorIndex: "number",
    },
    keyboard: {
      theme: "string",
      autocapI: "boolean",
    },
    minigolf: {
      aimerStyle: "string",
      aimerSpeed: "string",
      ballColor: "string",
      aimerThickness: "number",
      aimerThicknessName: "string",
      sound: "boolean",
      music: "boolean",
      tts: "boolean",
      voiceIndex: "number",
    },
    peggle: {
      music: "boolean",
      aimerIndex: "number",
      aimerSpeedIndex: "number",
      crosshairEnabled: "boolean",
    },
    streaming: {
      theme: "string",
    },
    journal: {
      theme: "string",
    },
  };

  function schemaForApp(appId) {
    return Object.assign({}, GLOBAL_SCHEMA, APP_SCHEMAS[appId] || {});
  }

  /**
   * Validate a single key/value against a schema.
   * @returns {boolean} true if the value is acceptable.
   */
  function isValid(schema, key, value) {
    const spec = schema[key];
    if (!spec) return false; // unknown key
    if (typeof spec === "string") return typeof value === spec;
    if (spec.enum) return spec.enum.indexOf(value) !== -1;
    return false;
  }

  // --- Helpers shared by migrations --------------------------------------

  /** Map a highlight style from any known legacy spelling to the canonical set. */
  function normalizeHighlightStyle(style) {
    if (style === "full" || style === "fill") return "full";
    if (style === "outline") return "outline";
    return undefined; // unknown -> let the default stand
  }

  /** Map a highlight color (name string or numeric index) to a canonical index. */
  function normalizeHighlightColorIndex(value) {
    if (
      typeof value === "number" &&
      value >= 0 &&
      value < HIGHLIGHT_COLORS.length
    ) {
      return value;
    }
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      const idx = HIGHLIGHT_COLORS.findIndex((c) => c.toLowerCase() === lower);
      if (idx !== -1) return idx;
    }
    return undefined; // unknown -> let the default stand
  }

  // --- localStorage access (single choke point; swap for platform.storage in IP-6)

  function readRaw(storageKey) {
    try {
      // TODO(IP-6): route through platform.storage instead of localStorage.
      const raw = localStorage.getItem(storageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      console.warn("SettingsStore: failed to read " + storageKey + ":", e);
      return {};
    }
  }

  function writeRaw(storageKey, obj) {
    try {
      // TODO(IP-6): route through platform.storage instead of localStorage.
      localStorage.setItem(storageKey, JSON.stringify(obj));
    } catch (e) {
      console.error("SettingsStore: failed to write " + storageKey + ":", e);
    }
  }

  // --- Active-profile state ----------------------------------------------

  /** Read the persisted active profile id (a plain string), or the default. */
  function readActiveProfile() {
    try {
      const raw = localStorage.getItem(ACTIVE_PROFILE_KEY);
      return typeof raw === "string" && raw ? raw : DEFAULT_PROFILE;
    } catch (e) {
      return DEFAULT_PROFILE;
    }
  }

  let activeProfile =
    typeof localStorage !== "undefined" ? readActiveProfile() : DEFAULT_PROFILE;

  // --- Cross-iframe broadcast (mirrors scan-manager) ----------------------

  // Registry of live store instances by their storage key, so the single
  // window-level message/storage listener can route a change to the right store.
  const registry = new Map();

  const hasWindow = typeof window !== "undefined" && window.addEventListener;

  /**
   * Broadcast a change to other frames. Mirrors scan-manager: only posts to a
   * parent that is a *different* window (i.e. we're in a child iframe), so a
   * single document never messages itself into a loop. Receivers do not
   * re-broadcast, which is the second loop guard.
   */
  function broadcast(storageKey, settings) {
    if (!hasWindow) return;
    const message = { type: MESSAGE_TYPE, key: storageKey, settings: settings };
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(message, "*");
      }
    } catch (e) {
      console.warn("SettingsStore: broadcast failed:", e);
    }
  }

  /**
   * Broadcast a profile switch to other frames. Same parent-only loop guard as
   * `broadcast` above. The receiver applies it WITHOUT re-broadcasting.
   */
  function broadcastProfileChange(profileId) {
    if (!hasWindow) return;
    const message = { type: PROFILE_MESSAGE_TYPE, profile: profileId };
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(message, "*");
      }
    } catch (e) {
      console.warn("SettingsStore: profile broadcast failed:", e);
    }
  }

  if (hasWindow) {
    // Same-window-tree sync via postMessage (the simulated path in tests).
    window.addEventListener("message", function (event) {
      const data = event && event.data;
      if (!data) return;
      if (data.type === PROFILE_MESSAGE_TYPE) {
        if (typeof data.profile === "string" && data.profile) {
          switchProfile(data.profile, false); // receive path: do not re-broadcast
        }
        return;
      }
      if (data.type !== MESSAGE_TYPE) return;
      const store = registry.get(data.key);
      if (!store) return;
      if (data.settings && typeof data.settings === "object") {
        store._receiveRemote(data.settings);
      }
    });

    // Cross-tab sync via the native storage event.
    window.addEventListener("storage", function (event) {
      if (!event || typeof event.key !== "string") return;
      const store = registry.get(event.key);
      if (store) store._refreshFromStorage();
    });
  }

  // --- Store instance -----------------------------------------------------

  function createStore(storageKey, schema) {
    let cache = readRaw(storageKey);
    const subscribers = [];

    function notify() {
      const snapshot = getAll();
      subscribers.forEach(function (cb) {
        try {
          cb(snapshot);
        } catch (e) {
          console.error("SettingsStore: subscriber error:", e);
        }
      });
    }

    function getAll() {
      return Object.assign({}, cache);
    }

    const store = {
      _storageKey: storageKey,
      _schema: schema,

      get: function (key) {
        return cache[key];
      },

      getAll: getAll,

      /**
       * Set a single key. Validates against the schema; rejects unknown keys
       * and type mismatches with a warning and returns false.
       * @returns {boolean} whether the value was accepted.
       */
      set: function (key, value) {
        if (!isValid(schema, key, value)) {
          console.warn(
            "SettingsStore: rejected invalid set on " +
              storageKey +
              ' — key "' +
              key +
              '" value ' +
              JSON.stringify(value),
          );
          return false;
        }
        cache = Object.assign({}, cache, { [key]: value });
        writeRaw(storageKey, cache);
        notify();
        broadcast(storageKey, cache);
        return true;
      },

      subscribe: function (cb) {
        if (typeof cb === "function" && subscribers.indexOf(cb) === -1) {
          subscribers.push(cb);
        }
      },

      unsubscribe: function (cb) {
        const i = subscribers.indexOf(cb);
        if (i !== -1) subscribers.splice(i, 1);
      },

      // --- Internal hooks --------------------------------------------------

      /** Re-read from storage and notify (native storage event path). */
      _refreshFromStorage: function () {
        cache = readRaw(storageKey);
        notify();
      },

      /**
       * Fire subscribers without a value change, used on a profile switch so
       * consumers re-read through `SettingsStore.global` / `.app()` (which now
       * resolve to the newly-active namespace).
       */
      _notifyProfileChange: function () {
        notify();
      },

      /** Apply an incoming remote snapshot, persist it, notify. No re-broadcast. */
      _receiveRemote: function (settings) {
        const next = Object.assign({}, cache);
        Object.keys(settings).forEach(function (key) {
          if (isValid(schema, key, settings[key])) next[key] = settings[key];
        });
        cache = next;
        writeRaw(storageKey, cache);
        notify();
      },

      /**
       * Fill keys from a migration WITHOUT clobbering values already present.
       * @returns {boolean} whether anything changed.
       */
      _applyMigrated: function (values) {
        let changed = false;
        const next = Object.assign({}, cache);
        Object.keys(values).forEach(function (key) {
          if (next[key] !== undefined) return; // never clobber existing
          if (isValid(schema, key, values[key])) {
            next[key] = values[key];
            changed = true;
          }
        });
        if (changed) {
          cache = next;
          writeRaw(storageKey, cache);
          notify();
        }
        return changed;
      },
    };

    registry.set(storageKey, store);
    return store;
  }

  // --- Singletons ---------------------------------------------------------

  // Stores are cached by their (profile-resolved) storage key. `registry` is
  // already that map — createStore registers each store under its storage key —
  // so we reuse it as the cache instead of keeping a second index. This makes a
  // profile switch a no-op for already-built stores: the same id resolves to a
  // different key, which creates/returns a different store.
  function getOrCreateStore(storageKey, schema) {
    const existing = registry.get(storageKey);
    if (existing) return existing;
    return createStore(storageKey, schema); // self-registers in `registry`
  }

  function getGlobal() {
    return getOrCreateStore(
      namespaceKey(GLOBAL_KEY, activeProfile),
      GLOBAL_SCHEMA,
    );
  }

  function getApp(appId) {
    if (!appId || typeof appId !== "string") {
      throw new Error(
        "SettingsStore.app(appId): appId must be a non-empty string",
      );
    }
    return getOrCreateStore(
      namespaceKey(KEY_PREFIX + appId, activeProfile),
      schemaForApp(appId),
    );
  }

  // --- Profile management (IP-7) -----------------------------------------

  /** The active profile id; "default" when unset. */
  function getActiveProfile() {
    return activeProfile;
  }

  /**
   * Switch the active profile. Persists the id, re-notifies live stores so
   * subscribers re-read through the new namespace, and broadcasts a
   * "narbe-profile-changed" message to sibling frames. Subsequent get/set go
   * to the new namespace. No-op (besides validation) when already active.
   */
  function setActiveProfile(id) {
    if (typeof id !== "string" || !id) {
      throw new Error(
        "SettingsStore.setActiveProfile(id): id must be a non-empty string",
      );
    }
    switchProfile(id, true);
  }

  /**
   * Core profile switch. `doBroadcast` is false on the receive path (an incoming
   * "narbe-profile-changed" message) so siblings don't re-broadcast into a loop —
   * the same loop guard the settings receiver uses.
   */
  function switchProfile(id, doBroadcast) {
    if (id === activeProfile) return;
    activeProfile = id;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(ACTIVE_PROFILE_KEY, id);
      } catch (e) {
        console.error("SettingsStore: failed to persist active profile:", e);
      }
    }
    // Re-notify every live store so consumers re-read via the active namespace.
    registry.forEach(function (store) {
      if (store && typeof store._notifyProfileChange === "function") {
        store._notifyProfileChange();
      }
    });
    if (doBroadcast) broadcastProfileChange(id);
  }

  /**
   * Discover known profiles: "default" first, then every `<id>` that has at
   * least one "narbe.profile.<id>." key in localStorage. De-duped.
   */
  function listProfiles() {
    const ids = [DEFAULT_PROFILE];
    if (typeof localStorage === "undefined") return ids;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (typeof k !== "string" || k.indexOf(PROFILE_PREFIX) !== 0) continue;
        const rest = k.slice(PROFILE_PREFIX.length);
        const dot = rest.indexOf(".");
        if (dot <= 0) continue;
        const id = rest.slice(0, dot);
        if (id && ids.indexOf(id) === -1) ids.push(id);
      }
    } catch (e) {
      console.warn("SettingsStore: listProfiles scan failed:", e);
    }
    return ids;
  }

  /**
   * Create a profile by seeding an empty global-settings namespace for it, so
   * it is discoverable by listProfiles(). No-op for the default profile (it is
   * always present). Returns the id.
   */
  function createProfile(id) {
    if (typeof id !== "string" || !id) {
      throw new Error(
        "SettingsStore.createProfile(id): id must be a non-empty string",
      );
    }
    if (id === DEFAULT_PROFILE) return id;
    const key = namespaceKey(GLOBAL_KEY, id);
    if (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(key) === null
    ) {
      writeRaw(key, {});
    }
    return id;
  }

  /**
   * Delete a profile: remove every "narbe.profile.<id>." key. Never deletes the
   * default profile. If the deleted profile is active, falls back to default.
   * Returns the number of keys removed.
   */
  function deleteProfile(id) {
    if (id === DEFAULT_PROFILE || typeof id !== "string" || !id) return 0;
    if (typeof localStorage === "undefined") return 0;
    const prefix = PROFILE_PREFIX + id + ".";
    const toRemove = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (typeof k === "string" && k.indexOf(prefix) === 0) toRemove.push(k);
      }
    } catch (e) {
      console.warn("SettingsStore: deleteProfile scan failed:", e);
    }
    toRemove.forEach(function (k) {
      try {
        localStorage.removeItem(k);
        registry.delete(k); // drop any cached store bound to a removed key
      } catch (e) {
        /* best-effort */
      }
    });
    if (activeProfile === id) setActiveProfile(DEFAULT_PROFILE);
    return toRemove.length;
  }

  // --- Migrations ---------------------------------------------------------

  // Each migration: { id, oldKey, appId, migrate(oldBlob) -> { global, app } }.
  // `migrate` is pure: it converts a legacy blob into canonical global / per-app
  // patches. runMigrations() handles reading the old key, applying the patches
  // (without clobbering), and bookkeeping. The old key is kept for one release.
  const migrations = [
    {
      id: "tictactoe_settings",
      oldKey: "tictactoe_settings",
      appId: "tictactoe",
      migrate: function (old) {
        const global = {};
        if (typeof old.scanSpeedIndex === "number")
          global.scanSpeedIndex = old.scanSpeedIndex;
        const hs = normalizeHighlightStyle(old.highlightStyle);
        if (hs) global.highlightStyle = hs;
        const hc = normalizeHighlightColorIndex(old.highlightColorIndex);
        if (hc !== undefined) global.highlightColorIndex = hc;
        const app = pick(old, [
          "themeIndex",
          "tts",
          "locationTTS",
          "sound",
          "voiceIndex",
          "p1Color",
          "p2Color",
        ]);
        return { global: global, app: app };
      },
    },
    {
      id: "wordjumble_settings_v2",
      oldKey: "wordjumble_settings_v2",
      appId: "wordjumble",
      migrate: function (old) {
        const global = {};
        if (typeof old.autoScan === "boolean") global.autoScan = old.autoScan;
        if (typeof old.scanSpeedIndex === "number")
          global.scanSpeedIndex = old.scanSpeedIndex;
        const hs = normalizeHighlightStyle(old.highlightStyle);
        if (hs) global.highlightStyle = hs;
        const hc = normalizeHighlightColorIndex(old.highlightColorIndex);
        if (hc !== undefined) global.highlightColorIndex = hc;
        const app = pick(old, ["themeIndex", "tts", "dataSource"]);
        return { global: global, app: app };
      },
    },
    {
      id: "matchy_settings",
      oldKey: "matchy_settings",
      appId: "matchy",
      migrate: function (old) {
        const global = {};
        const hs = normalizeHighlightStyle(old.highlightStyle);
        if (hs) global.highlightStyle = hs;
        const hc = normalizeHighlightColorIndex(old.highlightColorIndex);
        if (hc !== undefined) global.highlightColorIndex = hc;
        const app = pick(old, [
          "themeIndex",
          "tts",
          "ttsLocation",
          "sound",
          "voiceIndex",
          "p1Color",
          "p2Color",
        ]);
        return { global: global, app: app };
      },
    },
    {
      id: "benny_settings",
      oldKey: "benny_settings",
      appId: "bowling",
      migrate: function (old) {
        // Bowling's legacy blob is app-specific (no highlight keys). Voice/TTS
        // remain app-local; the voice manager owns the global voice fields.
        const app = pick(old, [
          "themeIndex",
          "tts",
          "music",
          "sfx",
          "voiceIndex",
          "ballStyleIndex",
          "aimerColorIndex",
        ]);
        return { global: {}, app: app };
      },
    },
    {
      id: "kb_settings",
      oldKey: "kb_settings",
      appId: "keyboard",
      migrate: function (old) {
        const global = {};
        if (typeof old.autoScan === "boolean") global.autoScan = old.autoScan;
        // Keyboard stores highlightColor as a color name string.
        const hc = normalizeHighlightColorIndex(old.highlightColor);
        if (hc !== undefined) global.highlightColorIndex = hc;
        const app = pick(old, ["theme", "autocapI"]);
        return { global: global, app: app };
      },
    },
    {
      id: "bmg_settings",
      oldKey: "bmg_settings",
      appId: "minigolf",
      migrate: function (old) {
        const app = pick(old, [
          "aimerStyle",
          "aimerSpeed",
          "ballColor",
          "aimerThickness",
          "aimerThicknessName",
          "sound",
          "music",
          "tts",
          "voiceIndex",
        ]);
        return { global: {}, app: app };
      },
    },
    {
      id: "bensPeggleV4Settings",
      oldKey: "bensPeggleV4Settings",
      appId: "peggle",
      migrate: function (old) {
        const global = {};
        if (typeof old.autoScan === "boolean") global.autoScan = old.autoScan;
        if (typeof old.scanSpeedIndex === "number")
          global.scanSpeedIndex = old.scanSpeedIndex;
        const app = pick(old, [
          "music",
          "aimerIndex",
          "aimerSpeedIndex",
          "crosshairEnabled",
        ]);
        return { global: global, app: app };
      },
    },
    {
      id: "streaming_settings",
      oldKey: "streaming_settings",
      appId: "streaming",
      migrate: function (old) {
        const global = {};
        // Streaming spells the style "fill"; normalize to canonical "full".
        const hs = normalizeHighlightStyle(old.highlightStyle);
        if (hs) global.highlightStyle = hs;
        const hc = normalizeHighlightColorIndex(old.highlightColor);
        if (hc !== undefined) global.highlightColorIndex = hc;
        const app = pick(old, ["theme"]);
        return { global: global, app: app };
      },
    },
    {
      id: "journal_settings",
      oldKey: "journal_settings",
      appId: "journal",
      migrate: function (old) {
        const global = {};
        const hc = normalizeHighlightColorIndex(old.highlightColor);
        if (hc !== undefined) global.highlightColorIndex = hc;
        const app = pick(old, ["theme"]);
        return { global: global, app: app };
      },
    },
  ];

  /** Shallow-pick the listed keys that are actually present (not undefined). */
  function pick(source, keys) {
    const out = {};
    keys.forEach(function (k) {
      if (source[k] !== undefined) out[k] = source[k];
    });
    return out;
  }

  function readMigratedIds() {
    try {
      const raw = localStorage.getItem(MIGRATED_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function markMigrated(ids) {
    writeRaw(MIGRATED_KEY, ids);
  }

  /**
   * Run any pending migrations. Reads each legacy blob, applies its canonical
   * global / per-app patches without clobbering existing values, and records
   * the migration as done. Old keys are intentionally left in place.
   * @param {boolean} [force] re-run even migrations already recorded as done.
   * @returns {string[]} ids of migrations that ran this call.
   */
  function runMigrations(force) {
    const done = force ? [] : readMigratedIds();
    const ran = [];
    migrations.forEach(function (m) {
      if (done.indexOf(m.id) !== -1) return;
      let oldBlob;
      try {
        const raw = localStorage.getItem(m.oldKey);
        if (!raw) return; // nothing to migrate
        oldBlob = JSON.parse(raw);
      } catch (e) {
        console.warn(
          "SettingsStore: could not parse legacy blob " + m.oldKey + ":",
          e,
        );
        return;
      }
      if (!oldBlob || typeof oldBlob !== "object") return;

      let patch;
      try {
        patch = m.migrate(oldBlob) || {};
      } catch (e) {
        console.error("SettingsStore: migration " + m.id + " threw:", e);
        return;
      }
      if (patch.global) getGlobal()._applyMigrated(patch.global);
      if (patch.app && m.appId) getApp(m.appId)._applyMigrated(patch.app);

      done.push(m.id);
      ran.push(m.id);
    });
    if (ran.length) markMigrated(done);
    return ran;
  }

  // --- Public API ---------------------------------------------------------

  const SettingsStore = {
    get global() {
      return getGlobal();
    },
    app: getApp,
    runMigrations: runMigrations,
    migrations: migrations,

    // Profiles (IP-7).
    getActiveProfile: getActiveProfile,
    setActiveProfile: setActiveProfile,
    listProfiles: listProfiles,
    createProfile: createProfile,
    deleteProfile: deleteProfile,

    // Exposed for callers/tests that need the canonical reference data.
    GLOBAL_SCHEMA: GLOBAL_SCHEMA,
    APP_SCHEMAS: APP_SCHEMAS,
    HIGHLIGHT_COLORS: HIGHLIGHT_COLORS,
    keyFor: function (appId) {
      return appId ? KEY_PREFIX + appId : GLOBAL_KEY;
    },
    /**
     * The active-profile-resolved storage key for the global store (no appId)
     * or a per-app store. Lets the hub/tests confirm where writes land.
     */
    activeKeyFor: function (appId) {
      const base = appId ? KEY_PREFIX + appId : GLOBAL_KEY;
      return namespaceKey(base, activeProfile);
    },

    // Test/lifecycle helper: drop in-memory store instances and re-read the
    // active profile so a fresh localStorage (e.g. between tests) is re-read
    // cleanly. Does not touch storage.
    _reset: function () {
      registry.clear();
      activeProfile =
        typeof localStorage !== "undefined"
          ? readActiveProfile()
          : DEFAULT_PROFILE;
    },
  };

  // Run migrations on read at module init (best-effort; no-op without storage).
  if (typeof localStorage !== "undefined") {
    try {
      runMigrations();
    } catch (e) {
      console.warn("SettingsStore: initial migration sweep failed:", e);
    }
  }

  // --- Dual export: IIFE global + CommonJS --------------------------------
  if (typeof window !== "undefined") {
    window.SettingsStore = SettingsStore;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SettingsStore;
  }
})();
