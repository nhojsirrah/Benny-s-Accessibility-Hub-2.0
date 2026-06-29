/**
 * Tests for the BENNYSDICE scan layer after migrating it onto the shared
 * ScanController (shared/scan-core.js).
 *
 * BENNYSDICE's main game logic (js/game.js) is an ES module that imports three
 * and cannon-es and boots a WebGL renderer at load time, so it cannot be
 * require()d in jsdom. These tests therefore exercise the migration two ways:
 *
 *   1. Behaviorally — they reconstruct the EXACT controller wiring the app sets
 *      up in setupScan() (same option values: getTargets re-read every step,
 *      onFocus/onAnnounce/onSelect, wrap, spaceHoldMs = 3000, the unreachable
 *      enterHoldMs sentinel, no min-press/min-select/min-interval gate) against
 *      the real #main-menu markup pulled from index.html, and drive it with real
 *      KeyboardEvents through the real ScanController class.
 *
 *   2. Statically — they read js/game.js and assert it constructs the controller
 *      with those option values and no longer contains the removed hand-rolled
 *      scan loop (moveScan / onSpaceShortPress / onSpaceLongPress).
 *
 * Runs in jsdom with jest fake timers; the shared scan/voice managers are mocked
 * and injected via window globals exactly as the real page exposes them.
 */

const fs = require("fs");
const pathlib = require("path");

const ScanController = require("../../../../shared/scan-core.js");

const GAME_JS = fs.readFileSync(
  pathlib.join(__dirname, "..", "js", "game.js"),
  "utf8",
);

// ---- Helpers -------------------------------------------------------------

function dispatchKey(type, code, opts = {}) {
  const event = new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
    repeat: !!opts.repeat,
  });
  document.dispatchEvent(event);
  return event;
}

// Short press = keydown immediately followed by keyup (duration 0 < every hold
// threshold), which advances (Space) or selects (Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

function makeMockScanManager(overrides = {}) {
  const subscribers = [];
  return {
    autoScan: overrides.autoScan || false,
    interval: overrides.interval || 2000,
    getSettings() {
      return { autoScan: this.autoScan, scanInterval: this.interval };
    },
    getScanInterval() {
      return this.interval;
    },
    subscribe(cb) {
      subscribers.push(cb);
    },
    unsubscribe(cb) {
      const i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    },
    _emit() {
      subscribers.slice().forEach((cb) => cb());
    },
  };
}

// The #main-menu markup, pulled from index.html so the test DOM stays in sync
// with the real page's element IDs / data-actions / labels.
function loadMainMenu() {
  const html = fs.readFileSync(
    pathlib.join(__dirname, "..", "index.html"),
    "utf8",
  );
  const m = html.match(/<div id="main-menu"[\s\S]*?<\/div>\s*<\/div>/i);
  // Grab just the #main-menu panel (it is the first .menu-panel).
  const panel = html.match(/<div id="main-menu"[\s\S]*?<!-- Setup Menu/i);
  return (panel ? panel[0].replace(/<!-- Setup Menu/i, "") : m[0]).trim();
}

const MAIN_MENU = loadMainMenu();

// ---- A faithful rebuild of the dice scan wiring (setupScan + callbacks) ----
//
// Mirrors js/game.js: getFocusables() (MENU state) re-read every step,
// onScanFocus -> highlight + cursor sync, onScanAnnounce -> speak, onScanSelect
// -> dispatch the focused item's data-action.

let appState;
let voice;
let scanManager;
let scan;
let selectedActions;

function getFocusables() {
  return Array.from(document.querySelectorAll("#main-menu .menu-item"));
}

function refreshScanFocus(shouldSpeak) {
  const targets = getFocusables();
  document
    .querySelectorAll(".focused")
    .forEach((el) => el.classList.remove("focused"));
  if (targets.length === 0) return;
  if (appState.scanIndex >= targets.length) appState.scanIndex = 0;
  if (scan) scan.setIndex(appState.scanIndex);
  const target = targets[appState.scanIndex];
  target.classList.add("focused");
  if (shouldSpeak) onScanAnnounce();
}

function announceElement(el) {
  if (!el) return;
  const text = (el.getAttribute("aria-label") || el.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text) voice.speak(text);
}

function onScanFocus(target, index) {
  appState.scanIndex = index;
  refreshScanFocus(false);
}

function onScanAnnounce() {
  const targets = getFocusables();
  if (appState.scanIndex >= 0 && appState.scanIndex < targets.length) {
    announceElement(targets[appState.scanIndex]);
  }
}

function activateFocused() {
  const targets = getFocusables();
  if (appState.scanIndex >= targets.length) return;
  const target = targets[appState.scanIndex];
  if (target.dataset.action) selectedActions.push(target.dataset.action);
}

function onScanSelect() {
  if (scan) appState.scanIndex = scan.getIndex();
  activateFocused();
}

function resolveScanInterval() {
  return scanManager ? scanManager.getScanInterval() : 2000;
}

function setupScan() {
  scan = new ScanController({
    getTargets: getFocusables,
    onFocus: onScanFocus,
    onAnnounce: onScanAnnounce,
    onSelect: onScanSelect,
    wrap: true,
    spaceHoldMs: 3000, // inputState.config.longPress
    reverseCadenceMs: resolveScanInterval(),
    enterHoldMs: 2147483647, // unreachable: long Enter holds still select
    scanManager,
    voice,
  });
  scan.attach(document);
  scan.start();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);

  document.body.innerHTML = `<div id="menu-layer"><div class="menu-panel">${MAIN_MENU}</div></div>`;

  appState = { scanIndex: 0, state: "MENU" };
  voice = { speak: jest.fn() };
  scanManager = makeMockScanManager();
  selectedActions = [];

  setupScan();
  // The app seats focus on the first item when entering MENU.
  appState.scanIndex = 0;
  refreshScanFocus(false);
});

