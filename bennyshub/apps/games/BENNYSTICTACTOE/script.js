// --- Configuration & Constants ---
const config = {
  longPress: 3000,
  repeatInterval: 2000,
  enterLongPress: 6000,
};

// Background themes come from the shared Themes module (loaded via
// <script src="../../../shared/themes.js">). The local array that used to live
// here was byte-identical to Themes.THEMES (the background gradients are pinned
// by shared/__tests__/themes.test.js), so this is a behavior-preserving swap.
const themes = window.Themes.THEMES;

const basicColors = [
  "Red",
  "Orange",
  "Yellow",
  "Lime",
  "Green",
  "Teal",
  "Cyan",
  "Blue",
  "Purple",
  "Magenta",
  "Pink",
  "White",
  "Gray",
  "Black",
];

// Highlight palette from the shared Themes module. TicTacToe's local 13-entry
// list was identical to Themes.HIGHLIGHT_COLORS (pinned verbatim by the shared
// themes snapshot test), so the resolved colors are unchanged.
const highlightColors = window.Themes.HIGHLIGHT_COLORS;

// Note: Scan speeds are now managed by NarbeScanManager.
// The scan loop (forward/backward stepping, hold-to-reverse, hold-to-pause,
// auto-scan cadence and NumpadEnter handling) is driven by the shared
// ScanController (shared/scan-core.js). This file only supplies the per-mode
// target sets and per-mode action dispatch.

const gameStats = {
  single: { wins: 0, losses: 0, ties: 0 },
  two: { p1Wins: 0, p2Wins: 0, ties: 0 },
};

// --- State Management ---
const state = {
  mode: "menu", // menu, game, pause, gameover
  menuState: "main",
  gameMode: "single",
  pauseMenuState: "main", // main, settings

  // Game State
  turn: "X",
  board: Array(9).fill(""),
  computerThinking: false,
};

// The shared scan controller is the single source of truth for the scan index.
// `state.mode` selects which target set it steps through (see getScanTargets).
let scan = null;

// Remembers the board cell the player was scanning when the game was paused, so
// resuming returns the highlight to that cell (matches the pre-migration behavior).
let pausedGameCell = 0;

// Shared <benny-pause-overlay> instance for the MAIN pause menu. Stays null when
// window.BennyPauseOverlay is unavailable (the game then falls back to the bespoke
// #pause-overlay markup). Built lazily the first time the menu is shown.
let pauseOverlay = null;

// True while the shared overlay is driving the MAIN pause menu (vs the bespoke
// fallback markup or the pause-settings submenu, which still use #pause-overlay).
function sharedPauseActive() {
  return !!(
    pauseOverlay &&
    pauseOverlay.isOpen() &&
    state.pauseMenuState === "main"
  );
}

const settings = {
  themeIndex: 0,
  tts: true,
  locationTTS: false,
  sound: true,
  voiceIndex: 0,
  p1Color: "Red",
  p2Color: "Blue",

  // New Settings
  scanSpeedIndex: 0, // 0 = Off
  highlightColorIndex: 0, // 0 = Theme Default (Yellow generally)
  highlightStyle: "outline", // 'outline' or 'full'
};

// --- Initialization ---

function init() {
  loadSettings();
  setupScan();
  applyTheme();
  createDOMStructure();

  // Scan Manager Integration.
  // ScanController owns restarting the auto-scan timer when cadence / autoScan
  // change (it subscribes to NarbeScanManager itself). Here we only refresh the
  // settings menus so the on-screen Scan Speed / Auto Scan labels stay current.
  if (window.NarbeScanManager) {
    window.NarbeScanManager.subscribe(() => {
      if (state.mode === "menu" && state.menuState === "settings")
        refreshMenu();
      if (state.mode === "pause" && state.pauseMenuState === "settings")
        refreshPauseMenu();
    });
  }

  showMainMenu();
}

// Settings are persisted through the shared SettingsStore. The cross-app keys
// (scan speed + highlight) live in the global store; the rest are TicTacToe's
// per-app keys. SettingsStore runs the `tictactoe_settings` migration on first
// read, converting the legacy localStorage blob into these canonical stores.
const APP_ID = "tictactoe";
const GLOBAL_SETTING_KEYS = [
  "scanSpeedIndex",
  "highlightColorIndex",
  "highlightStyle",
];

function storeForSetting(key) {
  return GLOBAL_SETTING_KEYS.indexOf(key) !== -1
    ? window.SettingsStore.global
    : window.SettingsStore.app(APP_ID);
}

function loadSettings() {
  try {
    // Idempotent — converts the legacy `tictactoe_settings` blob on first run.
    window.SettingsStore.runMigrations();
    Object.keys(settings).forEach((key) => {
      const stored = storeForSetting(key).get(key);
      if (stored !== undefined) settings[key] = stored;
    });
    // Game stats are not part of the typed settings schema; keep them local.
    const savedStats = localStorage.getItem("tictactoe_stats");
    if (savedStats) {
      Object.assign(gameStats, JSON.parse(savedStats));
    }
  } catch (e) {
    console.error("Failed to load settings", e);
  }
}

