/**
 * Integration tests for Ben's keyboard after migrating its scan layer onto the
 * shared ScanController (nested rows -> buttons) and its prediction engine onto
 * the shared Predict module.
 *
 * This is Ben's primary comms path, so the tests drive the REAL app.js through
 * real keyboard events under jsdom and assert on the rendered DOM (the
 * `.highlighted` classes + the text-bar buffer) — exercising the actual
 * ScanController wiring rather than a re-implementation. The shared scan/voice
 * managers and the prediction system are mocked + injected via window globals
 * exactly as the running page exposes them.
 *
 * Group ordering (must match app.js):
 *   index 0                  -> text bar
 *   index 1 .. rows.length   -> keyboard rows (controls, A-F, G-L, ...)
 *   index rows.length + 1    -> predictive row (chips)
 */

const ScanController = require("../../../../shared/scan-core.js");
const Predict = require("../../../../shared/predict.js");

// ---- Helpers -------------------------------------------------------------

function dispatchKey(type, code) {
  document.dispatchEvent(
    new KeyboardEvent(type, { code, bubbles: true, cancelable: true }),
  );
}

// Short press: keydown, a brief realistic hold (~300ms), then keyup. The duration
// sits above the keyboard's restored debounce floors (Space 250ms / Enter 100ms)
// but below the hold thresholds -> advance (Space) or select (Enter / NumpadEnter).
function tap(code) {
  dispatchKey("keydown", code);
  jest.advanceTimersByTime(300);
  dispatchKey("keyup", code);
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

// Settle init(): run the deferred prediction render + flush microtasks so the
// predictive chips exist.
async function settle() {
  jest.advanceTimersByTime(200);
  await flush();
}

function textVal() {
  return document.getElementById("textBar").textContent.replace("|", "");
}

function kbHighlighted() {
  return Array.from(document.querySelectorAll("#keyboard .key.highlighted"));
}

function chips() {
  return Array.from(document.querySelectorAll("#predictBar .chip"));
}

const KEYBOARD_HTML = `
  <div id="app"><main>
    <div class="textbar-container"><div id="textBar" class="textbar"></div></div>
    <div id="keyboard" class="keyboard"></div>
    <div id="predictBar" class="predictbar"></div>
  </main></div>
  <div id="settingsMenu" class="settings-menu hidden">
    <div id="settingsGrid" class="settings-grid">
      <button class="settings-item" data-setting="theme"><span class="setting-label">Theme</span><span class="setting-value" id="themeValue"></span></button>
      <button class="settings-item" data-setting="highlight"><span class="setting-label">Highlight</span><span class="setting-value" id="highlightValue"></span></button>
      <button class="settings-item" data-setting="voice"><span class="setting-label">Voice</span><span class="setting-value" id="voiceValue"></span></button>
      <button class="settings-item" data-setting="tts-toggle"><span class="setting-label">TTS</span><span class="setting-value" id="ttsToggleValue"></span></button>
      <button class="settings-item" data-setting="scan-speed"><span class="setting-label">Scan Speed</span><span class="setting-value" id="scanSpeedValue"></span></button>
      <button class="settings-item" data-setting="auto-scan"><span class="setting-label">Auto Scan</span><span class="setting-value" id="autoScanValue"></span></button>
      <button class="settings-item" data-setting="close"><span class="setting-label">Close Settings</span><span class="setting-value"></span></button>
    </div>
  </div>
`;

function makeVoice() {
  return {
    voices: [],
    cancel: jest.fn(),
    speak: jest.fn(),
    speakProcessed: jest.fn(),
    processTextForSpeech: (t) => t,
    waitForVoices: () => Promise.resolve(),
    getSettings: () => ({ ttsEnabled: true }),
    getCurrentVoice: () => null,
    getVoiceDisplayName: () => "Default",
    toggleTTS: jest.fn(() => true),
    onSettingsChange: jest.fn(),
    areVoicesLoaded: () => true,
  };
}

function makeScanManager() {
  return {
    getSettings: () => ({
      autoScan: false,
      scanSpeedIndex: 1,
      scanInterval: 2000,
    }),
    getScanInterval: () => 2000,
    cycleScanSpeed: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
  };
}

function makePredictionStub(words) {
  return {
    dataLoaded: true,
    getHybridPredictions: jest.fn(() => words.slice()),
    recordLocalWord: jest.fn(),
    recordNgram: jest.fn(),
    load: jest.fn(() => Promise.resolve()),
  };
}

let app;
let predictions;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  localStorage.clear();
  document.body.innerHTML = KEYBOARD_HTML;

  window.ScanController = ScanController;
  window.Predict = Predict;
  window.NarbeVoiceManager = makeVoice();
  window.NarbeScanManager = makeScanManager();
  predictions = makePredictionStub(["YES", "NO", "HELP", "THE", "I", "YOU"]);
  window.predictionSystem = predictions; // pre-seed so app.js does not replace it

  jest.resetModules();
  app = require("../app.js"); // IIFE auto-runs init() on require
});

