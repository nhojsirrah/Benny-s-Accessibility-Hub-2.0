// --- Benny's Connect Four ---
// Based on Chess/Checkers template with scan/select accessibility.
//
// The hand-rolled scan loop (forward/backward stepping, hold-to-reverse,
// hold-to-pause, auto-scan cadence and key handling) has been migrated onto the
// shared ScanController (shared/scan-core.js). This file now only supplies the
// per-mode target sets and per-mode action dispatch; the controller owns the
// scan index, the cadence and the press/hold timing. The migration also picks up
// NumpadEnter support for free (the controller treats Enter and NumpadEnter
// identically — the pre-migration code only listened for "Enter").

// --- Configuration & Constants ---
const config = {
  longPress: 3000, // 3 seconds for backward scanning intent (hold Space -> reverse)
  repeatInterval: 2000, // Default fallback reverse cadence
  enterLongPress: 5000, // 5 seconds to open pause menu (hold Enter)
  scanSpeeds: [
    { label: "1 Second", val: 1000 },
    { label: "2 Seconds", val: 2000 },
    { label: "3 Seconds", val: 3000 },
    { label: "5 Seconds", val: 5000 },
  ],
  rows: 6,
  cols: 7,
  winLength: 4,
};

// Background themes now come from the shared themes module (shared/themes.js).
// Connect Four shares the first six "standard cluster" themes verbatim and keeps
// its own bespoke 7th theme ("Classic Blue"), exactly as documented in the
// themes-module reconciliation notes. The fallback reproduces the historical
// local array for environments where the shared module is unavailable.
const CLASSIC_BLUE = {
  name: "Classic Blue",
  bg: "linear-gradient(135deg, #1a237e, #3949ab)",
};

const themes =
  typeof window !== "undefined" && window.Themes
    ? [...window.Themes.THEMES.slice(0, 6), CLASSIC_BLUE]
    : [
        { name: "Default", bg: "linear-gradient(135deg, #ff4b1f, #ff9068)" },
        { name: "Ocean", bg: "linear-gradient(135deg, #2193b0, #6dd5ed)" },
        { name: "Midnight", bg: "linear-gradient(135deg, #232526, #414345)" },
        { name: "Forest", bg: "linear-gradient(135deg, #134e5e, #71b280)" },
        { name: "Sunset", bg: "linear-gradient(135deg, #f12711, #f5af19)" },
        { name: "Lavender", bg: "linear-gradient(135deg, #834d9b, #d04ed6)" },
        CLASSIC_BLUE,
      ];

// Connect Four's highlight palette is intentionally NOT sourced from the shared
// Themes.HIGHLIGHT_COLORS list. The shared list is a 13-entry palette led by a
// "Theme Default" sentinel (and includes White/Pink); Connect Four's palette is
// a different 10-entry list with a different order and no sentinel. Adopting the
// shared list would remap every stored highlightColorIndex to a different color
// and cross-contaminate the shared global highlight index with an incompatible
// range, so the palette stays local (a deliberate "adopt only where clean").
const highlightColors = [
  "Yellow",
  "Cyan",
  "Lime",
  "Magenta",
  "Red",
  "Orange",
  "Gold",
  "DeepSkyBlue",
  "SpringGreen",
  "Violet",
];

const playerColors = [
  { name: "Red", hex: "#d32f2f" },
  { name: "Yellow", hex: "#fbc02d" },
  { name: "Blue", hex: "#1976d2" },
  { name: "Green", hex: "#388e3c" },
  { name: "Purple", hex: "#7b1fa2" },
  { name: "Orange", hex: "#f57c00" },
  { name: "Pink", hex: "#e91e63" },
  { name: "Teal", hex: "#00897b" },
];

// --- Game State ---
const state = {
  mode: "menu", // menu, game, pause, gameover
  menuState: "main", // main, settings
  gameMode: "single", // single, two

  // Board: 6 rows x 7 columns, 0 = empty, 1 = P1, -1 = P2
  board: [],

  turn: 1, // 1 for Player 1, -1 for Player 2

  // Menu sub-state
  pauseMenuState: "main",

  // Winning cells for animation
  winningCells: [],

  // True while the computer is taking its turn — gates auto-scan/input so the
  // board does not scan or accept a drop during the AI's move.
  computerThinking: false,

  timers: {
    status: null,
  },
};

// The shared scan controller (shared/scan-core.js). It is the single source of
// truth for the scan index; getScanTargets() supplies the per-context targets.
let scan = null;

// The shared pause overlay instance (shared/pause-overlay.js), created at init
// when window.BennyPauseOverlay is present. Null when the shared module is
// absent — in that case the legacy bespoke #pause-overlay menu is used instead
// (see openPauseMenu / the PAUSE-OVERLAY CONTRACT v1 fallback). While the
// overlay is open it owns the pause scan targets: getScanTargets() returns
// overlay.getTargets() and a select runs overlay.activate().
let pauseOverlay = null;

// Stable ids for the migrated pause actions, positionally aligned with
// menus.pause (Continue Game / Reset Game / Settings / Main Menu). The action
// handlers themselves are reused verbatim from menus.pause.
const PAUSE_ACTION_IDS = ["continue", "reset", "settings", "mainmenu"];

const settings = {
  themeIndex: 0,
  tts: true,
  sound: true,
  p1ColorIndex: 0, // Red
  p2ColorIndex: 1, // Yellow
  highlightColorIndex: 0, // Yellow
  autoScan: false, // fallback when NarbeScanManager is absent
  scanSpeedIndex: 1, // Default 2 Seconds (fallback when NarbeScanManager is absent)
  highlightStyle: "outline", // 'outline' or 'full'
};

