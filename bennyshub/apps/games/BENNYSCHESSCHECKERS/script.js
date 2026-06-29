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
};

// Themes + highlight palette now come from the shared themes module
// (shared/themes.js). ChessCheckers shares the first six "standard cluster"
// themes verbatim and keeps its own bespoke 7th theme ("Classic Wood"), exactly
// as documented in the themes-module reconciliation notes. The fallbacks below
// reproduce the historical local arrays for environments where the shared module
// is unavailable.
const CLASSIC_WOOD = {
  name: "Classic Wood",
  bg: 'url("https://www.transparenttextures.com/patterns/wood-pattern.png"), linear-gradient(135deg, #8b5a2b, #4e342e)',
};

const themes =
  typeof window !== "undefined" && window.Themes
    ? [...window.Themes.THEMES.slice(0, 6), CLASSIC_WOOD]
    : [
        { name: "Default", bg: "linear-gradient(135deg, #ff4b1f, #ff9068)" },
        { name: "Ocean", bg: "linear-gradient(135deg, #2193b0, #6dd5ed)" },
        { name: "Midnight", bg: "linear-gradient(135deg, #232526, #414345)" },
        { name: "Forest", bg: "linear-gradient(135deg, #134e5e, #71b280)" },
        { name: "Sunset", bg: "linear-gradient(135deg, #f12711, #f5af19)" },
        { name: "Lavender", bg: "linear-gradient(135deg, #834d9b, #d04ed6)" },
        CLASSIC_WOOD,
      ];

const highlightColors =
  typeof window !== "undefined" && window.Themes
    ? window.Themes.HIGHLIGHT_COLORS
    : [
        "Theme Default",
        "Yellow",
        "White",
        "Cyan",
        "Lime",
        "Magenta",
        "Red",
        "Orange",
        "Pink",
        "Gold",
        "DeepSkyBlue",
        "SpringGreen",
        "Violet",
      ];

const playerColors = [
  { name: "Red", hex: "#d32f2f" },
  { name: "Black", hex: "#212121" },
  { name: "White", hex: "#f5f5f5" },
  { name: "Blue", hex: "#1976d2" },
  { name: "Green", hex: "#388e3c" },
  { name: "Purple", hex: "#7b1fa2" },
  { name: "Orange", hex: "#f57c00" },
];

// --- Game State ---
const state = {
  mode: "menu", // menu, game, pause, gameover
  menuState: "main", // main, settings
  gameMode: "single", // single, two
  gameType: "checkers", // checkers, chess

  // Board Representation:
  // Checkers: 8x8 array. 0 = empty. P1=1/2, P2=-1/-2
  // Chess: Managed by ChessGame instance
  board: [],

  turn: 1, // 1/w for Player 1, -1/b for Player 2

  // Selection state
  selectedPiece: null, // {r, c}
  availableMoves: [], // List of {r, c, type, capturedPiece}

  // Scanning state.
  // The shared ScanController (shared/scan-core.js) owns the scan index now;
  // `scanItems` remains the dynamic, single-axis target list it steps through
  // (available pieces, then the legal-move targets for the selected piece).
  scanItems: [], // List of interactable items currently available

  pauseMenuState: "main",

  // Chess random side
  humanSide: 1, // 1 for White/P1, -1 for Black/P2
  computerSide: -1,

  // True while the computer is taking its turn — gates auto-scan so the board
  // does not scan during the AI's move.
  computerThinking: false,

  timers: {
    status: null,
  },
};

let chessGame = null; // Instance of ChessGame

// The shared scan controller (shared/scan-core.js). It is the single source of
// truth for the scan index; `getScanTargets()` supplies the per-context targets.
let scan = null;

// The shared pause overlay (shared/pause-overlay.js, window.BennyPauseOverlay).
// Created in init() when the contract is available; stays null otherwise, in
// which case the legacy in-page pause menu (#pause-overlay) is used as a fallback
// so the app keeps working if the shared module is absent.
let pauseOverlay = null;

const settings = {
  themeIndex: 0,
  tts: true,
  sound: true,
  p1ColorIndex: 0, // Red
  p2ColorIndex: 1, // Black
  highlightColorIndex: 0, // Theme Default (resolves to the active theme's highlight)
  autoScan: false, // Default off (fallback when NarbeScanManager is absent)
  scanSpeedIndex: 1, // Default 2 Seconds (fallback when NarbeScanManager is absent)
  locationTTS: true, // Announce coordinates
  highlightStyle: "outline", // 'outline' or 'full'
};

// Keys that belong to the shared, cross-app global settings contract
// (shared/settings-store.js GLOBAL_SCHEMA). These are routed through
// SettingsStore.global so they stay in sync with the rest of the hub. The scan
// cadence / autoScan settings stay owned by NarbeScanManager (as before), and
// the remaining app-specific keys stay in this app's own localStorage blob.
const SETTINGS_KEY = "bennys_checkers_settings";
const GLOBAL_SETTINGS_KEYS = ["highlightColorIndex", "highlightStyle"];

