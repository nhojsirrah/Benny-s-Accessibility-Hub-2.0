/**
 * Tests for BENNYSTRIVIAMASTER after migrating its switch-scanning onto the
 * shared ScanController (shared/scan-core.js) and adopting the shared Nav
 * back-contract + SettingsStore persistence accessor.
 *
 * Runs in jsdom with jest fake timers. script.js is a plain <script> (not a
 * module) in the browser; under CommonJS it exposes a test surface and skips its
 * auto-start (init()/loadGamesList()) so jsdom can require() it headless and
 * drive it directly. The shared scan/voice managers + ScanController + Nav +
 * SettingsStore are exposed on window exactly as the real page exposes them via
 * <script src>.
 *
 * SCOPE: covers the answer-choice scan + select flow (the core in-game
 * scanning), NumpadEnter parity, the preserved input thresholds, the (absent)
 * anti-tremor gate, the Nav exit contract, and the SettingsStore games-source
 * accessor (fallback + forward-compatible paths).
 */

const fs = require("fs");
const path = require("path");

const SHARED = path.join(__dirname, "..", "..", "..", "..", "shared");
const INDEX_HTML = path.join(__dirname, "..", "index.html");

// ---- Helpers -------------------------------------------------------------

// Events are dispatched on `document` so the ScanController's capture-phase
// keydown/keyup listeners (attached to document) receive them.
function dispatchKey(type, code) {
  const event = new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

// Short press = keydown immediately followed by keyup (duration 0 < hold
// thresholds), which advances (Space) or selects (Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  dispatchKey("keyup", code);
}

function makeAudioContextStub() {
  const node = {
    type: "",
    connect() {},
    start() {},
    stop() {},
    frequency: { setValueAtTime() {} },
    gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
  };
  return class AudioContextStub {
    constructor() {
      this.currentTime = 0;
      this.state = "running";
      this.destination = {};
    }
    createOscillator() {
      return node;
    }
    createGain() {
      return node;
    }
    resume() {
      return Promise.resolve();
    }
  };
}

function makeMockScanManager(overrides = {}) {
  return {
    autoScan: overrides.autoScan || false,
    interval: overrides.interval || 2000,
    getSettings() {
      return { autoScan: this.autoScan, scanInterval: this.interval };
    },
    getScanInterval() {
      return this.interval;
    },
    subscribe() {},
    unsubscribe() {},
    toggleAutoScan() {},
    cycleScanSpeed() {},
  };
}

function loadBodyMarkup() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1];
  // <script> tags would not execute via innerHTML, but strip them for clarity.
  return body.replace(/<script[\s\S]*?<\/script>/gi, "");
}

const SAMPLE_TRIVIA = {
  TestCat: [{ question: "Q1?", choices: ["Right", "Wrong A", "Wrong B"] }],
};

let app;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  localStorage.clear();

  // Replace the body element wholesale so click-delegation listeners from a
  // previous test's init() do not accumulate on a persistent <body>.
  document.body.replaceWith(document.createElement("body"));
  document.body.innerHTML = loadBodyMarkup();

  // jsdom implements neither scrollIntoView nor Web Audio / speech synthesis;
  // stub what module load + scanning touch so requiring script.js is safe.
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
  window.AudioContext = makeAudioContextStub();
  window.webkitAudioContext = window.AudioContext;
  window.speechSynthesis = {
    cancel: jest.fn(),
    speak: jest.fn(),
    getVoices: () => [],
    onvoiceschanged: null,
  };

  jest.resetModules();
  window.ScanController = require(path.join(SHARED, "scan-core.js"));
  window.Nav = require(path.join(SHARED, "nav.js"));
  window.SettingsStore = require(path.join(SHARED, "settings-store.js"));
  window.SettingsStore._reset();
  window.NarbeScanManager = makeMockScanManager();
  window.NarbeVoiceManager = { speak: jest.fn() };

  app = require("../script.js");
  app.init();
});