// Keys that belong to the shared, cross-app global settings contract
// (shared/settings-store.js GLOBAL_SCHEMA). Only highlightStyle is routed
// through SettingsStore.global — it shares the canonical outline/full enum. The
// scan cadence / autoScan settings stay owned by NarbeScanManager (as before),
// highlightColorIndex stays app-local (its palette differs from the shared one),
// and the remaining app-specific keys stay in this app's own localStorage blob.
const SETTINGS_KEY = "bennys_connectfour_settings";
const GLOBAL_SETTINGS_KEYS = ["highlightStyle"];

// --- Sounds ---
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx)
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "touchstart",
    () => {
      getAudioCtx();
    },
    { once: true, passive: true },
  );
  window.addEventListener(
    "click",
    () => {
      getAudioCtx();
    },
    { once: true },
  );
}

function playSound(type) {
  if (!settings.sound) return;

  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();

  osc.connect(gainNode);
  gainNode.connect(ctx.destination);

  if (type === "scan") {
    osc.type = "sine";
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
  } else if (type === "select") {
    osc.type = "square";
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } else if (type === "drop") {
    osc.type = "triangle";
    osc.frequency.setValueAtTime(500, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(200, ctx.currentTime + 0.3);
    gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } else if (type === "win") {
    // Victory fanfare
    const notes = [523, 659, 784, 1047]; // C5, E5, G5, C6
    notes.forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = "sine";
      o.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.15);
      g.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + i * 0.15 + 0.3);
      o.start(ctx.currentTime + i * 0.15);
      o.stop(ctx.currentTime + i * 0.15 + 0.3);
    });
  } else if (type === "error") {
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(200, ctx.currentTime);
    gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  }
}

// --- Initialization ---

if (typeof window !== "undefined") {
  window.onload = init;
}

function init() {
  loadSettings();
  applyTheme();
  setupScan();
  createDOMStructure();
  setupPauseOverlay();

  // Scan Manager Integration. ScanController owns restarting the auto-scan
  // timer when cadence / autoScan change (it subscribes to NarbeScanManager
  // itself). Here we only keep the reverse cadence in sync and refresh the
  // settings menus so the on-screen Scan Speed / Auto Scan labels stay current.
  if (window.NarbeScanManager) {
    window.NarbeScanManager.subscribe(() => {
      if (scan) scan.reverseCadenceMs = resolveScanInterval();
      if (state.mode === "menu" && state.menuState === "settings")
        refreshCurrentMenu();
      else if (state.mode === "pause" && state.pauseMenuState === "settings")
        refreshCurrentMenu();
    });
  }

  showMainMenu();
}

function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      Object.assign(settings, parsed);

      const check = (key, max, def) => {
        if (
          typeof settings[key] !== "number" ||
          settings[key] < 0 ||
          settings[key] >= max
        ) {
          settings[key] = def;
        }
      };

      check("themeIndex", themes.length, 0);
      check("p1ColorIndex", playerColors.length, 0);
      check("p2ColorIndex", playerColors.length, 1);
      check("highlightColorIndex", highlightColors.length, 0);
      check("scanSpeedIndex", config.scanSpeeds.length, 1);

      if (
        settings.highlightStyle !== "outline" &&
        settings.highlightStyle !== "full"
      ) {
        settings.highlightStyle = "outline";
      }
    } else {
      saveSettings();
    }
  } catch (e) {
    console.error("Error loading settings:", e);
    saveSettings();
  }

  // Adopt the shared SettingsStore for the globally-shared keys. If the shared
  // store already has a value it wins (cross-app sync); otherwise seed it from
  // this app's value so the contract is populated going forward.
  if (typeof window !== "undefined" && window.SettingsStore) {
    try {
      const g = window.SettingsStore.global;
      GLOBAL_SETTINGS_KEYS.forEach((key) => {
        const v = g.get(key);
        if (v !== undefined) settings[key] = v;
        else g.set(key, settings[key]);
      });
      // Re-validate after the overlay in case the shared value is stale.
      if (
        settings.highlightStyle !== "outline" &&
        settings.highlightStyle !== "full"
      ) {
        settings.highlightStyle = "outline";
      }
    } catch (e) {
      console.warn("SettingsStore adoption failed:", e);
    }
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  if (typeof window !== "undefined" && window.SettingsStore) {
    try {
      const g = window.SettingsStore.global;
      GLOBAL_SETTINGS_KEYS.forEach((key) => {
        g.set(key, settings[key]);
      });
    } catch (e) {
      console.warn("SettingsStore save failed:", e);
    }
  }
}

