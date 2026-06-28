/**
 * Tests for the manifest schema + validator (IP-4 load-time app-contract gate).
 *
 * Covers:
 *  - a valid entry passes
 *  - a missing required field fails with a clear error
 *  - an entry using the new IP-4 optional fields validates
 *  - validateAll over the ACTUAL games.json / tools.json reports results;
 *    known-good entries must pass, and any failures/mismatches are surfaced in
 *    the test output (and the PR body) rather than failing the suite — this is
 *    the manifest reconciliation finding.
 *  - the inlined SCHEMA stays in sync with the on-disk manifest.schema.json
 */

const fs = require("fs");
const path = require("path");

const { validate, validateAll, SCHEMA } = require("../manifest-validator");

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
const SCHEMA_PATH = path.join(__dirname, "..", "manifest.schema.json");

function baseEntry(overrides) {
  return Object.assign(
    {
      id: "sample",
      title: "Sample App",
      description: "A sample entry used in tests.",
      path: "apps/games/SAMPLE/index.html",
      image: "images/games/sample.png",
      genres: ["Test"],
    },
    overrides || {},
  );
}

describe("manifest-validator: single entry", () => {
  test("a valid entry passes", () => {
    const result = validate(baseEntry());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a launchExternal-only entry (no path) passes", () => {
    const entry = baseEntry();
    delete entry.path;
    entry.launchExternal = "search";
    const result = validate(entry);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("missing a required field fails with a clear error", () => {
    const entry = baseEntry();
    delete entry.title;
    const result = validate(entry);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("required") && e.includes("title")),
    ).toBe(true);
  });

  test("an entry with neither path nor launchExternal fails", () => {
    const entry = baseEntry();
    delete entry.path;
    const result = validate(entry);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.toLowerCase().includes("alternative")),
    ).toBe(true);
  });

  test("a wrong-typed field fails with a clear error", () => {
    const result = validate(baseEntry({ genres: "Test" }));
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("genres") && e.includes("array")),
    ).toBe(true);
  });

  test("an entry with the new IP-4 optional fields validates", () => {
    const entry = baseEntry({
      type: "game",
      entry: "apps/games/SAMPLE/index.html",
      controls: "scan-core@1",
      version: "1.2.0",
      capabilities: {
        needsElectron: true,
        usesPhysics: false,
        twoPlayer: true,
      },
      settingsSchema: { properties: { difficulty: { type: "string" } } },
    });
    const result = validate(entry);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("an invalid IP-4 enum value (type) fails", () => {
    const result = validate(baseEntry({ type: "widget" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("type"))).toBe(true);
  });

  test("an unknown field is rejected (additionalProperties: false)", () => {
    const result = validate(baseEntry({ totallyMadeUp: true }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown field"))).toBe(true);
  });

  test("an unknown nested capability is rejected", () => {
    const result = validate(baseEntry({ capabilities: { flying: true } }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("capabilities"))).toBe(true);
  });
});

describe("manifest-validator: validateAll", () => {
  test("accepts a raw array of entries", () => {
    const result = validateAll([baseEntry(), baseEntry({ id: "second" })]);
    expect(result.valid).toBe(true);
  });

  test("accepts a manifest wrapper object and labels failures by id", () => {
    const result = validateAll({
      games: [baseEntry(), baseEntry({ id: "broken", title: undefined })],
    });
    // The undefined title is treated as a missing required field.
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("'broken'"))).toBe(true);
  });

  test("non-array, non-wrapper input fails cleanly", () => {
    const result = validateAll(42);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

/**
 * Reconciliation pass over the ACTUAL manifests. The IP-4 brief flagged a
 * possible ~17-ids vs ~15-dirs mismatch (ConnectFour / SlotMachine said to be
 * ".io-only"). We assert the schema-validity contract here, and SURFACE (not
 * fail on) any entry-vs-directory mismatches so they land in the test output
 * and PR body for the reconciliation follow-up.
 */
describe("manifest reconciliation: actual games.json / tools.json", () => {
  const manifests = [
    {
      name: "games.json",
      file: GAMES_PATH,
      appsRoot: path.join(GAMES_PATH, ".."),
    },
    {
      name: "tools.json",
      file: TOOLS_PATH,
      appsRoot: path.join(TOOLS_PATH, ".."),
    },
  ];

  manifests.forEach(({ name, file, appsRoot }) => {
    describe(name, () => {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const entries = Array.isArray(raw) ? raw : raw[Object.keys(raw)[0]];

      test(`all ${name} entries are schema-valid`, () => {
        const result = validateAll(raw);
        if (!result.valid) {
          // Surface every error so failures are actionable in CI output.
          console.warn(
            `[reconciliation] ${name} schema errors:\n` +
              result.errors.join("\n"),
          );
        }
        expect(result.valid).toBe(true);
      });

      test(`${name}: report entry-vs-directory reconciliation (non-failing)`, () => {
        const findings = [];
        entries.forEach((entry) => {
          // Only path-backed entries map to a local directory; launchExternal
          // entries (e.g. search/messenger) are intentionally dir-less.
          if (!entry.path) {
            findings.push(
              `${entry.id}: launchExternal-only (no local dir expected)`,
            );
            return;
          }
          const resolved = path.join(appsRoot, "..", "..", entry.path);
          if (!fs.existsSync(resolved)) {
            findings.push(`${entry.id}: MISSING entry file -> ${entry.path}`);
          }
        });

        // List directories present on disk that no manifest entry references.
        const referencedDirs = new Set(
          entries
            .filter((e) => e.path)
            .map((e) => e.path.split("/").filter(Boolean).slice(-2, -1)[0]),
        );
        const onDisk = fs
          .readdirSync(appsRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        const orphanDirs = onDisk.filter((d) => !referencedDirs.has(d));

        console.warn(
          `[reconciliation] ${name}: ${entries.length} entries, ` +
            `${onDisk.length} app dirs on disk.\n` +
            (findings.length
              ? "  Entry findings:\n   - " + findings.join("\n   - ") + "\n"
              : "  No entry-file findings.\n") +
            (orphanDirs.length
              ? "  Dirs with no manifest entry:\n   - " +
                orphanDirs.join("\n   - ")
              : "  No orphan dirs."),
        );

        // Intentionally non-failing: reconciliation is a finding, not a gate.
        expect(Array.isArray(findings)).toBe(true);
      });
    });
  });
});

describe("schema file <-> inlined SCHEMA sync", () => {
  const onDisk = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

  test("required lists match", () => {
    expect(SCHEMA.required.slice().sort()).toEqual(
      onDisk.required.slice().sort(),
    );
  });

  test("property names match", () => {
    expect(Object.keys(SCHEMA.properties).sort()).toEqual(
      Object.keys(onDisk.properties).sort(),
    );
  });

  test("property types match", () => {
    Object.keys(onDisk.properties).forEach((key) => {
      expect(SCHEMA.properties[key].type).toBe(onDisk.properties[key].type);
    });
  });

  test("type enum matches", () => {
    expect(SCHEMA.properties.type.enum).toEqual(onDisk.properties.type.enum);
  });

  test("anyOf launch-target rule matches", () => {
    expect(SCHEMA.anyOf).toEqual(onDisk.anyOf);
  });
});
