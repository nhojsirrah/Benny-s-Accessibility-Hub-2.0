/**
 * ProfileSwitcher — pure helpers for the hub's IP-7 multi-user profile switcher.
 *
 * The hub chrome (bennyshub/index.html) renders a small "Profile: <name>" control
 * group next to <benny-hud> that lets a household switch between named profiles
 * (default + extras) and create new ones. The actual persistence/broadcast lives
 * in SettingsStore (PROFILE CONTRACT v1):
 *
 *   SettingsStore.getActiveProfile(): string          (default "default")
 *   SettingsStore.setActiveProfile(id: string): void  (persists + broadcasts
 *                                                       "narbe-profile-changed")
 *   SettingsStore.listProfiles(): string[]            (["default", ...])
 *   SettingsStore.createProfile(id) / deleteProfile(id)  (may exist)
 *
 * That API lands in a sibling PR. These helpers are written so the hub degrades
 * gracefully BEFORE it exists: every helper takes the store as an argument,
 * guards each call, and falls back to a sane "default-only" view when the API is
 * absent. They contain NO DOM access so they can be unit-tested under jsdom and
 * reused inline by the hub.
 *
 * Loaded as an IIFE-style global via <script src> (window.ProfileSwitcher),
 * matching the other shared modules. A dual CommonJS export is provided so the
 * jsdom jest harness can require() it.
 */
(function () {
  "use strict";

  // The profile that always exists. Mirrors SettingsStore.getActiveProfile()'s
  // documented default so the hub shows a coherent state even with no API.
  var DEFAULT_PROFILE = "default";

  /** True when `obj` has a callable method named `name`. */
  function hasFn(obj, name) {
    return !!obj && typeof obj[name] === "function";
  }

  /**
   * Whether the full profile-switching API is available on the store. The hub
   * hides the switcher entirely unless this is true, so a missing API leaves the
   * page looking/behaving exactly as today.
   * @param {object|null|undefined} store
   * @returns {boolean}
   */
  function isProfileApiAvailable(store) {
    return (
      hasFn(store, "getActiveProfile") &&
      hasFn(store, "setActiveProfile") &&
      hasFn(store, "listProfiles")
    );
  }

  /**
   * Whether the optional createProfile method is present. The hub shows the
   * "New profile" affordance only when this is true.
   * @param {object|null|undefined} store
   * @returns {boolean}
   */
  function canCreateProfile(store) {
    return hasFn(store, "createProfile");
  }

  /**
   * Resolve the active profile id, defaulting to "default". Tolerates a missing
   * API, a throwing getter, and non-string/empty results.
   * @param {object|null|undefined} store
   * @returns {string}
   */
  function resolveActiveProfile(store) {
    if (!hasFn(store, "getActiveProfile")) return DEFAULT_PROFILE;
    try {
      var id = store.getActiveProfile();
      return typeof id === "string" && id ? id : DEFAULT_PROFILE;
    } catch (e) {
      return DEFAULT_PROFILE;
    }
  }

  /**
   * Resolve the profile list as a clean, ordered, deduplicated string array that
   * always begins with "default". Tolerates a missing API, a throwing call, and
   * non-array / non-string entries.
   * @param {object|null|undefined} store
   * @returns {string[]}
   */
  function resolveProfileList(store) {
    var raw = [];
    if (hasFn(store, "listProfiles")) {
      try {
        var result = store.listProfiles();
        if (Array.isArray(result)) raw = result;
      } catch (e) {
        raw = [];
      }
    }
    var out = [DEFAULT_PROFILE];
    var seen = {};
    seen[DEFAULT_PROFILE] = true;
    raw.forEach(function (id) {
      if (typeof id === "string" && id && !seen[id]) {
        seen[id] = true;
        out.push(id);
      }
    });
    return out;
  }

  /**
   * The next profile id when cycling a single "Switch profile" button. Wraps
   * around; returns "default" for an empty list; if `current` is not in the
   * list, starts from the first entry.
   * @param {string[]} list
   * @param {string} current
   * @returns {string}
   */
  function nextProfile(list, current) {
    if (!Array.isArray(list) || list.length === 0) return DEFAULT_PROFILE;
    var idx = list.indexOf(current);
    if (idx === -1) return list[0];
    return list[(idx + 1) % list.length];
  }

  /**
   * Normalize a user-entered new-profile name (e.g. from window.prompt). Trims
   * surrounding whitespace; returns "" for anything unusable (null, cancel,
   * non-string, whitespace-only) so callers can reject it.
   * @param {*} raw
   * @returns {string}
   */
  function normalizeProfileId(raw) {
    if (typeof raw !== "string") return "";
    return raw.trim();
  }

  var ProfileSwitcher = {
    DEFAULT_PROFILE: DEFAULT_PROFILE,
    isProfileApiAvailable: isProfileApiAvailable,
    canCreateProfile: canCreateProfile,
    resolveActiveProfile: resolveActiveProfile,
    resolveProfileList: resolveProfileList,
    nextProfile: nextProfile,
    normalizeProfileId: normalizeProfileId,
  };

  if (typeof window !== "undefined") {
    window.ProfileSwitcher = ProfileSwitcher;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = ProfileSwitcher;
  }
})();