function createDOMStructure() {
  const mainContent = document.getElementById("main-content");

  // Menu
  const menuContainer = document.createElement("div");
  menuContainer.id = "menu-container";
  menuContainer.className = "menu-container";
  mainContent.appendChild(menuContainer);

  // Game Board Container
  const gameContainer = document.createElement("div");
  gameContainer.id = "game-board-container";
  gameContainer.className = "game-container";
  gameContainer.style.display = "none";

  // Turn Indicator
  const turnIndicator = document.createElement("div");
  turnIndicator.id = "turn-indicator";
  turnIndicator.className = "turn-indicator";
  gameContainer.appendChild(turnIndicator);

  // Column Selector (arrows above board)
  const columnSelector = document.createElement("div");
  columnSelector.id = "column-selector";
  columnSelector.className = "column-selector";
  for (let c = 0; c < config.cols; c++) {
    const arrow = document.createElement("div");
    arrow.id = `arrow-${c}`;
    arrow.className = "column-arrow";
    arrow.innerHTML = "▼";
    arrow.onclick = () => handleColumnClick(c);
    columnSelector.appendChild(arrow);
  }
  gameContainer.appendChild(columnSelector);

  // Board
  const board = document.createElement("div");
  board.id = "connect-four-board";
  board.className = "connect-four-board";
  gameContainer.appendChild(board);

  mainContent.appendChild(gameContainer);

  // Pause Overlay
  const pauseOverlay = document.createElement("div");
  pauseOverlay.id = "pause-overlay";
  pauseOverlay.className = "pause-overlay";
  pauseOverlay.style.display = "none";
  document.body.appendChild(pauseOverlay);

  // Pause Icon
  const pauseIcon = document.createElement("div");
  pauseIcon.id = "pause-button-icon";
  pauseIcon.className = "pause-button-icon";
  pauseIcon.innerHTML = "ll";
  pauseIcon.title = "Pause Game";
  pauseIcon.style.display = "none";
  pauseIcon.onclick = () => {
    if (state.mode === "game") {
      openPauseMenu();
    }
  };
  document.body.appendChild(pauseIcon);
}

// --- Scan wiring (shared ScanController) ---

// Resolve the active scan cadence: prefer NarbeScanManager (which owns scan
// speed / autoScan), falling back to the local setting when it is absent. Used
// for both auto-scan and the hold-Space reverse cadence.
function resolveScanInterval() {
  if (typeof window !== "undefined" && window.NarbeScanManager) {
    return window.NarbeScanManager.getScanInterval();
  }
  return config.scanSpeeds[settings.scanSpeedIndex].val;
}

function setupScan() {
  if (typeof window === "undefined" || !window.ScanController) {
    console.error("ScanController not loaded — scanning will be unavailable.");
    return;
  }

  scan = new window.ScanController({
    getTargets: getScanTargets,
    onFocus: onScanFocus,
    onSelect: onScanSelect,
    onAnnounce: onScanAnnounce,
    onPause: onScanPause,
    wrap: true,
    spaceHoldMs: config.longPress, // hold Space >= 3s -> reverse scan
    reverseCadenceMs: resolveScanInterval(), // reverse repeats at scan cadence
    enterHoldMs: config.enterLongPress, // hold Enter >= 5s -> open pause menu (game only)
    scanManager: window.NarbeScanManager,
    voice: window.NarbeVoiceManager,
  });
  scan.attach(document);

  // Preserve the pre-migration "reset auto-scan on every switch interaction"
  // timing so a manual press is never immediately followed by an auto-advance.
  // The scan loop itself lives entirely in ScanController; this listener only
  // re-phases the auto-scan timer (suppressed during the computer's turn).
  const bump = (e) => {
    if (e.repeat) return;
    if (e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter") {
      if (!state.computerThinking) startScan();
    }
  };
  document.addEventListener("keydown", bump, true);
  document.addEventListener("keyup", bump, true);
}

// (Re)start auto-scan, keeping the reverse cadence aligned with the current scan
// speed. Mirrors the historical startAutoScan/resetAutoScan call sites.
function startScan() {
  if (!scan) return;
  scan.reverseCadenceMs = resolveScanInterval();
  scan.start();
}

function stopScan() {
  if (scan) scan.stop();
}

// The flat, single-axis target list ScanController steps through for the active
// context. In game mode this is the set of DROPPABLE columns (full columns are
// skipped by simply not being in the list — the same empty-cells technique
// TicTacToe uses to skip occupied cells). In menus it is the menu item arrays.
// ScanController re-reads this on every step, so a column filling up is reflected
// on the next scan automatically.
function getGameColumns() {
  const cols = [];
  if (!state.board || state.board.length === 0) return cols;
  for (let c = 0; c < config.cols; c++) {
    if (state.board[0][c] === 0) {
      cols.push({ type: "column", col: c, text: `Column ${c + 1}` });
    }
  }
  return cols;
}

function getScanItemsForMode() {
  if (state.mode === "game") return getGameColumns();
  if (state.mode === "menu") return menus[state.menuState] || [];
  if (state.mode === "pause") {
    return state.pauseMenuState === "main" ? menus.pause : menus.pauseSettings;
  }
  return [];
}

function getScanTargets() {
  // While the shared pause overlay is open it owns the scan targets: the
  // controller scans its action buttons directly (CONTRACT: getTargets()).
  if (pauseOverlay && pauseOverlay.isOpen()) {
    return pauseOverlay.getTargets() || [];
  }
  return getScanItemsForMode();
}

// Clamped current scan index (treats the unseated -1 as 0 for menu lookups).
function currentIndex() {
  const idx = scan ? scan.getIndex() : 0;
  return idx < 0 ? 0 : idx;
}

function onScanFocus() {
  // A scan step has landed on a new target. Beep + reflect it in the visuals.
  playSound("scan");
  if (pauseOverlay && pauseOverlay.isOpen()) {
    updateOverlayHighlights();
    return;
  }
  if (state.mode === "game") updateGameHighlights();
  else updateHighlights();
}

function onScanAnnounce() {
  if (pauseOverlay && pauseOverlay.isOpen()) {
    announceCurrentOverlayItem();
    return;
  }
  if (state.mode === "game") announceCurrentGameItem();
  else announceCurrentMenuItem();
}

