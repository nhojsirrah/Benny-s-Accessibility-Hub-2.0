# create-benny-game

A small Node CLI that scaffolds a new switch-accessible game for the Narbehouse
Accessibility Hub. Every game it emits is **accessible by default**: it boots the
shared voice/scan managers, the `ScanController` switch-scanning core, and a
`BennyGame` subclass that inherits pause/back and TTS. It also ships a
conformance test that passes out of the box, so the starting point is a
known-good accessible baseline rather than a blank file.

## Usage

Run it with `node` from the repo root (there is no npm script on purpose — the
scaffolder never touches `package.json`):

```bash
node tools/create-benny-game/index.js --id <id> --family <board|grid|arcade|quiz>
```

Flags:

| Flag       | Required | Description                                                               |
| ---------- | -------- | ------------------------------------------------------------------------- |
| `--id`     | yes      | Lowercase identifier, e.g. `bennyspuzzle`. Drives the folder/class names. |
| `--family` | yes      | One of `board`, `grid`, `arcade`, `quiz`.                                 |
| `--title`  | no       | Human title; derived from `--id` when omitted.                            |
| `--out`    | no       | Write into this dir instead of `bennyshub/apps/games/<ID>/` (testing).    |
| `--force`  | no       | Overwrite a non-empty target directory.                                   |

Example — scaffold straight into the hub:

```bash
node tools/create-benny-game/index.js --id bennyspuzzle --family grid
```

Example — scaffold into a throwaway dir to inspect first:

```bash
node tools/create-benny-game/index.js --id puzzle --family grid --out /tmp/puzzle
```

## What it emits

Into `bennyshub/apps/games/<ID>/` (or `--out`):

- **`index.html`** — loads the shared managers, `scan-core.js`, and
  `benny-app.js` via `<script src="../../../shared/…">`, then `js/app.js`.
- **`js/app.js`** — a `class <Name> extends BennyGame` with `getScanTargets()`
  and `onSelect()` stubs. Pause, back, and TTS are inherited from `BennyGame`.
- **`style.css`** — accessible focus-visible defaults (loud high-contrast scan
  ring shared by `.scan-focus` and `:focus-visible`, plus the pause overlay).
- **`js/app.conformance.test.js`** — a jest/jsdom test that loads the real
  shared stack and asserts the game overrides the two required hooks and wires a
  live `ScanController` on mount. Passes out of the box.
- **`games.entry.json`** — a `games.json` stub entry in the **current** manifest
  shape (`id`, `title`, `description`, `path`, `image`, `genres`,
  `launchExternal`). The CLI also prints it so you can paste it into
  `bennyshub/apps/games/games.json`. (The extended manifest is a pending IP-4
  item; the generated entry leaves a `TODO` for the richer fields.)

## The accessible-by-default baseline

A game is "done right" for this hub when a single switch can play it. The
scaffold bakes that in:

- **`ScanController`** drives single-switch scanning (short-press to scan, hold
  to reverse, hold-to-pause) so you never re-implement input handling.
- **`BennyGame`** composes the controller and supplies the pause/back overlay
  and TTS announcements. You only fill in `getScanTargets()` (what the scanner
  steps through) and `onSelect()` (what a switch press does).
- **focus-visible CSS** gives every scan target an unambiguous high-contrast
  highlight for switch, keyboard, and magnifier users.
- **the conformance test** is the guardrail: if a refactor drops the overrides
  or stops wiring a `ScanController`, the test goes red.

## For an AI assistant or a parent

Start from the generated `js/app.js` and edit only the two overrides and
`onMount()`. Keep the conformance test green — it is the contract that the game
stays switch-accessible. Run it with:

```bash
npx jest bennyshub/apps/games/<ID>/js/app.conformance.test.js
```

## ActionGraph tie-in

This scaffolder is the "generate" half of a generate-then-render loop: an agent
can call the CLI to stand up an accessible game from a one-line spec, then render
`index.html` (or the conformance result) back onto a canvas node for review —
generation and verification in the same pass.

## Not in scope (deferred follow-up)

Refactoring the existing games into config-driven family engines is a separate,
later piece of work. This tool only scaffolds a new game from a template; it does
not touch existing games, `jest.config.js`, or `package.json`.