function saveSettings() {
  Object.keys(settings).forEach((key) => {
    storeForSetting(key).set(key, settings[key]);
  });
  localStorage.setItem("tictactoe_stats", JSON.stringify(gameStats));
}

function createDOMStructure() {
  const mainContent = document.getElementById("main-content");

  // Menu Container
  const menuContainer = document.createElement("div");
  menuContainer.id = "menu-container";
  menuContainer.className = "menu-container";
  mainContent.appendChild(menuContainer);

  // Game Container
  const gameContainer = document.createElement("div");
  gameContainer.id = "game-container-inner";
  gameContainer.className = "game-container";
  gameContainer.style.display = "none";
  gameContainer.innerHTML = `
        <div class="game-board" id="game-board">
            ${Array(9)
              .fill(0)
              .map((_, i) => `<div class="cell" id="cell-${i}"></div>`)
              .join("")}
        </div>
    `;
  mainContent.appendChild(gameContainer);

  // Initial Mouse Bindings for the Board cells (Click Only, Hover logic separate)
  for (let i = 0; i < 9; i++) {
    const cell = document.getElementById(`cell-${i}`);
    cell.onclick = () => {
      if (state.mode === "game" && !state.computerThinking) {
        playerMove(i);
      }
    };
    // Removed onmouseenter to prevent auto-highlight/scan override
  }

  // Pause Overlay
  const pauseOverlay = document.createElement("div");
  pauseOverlay.id = "pause-overlay";
  pauseOverlay.className = "pause-overlay";
  pauseOverlay.style.display = "none";
  document.body.appendChild(pauseOverlay);

  // Pause Button (Bottom Left)
  const pauseBtn = document.createElement("div");
  pauseBtn.id = "pause-button";
  pauseBtn.innerHTML = "&#10074;&#10074;"; // Pause symbol
  pauseBtn.onclick = () => {
    if (state.mode === "game") showPauseMenu();
  };
  pauseBtn.style.display = "none"; // Only show in game
  document.body.appendChild(pauseBtn);

  // Header
  const header = document.getElementById("header");
  if (!header.querySelector("#status-display")) {
    const status = document.createElement("div");
    status.id = "status-display";
    header.appendChild(status);
  }
}

function applyTheme() {
  document.body.style.background = themes[settings.themeIndex].bg;
  updateHighlights();
}

// --- Scan wiring (shared ScanController) ---

function setupScan() {
  if (!window.ScanController) {
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
    spaceHoldMs: config.longPress, // hold Space >= 3s -> reverse
    reverseCadenceMs: config.repeatInterval, // reverse repeats every 2s
    enterHoldMs: config.enterLongPress, // default (game) hold-Enter = 6s; re-tuned per mode
    scanManager: window.NarbeScanManager,
    voice: window.NarbeVoiceManager,
  });
  scan.attach(document);

  // Preserve the pre-migration "reset auto-scan on every switch interaction"
  // timing. The scan loop itself lives entirely in ScanController; this listener
  // only re-phases the auto-scan timer so a manual press is never immediately
  // followed by an auto-advance. It does no scanning of its own.
  const bump = (e) => {
    if (e.repeat) return;
    if (e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter") {
      bumpAutoScan();
    }
  };
  document.addEventListener("keydown", bump, true);
  document.addEventListener("keyup", bump, true);
}

// Return the ELEMENTS the scanner should step through for the current mode.
// Game mode returns only the EMPTY cells, which gives occupied-cell skipping
// (forward and backward) and "stay put when the board is full" for free.
function getScanTargets() {
  if (state.mode === "menu") {
    const items = menus[state.menuState] || [];
    return items
      .map((_, i) => document.getElementById(`btn-menu-container-${i}`))
      .filter(Boolean);
  } else if (state.mode === "game") {
    const cells = [];
    for (let i = 0; i < 9; i++) {
      if (state.board[i] === "") {
        const el = document.getElementById(`cell-${i}`);
        if (el) cells.push(el);
      }
    }
    return cells;
  } else if (state.mode === "pause") {
    // Main pause menu: when the shared overlay owns it, scan its action buttons.
    if (sharedPauseActive()) return pauseOverlay.getTargets();
    const items =
      state.pauseMenuState === "settings" ? menus.pauseSettings : menus.pause;
    return items
      .map((_, i) => document.getElementById(`btn-pause-overlay-${i}`))
      .filter(Boolean);
  } else if (state.mode === "gameover") {
    return menus.gameover
      .map((_, i) => document.getElementById(`btn-pause-overlay-${i}`))
      .filter(Boolean);
  }
  return [];
}

function onScanFocus() {
  // The controller has already advanced its index; reflect it in the visuals.
  updateHighlights();
}