function onScanSelect() {
  // Overlay open: route the select at the focused overlay action button
  // (CONTRACT: activate()), which runs that action's onSelect handler.
  if (pauseOverlay && pauseOverlay.isOpen()) {
    const targets = pauseOverlay.getTargets() || [];
    const idx = scan ? scan.getIndex() : -1;
    if (idx < 0 || idx >= targets.length) return;
    playSound("select");
    pauseOverlay.activate(targets[idx]);
    return;
  }
  if (state.mode === "game") {
    const cols = getGameColumns();
    const idx = scan ? scan.getIndex() : -1;
    if (idx < 0 || idx >= cols.length) return;
    const item = cols[idx];
    if (item && item.type === "column") {
      playSound("select");
      handleColumnClick(item.col);
    }
  } else if (state.mode === "menu" || state.mode === "pause") {
    const items = getScanItemsForMode();
    const item = items[currentIndex()];
    if (item && item.action) {
      playSound("select");
      item.action();
    }
  }
}

// Hold-Enter opens the pause menu, but only during a game (matches the original;
// in menus a long Enter simply suppresses an accidental select and does nothing).
function onScanPause() {
  if (state.mode === "game") openPauseMenu();
}

// --- Shared pause overlay wiring (shared/pause-overlay.js) ---

// Create the shared pause overlay (PAUSE-OVERLAY CONTRACT v1) from the existing
// pause actions. The action handlers are reused verbatim from menus.pause, so
// Continue/Reset/Settings/Main Menu behave exactly as before. When the shared
// module is absent this leaves pauseOverlay null and the legacy bespoke
// #pause-overlay menu is used instead (guarded throughout).
function setupPauseOverlay() {
  pauseOverlay = null;
  if (typeof window === "undefined" || !window.BennyPauseOverlay) return;

  try {
    pauseOverlay = window.BennyPauseOverlay.create({
      actions: menus.pause.map((item, i) => ({
        id: PAUSE_ACTION_IDS[i] || `pause-${i}`,
        label: typeof item.text === "function" ? item.text() : item.text,
        onSelect: item.action,
      })),
      scanManager: window.NarbeScanManager,
      voice: window.NarbeVoiceManager,
    });
  } catch (e) {
    console.warn(
      "BennyPauseOverlay.create failed; using legacy pause menu:",
      e,
    );
    pauseOverlay = null;
  }
}

// Highlight the focused overlay action button, mirroring the menu highlight UX
// (outline vs. full-cell, app highlight color). Defensive: the overlay owns its
// own DOM, so this only sets/clears removable inline styles on its buttons.
function updateOverlayHighlights() {
  if (!pauseOverlay || !pauseOverlay.isOpen() || !scan) return;
  const targets = pauseOverlay.getTargets() || [];
  const idx = currentIndex();
  const color = highlightColors[settings.highlightColorIndex];

  targets.forEach((btn, i) => {
    if (!btn || !btn.style) return;
    if (i === idx) {
      if (settings.highlightStyle === "full") {
        btn.style.backgroundColor = color;
        btn.style.color = "#000";
        btn.style.outline = "";
      } else {
        btn.style.outline = `6px solid ${color}`;
        btn.style.backgroundColor = "";
        btn.style.color = "";
      }
    } else {
      btn.style.outline = "";
      btn.style.backgroundColor = "";
      btn.style.color = "";
    }
  });
}

// Announce the focused overlay action button via TTS (reads its label).
function announceCurrentOverlayItem() {
  const t = scan ? scan.getCurrentTarget() : null;
  if (!t) return;
  const raw =
    (t.getAttribute && t.getAttribute("aria-label")) || t.textContent || "";
  const text = String(raw)
    .replace(/<[^>]*>?/gm, "")
    .trim();
  if (text) speak(text);
}

// --- Menu System ---