afterEach(() => {
  try {
    app.__getKbScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  try {
    app.__getSettingsScan()?.destroy?.();
  } catch (e) {
    /* ignore */
  }
  jest.clearAllTimers();
  jest.useRealTimers();
  delete window.predictionSystem;
});

// ---- Tests ---------------------------------------------------------------

describe("nested scan: rows -> buttons", () => {
  test("init focuses the text-bar row", async () => {
    await settle();
    expect(
      document.getElementById("textBar").classList.contains("highlighted"),
    ).toBe(true);
    expect(kbHighlighted()).toHaveLength(0);
  });

  test("Space cycles rows; whole row highlights at the group level", async () => {
    await settle();

    tap("Space"); // -> controls row (group 1)
    expect(kbHighlighted()).toHaveLength(6);

    tap("Space"); // -> A-F row (group 2)
    expect(kbHighlighted()).toHaveLength(6);
    expect(kbHighlighted()[0].textContent).toBe("A");
  });

  test("row -> descend -> button cycle -> select -> ascend", async () => {
    await settle();

    tap("Space"); // controls
    tap("Space"); // A-F row

    // Descend: drilling in immediately focuses + reads the first button.
    tap("Enter");
    expect(kbHighlighted()).toHaveLength(1);
    expect(kbHighlighted()[0].textContent).toBe("A");

    // Scan within the row.
    tap("Space");
    expect(kbHighlighted()[0].textContent).toBe("B");

    // Select the button -> types it, then ascends back to the whole row.
    tap("Enter");
    expect(textVal()).toBe("B");
    expect(kbHighlighted()).toHaveLength(6); // back at the row level
  });

  test("Enter on the text-bar row speaks instead of descending", async () => {
    await settle();
    // Type something so the text bar is non-empty.
    tap("Space"); // controls
    tap("Space"); // A-F
    tap("Enter"); // descend
    tap("Enter"); // type "A"
    expect(textVal()).toBe("A");

    // Back to the text-bar row.
    const kbScan = app.__getKbScan();
    kbScan.ascend();
    kbScan.focusIndex(0);
    expect(
      document.getElementById("textBar").classList.contains("highlighted"),
    ).toBe(true);

    // A short Enter on the text bar speaks; it does NOT descend into items.
    tap("Enter");
    expect(kbScan.getLevel()).toBe("group");
    expect(window.NarbeVoiceManager.speakProcessed).not.toBeNull();
  });

  test("holding Space reverses (wraps from the text bar to the predictive row)", async () => {
    await settle();
    dispatchKey("keydown", "Space");
    jest.advanceTimersByTime(2000); // cross the hold threshold -> reverse step
    dispatchKey("keyup", "Space");

    expect(chips().some((c) => c.classList.contains("highlighted"))).toBe(true);
  });
});

describe("predictive row", () => {
  test("descend then select inserts the focused prediction", async () => {
    await settle();

    // Walk to the predictive row: 8 forward steps from the text bar.
    for (let i = 0; i < 8; i++) tap("Space");
    await flush();

    expect(chips()).toHaveLength(6);
    expect(chips().every((c) => c.classList.contains("highlighted"))).toBe(
      true,
    );

    tap("Enter"); // descend -> first chip focused
    expect(chips()[0].classList.contains("highlighted")).toBe(true);
    expect(chips()[1].classList.contains("highlighted")).toBe(false);

    tap("Enter"); // select "YES"
    await flush();
    expect(textVal()).toBe("YES ");
    expect(predictions.recordLocalWord).toHaveBeenCalledWith("YES");
  });
});

describe("NumpadEnter parity", () => {
  test("NumpadEnter descends + selects identically to Enter", async () => {
    await settle();

    tap("Space"); // controls
    tap("Space"); // A-F

    tap("NumpadEnter"); // descend via numpad
    expect(kbHighlighted()[0].textContent).toBe("A");

    tap("NumpadEnter"); // select via numpad
    expect(textVal()).toBe("A");
  });
});

describe("shared predict ranking (Ben's text path)", () => {
  const OLD = "2020-01-01T00:00:00.000Z";
  const e = (count) => ({ count, last_used: OLD });

  function engine() {
    return Predict.create({
      data: {
        frequent_words: { HELLO: e(5), HELP: e(8), HI: e(3) },
        bigrams: { "HELLO THERE": e(2) },
        trigrams: {},
      },
      predictions: {
        async getPredictions() {
          return null;
        },
        async savePrediction() {},
        async saveNgram() {},
        async clearPredictions() {},
      },
    });
  }

  test("a learned bigram ranks the next word first after a space", () => {
    const p = engine().getHybridPredictions("HELLO ");
    expect(p[0]).toBe("THERE");
  });

  test("a partial word yields frequency-ranked completions", () => {
    const p = engine().getHybridPredictions("HEL");
    const nonEmpty = p.filter(Boolean);
    expect(nonEmpty).toEqual(expect.arrayContaining(["HELP", "HELLO"]));
    // Higher count (HELP=8) outranks HELLO=5 at equal recency.
    expect(p.indexOf("HELP")).toBeLessThan(p.indexOf("HELLO"));
    // "HI" does not start with "HEL" and must not appear.
    expect(nonEmpty).not.toContain("HI");
  });

  test("returns exactly six padded slots", () => {
    const p = engine().getHybridPredictions("HELLO ");
    expect(p).toHaveLength(6);
  });
});