function onScanAnnounce(target, index) {
  if (state.mode === "menu") {
    const item = (menus[state.menuState] || [])[index];
    if (item) speak(menuItemText(item));
  } else if (state.mode === "game") {
    const cellIndex = cellIndexOf(target);
    if (cellIndex >= 0) announceCell(cellIndex);
  } else if (state.mode === "pause") {
    const items =
      state.pauseMenuState === "settings" ? menus.pauseSettings : menus.pause;
    const item = items[index];
    if (item) speak(menuItemText(item));
  } else if (state.mode === "gameover") {
    const item = menus.gameover[index];
    if (item) speak(item.text);
  }
}

function onScanSelect(target, index) {
  if (state.mode === "menu") {
    const item = (menus[state.menuState] || [])[index];
    if (item && item.action) item.action();
  } else if (state.mode === "game") {
    const cellIndex = cellIndexOf(target);
    if (cellIndex >= 0) playerMove(cellIndex);
  } else if (state.mode === "pause") {
    // Main pause menu via the shared overlay: let it run the selected action
    // (which is wired to the same menus.pause handler).
    if (sharedPauseActive()) {
      const t = target || pauseOverlay.getTargets()[index];
      if (t) pauseOverlay.activate(t);
      return;
    }
    const items =
      state.pauseMenuState === "settings" ? menus.pauseSettings : menus.pause;
    const item = items[index];
    if (item && item.action) item.action();
  } else if (state.mode === "gameover") {
    const item = menus.gameover[index];
    if (item && item.action) item.action();
  }
}

// Hold-Enter behavior differs per mode:
//   - game: open the pause menu (enterHoldMs = 6s).
//   - menu / pause: step the focused setting backward (enterHoldMs = 3s).
//   - gameover: no hold action (the 3s timer only suppresses an accidental select).
function onScanPause() {
  if (state.mode === "game") {
    showPauseMenu();
  } else if (state.mode === "menu") {
    const item = (menus[state.menuState] || [])[currentIndex()];
    if (item && item.onPrev) item.onPrev();
  } else if (state.mode === "pause") {
    const items =
      state.pauseMenuState === "settings" ? menus.pauseSettings : menus.pause;
    const item = items[currentIndex()];
    if (item && item.onPrev) item.onPrev();
  }
}

// Configure the controller for the active mode and re-seat its index to 0.
function seatScanForMode() {
  if (!scan) return;
  scan.enterHoldMs =
    state.mode === "game" ? config.enterLongPress : config.longPress;
  scan.setIndex(0);
}

// Re-seat the game scanner onto the first empty cell after the board changes.
function reseatGameScan() {
  if (!scan) return;
  scan.setIndex(0);
  updateHighlights();
}

function currentIndex() {
  const idx = scan ? scan.getIndex() : 0;
  return idx < 0 ? 0 : idx;
}

function cellIndexOf(el) {
  if (!el || !el.id) return -1;
  const m = /^cell-(\d+)$/.exec(el.id);
  return m ? parseInt(m[1], 10) : -1;
}

function menuItemText(item) {
  const datext = typeof item.text === "function" ? item.text() : item.text;
  return datext.replace(/<[^>]*>/g, "");
}

// --- Menu System ---

function getColorSwatch(color) {
  if (color.startsWith("Theme")) return "";
  return `<span style="display:inline-block; width:24px; height:24px; background-color:${color}; border:2px solid #fff; margin-left:10px; vertical-align:middle; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></span>`;
}

// Leave the app / return to the hub via the shared Nav module, which sends the
// hub's `{ action: 'closeApp' }` iframe contract (the hub also accepts the older
// `focusBackButton` alias this app used to post). Falls back to the original
// standalone path if Nav is unavailable.
function exitToHub() {
  speak("Exiting to Hub");
  setTimeout(() => {
    if (window.Nav && typeof window.Nav.goBack === "function") {
      window.Nav.goBack();
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage({ action: "focusBackButton" }, "*");
    } else {
      window.location.href = "../../../index.html";
    }
  }, 500);
}