const menus = {
  main: [
    { text: "Single Player", action: () => startGame("single") },
    { text: "Two Player", action: () => startGame("two") },
    { text: "Settings", action: () => showMenu("settings") },
    {
      text: "Exit",
      action: () => {
        speak("Exiting to Hub");
        setTimeout(() => {
          // Adopt the shared nav contract; fall back to the legacy path.
          if (typeof window !== "undefined" && window.Nav) {
            window.Nav.goBack();
          } else if (window.parent && window.parent !== window) {
            window.parent.postMessage({ action: "focusBackButton" }, "*");
          } else {
            window.location.href = "../../../index.html";
          }
        }, 500);
      },
    },
  ],
  settings: [
    {
      text: () =>
        `TTS: ${window.NarbeVoiceManager ? (window.NarbeVoiceManager.getSettings().ttsEnabled ? "On" : "Off") : settings.tts ? "On" : "Off"}`,
      action: () => toggleSetting("tts"),
      onPrev: () => toggleSetting("tts"),
    },
    {
      text: () => `Sound: ${settings.sound ? "On" : "Off"}`,
      action: () => toggleSetting("sound"),
      onPrev: () => toggleSetting("sound"),
    },
    {
      text: () => `Theme: ${themes[settings.themeIndex].name}`,
      action: () => cycleSetting("themeIndex", 1, themes.length),
      onPrev: () => cycleSetting("themeIndex", -1, themes.length),
    },
    {
      text: () =>
        `Highlight: ${settings.highlightStyle === "outline" ? "Outline" : "Full Cell"}`,
      action: () => toggleHighlightStyle(),
      onPrev: () => toggleHighlightStyle(),
    },
    {
      text: () =>
        `P1 Color: ${playerColors[settings.p1ColorIndex].name} <span class="color-swatch-circle" style="background-color:${playerColors[settings.p1ColorIndex].hex};"></span>`,
      action: () => cycleColor("p1ColorIndex", 1),
      onPrev: () => cycleColor("p1ColorIndex", -1),
    },
    {
      text: () =>
        `P2 Color: ${playerColors[settings.p2ColorIndex].name} <span class="color-swatch-circle" style="background-color:${playerColors[settings.p2ColorIndex].hex};"></span>`,
      action: () => cycleColor("p2ColorIndex", 1),
      onPrev: () => cycleColor("p2ColorIndex", -1),
    },
    {
      text: () =>
        `Highlight Color: ${highlightColors[settings.highlightColorIndex]}`,
      action: () =>
        cycleSetting("highlightColorIndex", 1, highlightColors.length),
      onPrev: () =>
        cycleSetting("highlightColorIndex", -1, highlightColors.length),
    },
    {
      text: () => {
        if (window.NarbeScanManager)
          return `Auto Scan: ${window.NarbeScanManager.getSettings().autoScan ? "On" : "Off"}`;
        return `Auto Scan: ${settings.autoScan ? "On" : "Off"}`;
      },
      action: () => {
        if (window.NarbeScanManager) {
          window.NarbeScanManager.updateSettings({
            autoScan: !window.NarbeScanManager.getSettings().autoScan,
          });
          refreshCurrentMenu();
        } else {
          toggleSetting("autoScan");
        }
      },
      onPrev: () => {
        if (window.NarbeScanManager) {
          window.NarbeScanManager.updateSettings({
            autoScan: !window.NarbeScanManager.getSettings().autoScan,
          });
          refreshCurrentMenu();
        } else {
          toggleSetting("autoScan");
        }
      },
    },
    {
      text: () => {
        if (window.NarbeScanManager)
          return `Scan Speed: ${window.NarbeScanManager.getScanInterval() / 1000} Seconds`;
        return `Scan Speed: ${config.scanSpeeds[settings.scanSpeedIndex].label}`;
      },
      action: () => {
        if (window.NarbeScanManager) {
          window.NarbeScanManager.cycleScanSpeed();
          refreshCurrentMenu();
          startScan();
        } else cycleSetting("scanSpeedIndex", 1, config.scanSpeeds.length);
      },
      onPrev: () => {
        if (window.NarbeScanManager) {
          window.NarbeScanManager.cycleScanSpeed();
          refreshCurrentMenu();
          startScan();
        } else cycleSetting("scanSpeedIndex", -1, config.scanSpeeds.length);
      },
    },
    { text: "Back", action: () => showMainMenu() },
  ],
  pause: [
    { text: "Continue Game", action: () => resumeGame() },
    { text: "Reset Game", action: () => restartGame() },
    { text: "Settings", action: () => showPauseSettings() },
    { text: "Main Menu", action: () => showMainMenu() },
  ],
  pauseSettings: [],
};

// Fill pauseSettings based on settings logic
menus.pauseSettings = menus.settings.map((item) => {
  if (item.text === "Back")
    return { text: "Back", action: () => openPauseMenu() };
  return item;
});

function renderMenu(menuName, menuItems, containerId = "menu-container") {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  if (menuName === "settings") {
    container.classList.add("settings-layout");
    container.style.display = "grid";
    container.style.gridTemplateColumns = "1fr 1fr";
    container.style.alignContent = "center";
  } else {
    container.classList.remove("settings-layout");
    container.style.display = "flex";
    container.style.flexDirection = "column";
  }

  // Add Title
  const title = document.createElement("div");
  title.className = state.mode === "menu" ? "menu-title" : "pause-title";

  if (menuName === "main") {
    title.innerHTML = `BENNY'S<br>CONNECT FOUR`;
  } else {
    title.innerHTML =
      menuName === "settings"
        ? "SETTINGS"
        : menuName === "pause"
          ? "PAUSED"
          : menuName === "gameover"
            ? "GAME OVER"
            : "SETTINGS";
  }
  container.appendChild(title);

  // Add Buttons
  menuItems.forEach((item, idx) => {
    const btn = document.createElement("button");
    btn.className = "menu-button";
    btn.id = `btn-${containerId}-${idx}`;
    const txt = typeof item.text === "function" ? item.text() : item.text;
    btn.innerHTML = txt;

    btn.onclick = () => {
      // Sync the scan index to the clicked button for consistency.
      if (scan) {
        scan.setIndex(idx);
        updateHighlights();
      }
      item.action();
    };

    container.appendChild(btn);
  });

  updateHighlights();
}

function showMainMenu() {
  state.mode = "menu";
  state.menuState = "main";
  if (scan) scan.setIndex(0);

  if (pauseOverlay) pauseOverlay.hide();
  document.getElementById("menu-container").style.display = "flex";
  document.getElementById("game-board-container").style.display = "none";
  document.getElementById("pause-overlay").style.display = "none";

  const pauseIcon = document.getElementById("pause-button-icon");
  if (pauseIcon) pauseIcon.style.display = "none";

  renderMenu("main", menus.main);
  speak("Benny's Connect Four. Single Player.");

  startScan();
}

function showMenu(menuName) {
  state.mode = "menu";
  state.menuState = menuName;
  if (scan) scan.setIndex(0);

  const pauseIcon = document.getElementById("pause-button-icon");
  if (pauseIcon) pauseIcon.style.display = "none";

  renderMenu(menuName, menus[menuName]);
  announceCurrentMenuItem();
  startScan();
}

