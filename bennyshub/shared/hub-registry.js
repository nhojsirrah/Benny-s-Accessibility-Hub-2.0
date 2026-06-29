/**
 * HubRegistry — a small typed registry over the hub's app manifests
 * (games.json / tools.json).
 *
 * Today bennyshub/index.html holds the loaded manifests in a bare
 * `appsData = { tools: [...], games: [...] }` object and reaches into the raw
 * arrays everywhere it needs to list, filter, paginate, or look an app up
 * (auto-launch, nav signals, genre filtering). IP-7 hub composition models that
 * same data as a typed registry: each manifest entry is wrapped in a HubAppEntry
 * with stable accessors (id / title / type / path / capabilities / …) and each
 * category is a HubCategory exposing the list/genre/filter/find operations the
 * launcher needs. The launcher iterates the registry instead of the raw arrays.
 *
 * This is a behaviour-preserving refactor: entries are sorted by title on load
 * (exactly as before), genre filtering and the title lookup order are identical,
 * and the HubAppEntry getters mirror the raw fields the existing card renderer
 * reads, so a HubAppEntry is a drop-in for the old plain object.
 *
 * Loaded as an IIFE-style global via <script src>, matching the other shared
 * modules (Nav, BennyHud, NarbeScanManager, NarbeVoiceManager). The hub reads
 * window.HubRegistry. A dual CommonJS export is provided so jsdom/node tests can
 * require() it.
 */