const menus = {
  main: [
    { text: "Single Player", action: () => startGame("single") },
    { text: "Two Player", action: () => startGame("two") },
    { text: "Settings", action: () => showSettingsMenu() },
    {
      text: "Exit",
      action: () => exitToHub(),
    },
  ],
  settings: [
    {
      text: () => `Change Theme: ${themes[settings.themeIndex].name}`,
      action: () => cycleTheme(1),
      onPrev: () => cycleTheme(-1),
    },
    {
      text: () => `TTS: ${settings.tts ? "On" : "Off"}`,
      action: () => toggleTTS(),
      onPrev: () => toggleTTS(),
    },
    {
      text: () => `Location TTS: ${settings.locationTTS ? "On" : "Off"}`,
      action: () => toggleLocationTTS(),
      onPrev: () => toggleLocationTTS(),
    },
    {
      text: () => {
        if (window.NarbeScanManager)
          return `Auto Scan: ${window.NarbeScanManager.getSettings().autoScan ? "On" : "Off"}`;
        return "Auto Scan: Off";
      },
      action: () => toggleAutoScan(),
      onPrev: () => toggleAutoScan(),
    },
    {
      text: () => {
        if (window.NarbeScanManager)
          return `Scan Speed: ${window.NarbeScanManager.getScanInterval() / 1000}s`;
        return "Scan Speed: 2s";
      },
      action: () => cycleScanSpeed(1),
      onPrev: () => cycleScanSpeed(-1),
    },
    {
      text: () =>
        `Highlight Style: ${settings.highlightStyle === "outline" ? "Outline" : "Full Cell"}`,
      action: () => toggleHighlightStyle(),
      onPrev: () => toggleHighlightStyle(),
    },
    {
      text: () =>
        `Highlight Color: ${highlightColors[settings.highlightColorIndex]}${getColorSwatch(highlightColors[settings.highlightColorIndex])}`,
      action: () => cycleHighlightColor(1),
      onPrev: () => cycleHighlightColor(-1),
    },
    {
      text: () =>
        `P1 Color (X): ${settings.p1Color}${getColorSwatch(settings.p1Color)}`,
      action: () => cycleP1Color(1),
      onPrev: () => cycleP1Color(-1),
    },
    {
      text: () =>
        `P2 Color (O): ${settings.p2Color}${getColorSwatch(settings.p2Color)}`,
      action: () => cycleP2Color(1),
      onPrev: () => cycleP2Color(-1),
    },
    { text: "Back", action: () => showMainMenu() },
  ],
  pause: [
    { text: "Continue Game", action: () => resumeGame() },
    { text: "Settings", action: () => showPauseSettings() },
    { text: "Return to Menu", action: () => showMainMenu() },
    {
      text: "Exit",
      action: () => exitToHub(),
    },
  ],
  pauseSettings: [
    {
      text: () => `Change Theme: ${themes[settings.themeIndex].name}`,
      action: () => cycleTheme(1, true),
      onPrev: () => cycleTheme(-1, true),
    },
    {
      text: () => `TTS: ${settings.tts ? "On" : "Off"}`,
      action: () => toggleTTS(true),
      onPrev: () => toggleTTS(true),
    },
    {
      text: () => `Location TTS: ${settings.locationTTS ? "On" : "Off"}`,
      action: () => toggleLocationTTS(true),
      onPrev: () => toggleLocationTTS(true),
    },
    {
      text: () => {
        if (window.NarbeScanManager)
          return `Auto Scan: ${window.NarbeScanManager.getSettings().autoScan ? "On" : "Off"}`;
        return "Auto Scan: Off";
      },
      action: () => toggleAutoScan(true),
      onPrev: () => toggleAutoScan(true),
    },
    {
      text: () => {
        if (window.NarbeScanManager)
          return `Scan Speed: ${window.NarbeScanManager.getScanInterval() / 1000}s`;
        return "Scan Speed: 2s";
      },
      action: () => cycleScanSpeed(1, true),
      onPrev: () => cycleScanSpeed(-1, true),
    },
    {
      text: () =>
        `Highlight Style: ${settings.highlightStyle === "outline" ? "Outline" : "Full Cell"}`,
      action: () => toggleHighlightStyle(true),
      onPrev: () => toggleHighlightStyle(true),
    },
    {
      text: () =>
        `Highlight Color: ${highlightColors[settings.highlightColorIndex]}${getColorSwatch(highlightColors[settings.highlightColorIndex])}`,
      action: () => cycleHighlightColor(1, true),
      onPrev: () => cycleHighlightColor(-1, true),
    },
    {
      text: () =>
        `P1 Color (X): ${settings.p1Color}${getColorSwatch(settings.p1Color)}`,
      action: () => cycleP1Color(1, true),
      onPrev: () => cycleP1Color(-1, true),
    },
    {
      text: () =>
        `P2 Color (O): ${settings.p2Color}${getColorSwatch(settings.p2Color)}`,
      action: () => cycleP2Color(1, true),
      onPrev: () => cycleP2Color(-1, true),
    },
    { text: "Back", action: () => showPauseMenu() },
  ],
  gameover: [
    { text: "Yes", action: () => restartGame() },
    { text: "No", action: () => showMainMenu() },
  ],
};