function openPauseMenu() {
  state.mode = "pause";
  state.pauseMenuState = "main";
  if (scan) scan.setIndex(0);

  // Shared overlay path: show the shared <benny-pause-overlay> and let it own
  // the pause scan targets. The legacy bespoke #pause-overlay stays hidden
  // (it is still used as the host for the pause Settings sub-menu below).
  if (pauseOverlay) {
    const legacy = document.getElementById("pause-overlay");
    if (legacy) legacy.style.display = "none";
    pauseOverlay.show();
    updateOverlayHighlights();
    speak("Paused");
    startScan();
    return;
  }

  // Fallback: legacy bespoke pause menu (BennyPauseOverlay absent).
  const ov = document.getElementById("pause-overlay");
  ov.style.display = "flex";

  renderMenu("pause", menus.pause, "pause-overlay");
  speak("Paused");
  startScan();
}

function showPauseSettings() {
  state.pauseMenuState = "settings";
  // The flat overlay contract has no sub-menu, so the pause Settings list keeps
  // rendering into the legacy #pause-overlay host. Hide the shared overlay first
  // so scanning falls back to the menus.pauseSettings target set.
  if (pauseOverlay) pauseOverlay.hide();
  if (scan) scan.setIndex(0);
  const ov = document.getElementById("pause-overlay");
  if (ov) ov.style.display = "flex";
  renderMenu("settings", menus.pauseSettings, "pause-overlay");
  announceCurrentMenuItem();
  startScan();
}

function resumeGame() {
  if (pauseOverlay) pauseOverlay.hide();
  document.getElementById("pause-overlay").style.display = "none";
  state.mode = "game";
  state.computerThinking = false;
  if (scan) scan.setIndex(0);
  updateGameHighlights();
  speak("Resuming Game.");
  startScan();
}

// --- Settings Logic ---

function toggleSetting(key) {
  if (key === "tts" && window.NarbeVoiceManager) {
    window.NarbeVoiceManager.toggleTTS();
    settings.tts = window.NarbeVoiceManager.getSettings().ttsEnabled;
  } else {
    settings[key] = !settings[key];
  }
  saveSettings();
  refreshCurrentMenu();
}

function cycleSetting(key, dir, max) {
  settings[key] = (settings[key] + dir + max) % max;
  saveSettings();
  if (key === "themeIndex") applyTheme();
  refreshCurrentMenu();
}

function cycleColor(key, dir) {
  const otherKey = key === "p1ColorIndex" ? "p2ColorIndex" : "p1ColorIndex";
  let nextVal = settings[key];

  do {
    nextVal = (nextVal + dir + playerColors.length) % playerColors.length;
  } while (nextVal === settings[otherKey]);

  settings[key] = nextVal;
  saveSettings();
  refreshCurrentMenu();
}

function refreshCurrentMenu() {
  if (state.mode === "menu") {
    renderMenu(state.menuState, menus[state.menuState]);
    announceCurrentMenuItem();
  } else if (state.mode === "pause") {
    const m =
      state.pauseMenuState === "main" ? menus.pause : menus.pauseSettings;
    renderMenu(
      state.pauseMenuState === "main" ? "pause" : "settings",
      m,
      "pause-overlay",
    );
    announceCurrentMenuItem();
  }
}

function toggleHighlightStyle() {
  settings.highlightStyle =
    settings.highlightStyle === "outline" ? "full" : "outline";
  saveSettings();
  refreshCurrentMenu();
  updateGameHighlights();
}

// --- Game Logic ---

function initBoard() {
  state.board = [];
  for (let r = 0; r < config.rows; r++) {
    state.board.push(Array(config.cols).fill(0));
  }
  state.winningCells = [];
}

function renderBoard() {
  const boardEl = document.getElementById("connect-four-board");
  boardEl.innerHTML = "";

  for (let r = 0; r < config.rows; r++) {
    for (let c = 0; c < config.cols; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.id = `cell-${r}-${c}`;

      cell.onclick = () => handleColumnClick(c);

      const pieceVal = state.board[r][c];
      if (pieceVal !== 0) {
        const piece = document.createElement("div");
        piece.className = "piece";
        piece.id = `piece-${r}-${c}`;

        const colorIndex =
          pieceVal === 1 ? settings.p1ColorIndex : settings.p2ColorIndex;
        piece.style.backgroundColor = playerColors[colorIndex].hex;

        // Check if this is a winning cell
        if (state.winningCells.some((wc) => wc.r === r && wc.c === c)) {
          piece.classList.add("winning");
        }

        cell.appendChild(piece);
      }

      boardEl.appendChild(cell);
    }
  }

  updateTurnIndicator();
  updateGameHighlights();
}

function updateTurnIndicator() {
  const indicator = document.getElementById("turn-indicator");
  if (!indicator) return;

  const playerName =
    state.turn === 1
      ? "Player 1"
      : state.gameMode === "single"
        ? "Computer"
        : "Player 2";
  const colorIndex =
    state.turn === 1 ? settings.p1ColorIndex : settings.p2ColorIndex;

  indicator.innerHTML = `${playerName}'s Turn <div class="preview-piece" style="background-color: ${playerColors[colorIndex].hex}"></div>`;
}

function startGame(mode) {
  state.gameMode = mode;
  state.mode = "game";
  state.turn = 1;
  state.winningCells = [];
  state.computerThinking = false;

  document.getElementById("menu-container").style.display = "none";
  document.getElementById("game-board-container").style.display = "flex";

  const pauseIcon = document.getElementById("pause-button-icon");
  if (pauseIcon) pauseIcon.style.display = "flex";

  initBoard();
  if (scan) scan.setIndex(0);
  renderBoard();

  showTurnNotification("Player 1's Turn");
  speak("Game Started. Player 1's Turn.");

  startScan();
}

