/**
 * Unit tests for ProfileSwitcher (profile-switcher.js) — the pure helpers that
 * back the hub's IP-7 multi-user profile switcher.
 *
 * These cover the graceful-degradation contract the hub relies on: every helper
 * must tolerate a missing / partial / throwing SettingsStore profile API and
 * fall back to a coherent "default-only" view, so the hub chrome stays correct
 * (and hidden) until the sibling SettingsStore PR ships the real API.
 */

const ProfileSwitcher = require("../profile-switcher.js");

// A store that implements the full PROFILE CONTRACT v1.
function fullStore(active, profiles, opts) {
  opts = opts || {};
  return {
    getActiveProfile: () => active,
    setActiveProfile: () => {},
    listProfiles: () => profiles.slice(),
    ...(opts.withCreate ? { createProfile: () => {} } : {}),
  };
}

describe("isProfileApiAvailable", () => {
  test("true when get/set/list are all present", () => {
    expect(
      ProfileSwitcher.isProfileApiAvailable(fullStore("default", ["default"])),
    ).toBe(true);
  });

  test("false when the store is null/undefined", () => {
    expect(ProfileSwitcher.isProfileApiAvailable(null)).toBe(false);
    expect(ProfileSwitcher.isProfileApiAvailable(undefined)).toBe(false);
  });

  test("false when any required method is missing", () => {
    expect(
      ProfileSwitcher.isProfileApiAvailable({
        getActiveProfile: () => "default",
        listProfiles: () => ["default"],
      }),
    ).toBe(false);
  });
});

describe("canCreateProfile", () => {
  test("true only when createProfile exists", () => {
    expect(
      ProfileSwitcher.canCreateProfile(
        fullStore("default", ["default"], { withCreate: true }),
      ),
    ).toBe(true);
    expect(
      ProfileSwitcher.canCreateProfile(fullStore("default", ["default"])),
    ).toBe(false);
    expect(ProfileSwitcher.canCreateProfile(null)).toBe(false);
  });
});

describe("resolveActiveProfile", () => {
  test("returns the store's active profile", () => {
    expect(
      ProfileSwitcher.resolveActiveProfile(
        fullStore("benny", ["default", "benny"]),
      ),
    ).toBe("benny");
  });

  test("defaults to 'default' with no API", () => {
    expect(ProfileSwitcher.resolveActiveProfile(null)).toBe("default");
    expect(ProfileSwitcher.resolveActiveProfile({})).toBe("default");
  });

  test("defaults to 'default' on empty/non-string result", () => {
    expect(
      ProfileSwitcher.resolveActiveProfile({ getActiveProfile: () => "" }),
    ).toBe("default");
    expect(
      ProfileSwitcher.resolveActiveProfile({ getActiveProfile: () => 42 }),
    ).toBe("default");
  });

  test("defaults to 'default' when the getter throws", () => {
    expect(
      ProfileSwitcher.resolveActiveProfile({
        getActiveProfile: () => {
          throw new Error("boom");
        },
      }),
    ).toBe("default");
  });
});

describe("resolveProfileList", () => {
  test("always starts with 'default' and dedupes", () => {
    expect(
      ProfileSwitcher.resolveProfileList(
        fullStore("default", ["default", "benny", "benny", "mum"]),
      ),
    ).toEqual(["default", "benny", "mum"]);
  });

  test("injects 'default' when the store omits it", () => {
    expect(
      ProfileSwitcher.resolveProfileList(fullStore("benny", ["benny"])),
    ).toEqual(["default", "benny"]);
  });

  test("['default'] with no API", () => {
    expect(ProfileSwitcher.resolveProfileList(null)).toEqual(["default"]);
    expect(ProfileSwitcher.resolveProfileList({})).toEqual(["default"]);
  });

  test("drops non-string entries and tolerates a throwing call", () => {
    expect(
      ProfileSwitcher.resolveProfileList({
        listProfiles: () => ["a", 1, null, "b", ""],
      }),
    ).toEqual(["default", "a", "b"]);
    expect(
      ProfileSwitcher.resolveProfileList({
        listProfiles: () => {
          throw new Error("boom");
        },
      }),
    ).toEqual(["default"]);
  });
});

describe("nextProfile", () => {
  test("cycles forward and wraps", () => {
    const list = ["default", "benny", "mum"];
    expect(ProfileSwitcher.nextProfile(list, "default")).toBe("benny");
    expect(ProfileSwitcher.nextProfile(list, "benny")).toBe("mum");
    expect(ProfileSwitcher.nextProfile(list, "mum")).toBe("default");
  });

  test("starts from the first entry when current is unknown", () => {
    expect(ProfileSwitcher.nextProfile(["default", "benny"], "ghost")).toBe(
      "default",
    );
  });

  test("returns 'default' for an empty/invalid list", () => {
    expect(ProfileSwitcher.nextProfile([], "x")).toBe("default");
    expect(ProfileSwitcher.nextProfile(null, "x")).toBe("default");
  });
});

describe("normalizeProfileId", () => {
  test("trims valid input", () => {
    expect(ProfileSwitcher.normalizeProfileId("  Benny ")).toBe("Benny");
  });

  test("returns '' for unusable input (cancel / non-string / blank)", () => {
    expect(ProfileSwitcher.normalizeProfileId(null)).toBe("");
    expect(ProfileSwitcher.normalizeProfileId(undefined)).toBe("");
    expect(ProfileSwitcher.normalizeProfileId(123)).toBe("");
    expect(ProfileSwitcher.normalizeProfileId("   ")).toBe("");
  });
});
