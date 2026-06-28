#!/usr/bin/env node
/**
 * create-benny-game — scaffold a new switch-accessible game for the
 * Narbehouse Accessibility Hub.
 *
 * Every game it emits is accessible by default: it boots the shared voice /
 * scan managers, the ScanController switch-scanning core, and a BennyGame
 * subclass that inherits pause/back/TTS. The generated game also ships a
 * conformance test that passes out of the box, so a parent or an AI assistant
 * starts from a known-good accessible baseline instead of a blank file.
 *
 * Usage:
 *   node tools/create-benny-game/index.js --id <id> --family <board|grid|arcade|quiz>
 *   node tools/create-benny-game/index.js --id puzzle --family grid --out /tmp/puzzle
 *
 * Flags:
 *   --id <id>          Required. Lowercase identifier, e.g. "bennyspuzzle".
 *   --family <family>  Required. One of board | grid | arcade | quiz.
 *   --title <title>    Optional. Human title; derived from --id when omitted.
 *   --out <dir>        Optional. Write into this dir instead of the hub's
 *                      apps/games/<ID>/ folder (used for testing).
 *   --force            Overwrite an existing target directory.
 *
 * No npm script wraps this on purpose — invoke it with `node` directly so the
 * scaffolder never has to touch package.json.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const FAMILIES = ["board", "grid", "arcade", "quiz"];
const TEMPLATES_DIR = path.join(__dirname, "templates");

/**
 * Parse `--flag value` / `--flag` style argv into a plain object.
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/** Split an id into lowercase word parts (handles dashes, underscores, camelCase). */
function words(id) {
  return String(id)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** PascalCase class name, e.g. "benny-puzzle" -> "BennyPuzzle". */
function toClassName(id) {
  const name = words(id)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  // A JS class name cannot start with a digit.
  return /^[0-9]/.test(name) ? `Game${name}` : name || "BennyGame";
}

/** Title Case label, e.g. "bennyspuzzle" -> "Bennyspuzzle". */
function toTitle(id) {
  return words(id)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Replace every __TOKEN__ in `text` using the provided map. */
function substitute(text, tokens) {
  return text.replace(/__([A-Z_]+)__/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match,
  );
}

/** Read a template file and apply token substitution. */
function renderTemplate(name, tokens) {
  const raw = fs.readFileSync(path.join(TEMPLATES_DIR, name), "utf8");
  return substitute(raw, tokens);
}

/**
 * Generate a game scaffold.
 * @param {object} opts
 * @param {string} opts.id          Lowercase identifier.
 * @param {string} opts.family      One of FAMILIES.
 * @param {string} [opts.title]     Human title.
 * @param {string} opts.outDir      Directory to write the game into.
 * @returns {{ outDir: string, files: string[], gamesEntry: object }}
 */
function generate(opts) {
  const id = String(opts.id).toLowerCase();
  const family = opts.family;
  const className = toClassName(id);
  const title = opts.title || toTitle(id);
  const dirName = id.toUpperCase();

  const tokens = {
    ID: id,
    ID_UPPER: dirName,
    NAME: className,
    TITLE: title,
    FAMILY: family,
    FAMILY_TITLE: family.charAt(0).toUpperCase() + family.slice(1),
  };

  // Current games.json shape. The extended manifest (genres metadata, etc.)
  // is a pending IP-4 item — leave the richer fields for that follow-up.
  const gamesEntry = {
    id,
    title,
    // TODO(IP-4): write a real description; the extended manifest lands later.
    description: `${title} — a switch-accessible ${family} game.`,
    path: `apps/games/${dirName}/index.html`,
    image: `images/games/${id}.png`,
    genres: [tokens.FAMILY_TITLE],
    launchExternal: false,
  };

  fs.mkdirSync(path.join(opts.outDir, "js"), { recursive: true });

  const written = [];
  const write = (relPath, contents) => {
    const dest = path.join(opts.outDir, relPath);
    fs.writeFileSync(dest, contents);
    written.push(relPath);
  };

  write("index.html", renderTemplate("index.html", tokens));
  write("style.css", renderTemplate("style.css", tokens));
  write("js/app.js", renderTemplate("app.js", tokens));
  write(
    "js/app.conformance.test.js",
    renderTemplate("conformance.test.js", tokens),
  );
  write("games.entry.json", `${JSON.stringify(gamesEntry, null, 2)}\n`);

  return { outDir: opts.outDir, files: written, gamesEntry };
}

/** Resolve the hub's apps/games root from this tool's location. */
function resolveGamesRoot() {
  return path.join(__dirname, "..", "..", "bennyshub", "apps", "games");
}

function usage() {
  return [
    "Usage:",
    "  node tools/create-benny-game/index.js --id <id> --family <board|grid|arcade|quiz> [--title <title>] [--out <dir>] [--force]",
    "",
    "Examples:",
    "  node tools/create-benny-game/index.js --id bennyspuzzle --family grid",
    "  node tools/create-benny-game/index.js --id puzzle --family grid --out /tmp/puzzle",
  ].join("\n");
}

function main(argv) {
  const args = parseArgs(argv);

  if (args.help || args.h) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const id = args.id;
  const family = args.family;

  if (!id || typeof id !== "string") {
    process.stderr.write(`Error: --id is required.\n\n${usage()}\n`);
    return 1;
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
    process.stderr.write(
      `Error: --id "${id}" must start with a letter and contain only letters, digits, dashes, or underscores.\n`,
    );
    return 1;
  }
  if (!family || !FAMILIES.includes(family)) {
    process.stderr.write(
      `Error: --family must be one of: ${FAMILIES.join(", ")}.\n\n${usage()}\n`,
    );
    return 1;
  }

  const outDir =
    typeof args.out === "string"
      ? path.resolve(args.out)
      : path.join(resolveGamesRoot(), id.toUpperCase());

  if (
    fs.existsSync(outDir) &&
    fs.readdirSync(outDir).length > 0 &&
    !args.force
  ) {
    process.stderr.write(
      `Error: target "${outDir}" already exists and is not empty. Pass --force to overwrite.\n`,
    );
    return 1;
  }

  const result = generate({
    id,
    family,
    title: typeof args.title === "string" ? args.title : undefined,
    outDir,
  });

  process.stdout.write(
    `Scaffolded ${toTitle(id)} (${family}) into:\n  ${result.outDir}\n\n`,
  );
  process.stdout.write("Files written:\n");
  for (const f of result.files) {
    process.stdout.write(`  ${f}\n`);
  }

  process.stdout.write(
    '\nPaste this entry into bennyshub/apps/games/games.json (inside the "games" array):\n\n',
  );
  process.stdout.write(`${JSON.stringify(result.gamesEntry, null, 2)}\n`);

  process.stdout.write(
    "\nRun the generated conformance test from the repo root with:\n" +
      `  npx jest ${path.relative(process.cwd(), path.join(result.outDir, "js", "app.conformance.test.js"))}\n`,
  );

  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  parseArgs,
  toClassName,
  toTitle,
  substitute,
  generate,
  main,
  FAMILIES,
};