function restartGame() {
  if (pauseOverlay) pauseOverlay.hide();
  document.getElementById("pause-overlay").style.display = "none";
  startGame(state.gameMode);
}

function handleColumnClick(col) {
  if (state.mode !== "game") return;
  if (state.gameMode === "single" && state.turn === -1) return; // Computer's turn

  // Check if column is full
  if (state.board[0][col] !== 0) {
    playSound("error");
    speak("Column full");
    return;
  }

  dropPiece(col);
}

function dropPiece(col) {
  // Find the lowest empty row in this column
  let targetRow = -1;
  for (let r = config.rows - 1; r >= 0; r--) {
    if (state.board[r][col] === 0) {
      targetRow = r;
      break;
    }
  }

  if (targetRow === -1) return; // Column full

  // Place piece
  state.board[targetRow][col] = state.turn;

  playSound("drop");
  renderBoard();

  // Animate the drop
  const piece = document.getElementById(`piece-${targetRow}-${col}`);
  if (piece) {
    piece.classList.add("dropping");
    setTimeout(() => piece.classList.remove("dropping"), 500);
  }

  // Check for win
  const winResult = checkWin(targetRow, col);
  if (winResult) {
    state.winningCells = winResult;
    renderBoard(); // Re-render to show winning animation

    const winner =
      state.turn === 1
        ? "Player 1"
        : state.gameMode === "single"
          ? "Computer"
          : "Player 2";
    gameOver(`${winner} Wins!`);
    return;
  }

  // Check for draw
  if (isBoardFull()) {
    gameOver("It's a Draw!");
    return;
  }

  // Switch turns
  endTurn();
}

function checkWin(row, col) {
  const player = state.board[row][col];
  const directions = [
    [0, 1], // Horizontal
    [1, 0], // Vertical
    [1, 1], // Diagonal down-right
    [1, -1], // Diagonal down-left
  ];

  for (const [dr, dc] of directions) {
    const cells = [{ r: row, c: col }];

    // Check in positive direction
    for (let i = 1; i < config.winLength; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      if (
        r >= 0 &&
        r < config.rows &&
        c >= 0 &&
        c < config.cols &&
        state.board[r][c] === player
      ) {
        cells.push({ r, c });
      } else {
        break;
      }
    }

    // Check in negative direction
    for (let i = 1; i < config.winLength; i++) {
      const r = row - dr * i;
      const c = col - dc * i;
      if (
        r >= 0 &&
        r < config.rows &&
        c >= 0 &&
        c < config.cols &&
        state.board[r][c] === player
      ) {
        cells.push({ r, c });
      } else {
        break;
      }
    }

    if (cells.length >= config.winLength) {
      return cells;
    }
  }

  return null;
}

function isBoardFull() {
  for (let c = 0; c < config.cols; c++) {
    if (state.board[0][c] === 0) return false;
  }
  return true;
}

function endTurn() {
  state.turn = state.turn === 1 ? -1 : 1;

  // Re-seat the scanner onto the first droppable column for the new turn.
  if (scan) scan.setIndex(0);

  renderBoard();

  setTimeout(() => {
    let playerText = state.turn === 1 ? "Player 1" : "Player 2";
    if (state.gameMode === "single" && state.turn === -1) {
      playerText = "Computer";
    }

    showTurnNotification(`${playerText}'s Turn`);

    if (state.gameMode === "single" && state.turn === -1) {
      state.computerThinking = true;
      stopScan(); // No auto-scan / no manual input during the computer's turn
      speak("Computer's Turn.");
      setTimeout(computerMove, 800);
    } else {
      state.computerThinking = false;
      speak(`${playerText}'s Turn.`);
      startScan();
    }
  }, 300);
}

function computerMove() {
  state.computerThinking = true;
  stopScan();

  // Simple AI: Try to win, block opponent wins, or pick best strategic move
  const validCols = [];
  for (let c = 0; c < config.cols; c++) {
    if (state.board[0][c] === 0) validCols.push(c);
  }

  if (validCols.length === 0) return;

  // Try to win
  for (const col of validCols) {
    const row = getDropRow(col);
    if (row !== -1) {
      state.board[row][col] = -1;
      if (checkWin(row, col)) {
        state.board[row][col] = 0;
        dropPiece(col);
        return;
      }
      state.board[row][col] = 0;
    }
  }

  // Block opponent win
  for (const col of validCols) {
    const row = getDropRow(col);
    if (row !== -1) {
      state.board[row][col] = 1;
      if (checkWin(row, col)) {
        state.board[row][col] = 0;
        dropPiece(col);
        return;
      }
      state.board[row][col] = 0;
    }
  }

  // Prefer center columns
  const centerPref = [3, 2, 4, 1, 5, 0, 6];
  for (const col of centerPref) {
    if (validCols.includes(col)) {
      dropPiece(col);
      return;
    }
  }

  // Random fallback
  const randomCol = validCols[Math.floor(Math.random() * validCols.length)];
  dropPiece(randomCol);
}

function getDropRow(col) {
  for (let r = config.rows - 1; r >= 0; r--) {
    if (state.board[r][col] === 0) return r;
  }
  return -1;
}

function gameOver(msg) {
  state.mode = "gameover";
  state.computerThinking = false;
  stopScan();
  playSound("win");
  speak("Game Over. " + msg);
  showTurnNotification(msg, 5000);

  setTimeout(() => {
    speak("Returning to Main Menu");
    showMainMenu();
  }, 4000);
}

// --- Announcements ---