afterEach(() => {
  try {
    app.getScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---- Scan structure ------------------------------------------------------

describe("the controller is the shared ScanController, wired single-axis", () => {
  test("getScan() returns a ScanController instance", () => {
    expect(app.getScan()).toBeInstanceOf(window.ScanController);
  });

  test("in-game targets are the answer buttons + the question-text wrapper", () => {
    app.setTriviaData(SAMPLE_TRIVIA);
    app.startGame("TestCat");

    const targets = app.getScannables();
    const answerCount = targets.filter((el) =>
      el.classList.contains("answer-btn"),
    ).length;
    expect(answerCount).toBe(3);
    expect(targets.some((el) => el.id === "question-text-wrapper")).toBe(true);
  });
});

// ---- Answer-choice scan + select ----------------------------------------

describe("answer-choice scanning advances and selecting runs handleAnswer", () => {
  test("Space advances the highlight through the answer choices", () => {
    app.setTriviaData(SAMPLE_TRIVIA);
    app.startGame("TestCat");

    app.getScan().focusIndex(0);
    expect(app.getScan().getIndex()).toBe(0);
    expect(app.getScannables()[0].classList.contains("scanned")).toBe(true);

    tap("Space");
    expect(app.getScan().getIndex()).toBe(1);
    expect(app.getScannables()[1].classList.contains("scanned")).toBe(true);
    expect(app.getScannables()[0].classList.contains("scanned")).toBe(false);
  });

  test("selecting the correct answer (Enter) scores it as correct", () => {
    app.setTriviaData(SAMPLE_TRIVIA);
    app.startGame("TestCat");

    const targets = app.getScannables();
    const correctIdx = targets.findIndex(
      (el) => el.dataset && el.dataset.isCorrect === "true",
    );
    expect(correctIdx).toBeGreaterThanOrEqual(0);

    const scoreBefore = app.getState().score;
    app.getScan().focusIndex(correctIdx);
    tap("Enter");

    expect(targets[correctIdx].classList.contains("correct")).toBe(true);
    expect(app.getState().score).toBeGreaterThan(scoreBefore);
    expect(app.getState().streak).toBe(1);
  });

  test("selecting a wrong answer (Enter) marks it wrong and breaks the streak", () => {
    app.setTriviaData(SAMPLE_TRIVIA);
    app.startGame("TestCat");
    app.getState().streak = 3;

    const targets = app.getScannables();
    const wrongIdx = targets.findIndex(
      (el) => el.dataset && el.dataset.isCorrect === "false",
    );
    expect(wrongIdx).toBeGreaterThanOrEqual(0);

    app.getScan().focusIndex(wrongIdx);
    tap("Enter");

    expect(targets[wrongIdx].classList.contains("wrong")).toBe(true);
    expect(app.getState().streak).toBe(0);
  });
});

// ---- NumpadEnter parity (shared isSelect predicate) ----------------------

describe("NumpadEnter selects identically to Enter", () => {
  test("NumpadEnter on the correct answer scores it", () => {
    app.setTriviaData(SAMPLE_TRIVIA);
    app.startGame("TestCat");

    const targets = app.getScannables();
    const correctIdx = targets.findIndex(
      (el) => el.dataset && el.dataset.isCorrect === "true",
    );
    const scoreBefore = app.getState().score;

    app.getScan().focusIndex(correctIdx);
    tap("NumpadEnter");

    expect(targets[correctIdx].classList.contains("correct")).toBe(true);
    expect(app.getState().score).toBeGreaterThan(scoreBefore);
  });
});

// ---- Preserved input thresholds + (absent) anti-tremor gate --------------

describe("original input thresholds are preserved and no anti-tremor gate", () => {
  test("the debounce floors are OFF (the original game had none)", () => {
    const s = app.getScan();
    expect(s.minPressMs).toBe(0);
    expect(s.minSelectMs).toBe(0);
    expect(s.minIntervalMs).toBe(0);
  });

  test("a zero-duration Space tap still advances (gate does not reject it)", () => {
    app.setTriviaData(SAMPLE_TRIVIA);
    app.startGame("TestCat");

    app.getScan().focusIndex(0);
    tap("Space"); // keydown+keyup at the same fake-clock instant => 0ms press
    expect(app.getScan().getIndex()).toBe(1);
  });

  test("Space held >= 3s reverses; Enter held >= 3s opens the pause menu", () => {
    const s = app.getScan();
    expect(s.spaceHoldMs).toBe(3000);
    expect(s.reverseCadenceMs).toBe(2000);
    expect(s.enterHoldMs).toBe(3000);

    app.setTriviaData(SAMPLE_TRIVIA);
    app.startGame("TestCat");
    expect(app.getState().isPaused).toBe(false);

    dispatchKey("keydown", "Enter");
    jest.advanceTimersByTime(3000); // hold threshold -> onPause -> togglePause
    expect(app.getState().isPaused).toBe(true);
    dispatchKey("keyup", "Enter"); // long press => no select
  });
});

// ---- Nav adoption --------------------------------------------------------

describe("exit routes through the shared Nav back-contract", () => {
  test("exit-game calls Nav.goBack after the 500ms TTS delay", () => {
    app.showScreen("main-menu");
    const goBack = jest
      .spyOn(window.Nav, "goBack")
      .mockImplementation(() => {});

    document.querySelector('[data-action="exit-game"]').click();
    expect(goBack).not.toHaveBeenCalled(); // deferred behind the spoken cue

    jest.advanceTimersByTime(500);
    expect(goBack).toHaveBeenCalledTimes(1);
  });
});

// ---- SettingsStore adoption ---------------------------------------------

describe("games-source persistence adopts SettingsStore with localStorage fallback", () => {
  test("with no triviamaster schema, it falls back to the legacy localStorage key", () => {
    // The shipped shared schema has no `triviamaster` entry, so the typed store
    // is bypassed and the original key is used (behavior preserved).
    app.saveGamesSource("Local");
    expect(localStorage.getItem("trivia_games_source")).toBe("Local");
    expect(app.loadGamesSource()).toBe("Local");
  });

  test("once a triviamaster.gamesSource schema exists, it round-trips through SettingsStore", () => {
    // Simulate the forward-compatible state: a `triviamaster` schema gains a
    // `gamesSource` slot. The accessor then routes through the typed per-app
    // store (proving the adoption is wired, not just localStorage).
    window.SettingsStore.APP_SCHEMAS.triviamaster = { gamesSource: "string" };
    window.SettingsStore._reset();

    app.saveGamesSource("Online");
    expect(window.SettingsStore.app("triviamaster").get("gamesSource")).toBe(
      "Online",
    );
    expect(app.loadGamesSource()).toBe("Online");
  });
});