function renderMenu(containerId, items, titleText) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";

  if (titleText) {
    const title = document.createElement("div");
    title.className = state.mode === "menu" ? "menu-title" : "pause-title";
    title.innerHTML = titleText; // Changed to innerHTML for line breaks
    container.appendChild(title);
  }

  let buttonContainer = container;
  // Use grid for settings
  const isSettings =
    (state.mode === "pause" && state.pauseMenuState === "settings") ||
    (state.mode === "menu" && state.menuState === "settings");

  if (isSettings) {
    buttonContainer = document.createElement("div");
    buttonContainer.className = "menu-grid";
    container.appendChild(buttonContainer);
  }

  items.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.className = "menu-button";
    btn.id = `btn-${containerId}-${index}`; // Unique ID per container
    btn.innerHTML = typeof item.text === "function" ? item.text() : item.text;

    // Remove hover logic as requested
    btn.onclick = () => {
      // Sync the scan index to the clicked button so settings refreshes act on it.
      if (scan) {
        scan.setIndex(index);
        updateHighlights();
      }
      if (item.action) item.action();
    };

    if (isSettings && index === items.length - 1) {
      btn.classList.add("span-two-cols");
    }

    buttonContainer.appendChild(btn);
  });

  updateHighlights();
}

function showMainMenu() {
  state.mode = "menu";
  state.menuState = "main";

  document.getElementById("menu-container").style.display = "flex";
  document.getElementById("game-container-inner").style.display = "none";
  if (pauseOverlay && pauseOverlay.isOpen()) pauseOverlay.hide();
  document.getElementById("pause-overlay").style.display = "none";

  const pBtn = document.getElementById("pause-button");
  if (pBtn) pBtn.style.display = "none";

  document.getElementById("status-display").innerText = ""; // Clear status

  seatScanForMode();
  renderMenu("menu-container", menus.main, "BENNY'S<br>TIC TAC TOE");
  speak("Benny's Tic Tac Toe. Single Player");
  if (scan) scan.start();
}

function showSettingsMenu() {
  state.menuState = "settings";
  seatScanForMode();
  renderMenu("menu-container", menus.settings, "SETTINGS");
  announceCurrentMenuItem();
  if (scan) scan.start();
}

// Build the shared overlay's action list from menus.pause so the labels and
// handlers stay verbatim (Continue Game / Settings / Return to Menu / Exit).
function pauseOverlayActions() {
  return menus.pause.map((item, i) => ({
    id: String(i),
    label: typeof item.text === "function" ? item.text() : item.text,
    onSelect: () => {
      if (item.action) item.action();
    },
  }));
}

// Show the MAIN pause menu through the shared <benny-pause-overlay>. The game's
// ScanController still drives stepping/selection (getScanTargets routes at the
// overlay's buttons while it is open); the overlay only supplies the targets and
// runs activate(). Falls back to the bespoke markup via showPauseMenu's guard.
function showSharedPauseOverlay() {
  // Keep the bespoke overlay element hidden so only one pause UI is on screen.
  const legacy = document.getElementById("pause-overlay");
  if (legacy) {
    legacy.style.display = "none";
    legacy.innerHTML = "";
  }

  if (!pauseOverlay) {
    pauseOverlay = window.BennyPauseOverlay.create({
      actions: pauseOverlayActions(),
      scanManager: window.NarbeScanManager,
      voice: window.NarbeVoiceManager,
    });
  } else {
    pauseOverlay.setActions(pauseOverlayActions());
  }

  pauseOverlay.show();
  seatScanForMode();
  updateHighlights();
  speak("Paused. Continue Game");
  if (scan) scan.start();
}

function showPauseMenu() {
  // Remember where the player was scanning so resume can return there.
  if (state.mode === "game" && scan) {
    const cell = cellIndexOf(scan.getCurrentTarget());
    if (cell >= 0) pausedGameCell = cell;
  }

  state.mode = "pause";
  state.pauseMenuState = "main"; // default pause menu

  // Prefer the shared overlay; fall back to the bespoke markup when it is absent.
  if (window.BennyPauseOverlay) {
    showSharedPauseOverlay();
    return;
  }

  const overlay = document.getElementById("pause-overlay");
  overlay.style.display = "flex";
  overlay.innerHTML = ""; // Clear previous

  seatScanForMode();
  renderMenu("pause-overlay", menus.pause, "PAUSED");
  updateHighlights();
  speak("Paused. Continue Game");
  if (scan) scan.start();
}

function showPauseSettings() {
  state.pauseMenuState = "settings";
  // The settings submenu is not covered by the shared overlay contract; render it
  // into the bespoke #pause-overlay and hand the screen back from the shared one.
  if (pauseOverlay && pauseOverlay.isOpen()) pauseOverlay.hide();
  const overlay = document.getElementById("pause-overlay");
  if (overlay) overlay.style.display = "flex";
  seatScanForMode();
  renderMenu("pause-overlay", menus.pauseSettings, "SETTINGS");
  announceCurrentPauseItem();
  if (scan) scan.start();
}