// --- Sounds ---
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx)
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Ensure unlock on first touch
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
  } else if (type === "move") {
    osc.type = "triangle";
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(100, ctx.currentTime + 0.2);
    gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } else if (type === "king") {
    osc.type = "sine";
    osc.frequency.setValueAtTime(400, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(800, ctx.currentTime + 0.3);
    gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
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

      // Validate indices safely
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
      // First run, save defaults
      saveSettings();
    }
  } catch (e) {
    console.error("Error loading settings:", e);
    // Fallback to safe defaults if JSON parse fails
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
        typeof settings.highlightColorIndex !== "number" ||
        settings.highlightColorIndex < 0 ||
        settings.highlightColorIndex >= highlightColors.length
      ) {
        settings.highlightColorIndex = 0;
      }
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
  // Similar to Tic Tac Toe but for Checkers
  const mainContent = document.getElementById("main-content");

  // Menu
  const menuContainer = document.createElement("div");
  menuContainer.id = "menu-container";
  menuContainer.className = "menu-container";
  mainContent.appendChild(menuContainer);

  // Game Board
  const gameContainer = document.createElement("div");
  gameContainer.id = "game-board-container";
  gameContainer.className = "game-container";
  gameContainer.style.display = "none";

  const board = document.createElement("div");
  board.id = "checkers-board";
  board.className = "checkers-board";
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
  pauseIcon.id = "pause-button-icon"; // Give it an ID to reference easily
  pauseIcon.className = "pause-button-icon";
  pauseIcon.innerHTML = "ll";
  pauseIcon.title = "Pause Game";
  pauseIcon.style.display = "none"; // Initially hidden
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

// (Re)start auto-scan, keeping the reverse cadence aligned with the current
// scan speed. Mirrors the historical startAutoScan/resetAutoScan call sites.
function startScan() {
  if (!scan) return;
  scan.reverseCadenceMs = resolveScanInterval();
  scan.start();
}

// The flat, single-axis target list ScanController steps through for the active
// context: dynamic game items in game mode, the menu item arrays elsewhere.
function getScanItemsForMode() {
  if (state.mode === "game") return state.scanItems;
  if (state.mode === "menu") return menus[state.menuState] || [];
  if (state.mode === "pause") {
    // When the shared overlay is the active pause surface the controller scans
    // its action buttons; otherwise (pause-settings, or no-overlay fallback) it
    // scans the legacy menu item arrays.
    if (pauseOverlayActive()) return pauseOverlay.getTargets() || [];
    return state.pauseMenuState === "main" ? menus.pause : menus.pauseSettings;
  }
  return [];
}

function getScanTargets() {
  return getScanItemsForMode();
}

// Clamped current scan index (treats the unseated -1 as 0 for menu lookups).
function currentIndex() {
  const idx = scan ? scan.getIndex() : 0;
  return idx < 0 ? 0 : idx;
}

function onScanFocus() {
  // The controller has already advanced its index; reflect it in the visuals.
  if (state.mode === "game") updateGameHighlights();
  else if (pauseOverlayActive()) updatePauseOverlayHighlight();
  else updateHighlights();
}

function onScanAnnounce() {
  if (state.mode === "game") announceCurrentGameItem();
  else if (pauseOverlayActive()) announcePauseOverlayItem();
  else announceCurrentMenuItem();
}