(function () {
  "use strict";

  // The two manifest-backed categories the hub ships, mapped to their singular
  // app `type`. Keeping this declarative lets the registry derive a default
  // `type` for entries that predate the IP-4 explicit `type` field.
  var CATEGORY_TYPE = { tools: "tool", games: "game" };

  /**
   * Case-insensitive title sort, matching the existing
   * `a.title.localeCompare(b.title)` ordering used in the hub.
   * @param {HubAppEntry} a
   * @param {HubAppEntry} b
   * @returns {number}
   */
  function byTitle(a, b) {
    return a.title.localeCompare(b.title);
  }

  /**
   * A single manifest entry, wrapped with typed accessors. The getters return
   * the raw manifest values (with safe fallbacks) so the wrapper is a drop-in
   * for the plain object the card renderer used to read. The original record is
   * kept on `.raw` for any field not surfaced here.
   */
  function HubAppEntry(raw, category) {
    this.raw = raw && typeof raw === "object" ? raw : {};
    this.category = category;
  }

  Object.defineProperties(HubAppEntry.prototype, {
    id: {
      get: function () {
        return this.raw.id;
      },
    },
    title: {
      get: function () {
        return this.raw.title || "";
      },
    },
    description: {
      get: function () {
        return this.raw.description || "";
      },
    },
    // Explicit IP-4 `type` when present, else derived from the category.
    type: {
      get: function () {
        return this.raw.type || CATEGORY_TYPE[this.category] || null;
      },
    },
    path: {
      get: function () {
        return this.raw.path || null;
      },
    },
    image: {
      get: function () {
        return this.raw.image || null;
      },
    },
    genres: {
      get: function () {
        return Array.isArray(this.raw.genres) ? this.raw.genres : [];
      },
    },
    capabilities: {
      get: function () {
        return this.raw.capabilities || {};
      },
    },
    // Alternate launch targets the launcher branches on. Mirrored so callers can
    // read them off the entry exactly as they read the old raw object.
    launchUrl: {
      get: function () {
        return this.raw.launchUrl || null;
      },
    },
    launchExternal: {
      get: function () {
        return this.raw.launchExternal || null;
      },
    },
    serverApp: {
      get: function () {
        return this.raw.serverApp || null;
      },
    },
    externalUrl: {
      get: function () {
        return this.raw.externalUrl || null;
      },
    },
    serverPort: {
      get: function () {
        return this.raw.serverPort || null;
      },
    },
  });

  /**
   * One manifest category (tools or games): an ordered collection of
   * HubAppEntry wrappers plus the list/genre/filter/find operations the hub's
   * launcher performs over it.
   */
  function HubCategory(category) {
    this.category = category;
    this.entries = [];
  }

  /**
   * Replace this category's entries from a raw manifest array, wrapping and
   * title-sorting them (same ordering the hub applied on load). Non-arrays are
   * treated as empty.
   * @param {Array<object>} rawEntries
   * @returns {HubCategory} this
   */
  HubCategory.prototype.setEntries = function (rawEntries) {
    var category = this.category;
    this.entries = (Array.isArray(rawEntries) ? rawEntries : [])
      .map(function (raw) {
        return new HubAppEntry(raw, category);
      })
      .sort(byTitle);
    return this;
  };

  /** All entries, in title order. Returns a copy so callers can't mutate state. */
  HubCategory.prototype.list = function () {
    return this.entries.slice();
  };

  HubCategory.prototype.size = function () {
    return this.entries.length;
  };

  /** Unique genre tags across the category, sorted (matches getGenres()). */
  HubCategory.prototype.genres = function () {
    var set = {};
    var out = [];
    this.entries.forEach(function (entry) {
      entry.genres.forEach(function (genre) {
        if (!Object.prototype.hasOwnProperty.call(set, genre)) {
          set[genre] = true;
          out.push(genre);
        }
      });
    });
    return out.sort();
  };

  /**
   * Entries matching a genre, in title order. "all" / falsy returns everything
   * (the entries are already title-sorted, matching filterItemsByGenre()).
   * @param {string} genre
   * @returns {HubAppEntry[]}
   */
  HubCategory.prototype.filterByGenre = function (genre) {
    if (genre === "all" || !genre) return this.list();
    return this.entries.filter(function (entry) {
      return entry.genres.indexOf(genre) !== -1;
    });
  };

  HubCategory.prototype.find = function (predicate) {
    for (var i = 0; i < this.entries.length; i++) {
      if (predicate(this.entries[i], i)) return this.entries[i];
    }
    return null;
  };

  /**
   * Title lookup mirroring the hub's auto-launch / nav-signal resolution:
   * a case-insensitive exact match first, then the first substring match.
   * @param {string} query
   * @returns {HubAppEntry|null}
   */
  HubCategory.prototype.findByTitle = function (query) {
    if (!query) return null;
    var q = String(query).toLowerCase();
    return (
      this.find(function (entry) {
        return entry.title && entry.title.toLowerCase() === q;
      }) ||
      this.find(function (entry) {
        return entry.title && entry.title.toLowerCase().indexOf(q) !== -1;
      })
    );
  };

  /**
   * The registry: the typed view over both manifest categories. Unknown
   * category names resolve to an empty HubCategory so callers never crash.
   */
  function HubRegistry() {
    this.categories = {
      tools: new HubCategory("tools"),
      games: new HubCategory("games"),
    };
  }

  HubRegistry.prototype.category = function (name) {
    return this.categories[name] || new HubCategory(name);
  };

  /**
   * Load a category from a raw manifest array.
   * @param {string} name "tools" | "games"
   * @param {Array<object>} rawEntries
   * @returns {HubRegistry} this
   */
  HubRegistry.prototype.setCategory = function (name, rawEntries) {
    if (!this.categories[name]) this.categories[name] = new HubCategory(name);
    this.categories[name].setEntries(rawEntries);
    return this;
  };

  HubRegistry.prototype.list = function (name) {
    return this.category(name).list();
  };

  HubRegistry.prototype.genres = function (name) {
    return this.category(name).genres();
  };

  HubRegistry.prototype.filterByGenre = function (name, genre) {
    return this.category(name).filterByGenre(genre);
  };

  /**
   * Resolve a title across categories in the hub's historical order:
   * tools (exact, then substring) before games (exact, then substring).
   * @param {string} query
   * @param {string[]} [order] category search order; defaults to tools→games.
   * @returns {HubAppEntry|null}
   */
  HubRegistry.prototype.findByTitle = function (query, order) {
    var names = order || ["tools", "games"];
    for (var i = 0; i < names.length; i++) {
      var hit = this.category(names[i]).findByTitle(query);
      if (hit) return hit;
    }
    return null;
  };

  /** Factory mirroring the other shared modules' construction style. */
  function createHubRegistry() {
    return new HubRegistry();
  }

  var HubRegistryModule = {
    createHubRegistry: createHubRegistry,
    HubRegistry: HubRegistry,
    HubCategory: HubCategory,
    HubAppEntry: HubAppEntry,
    CATEGORY_TYPE: CATEGORY_TYPE,
  };

  if (typeof window !== "undefined") {
    window.HubRegistry = HubRegistryModule;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = HubRegistryModule;
  }
})();