function showGameOver(result) {
  state.mode = "gameover";

  // Update Stats
  if (state.gameMode === "single") {
    if (result === "X") gameStats.single.wins++;
    else if (result === "O") gameStats.single.losses++;
    else gameStats.single.ties++;
  } else {
    if (result === "X") gameStats.two.p1Wins++;
    else if (result === "O") gameStats.two.p2Wins++;
    else gameStats.two.ties++;
  }
  saveSettings();

  const overlay = document.getElementById("pause-overlay");
  overlay.style.display = "flex";
  overlay.innerHTML = "";

  let message = result === "Tie" ? "It's a tie!" : `Player ${result} wins!`;

  seatScanForMode();
  renderMenu("pause-overlay", menus.gameover, message);

  const title = overlay.querySelector(".pause-title");

  // Stats Display
  const statsDiv = document.createElement("div");
  statsDiv.className = "status-message";
  statsDiv.style.fontSize = "24px";
  if (state.gameMode === "single") {
    statsDiv.innerText = `Wins: ${gameStats.single.wins} | Losses: ${gameStats.single.losses} | Ties: ${gameStats.single.ties}`;
  } else {
    statsDiv.innerText = `P1 Wins: ${gameStats.two.p1Wins} | P2 Wins: ${gameStats.two.p2Wins} | Ties: ${gameStats.two.ties}`;
  }
  title.insertAdjacentElement("afterend", statsDiv);

  const sub = document.createElement("div");
  sub.className = "status-message";
  sub.innerText = "Play again?";
  statsDiv.insertAdjacentElement("afterend", sub);

  updateHighlights();
  speak(message + ". Play again? Yes");
  if (scan) scan.start();
}

// --- Settings Logic ---

function cycleTheme(dir, isPause = false) {
  settings.themeIndex =
    (settings.themeIndex + dir + themes.length) % themes.length;
  applyTheme();
  saveSettings();
  isPause ? refreshPauseMenu() : refreshMenu();
}

function toggleTTS(isPause = false) {
  settings.tts = !settings.tts;
  saveSettings();
  isPause ? refreshPauseMenu() : refreshMenu();
}

function toggleLocationTTS(isPause = false) {
  settings.locationTTS = !settings.locationTTS;
  saveSettings();
  isPause ? refreshPauseMenu() : refreshMenu();
}

function cycleScanSpeed(dir, isPause = false) {
  if (window.NarbeScanManager) {
    window.NarbeScanManager.cycleScanSpeed();
    // UI refresh happens via observer callback or we force it here
    isPause ? refreshPauseMenu() : refreshMenu();
    if (scan) scan.start(); // Restart with new speed
  }
}

function toggleHighlightStyle(isPause = false) {
  settings.highlightStyle =
    settings.highlightStyle === "outline" ? "full" : "outline";
  saveSettings();
  updateHighlights();
  isPause ? refreshPauseMenu() : refreshMenu();
}

function cycleHighlightColor(dir, isPause = false) {
  settings.highlightColorIndex =
    (settings.highlightColorIndex + dir + highlightColors.length) %
    highlightColors.length;
  saveSettings();
  updateHighlights();
  isPause ? refreshPauseMenu() : refreshMenu();
}

function cycleP1Color(dir, isPause = false) {
  let newIdx = basicColors.indexOf(settings.p1Color);
  do {
    newIdx = (newIdx + dir + basicColors.length) % basicColors.length;
  } while (basicColors[newIdx] === settings.p2Color);
  settings.p1Color = basicColors[newIdx];
  saveSettings();
  isPause ? refreshPauseMenu() : refreshMenu();
  if (state.mode === "game" || state.mode === "pause") updateBoardUI();
}

function cycleP2Color(dir, isPause = false) {
  let newIdx = basicColors.indexOf(settings.p2Color);
  do {
    newIdx = (newIdx + dir + basicColors.length) % basicColors.length;
  } while (basicColors[newIdx] === settings.p1Color);
  settings.p2Color = basicColors[newIdx];
  saveSettings();
  isPause ? refreshPauseMenu() : refreshMenu();
  if (state.mode === "game" || state.mode === "pause") updateBoardUI();
}

function refreshMenu() {
  const items = menus[state.menuState];
  const idx = currentIndex();
  const btn = document.getElementById(`btn-menu-container-${idx}`);
  if (btn && items[idx])
    btn.innerHTML =
      typeof items[idx].text === "function"
        ? items[idx].text()
        : items[idx].text;
  announceCurrentMenuItem();
}

function refreshPauseMenu() {
  const items =
    state.pauseMenuState === "settings" ? menus.pauseSettings : menus.pause;
  const idx = currentIndex();
  const btn = document.getElementById(`btn-pause-overlay-${idx}`);
  if (btn && items[idx])
    btn.innerHTML =
      typeof items[idx].text === "function"
        ? items[idx].text()
        : items[idx].text;
  announceCurrentPauseItem();
}

function announceCurrentMenuItem() {
  const items = menus[state.menuState];
  const item = items[currentIndex()];
  if (item) {
    speak(menuItemText(item));
  }
}

function announceCurrentPauseItem() {
  const items =
    state.pauseMenuState === "settings" ? menus.pauseSettings : menus.pause;
  const item = items[currentIndex()];
  if (item) {
    speak(menuItemText(item));
  }
}