afterEach(() => {
  try {
    scan?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Tests ---------------------------------------------------------------

describe("menu wiring", () => {
  test("main menu scans the four menu items in order", () => {
    const targets = getFocusables();
    expect(targets.map((t) => t.dataset.action)).toEqual([
      "toggle-mode",
      "play",
      "settings",
      "exit",
    ]);
  });

  test("first item is focused on entry (index 0)", () => {
    expect(getFocusables()[0].classList.contains("focused")).toBe(true);
    expect(scan.getIndex()).toBe(0);
  });
});

describe("scan + select", () => {
  test("Space advances the highlight and announces each step", () => {
    tap("Space"); // 0 -> 1 (Play)
    expect(scan.getIndex()).toBe(1);
    expect(getFocusables()[1].classList.contains("focused")).toBe(true);

    tap("Space"); // 1 -> 2 (Settings)
    expect(scan.getIndex()).toBe(2);
    expect(voice.speak).toHaveBeenCalled();
    expect(voice.speak.mock.calls.pop()[0]).toMatch(/Settings/i);
  });

  test("Enter selects the focused item", () => {
    tap("Space"); // focus index 1 = play
    tap("Enter");
    expect(selectedActions).toEqual(["play"]);
  });

  test("Space wraps around past the last item", () => {
    tap("Space"); // 1
    tap("Space"); // 2
    tap("Space"); // 3 (exit)
    expect(scan.getIndex()).toBe(3);
    tap("Space"); // wraps -> 0
    expect(scan.getIndex()).toBe(0);
  });
});

describe("NumpadEnter parity", () => {
  test("NumpadEnter selects identically to Enter", () => {
    tap("Space"); // focus index 1 = play
    tap("NumpadEnter");
    expect(selectedActions).toEqual(["play"]);
  });
});

describe("no anti-tremor / min-press gate (original had none)", () => {
  test("a zero-duration Space tap still advances (minPressMs = 0)", () => {
    expect(scan.getIndex()).toBe(0);
    tap("Space");
    expect(scan.getIndex()).toBe(1);
  });

  test("a zero-duration Enter tap still selects (minSelectMs = 0)", () => {
    tap("Enter");
    expect(selectedActions).toEqual(["toggle-mode"]);
  });

  test("a long Enter hold (beyond the old 5s pause default) STILL selects", () => {
    // The pre-migration handler selected on every Enter keyup regardless of how
    // long it was held. ScanController's default enterHoldMs (5000) would have
    // suppressed select on a >5s hold; the unreachable sentinel preserves the
    // original "always select" behavior and never triggers a (non-existent) pause.
    dispatchKey("keydown", "Enter");
    jest.advanceTimersByTime(6000); // > old 5000ms default
    dispatchKey("keyup", "Enter");
    expect(selectedActions).toEqual(["toggle-mode"]);
  });
});

describe("hold-Space reverse scan (>= 3s)", () => {
  test("holding Space for 3s scans backward", () => {
    // Seat on index 2 first.
    tap("Space");
    tap("Space");
    expect(scan.getIndex()).toBe(2);

    dispatchKey("keydown", "Space");
    jest.advanceTimersByTime(3000); // reverse threshold -> back() fires once
    expect(scan.getIndex()).toBe(1);
    dispatchKey("keyup", "Space"); // release after reverse: no extra advance
    expect(scan.getIndex()).toBe(1);
  });
});

describe("OS auto-repeat is ignored", () => {
  test("repeated Space keydown does not machine-gun advances", () => {
    dispatchKey("keydown", "Space", { repeat: true });
    dispatchKey("keydown", "Space", { repeat: true });
    expect(scan.getIndex()).toBe(0); // unchanged: repeats ignored
  });
});

describe("static wiring guard (js/game.js)", () => {
  test("constructs the shared ScanController with the migrated options", () => {
    expect(GAME_JS).toMatch(/new window\.ScanController\(/);
    expect(GAME_JS).toMatch(/getTargets:\s*getFocusables/);
    expect(GAME_JS).toMatch(/onSelect:\s*onScanSelect/);
    expect(GAME_JS).toMatch(/spaceHoldMs:\s*inputState\.config\.longPress/);
    expect(GAME_JS).toMatch(/enterHoldMs:\s*2147483647/);
    expect(GAME_JS).toMatch(/window\.diceScan\.attach\(document\)/);
  });

  test("does not set any min-press / min-select / min-interval gate", () => {
    // Dice had no anti-tremor gate; the migration must not introduce one.
    expect(GAME_JS).not.toMatch(/minPressMs:/);
    expect(GAME_JS).not.toMatch(/minSelectMs:/);
    expect(GAME_JS).not.toMatch(/minIntervalMs:/);
  });

  test("removed the hand-rolled scan loop", () => {
    expect(GAME_JS).not.toMatch(/function moveScan/);
    expect(GAME_JS).not.toMatch(/onSpaceShortPress/);
    expect(GAME_JS).not.toMatch(/onSpaceLongPress/);
  });
});