function onScanSelect() {
  if (state.mode === "game") {
    // Use the raw index: at turn start (unseated, -1) a select is a no-op,
    // matching the pre-migration behavior.
    const idx = scan ? scan.getIndex() : -1;
    if (idx < 0 || idx >= state.scanItems.length) return;
    const item = state.scanItems[idx];
    if (!item) return;
    if (item.type === "piece") {
      handleCellClick(item.r, item.c);
    } else if (item.type === "move") {
      executeMove(item.moveData);
    } else if (item.type === "cancel") {
      // Deselect
      state.selectedPiece = null;
      state.availableMoves = [];
      updateGameScanItems();
      renderBoard();
      speak("Selection Cancelled.");
    }
  } else if (state.mode === "menu" || state.mode === "pause") {
    // Pause main page via the shared overlay: select runs through the overlay's
    // activate() (which fires the action's onSelect and emits `pause-action`).
    if (pauseOverlayActive()) {
      const targets = pauseOverlay.getTargets() || [];
      const target = targets[currentIndex()];
      if (target) {
        playSound("select");
        pauseOverlay.activate(target);
      }
      return;
    }
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

// --- Menu System ---

const menus = {
  main: [
    {
      text: () =>
        `Game: ${state.gameType.charAt(0).toUpperCase() + state.gameType.slice(1)}`,
      action: () => toggleGameType(),
    },
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
      text: () => `TTS: ${settings.tts ? "On" : "Off"}`,
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
  // Separate settings menu instance for pause to handle "Back" correctly
  pauseSettings: [/* Copy of settings but Back goes to Pause */],
};

// Fill pauseSettings based on settings logic
menus.pauseSettings = menus.settings.map((item) => {
  if (item.text === "Back")
    return { text: "Back", action: () => openPauseMenu() };
  return item;
});

// The pause-menu actions in shared-overlay (BennyPauseOverlay) shape. These are
// the same four actions as menus.pause, expressed verbatim as the overlay's
// { id, label, onSelect } contract entries. The legacy menus.pause array is
// retained for the fallback path (when BennyPauseOverlay is unavailable).
const pauseActions = [
  { id: "continue", label: "Continue Game", onSelect: () => resumeGame() },
  { id: "reset", label: "Reset Game", onSelect: () => restartGame() },
  { id: "settings", label: "Settings", onSelect: () => showPauseSettings() },
  { id: "mainMenu", label: "Main Menu", onSelect: () => showMainMenu() },
];

// Create the shared pause overlay if the contract is present. On any failure (or
// when the module is absent) pauseOverlay stays null and the app falls back to
// the legacy in-page pause menu.
function setupPauseOverlay() {
  if (typeof window === "undefined" || !window.BennyPauseOverlay) return;
  try {
    pauseOverlay = window.BennyPauseOverlay.create({
      actions: pauseActions,
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

// True while the shared overlay is the active pause surface (pause mode, main
// pause page, overlay created and open). When true the ScanController scans the
// overlay's action buttons and selection runs through overlay.activate(); the
// pause-settings sub-page and the no-overlay fallback both report false here and
// keep using the legacy menu rendering / scan wiring.
function pauseOverlayActive() {
  return (
    state.mode === "pause" &&
    state.pauseMenuState === "main" &&
    !!pauseOverlay &&
    pauseOverlay.isOpen()
  );
}

// Highlight the focused overlay action button, honoring the user's highlight
// style/color settings. Operates only on the buttons getTargets() exposes, so it
// stays decoupled from the overlay's internal DOM.
function updatePauseOverlayHighlight() {
  if (!pauseOverlay) return;
  const targets = pauseOverlay.getTargets() || [];
  const idx = currentIndex();
  const color = getHighlightColor();
  targets.forEach((btn, i) => {
    if (!btn || !btn.style) return;
    if (i === idx) {
      btn.classList.add("highlight");
      if (settings.highlightStyle === "full") {
        btn.style.backgroundColor = color;
        btn.style.outline = "";
      } else {
        btn.style.outline = `6px solid ${color}`;
        btn.style.backgroundColor = "";
      }
    } else {
      btn.classList.remove("highlight");
      btn.style.outline = "";
      btn.style.backgroundColor = "";
    }
  });
}

// Announce the focused overlay action button via TTS (strips any markup).
function announcePauseOverlayItem() {
  if (!pauseOverlay) return;
  const targets = pauseOverlay.getTargets() || [];
  const btn = targets[currentIndex()];
  if (!btn) return;
  const t = (btn.textContent || "").replace(/<[^>]*>?/gm, "").trim();
  if (t) speak(t);
}

function renderMenu(menuName, menuItems, containerId = "menu-container") {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  // Toggle Layout Class for Settings
  if (menuName === "settings") {
    container.classList.add("settings-layout");
    container.style.display = "grid"; // Force grid
    container.style.gridTemplateColumns = "1fr 1fr"; // Ensure CSS hasn't been blocked
    container.style.alignContent = "center";
  } else {
    container.classList.remove("settings-layout");
    container.style.display = "flex"; // Restore flex
    container.style.flexDirection = "column";
  }

  // Add Title
  const title = document.createElement("div");
  title.className = state.mode === "menu" ? "menu-title" : "pause-title";

  if (menuName === "main") {
    title.innerHTML = `BENNY'S<br>${state.gameType.toUpperCase()}`;
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

    // Mouse click support
    btn.onclick = () => {
      // Sync the scan index to the clicked button for consistency
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

  if (pauseOverlay && pauseOverlay.isOpen()) pauseOverlay.hide();
  document.getElementById("menu-container").style.display = "flex";
  document.getElementById("game-board-container").style.display = "none";
  document.getElementById("pause-overlay").style.display = "none";

  // Hide Pause Button in Menu
  const pauseIcon = document.getElementById("pause-button-icon");
  if (pauseIcon) pauseIcon.style.display = "none";

  renderMenu("main", menus.main);
  speak("Benny's Checkers. Single Player.");

  startScan();
}

function showMenu(menuName) {
  state.mode = "menu";
  state.menuState = menuName;
  if (scan) scan.setIndex(0);

  // Hide pause button if showing settings from main menu
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

  if (pauseOverlay) {
    // Shared overlay path: hide the legacy container (used for pause settings),
    // show the overlay, and seat the scan highlight on the first action.
    document.getElementById("pause-overlay").style.display = "none";
    pauseOverlay.show();
    updatePauseOverlayHighlight();
    speak("Paused. Continue Game.");
    startScan();
    return;
  }

  // Legacy fallback: render the in-page pause menu.
  const ov = document.getElementById("pause-overlay");
  ov.style.display = "flex";

  renderMenu("pause", menus.pause, "pause-overlay");
  speak("Paused. Continue Game.");
  startScan();
}

function showPauseSettings() {
  state.pauseMenuState = "settings";
  if (scan) scan.setIndex(0);
  // The pause-settings sub-page is not part of the shared overlay contract; hide
  // the overlay and render the settings list into the legacy in-page container.
  if (pauseOverlay && pauseOverlay.isOpen()) pauseOverlay.hide();
  const ov = document.getElementById("pause-overlay");
  if (ov) ov.style.display = "flex";
  renderMenu("settings", menus.pauseSettings, "pause-overlay");
  announceCurrentMenuItem();
  startScan();
}

function resumeGame() {
  if (pauseOverlay && pauseOverlay.isOpen()) pauseOverlay.hide();
  document.getElementById("pause-overlay").style.display = "none";
  state.mode = "game";
  // Re-calculate scan items for board (re-seats the controller to index 0)
  updateGameScanItems();
  speak("Resuming Game.");
  startScan();
}

// --- Settings Logic ---

function toggleSetting(key) {
  settings[key] = !settings[key];
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

  // Loop until we find a color that isn't the opponent's
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
  updateGameHighlights(); // Force update in case board is underneath overlay
}
// --- Game Logic ---

function initBoard() {
  if (state.gameType === "chess") {
    if (!chessGame) chessGame = new ChessGame();
    else chessGame.reset();
    // Board logic is handled by chessGame, state.board is mostly for rendering hook or unused if we pull directly
    // But for renderBoard consistency, maybe we mirror it or better: pull from chessGame in renderBoard
  } else {
    // Checkers Initialization
    state.board = Array(8)
      .fill(null)
      .map(() => Array(8).fill(0));
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 !== 0) {
          if (r < 3)
            state.board[r][c] = -1; // P2
          else if (r > 4) state.board[r][c] = 1; // P1
        }
      }
    }
  }
}

function renderBoard() {
  const boardEl = document.getElementById("checkers-board");
  boardEl.innerHTML = ""; // Clear

  // In scan mode, we need to know what to highlight.
  // If selecting piece, highlight pieces of current turn.
  // If moving, highlight available moves.

  const isFlipped = state.humanSide === -1;

  for (let dispR = 0; dispR < 8; dispR++) {
    for (let dispC = 0; dispC < 8; dispC++) {
      let r = dispR;
      let c = dispC;

      if (isFlipped) {
        r = 7 - dispR;
        c = 7 - dispC;
      }

      const cell = document.createElement("div");
      cell.className = "cell " + ((r + c) % 2 === 0 ? "light" : "dark");
      cell.id = `cell-${r}-${c}`;

      // Mouse Interaction for selecting
      cell.onclick = () => handleCellClick(r, c);

      let pieceVal = 0;
      let displayPiece = null;
      let pColorIndex = 0;

      if (state.gameType === "chess") {
        const cp = chessGame.getPiece(r, c);
        if (cp) {
          displayPiece = CHESS_PIECES[cp.color][cp.type];
          pColorIndex = cp.color === "w" ? 2 : 1;
        }
      } else {
        pieceVal = state.board[r][c];
        if (pieceVal !== 0) {
          pColorIndex =
            pieceVal > 0 ? settings.p1ColorIndex : settings.p2ColorIndex;
        }
      }

      if (
        (state.gameType === "checkers" && pieceVal !== 0) ||
        (state.gameType === "chess" && displayPiece)
      ) {
        const piece = document.createElement("div");

        if (state.gameType === "checkers") {
          piece.className = "checker";
          if (Math.abs(pieceVal) === 2) piece.classList.add("king");
          piece.style.backgroundColor = playerColors[pColorIndex].hex;
        } else {
          // Chess Piece
          piece.className = "chess-piece";
          piece.innerText = displayPiece;
          piece.style.color = playerColors[pColorIndex].hex;
          // Use responsive font size
          piece.style.fontSize = "min(40px, 8vmin)";
          piece.style.display = "flex";
          piece.style.justifyContent = "center";
          piece.style.alignItems = "center";
          piece.style.width = "100%";
          piece.style.height = "100%";
          piece.style.textShadow = "1px 1px 2px rgba(0,0,0,0.5)";
        }

        // Visual selected state
        if (
          state.selectedPiece &&
          state.selectedPiece.r === r &&
          state.selectedPiece.c === c
        ) {
          if (state.gameType === "checkers") piece.classList.add("selected");
          else piece.style.background = "rgba(255, 255, 0, 0.4)";
        }

        cell.appendChild(piece);
      }

      // Highlight Moves
      if (state.selectedPiece) {
        const moveNode = state.availableMoves.find(
          (m) => m.r === r && m.c === c,
        );
        if (moveNode) {
          // Special visual for chess captures?
          // Just use existing highlight for now.
          cell.classList.add("possible-move");
        }
      }

      boardEl.appendChild(cell);
    }
  }

  updateGameHighlights();
}

function startGame(mode) {
  state.gameMode = mode;
  state.mode = "game";
  state.turn = 1; // P1 starts (White always starts)
  state.selectedPiece = null;
  state.availableMoves = [];
  state.computerThinking = false;

  // Randomize sides for Chess Single Player
  if (state.gameType === "chess" && state.gameMode === "single") {
    state.humanSide = Math.random() < 0.5 ? 1 : -1;
    state.computerSide = -state.humanSide;

    let sideText = state.humanSide === 1 ? "White" : "Black";
    speak(`You are playing as ${sideText}`);
    showTurnNotification(`You are ${sideText}`, 3000);
  } else {
    // Default
    state.humanSide = 1;
    state.computerSide = -1;
  }

  document.getElementById("menu-container").style.display = "none";
  document.getElementById("game-board-container").style.display = "flex";

  // Show Pause Button
  const pauseIcon = document.getElementById("pause-button-icon");
  if (pauseIcon) pauseIcon.style.display = "flex";

  initBoard();
  updateGameScanItems();
  renderBoard();

  let turnText = "White's Turn";
  if (state.gameType === "checkers") {
    turnText = "Player 1's Turn";
  }

  showTurnNotification(turnText);
  speak("Game Started. " + turnText);

  // If Human is Black (-1) and It's White's Turn (1), Computer moves
  if (
    state.gameType === "chess" &&
    state.gameMode === "single" &&
    state.humanSide === -1
  ) {
    state.computerThinking = true;
    if (scan) scan.stop();
    setTimeout(computerMove, 1000);
  } else {
    startScan();
  }
}

function restartGame() {
  if (pauseOverlay && pauseOverlay.isOpen()) pauseOverlay.hide();
  document.getElementById("pause-overlay").style.display = "none";
  startGame(state.gameMode);
}

// Data structure for scannable game items:
// We can either scan available pieces OR scan target moves. ScanController
// reads this list fresh on every step, so rebuilding it here re-seats the scan.
function updateGameScanItems() {
  if (state.mode !== "game") return;

  state.scanItems = [];

  // Chess Logic
  if (state.gameType === "chess") {
    if (!state.selectedPiece) {
      // Find all pieces with legal moves
      const moves = chessGame.getAllMoves(chessGame.turn);
      const pieces = new Set();
      moves.forEach((m) => pieces.add(`${m.from.r},${m.from.c}`));

      pieces.forEach((pStr) => {
        const [r, c] = pStr.split(",").map(Number);
        const piece = chessGame.getPiece(r, c);
        const name = piece ? getChessPieceName(piece.type) : "Piece";

        state.scanItems.push({
          type: "piece",
          r,
          c,
          text: `${name} at ${coordsToText(r, c)}`,
        });
      });
    } else {
      // Selected: Show moves
      // state.availableMoves already populated by selectPiece
      state.availableMoves.forEach((m) => {
        const isCap = m.moveData.captured;
        state.scanItems.push({
          type: "move",
          r: m.r,
          c: m.c,
          moveData: m, // Store the wrapper, so executeMove gets consistent input
          text: `${isCap ? "Capture " : "Move to "}${coordsToText(m.r, m.c)}`,
        });
      });

      state.scanItems.push({
        type: "cancel",
        text: "Select different piece",
      });
    }
    if (scan) scan.setIndex(0);
    return;
  }

  // Checkers Logic
  const possibleFrom = getPiecesWithMoves(state.turn);

  if (!state.selectedPiece) {
    state.scanItems = possibleFrom.map((p) => ({
      type: "piece",
      r: p.r,
      c: p.c,
      text: `Checker at ${coordsToText(p.r, p.c)}`,
    }));
  } else {
    const moves = getMovesForPiece(
      state.selectedPiece.r,
      state.selectedPiece.c,
    );
    state.scanItems = moves.map((m) => ({
      type: "move",
      r: m.r,
      c: m.c,
      moveData: m,
      text: `Move to ${coordsToText(m.r, m.c)}`,
    }));

    state.scanItems.push({
      type: "cancel",
      text: "Select different piece",
    });
  }
  if (scan) scan.setIndex(0);
}

function getChessPieceName(type) {
  const names = {
    k: "King",
    q: "Queen",
    r: "Rook",
    b: "Bishop",
    n: "Knight",
    p: "Pawn",
  };
  return names[type] || "Piece";
}

function getPiecesWithMoves(playerSign) {
  // Checkers Only Helper
  const pieces = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const val = state.board[r][c];
      if (val !== 0 && Math.sign(val) === Math.sign(playerSign)) {
        if (getMovesForPiece(r, c).length > 0) {
          pieces.push({ r, c });
        }
      }
    }
  }
  const allMoves = [];
  pieces.forEach((p) => {
    const moves = getMovesForPiece(p.r, p.c);
    if (moves.some((m) => m.isJump)) p.hasJump = true;
  });

  const hasAnyJump = pieces.some((p) => p.hasJump);
  if (hasAnyJump) {
    return pieces.filter((p) => p.hasJump);
  }
  return pieces;
}

function getMovesForPiece(r, c) {
  const moves = [];
  const piece = state.board[r][c];
  const isKing = Math.abs(piece) === 2;
  const playerDir = Math.sign(piece) === 1 ? -1 : 1; // P1 (val 1) moves UP (-r), P2 (val -1) moves DOWN (+r)

  const directions = [];
  // Regular moves
  if (isKing || Math.sign(piece) === 1) {
    // Up
    directions.push([-1, -1], [-1, 1]);
  }
  if (isKing || Math.sign(piece) === -1) {
    // Down
    directions.push([1, -1], [1, 1]);
  }

  // Check simple slides
  directions.forEach((d) => {
    const nr = r + d[0];
    const nc = c + d[1];
    if (isValidPos(nr, nc) && state.board[nr][nc] === 0) {
      moves.push({ r: nr, c: nc, isJump: false });
    }
  });

  // Check jumps
  directions.forEach((d) => {
    const nr = r + d[0];
    const nc = c + d[1];
    const nnr = r + d[0] * 2;
    const nnc = c + d[1] * 2;

    if (isValidPos(nr, nc) && isValidPos(nnr, nnc)) {
      const mid = state.board[nr][nc];
      // If mid piece is opponent
      if (mid !== 0 && Math.sign(mid) !== Math.sign(piece)) {
        if (state.board[nnr][nnc] === 0) {
          moves.push({
            r: nnr,
            c: nnc,
            isJump: true,
            captured: { r: nr, c: nc },
          });
        }
      }
    }
  });

  // Filter non-jumps if jumps exist for THIS piece (standard rule is per turn, but usually if a piece can jump it must... )
  // We handled global forced jumps in getPiecesWithMoves.
  // If this piece has jumps, it can ONLY jump.
  const hasJump = moves.some((m) => m.isJump);
  if (hasJump) return moves.filter((m) => m.isJump);

  return moves;
}

function isValidPos(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function handleCellClick(r, c) {
  if (state.mode !== "game") return;

  if (state.gameType === "chess") {
    handleChessClick(r, c);
    return;
  }

  // 1. Is it a piece we can select?
  if (state.board[r][c] !== 0 && Math.sign(state.board[r][c]) === state.turn) {
    // Check if it's in the valid pieces list (forced jumps)
    const validPieces = getPiecesWithMoves(state.turn);
    if (validPieces.some((p) => p.r === r && p.c === c)) {
      selectPiece(r, c);
      return;
    } else {
      // Feedback for unselectable pieces
      const moves = getMovesForPiece(r, c);
      if (moves.length === 0) {
        // Silent or "Blocked"
      } else {
        // Has moves but not valid -> Mandatory Jump
        speak("Jump Mandatory.");
        showTurnNotification("Jump Mandatory!", 1000);
      }
      return;
    }
  }

  // 2. Is it a valid move destination?
  if (state.selectedPiece) {
    const move = state.availableMoves.find((m) => m.r === r && m.c === c);
    if (move) {
      executeMove(move);
      return;
    }
  }
}

function handleChessClick(r, c) {
  // Chess selection logic
  const piece = chessGame.getPiece(r, c);
  const turnColor = state.turn === 1 ? "w" : "b";

  // Safety check: Don't allow clicking if it's computer turn (and we are single player)
  if (state.gameMode === "single" && state.turn === state.computerSide) return;

  // Special Helper: Allow Castling by clicking the Rook
  if (state.selectedPiece) {
    const selP = chessGame.getPiece(
      state.selectedPiece.r,
      state.selectedPiece.c,
    );
    if (
      selP &&
      selP.type === "k" &&
      piece &&
      piece.type === "r" &&
      piece.color === selP.color
    ) {
      // User clicked King then own Rook. Check for castling move.
      let targetC = -1;
      if (c === 7) targetC = 6; // Kingside
      if (c === 0) targetC = 2; // Queenside

      if (targetC !== -1) {
        const castleMove = state.availableMoves.find(
          (m) => m.r === r && m.c === targetC && m.moveData.isCastle,
        );
        if (castleMove) {
          executeMove(castleMove);
          return;
        }
      }
    }
  }

  // Logic: Select piece of own turn
  if (piece && piece.color === turnColor) {
    // Deselect or Select New
    selectPiece(r, c);
    return;
  }

  // Execute Move if target
  if (state.selectedPiece) {
    // Target empty or opponent
    const move = state.availableMoves.find((m) => m.r === r && m.c === c);
    if (move) {
      executeMove(move);
    }
  }
}

function selectPiece(r, c) {
  state.selectedPiece = { r, c };

  if (state.gameType === "chess") {
    // Chess Logic
    // Use getValidMoves instead of getMovesForPiece to ensure King safety
    const validMoves = chessGame.getValidMoves(r, c);

    // Map to UI format
    state.availableMoves = validMoves.map((m) => ({
      r: m.to.r,
      c: m.to.c,
      moveData: m,
    }));
  } else {
    // Checkers Logic
    state.availableMoves = getMovesForPiece(r, c);
  }

  updateGameScanItems(); // Now scanning moves
  renderBoard();

  // Announce
  speak(
    `Selected ${coordsToText(r, c)}. ${state.availableMoves.length} moves available.`,
  );
  playSound("select");
}

function executeMove(move) {
  if (state.gameType === "chess") {
    const moveData = move.moveData;
    const captured = moveData.captured;

    chessGame.makeMove(moveData);

    if (captured)
      playSound("scan"); // Capture sound
    else playSound("move");

    // Announcements
    if (state.gameType === "chess") {
      if (moveData.isCastle) {
        speak("Castle");
        showTurnNotification("Castling", 2000);
      }
      if (moveData.isEnPassant) {
        speak("En Passant");
      }
    }

    // Promotion Sound?
    if (moveData.promotion) {
      playSound("king");
      speak("Promoted!");
    }

    endTurn();
    return;
  }

  // --- Checkers Logic ---
  const { r, c } = state.selectedPiece;
  const pieceVal = state.board[r][c];

  // Move piece
  state.board[r][c] = 0;
  state.board[move.r][move.c] = pieceVal;

  // Capture
  if (move.isJump && move.captured) {
    state.board[move.captured.r][move.captured.c] = 0;
    playSound("scan"); // Capture sound
  }

  // King Promotion
  let promoted = false;
  // Check if not already a king (absolute value 1 means Man, 2 means King)
  if (Math.abs(pieceVal) === 1) {
    if (Math.sign(pieceVal) === 1 && move.r === 0) {
      state.board[move.r][move.c] = 2; // King P1
      promoted = true;
      playSound("king");
      speak("King Me!");
    } else if (Math.sign(pieceVal) === -1 && move.r === 7) {
      state.board[move.r][move.c] = -2; // King P2
      promoted = true;
      playSound("king");
      speak("King Me!");
    }
  }

  // Multi-jump logic?
  // If it was a jump, check if more jumps are available from new pos.
  let turnEnds = true;
  if (move.isJump && !promoted) {
    // Look for subsequent jumps from move.r, move.c
    const subsequentMoves = getMovesForPiece(move.r, move.c);

    if (subsequentMoves.some((m) => m.isJump)) {
      turnEnds = false;
      // Continue turn
      state.selectedPiece = { r: move.r, c: move.c };
      state.availableMoves = subsequentMoves; // filter to jumps (logic inside getMoves handles this if jumps exist)
      state.board[move.r][move.c] = pieceVal; // Ensure board is updated

      updateGameScanItems();
      renderBoard();

      // If Computer Turn, execute next jump immediately
      if (state.gameMode === "single" && state.turn === -1) {
        speak("Computer jumping again.");
        setTimeout(() => {
          // Pick a random jump if multiple
          const nextMove =
            subsequentMoves[Math.floor(Math.random() * subsequentMoves.length)];
          executeMove(nextMove);
        }, 500);
      } else {
        speak("Double Jump available.");
        playSound("move");
      }
    }
  }

  if (turnEnds) {
    endTurn();
  }
}

function endTurn() {
  // Determine Turn Flip
  if (state.gameType === "chess") {
    // Chess already flipped in makeMove internal state, but we need to update our global `state.turn`
    // ChessGame.turn is 'w' or 'b'
    state.turn = chessGame.turn === "w" ? 1 : -1;
  } else {
    state.turn = state.turn === 1 ? -1 : 1;
    playSound("move");
  }

  state.selectedPiece = null;
  state.availableMoves = [];
  state.scanItems = [];
  if (scan) scan.setIndex(-1);

  // Clear highlights
  document.querySelectorAll(".cell").forEach((c) => {
    c.classList.remove("highlight-outline", "highlight-full");
    c.style.boxShadow = "";
    c.style.backgroundColor = "";
  });

  // Check Win/Loss
  if (state.gameType === "chess") {
    // Check for Mate
    const legalMoves = chessGame.getAllMoves(chessGame.turn);
    if (legalMoves.length === 0) {
      if (chessGame.isInCheck(chessGame.turn)) {
        // Checkmate
        const winner =
          chessGame.turn === "b"
            ? "Player 1"
            : state.gameMode === "single"
              ? "Computer"
              : "Player 2";
        gameOver(`${winner} Wins by Checkmate!`);
        return;
      } else {
        gameOver("Stalemate! Draw.");
        return;
      }
    } else if (chessGame.isInCheck(chessGame.turn)) {
      speak("Check!");
      showTurnNotification("Check!", 1000);
    }
  } else {
    // Checkers Win/Loss
    const p1Pieces = countPieces(1);
    const p2Pieces = countPieces(-1);
    const p1Moves = getPiecesWithMoves(1).length;
    const p2Moves = getPiecesWithMoves(-1).length;

    if (p1Pieces === 0 || p1Moves === 0) {
      const winner = state.gameMode === "single" ? "Computer" : "Player 2";
      gameOver(`${winner} Wins!`);
      return;
    }
    if (p2Pieces === 0 || p2Moves === 0) {
      gameOver("Player 1 Wins!");
      return;
    }
  }

  renderBoard();

  // Delay for next turn setup
  setTimeout(() => {
    updateGameScanItems();
    if (scan) scan.setIndex(-1);

    let playerText = state.turn === 1 ? "Player 1" : "Player 2";
    if (state.gameType === "chess") {
      playerText = state.turn === 1 ? "White" : "Black";
    }

    if (state.gameMode === "single") {
      if (state.gameType === "chess") {
        if (state.turn === state.computerSide) playerText = "Computer";
      } else {
        if (state.turn === -1) playerText = "Computer";
      }
    }

    showTurnNotification(`${playerText}'s Turn`);

    // Check Computer Turn
    let isComputerTurn = false;
    if (state.gameMode === "single") {
      if (state.gameType === "chess" && state.turn === state.computerSide)
        isComputerTurn = true;
      else if (state.gameType === "checkers" && state.turn === -1)
        isComputerTurn = true;
    }

    if (isComputerTurn) {
      state.computerThinking = true;
      if (scan) scan.stop(); // No auto-scan during the computer's turn
      speak("Computer's Turn.");
      // Short delay for computer
      setTimeout(computerMove, 500);
    } else {
      state.computerThinking = false;
      speak(`${playerText}'s Turn.`);
      startScan();
    }
  }, 500);
}

function computerMove() {
  state.computerThinking = true;
  if (scan) scan.stop();

  if (state.gameType === "chess") {
    const aiColor = state.computerSide === 1 ? "w" : "b";
    // Chess AI
    const bestMove = chessGame.getBestMove(aiColor, 3); // Depth 3
    if (bestMove) {
      const uiMove = { r: bestMove.to.r, c: bestMove.to.c, moveData: bestMove };
      // Emulate UI move structure for executeMove
      executeMove(uiMove);
    } else {
      // Should indicate game over in endTurn
    }
    return;
  }

  // Checkers AI
  const pieces = getPiecesWithMoves(-1);
  if (pieces.length === 0) return;

  const piece = pieces[Math.floor(Math.random() * pieces.length)];
  const moves = getMovesForPiece(piece.r, piece.c);
  const move = moves[Math.floor(Math.random() * moves.length)];

  state.selectedPiece = piece;
  state.availableMoves = moves;
  executeMove(move);
}

function countPieces(sign) {
  let count = 0;
  state.board.forEach((row) =>
    row.forEach((val) => {
      if (val !== 0 && Math.sign(val) === Math.sign(sign)) count++;
    }),
  );
  return count;
}

function gameOver(msg) {
  state.mode = "gameover";
  state.computerThinking = false;
  if (scan) scan.stop();
  speak("Game Over. " + msg);
  showTurnNotification(msg, 5000); // Show for longer

  // Instead of opening pause menu, wait and go to main menu
  setTimeout(() => {
    speak("Returning to Main Menu");
    showMainMenu();
  }, 4000);
}

function coordsToText(r, c) {
  // Standard notation: A-H for cols, 1-8 for rows (usually bottom up? Or top down?)
  // Game usually 8...1.
  // Let's use simple Col Row.
  const cols = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const row = 8 - r;
  return `${cols[c]} ${row}`;
}

// --- Announcements ---

function announceCurrentMenuItem() {
  const items = getScanItemsForMode();
  const item = items[currentIndex()];
  if (item) {
    let t = typeof item.text === "function" ? item.text() : item.text;
    // Strip HTML tag for clean TTS (removes swatch span etc)
    t = t.replace(/<[^>]*>?/gm, "");
    speak(t);
  }
}

function announceCurrentGameItem() {
  const idx = scan ? scan.getIndex() : -1;
  if (idx < 0 || idx >= state.scanItems.length) return;
  const item = state.scanItems[idx];
  if (item && item.text) {
    speak(item.text);
  }
}

// --- Highlighting UI ---

// Resolve the active highlight color through the shared themes contract
// (getThemeHighlight): "Theme Default" resolves to the active theme's highlight,
// any other entry is the CSS color name applied directly.
function getHighlightColor() {
  if (typeof window !== "undefined" && window.Themes) {
    return window.Themes.getThemeHighlight(
      themes[settings.themeIndex],
      settings.highlightColorIndex,
    );
  }
  return highlightColors[settings.highlightColorIndex] || "#ffcc00";
}

function updateHighlights() {
  // Menu
  if (state.mode === "menu" || state.mode === "pause") {
    document.querySelectorAll(".menu-button").forEach((b) => {
      b.classList.remove("highlight");
      b.style.borderColor = "transparent";
      // Reset potentially changed styles from "Full Highlight"
      b.style.backgroundColor = "rgba(255, 255, 255, 0.9)";
      b.style.color = "#333";
    });

    let container = state.mode === "menu" ? "menu-container" : "pause-overlay";
    let idx = currentIndex();

    const btn = document.getElementById(`btn-${container}-${idx}`);
    // Note: For settings menu inside pause, ID might be tricky.
    // Let's rely on child index for robustness in simple menus.
    if (!btn) {
      // Fallback
      const c = document.getElementById(
        container === "pause-overlay" ? "pause-overlay" : "menu-container",
      );
      // Skip title
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
  // Color logic
  const uiColor = getHighlightColor();

  // Apply Highlight Style (Outline or Full)
  if (settings.highlightStyle === "full") {
    btn.style.backgroundColor = uiColor;
    // Adjust text color for contrast if needed? Assuming black text on bright colors for now.
    btn.style.color = "#000";
    btn.style.borderColor = "transparent";
  } else {
    // Outline Style
    btn.style.backgroundColor = "rgba(255, 255, 255, 0.9)"; // Reset to default
    btn.style.color = "#333"; // Reset
    btn.style.borderColor = uiColor;
    // Ensure border width is visible, class handles solid style but inline color is needed
    btn.style.borderWidth = "6px";
  }
}

function updateGameHighlights() {
  // Clear old highlights on board
  document.querySelectorAll(".cell").forEach((c) => {
    c.classList.remove("highlight-outline", "highlight-full");
    c.style.boxShadow = ""; // Clear inline box shadow
    c.style.backgroundColor = ""; // Clear inline background color from full highlight
  });

  if (state.scanItems.length === 0) return;
  // Use the raw index: at turn start (unseated, -1) nothing is highlighted.
  const idx = scan ? scan.getIndex() : -1;
  if (idx < 0 || idx >= state.scanItems.length) return;
  const item = state.scanItems[idx];

  let targetR, targetC;

  if (item.type === "cancel") {
    // Highlight the selectedPiece to indicate "Cancel / Back to Piece"
    if (state.selectedPiece) {
      targetR = state.selectedPiece.r;
      targetC = state.selectedPiece.c;
    } else {
      return;
    }
  } else if (item.r !== undefined && item.c !== undefined) {
    targetR = item.r;
    targetC = item.c;
  }

  if (targetR !== undefined && targetC !== undefined) {
    const cell = document.getElementById(`cell-${targetR}-${targetC}`);
    if (cell) {
      cell.classList.add(
        settings.highlightStyle === "full"
          ? "highlight-full"
          : "highlight-outline",
      );
      let color = getHighlightColor();

      cell.style.setProperty("--highlight-color", color);

      if (settings.highlightStyle === "full") {
        cell.style.backgroundColor = color;
      } else {
        // Increased thickness from 5px to 8px for better visibility
        cell.style.boxShadow = `inset 0 0 0 10px ${color}`;
      }
    }
  }
}

// --- TTS ---

function speak(text) {
  if (!settings.tts) return;
  if (window.NarbeVoiceManager) {
    window.NarbeVoiceManager.speak(text);
  }
}

function applyTheme() {
  const theme = themes[settings.themeIndex];
  if (theme) {
    // Safety check
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

  // Clear existing timeout if any to prevent hiding early
  if (state.timers.status) clearTimeout(state.timers.status);

  state.timers.status = setTimeout(() => {
    el.classList.remove("visible");
  }, duration);
}

// Toggle between Checkers and Chess
function toggleGameType() {
  state.gameType = state.gameType === "checkers" ? "chess" : "checkers";
  saveSettings(); // Maybe separate save for game type? stick to session for now or settings?
  // Let's not persist game type in settings to avoid confusion, or do. Defaults to checkers.
  refreshCurrentMenu();
  speak(`Game changed to ${state.gameType}`);
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
    startGame,
    restartGame,
    showMainMenu,
    showMenu,
    openPauseMenu,
    showPauseSettings,
    resumeGame,
    updateGameScanItems,
    selectPiece,
    handleCellClick,
    executeMove,
    getScan: () => scan,
    pauseActions,
    getPauseOverlay: () => pauseOverlay,
  };
}