// --- Auto Scan Logic ---

// Re-phase the ScanController auto-scan timer (so a manual press is not
// immediately followed by an auto-advance). Suppressed while the computer is
// thinking so the board does not auto-scan during its turn.
function bumpAutoScan() {
  if (scan && !state.computerThinking) scan.start();
}

function beginComputerThinking() {
  state.computerThinking = true;
  if (scan) scan.stop(); // pause auto-scan during the computer's turn
}

function endComputerThinking() {
  state.computerThinking = false;
  if (scan) scan.start(); // resume auto-scan
}

// --- Game Logic ---

function startGame(mode) {
  state.mode = "game";
  state.gameMode = mode;
  state.board.fill("");
  state.computerThinking = false;

  const pBtn = document.getElementById("pause-button");
  if (pBtn) pBtn.style.display = "flex";

  // Determine Turn
  if (mode === "single") {
    state.turn = Math.random() < 0.5 ? "X" : "O";
  } else {
    state.turn = "X";
  }

  document.getElementById("menu-container").style.display = "none";
  document.getElementById("game-container-inner").style.display = "flex";
  if (pauseOverlay && pauseOverlay.isOpen()) pauseOverlay.hide();
  document.getElementById("pause-overlay").style.display = "none";

  seatScanForMode();
  updateBoardUI();
  updateHighlights();
  if (scan) scan.start();

  let turnMsg = state.turn === "X" ? "X starts" : "O starts";
  document.getElementById("status-display").innerText = `${turnMsg}`;

  if (state.gameMode === "single" && state.turn === "O") {
    speak(turnMsg + ". Computer's turn.");
    setTimeout(computerMove, 1000);
  } else {
    speak(turnMsg + ". Your turn.");
  }
}

function restartGame() {
  startGame(state.gameMode);
}

function resumeGame() {
  state.mode = "game";
  if (pauseOverlay && pauseOverlay.isOpen()) pauseOverlay.hide();
  document.getElementById("pause-overlay").style.display = "none";
  // Return the highlight to the cell the player was scanning before pausing.
  if (scan) {
    scan.enterHoldMs = config.enterLongPress;
    const targets = getScanTargets();
    const pos = targets.findIndex((el) => cellIndexOf(el) === pausedGameCell);
    scan.setIndex(pos >= 0 ? pos : 0);
  }
  updateHighlights();
  speak("Resumed");
  if (scan) scan.start();
}

// Improved Computer Logic
function getBestMove(board, computerPlayer) {
  const opponent = computerPlayer === "X" ? "O" : "X";

  // 1. Check for immediate win
  for (let i = 0; i < 9; i++) {
    if (board[i] === "") {
      board[i] = computerPlayer;
      if (checkWinResult(board) === computerPlayer) {
        board[i] = ""; // Reset
        return i;
      }
      board[i] = ""; // Reset
    }
  }

  // 2. Block immediate threat
  for (let i = 0; i < 9; i++) {
    if (board[i] === "") {
      board[i] = opponent;
      if (checkWinResult(board) === opponent) {
        board[i] = ""; // Reset
        return i;
      }
      board[i] = ""; // Reset
    }
  }

  // 3. Take center if available
  if (board[4] === "") return 4;

  // 4. Take corners if available
  const corners = [0, 2, 6, 8];
  const availableCorners = corners.filter((i) => board[i] === "");
  if (availableCorners.length > 0) {
    return availableCorners[
      Math.floor(Math.random() * availableCorners.length)
    ];
  }

  // 5. Random Available
  const emptyIndices = board
    .map((v, i) => (v === "" ? i : null))
    .filter((v) => v !== null);
  if (emptyIndices.length > 0) {
    return emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
  }

  return null;
}

function checkWinResult(b) {
  const wins = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8], // Rows
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8], // Cols
    [0, 4, 8],
    [2, 4, 6], // Diagonals
  ];
  for (let combo of wins) {
    const [x, y, z] = combo;
    if (b[x] && b[x] === b[y] && b[x] === b[z]) return b[x];
  }
  return null;
}

function computerMove() {
  if (state.mode !== "game") return;

  beginComputerThinking();

  // Wait a bit to simulate thinking delay
  setTimeout(() => {
    // Double check mode in case user exited during timeout
    if (state.mode !== "game") return;

    const move = getBestMove(state.board, "O");

    if (move !== null) {
      if (settings.locationTTS) {
        speak(`Computer placed O on Cell ${move + 1}`);
      } else {
        // Minimal announcement
      }

      makeMove(move, "O");

      const result = checkWin();
      if (result) {
        showGameOver(result);
        return;
      }

      state.turn = "X";
      endComputerThinking();
      document.getElementById("status-display").innerText =
        `Turn: ${state.turn}`;
      reseatGameScan();

      setTimeout(() => speak("Your turn"), settings.locationTTS ? 1500 : 500);
    }
  }, 1000);
}