function announceCurrentMenuItem() {
  const items = getScanItemsForMode();
  const item = items[currentIndex()];
  if (item) {
    let t = typeof item.text === "function" ? item.text() : item.text;
    t = t.replace(/<[^>]*>?/gm, "");
    speak(t);
  }
}

function announceCurrentGameItem() {
  const cols = getGameColumns();
  const idx = scan ? scan.getIndex() : -1;
  if (idx < 0 || idx >= cols.length) return;
  const item = cols[idx];
  if (item && item.text) {
    speak(item.text);
  }
}

// --- Highlighting UI ---

function updateHighlights() {
  if (state.mode === "menu" || state.mode === "pause") {
    document.querySelectorAll(".menu-button").forEach((b) => {
      b.classList.remove("highlight");
      b.style.borderColor = "transparent";
      b.style.backgroundColor = "rgba(255, 255, 255, 0.9)";
      b.style.color = "#333";
    });

    let container = state.mode === "menu" ? "menu-container" : "pause-overlay";
    let idx = currentIndex();

    const btn = document.getElementById(`btn-${container}-${idx}`);
    if (!btn) {
      const c = document.getElementById(
        container === "pause-overlay" ? "pause-overlay" : "menu-container",
      );
      const buttons = c ? c.querySelectorAll("button") : [];
      if (buttons[idx]) {
        highlightButton(buttons[idx]);
      }
    } else {
      highlightButton(btn);
    }
  }
}

function highlightButton(btn) {
  btn.classList.add("highlight");
  const uiColor = highlightColors[settings.highlightColorIndex];

  if (settings.highlightStyle === "full") {
    btn.style.backgroundColor = uiColor;
    btn.style.color = "#000";
    btn.style.borderColor = "transparent";
  } else {
    btn.style.backgroundColor = "rgba(255, 255, 255, 0.9)";
    btn.style.color = "#333";
    btn.style.borderColor = uiColor;
    btn.style.borderWidth = "6px";
  }
}

function updateGameHighlights() {
  // Clear old highlights on arrows
  document.querySelectorAll(".column-arrow").forEach((a) => {
    a.classList.remove("highlight-outline", "highlight-full");
    a.style.boxShadow = "";
    a.style.backgroundColor = "";
  });

  // Clear old preview pieces and target cells
  document.querySelectorAll(".piece.preview").forEach((p) => p.remove());
  document
    .querySelectorAll(".cell.preview-target")
    .forEach((c) => c.classList.remove("preview-target"));

  // Update disabled state
  for (let c = 0; c < config.cols; c++) {
    const arrow = document.getElementById(`arrow-${c}`);
    if (arrow) {
      if (state.board[0] && state.board[0][c] !== 0) {
        arrow.classList.add("disabled");
      } else {
        arrow.classList.remove("disabled");
      }
    }
  }

  const cols = getGameColumns();
  const idx = scan ? scan.getIndex() : -1;
  if (idx < 0 || idx >= cols.length) return;

  const item = cols[idx];
  if (item && item.type === "column") {
    const color = highlightColors[settings.highlightColorIndex];

    // Highlight the arrow
    const arrow = document.getElementById(`arrow-${item.col}`);
    if (arrow) {
      if (settings.highlightStyle === "full") {
        arrow.classList.add("highlight-full");
        arrow.style.backgroundColor = color;
      } else {
        arrow.classList.add("highlight-outline");
        arrow.style.boxShadow = `inset 0 0 0 6px ${color}, 0 0 20px ${color}`;
      }
    }

    // Show preview piece where it will land
    const targetRow = getDropRow(item.col);
    if (targetRow !== -1) {
      const cell = document.getElementById(`cell-${targetRow}-${item.col}`);
      if (cell) {
        cell.classList.add("preview-target");

        // Add preview piece
        const preview = document.createElement("div");
        preview.className = "piece preview";
        const colorIndex =
          state.turn === 1 ? settings.p1ColorIndex : settings.p2ColorIndex;
        preview.style.backgroundColor = playerColors[colorIndex].hex;
        preview.style.color = playerColors[colorIndex].hex; // For box-shadow currentColor
        cell.appendChild(preview);
      }
    }
  }
}

// --- TTS & Theme ---

function speak(text) {
  if (window.NarbeVoiceManager) {
    window.NarbeVoiceManager.speak(text);
  } else if (settings.tts && "speechSynthesis" in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    speechSynthesis.speak(u);
  }
}

function applyTheme() {
  const theme = themes[settings.themeIndex];
  if (theme) {
    document.body.style.background = theme.bg;
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundAttachment = "fixed";
  }
}

function showTurnNotification(text, duration = 1500) {
  const el = document.getElementById("status-display");
  if (!el) return;
  el.innerText = text;
  el.classList.add("visible");

  if (state.timers.status) clearTimeout(state.timers.status);

  state.timers.status = setTimeout(() => {
    el.classList.remove("visible");
  }, duration);
}

// Dual export so the migrated scan layer can be exercised under jest + jsdom,
// mirroring the shared modules' IIFE-global + CommonJS pattern. The guard keeps
// this a no-op in the browser (where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    init,
    state,
    settings,
    themes,
    highlightColors,
    playerColors,
    menus,
    getScanTargets,
    getGameColumns,
    startGame,
    restartGame,
    showMainMenu,
    showMenu,
    openPauseMenu,
    showPauseSettings,
    resumeGame,
    dropPiece,
    handleColumnClick,
    getDropRow,
    checkWin,
    getScan: () => scan,
    getPauseOverlay: () => pauseOverlay,
  };
}