function playerMove(index) {
  if (state.board[index] !== "") {
    speak("Occupied");
    return;
  }

  if (state.gameMode === "single" && state.turn !== "X") return;

  // Re-phase autoscan on interaction
  bumpAutoScan();

  if (settings.locationTTS) {
    speak(`Placed ${state.turn} on Cell ${index + 1}`);
  } else {
    speak(`${state.turn}`);
  }

  makeMove(index, state.turn);

  const result = checkWin();
  if (result) {
    showGameOver(result);
    return;
  }

  state.turn = state.turn === "X" ? "O" : "X";
  document.getElementById("status-display").innerText = `Turn: ${state.turn}`;
  reseatGameScan();

  if (state.gameMode === "single" && state.turn === "O") {
    computerMove(); // Handled with internal timeout (manages computerThinking)
  } else {
    setTimeout(() => speak("Next turn"), 1000);
  }
}

function makeMove(index, player) {
  state.board[index] = player;
  updateBoardUI();
}

function checkWin() {
  if (checkWinResult(state.board)) return checkWinResult(state.board);
  if (state.board.every((cell) => cell !== "")) return "Tie";
  return null;
}

// --- UI Updates ---

function getHighlightColor() {
  // Resolve via the shared Themes module. For concrete colors this returns the
  // CSS color name unchanged (identical to before); for "Theme Default" it now
  // resolves to the active theme's own highlight (the canonical behavior the
  // shared module defines) instead of the old flat "#ffcc00" fallback.
  return window.Themes.getThemeHighlight(
    themes[settings.themeIndex],
    settings.highlightColorIndex,
  );
}

function updateHighlights() {
  // Clear all highlights
  document.querySelectorAll(".highlight, .highlight-full").forEach((el) => {
    el.classList.remove("highlight");
    el.classList.remove("highlight-full");
    el.style.borderColor = "";
    el.style.backgroundColor = "";
    if (el.classList.contains("cell") && !el.classList.contains("highlight")) {
      // Reset cell background if it was highlighted
      let baseBg = "rgba(255, 255, 255, 0.9)"; // Default
      if (el.classList.contains("winning")) baseBg = "#2ecc71";
      el.style.background = baseBg;
    }
  });

  // The current scan target is the single source of truth for what is highlighted.
  const target = scan ? scan.getCurrentTarget() : null;

  if (target) {
    const color = getHighlightColor();

    if (settings.highlightStyle === "full") {
      target.classList.add("highlight-full"); // Helper class for transforms/z-index
      target.style.backgroundColor = color;
      target.style.borderColor = "white"; // Contrast border
    } else {
      target.classList.add("highlight");
      target.style.borderColor = color;
      target.style.backgroundColor = ""; // Keep default
    }
  }
}

function updateBoardUI() {
  state.board.forEach((val, i) => {
    const cell = document.getElementById(`cell-${i}`);
    cell.innerText = val;
    cell.className = "cell"; // reset classes
    cell.style.color = "";
    cell.style.background = "rgba(255, 255, 255, 0.9)";

    if (val === "X") {
      cell.classList.add("x-mark");
      cell.style.color = settings.p1Color;
    }
    if (val === "O") {
      cell.classList.add("o-mark");
      cell.style.color = settings.p2Color;
    }
  });
  // Apply highlight on top
  updateHighlights();
}

function announceCell(index) {
  if (!settings.locationTTS) {
    const val = state.board[index];
    speak(val === "" ? "Empty" : val);
    return;
  }

  const val = state.board[index];
  if (val === "") speak(`Cell ${index + 1} Empty`);
  else speak(`Cell ${index + 1} ${val}`);
}

// --- TTS ---

function speak(text) {
  if (!settings.tts) return;
  if (window.NarbeVoiceManager) {
    window.NarbeVoiceManager.speak(text);
  }
}

function toggleAutoScan(isPause = false) {
  if (window.NarbeScanManager) {
    const current = window.NarbeScanManager.getSettings().autoScan;
    window.NarbeScanManager.setAutoScan(!current);
    isPause ? refreshPauseMenu() : refreshMenu();
    if (scan) scan.start(); // Restart logic
  }
}

window.onload = init;

// Dual export so the migrated scan layer can be exercised under jest + jsdom,
// mirroring the shared modules' IIFE-global + CommonJS pattern. The guard keeps
// this a no-op in the browser (where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    init,
    state,
    settings,
    menus,
    getScanTargets,
    playerMove,
    startGame,
    showMainMenu,
    showSettingsMenu,
    showPauseMenu,
    resumeGame,
    cellIndexOf,
    exitToHub,
    getHighlightColor,
    loadSettings,
    saveSettings,
    showPauseSettings,
    getScan: () => scan,
    getPauseOverlay: () => pauseOverlay,
  };
}
