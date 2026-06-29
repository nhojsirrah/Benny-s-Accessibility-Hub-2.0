(() => {
  const $ = (sel) => document.querySelector(sel);
  const textBar = $("#textBar");
  const predictBar = $("#predictBar");
  const kb = $("#keyboard");
  const settingsMenu = $("#settingsMenu");

  const defaultSettings = {
    autocapI: true,
    theme: "default",
    scanSpeed: "medium",
    highlightColor: "yellow",
    autoScan: false  // Changed from true to false
  };

  let settings = loadSettings();
  function loadSettings() {
    try { 
      const v = JSON.parse(localStorage.getItem("kb_settings")); 
      // Remove voiceIndex from keyboard settings as it's now handled by voice manager
      if (v && 'voiceIndex' in v) delete v.voiceIndex;
      return { ...defaultSettings, ...v }; 
    }
    catch { 
      return { ...defaultSettings }; 
    }
  }

  // INTEGRATION: Sync with Shared Scan Manager
  if (window.NarbeScanManager) {
      console.log("🔗 Connected to NarbeScanManager");
      
      // Update local logic when manager changes
      window.NarbeScanManager.subscribe((newSettings) => {
          console.log("🔄 Scan settings updated from Hub:", newSettings);
          
          // Restart auto-scan if active to apply new speed
          if (isAutoScanning) {
              stopAutoScan();
              startAutoScan();
          }
          updateScanSpeedDisplay();
      });
  }

  function saveSettings() {
    localStorage.setItem("kb_settings", JSON.stringify(settings));
  }

  // TTS functionality using unified voice manager with interruption
  function speak(text) {
    // Always cancel any currently speaking TTS first
    if (window.NarbeVoiceManager && window.NarbeVoiceManager.cancel) {
      window.NarbeVoiceManager.cancel();
    }
    
    // Small delay to ensure cancellation takes effect
    setTimeout(() => {
      if (window.NarbeVoiceManager && window.NarbeVoiceManager.speakProcessed) {
        window.NarbeVoiceManager.speakProcessed(text);
      }
    }, 50);
  }

  // Scan timing configuration - derived from Manager when possible
  // We keep this structure for manual interaction timeouts (Long Press) which aren't in Manager yet
  // But we will try to scale them relative to the main speed if we can, or just keep fixed defaults for hold durations.
  const scanSpeeds = {
    slow: { forward: 1500, backward: 3000, longPress: 2000 },
    medium: { forward: 1000, backward: 2000, longPress: 2000 },
    fast: { forward: 500, backward: 1000, longPress: 2000 }
  };
  
  // Helper to get current interval from Manager
  function getScanInterval() {
      if (window.NarbeScanManager) {
          return window.NarbeScanManager.getSettings().scanInterval;
      }
      return 2000; // Fallback default
  }

  let autoScanInterval = null;
  let isAutoScanning = false;

  // Theme management
  const themes = ["default", "light", "dark", "blue", "green", "purple", "orange", "red"];
  let currentThemeIndex = themes.indexOf(settings.theme) || 0;

  // Highlight color management
  const highlightColors = ["yellow", "pink", "green", "orange", "black", "white", "purple", "red"];
  let currentHighlightIndex = highlightColors.indexOf(settings.highlightColor) || 0;

  function applyTheme(theme) {
    themes.forEach(t => document.body.classList.remove(`theme-${t}`));
    if (theme !== "default") {
      document.body.classList.add(`theme-${theme}`);
    }
    settings.theme = theme;
    saveSettings();
    updateThemeDisplay();
  }

  function applyHighlightColor(color) {
    highlightColors.forEach(c => document.body.classList.remove(`highlight-${c}`));
    document.body.classList.add(`highlight-${color}`);
    settings.highlightColor = color;
    saveSettings();
    updateHighlightDisplay();
  }

  // Settings menu state
  let inSettingsMode = false;
  let settingsRowIndex = 0;
  let settingsItems = [];

  // Scanning state
  let inRowSelectionMode = true;
  let currentRowIndex = 0;
  let currentButtonIndex = 0;

  // Text state
  let buffer = "";
  let ttsUseCount = 0;

  function setBuffer(txt) {
    buffer = txt;
    const displayText = buffer + "|";
    textBar.textContent = displayText;
    
    // Dynamically adjust text size based on length
    adjustTextSize(displayText);
    
    ttsUseCount = 0;
    renderPredictions();
  }

  function adjustTextSize(text) {
    // Remove all size classes first
    textBar.classList.remove('text-medium', 'text-small', 'text-tiny');
    
    // Get the text length without the cursor
    const textLength = text.replace('|', '').length;
    
    // Apply appropriate class based on text length
    if (textLength > 100) {
      textBar.classList.add('text-tiny');
    } else if (textLength > 50) {
      textBar.classList.add('text-small');
    } else if (textLength > 25) {
      textBar.classList.add('text-medium');
    }
    // Otherwise use default size (no class needed)
  }

  // Keyboard layout with symbols for control buttons
  const rows = [
    ["Space", "Del Letter", "Del Word", "Clear", "Settings", "Exit"],
    ["A","B","C","D","E","F"],
    ["G","H","I","J","K","L"],
    ["M","N","O","P","Q","R"],
    ["S","T","U","V","W","X"],
    ["Y","Z","0","1","2","3"],
    ["4","5","6","7","8","9"]
  ];

  // Control button symbols
  const controlSymbols = {
    "Space": "—",        // Em dash symbol (changed from underscore)
    "Del Letter": "⌫",   // Backspace symbol
    "Del Word": "⌦",     // Delete forward symbol
    "Clear": "✕",        // Clear/X symbol
    "Settings": "⚙",     // Gear symbol
    "Exit": "⏻"          // Power/Exit symbol
  };

  function renderKeyboard() {
    kb.innerHTML = "";
    rows.forEach((row, rIdx) => {
      row.forEach((key) => {
        const btn = document.createElement("button");
        btn.className = "key" + (rIdx === 0 ? " ctrl" : "");
        
        if (key === "Settings") {
          btn.classList.add("settings");
        } else if (key === "Exit") {
          btn.classList.add("exit");
        }
        
        // For control buttons, add symbol and text
        if (rIdx === 0 && controlSymbols[key]) {
          btn.innerHTML = `
            <span class="ctrl-symbol">${controlSymbols[key]}</span>
            <span class="ctrl-text">${key}</span>
          `;
        } else {
          btn.textContent = key;
        }
        
        btn.addEventListener("click", () => {
          if (rIdx === 0) {
            handleControl(key);
          } else {
            insertKey(key);
          }
        });
        kb.appendChild(btn);
      });
    });
    highlightTextBox();
  }

  // ================================================================ //
  //  Scanning via the shared ScanController (nested rows -> buttons)  //
  // ================================================================ //
  //
  // The keyboard scans TWO levels: pick a ROW (text bar -> keyboard rows ->
  // predictive row), then scan the BUTTONS within that row. That is exactly the
  // shape ScanController's nested mode models, so the controller now owns the
  // scan index, the Space short/hold (forward / reverse) loop and the Enter
  // short/hold (select / jump-back) behaviour. The app keeps its battle-tested
  // highlight*/speak* helpers and the legacy index variables those helpers read
  // (currentRowIndex / currentButtonIndex / inRowSelectionMode); they are kept
  // in sync FROM the controller so the on-screen + spoken behaviour is unchanged.
  //
  // Group ordering mirrors the legacy row order EXACTLY:
  //   index 0                  -> text bar (speak-on-select; no sub-buttons)
  //   index 1 .. rows.length   -> keyboard rows (rows[0 .. rows.length-1])
  //   index rows.length + 1    -> predictive row (the chips)
  // Because this matches the old currentRowIndex values, the existing helpers
  // (highlightRow, highlightButton, speakRowTitle, ...) work verbatim.

  const PREDICTIVE_GROUP_INDEX = rows.length + 1;

  let kbScan = null;
  let settingsScan = null;

  function getGroups() {
    const groups = [{ type: "textbar" }];
    for (let r = 0; r < rows.length; r++) {
      groups.push({ type: "kbrow", rowIndex: r });
    }
    groups.push({ type: "predictive" });
    return groups;
  }

  function getItems(group) {
    if (!group) return [];
    if (group.type === "kbrow") {
      const start = group.rowIndex * 6;
      const allKeys = kb.querySelectorAll(".key");
      const items = [];
      for (let i = 0; i < rows[group.rowIndex].length; i++) {
        items.push(allKeys[start + i]);
      }
      return items;
    }
    if (group.type === "predictive") {
      // All six chips (including disabled/empty slots) - matches the legacy
      // predictive-row navigation, which stepped through every chip slot.
      return Array.from(predictBar.querySelectorAll(".chip"));
    }
    return []; // text bar has no sub-buttons (handled via descend override below)
  }

  // Mirror the controller's level/index into the legacy variables the highlight
  // and speak helpers depend on, so those helpers keep working unchanged.
  function syncLegacyFromScan() {
    if (kbScan.getLevel() === "item") {
      inRowSelectionMode = false;
      currentRowIndex = kbScan.getGroupIndex();
      currentButtonIndex = kbScan.getIndex();
    } else {
      inRowSelectionMode = true;
      const idx = kbScan.getIndex();
      if (idx >= 0) currentRowIndex = idx;
    }
  }

  // Highlight + speak the currently-focused row (group level) or button (item
  // level), reproducing the legacy scanForward/scanBackward/selectButton render.
  function renderScanFocus() {
    syncLegacyFromScan();

    if (kbScan.getLevel() === "item") {
      clearAllHighlights();
      if (currentRowIndex === PREDICTIVE_GROUP_INDEX) {
        highlightPredictiveButton(currentButtonIndex);
        speakPredictiveButtonLabel(currentButtonIndex);
      } else {
        highlightButton(currentButtonIndex);
        speakButtonLabel(currentButtonIndex);
      }
      return;
    }

    // Group (row) level.
    clearAllHighlights();
    if (currentRowIndex === 0) {
      highlightTextBox();
    } else if (currentRowIndex === PREDICTIVE_GROUP_INDEX) {
      highlightPredictiveRow();
      speakPredictions();
    } else {
      highlightRow(currentRowIndex - 1);
      speakRowTitle(currentRowIndex - 1);
    }
  }

  // Insert a predictive word, replacing the in-progress partial word, then learn
  // it. Shared by the predictive-chip click handler and the scan selection path
  // (the two were byte-identical in the legacy code).
  function applyPrediction(word) {
    const partial = currentWord();
    let newBuf = buffer;
    if (partial && !buffer.endsWith(" ")) {
      newBuf = buffer.slice(0, -partial.length) + word + " ";
    } else {
      if (!buffer.endsWith(" ") && buffer.length) newBuf += " ";
      newBuf += word + " ";
    }
    setBuffer(newBuf);

    if (window.predictionSystem) {
      try {
        window.predictionSystem.recordLocalWord(word);
        const context = buffer.replace("|", "").trim();
        if (context) {
          window.predictionSystem.recordNgram(context, word);
        }
      } catch (e) {
        console.error("Error recording prediction:", e);
      }
    }
  }

  // Speak the current text-bar contents, learning the words after 3 reads - the
  // legacy text-bar selection behaviour (a short Enter on the text-bar row).
  function speakTextBar() {
    const text = buffer.replace(/\|/g, "").trim();
    if (!text) return;
    speak(text);
    ttsUseCount++;
    console.log(`TTS use count: ${ttsUseCount} for text: "${text}"`);
    if (ttsUseCount >= 3) {
      console.log("3x TTS usage detected - recording words");
      saveTextToPredictive(text);
      ttsUseCount = 0;
    }
  }

  // Short Enter at the ITEM level: run the focused button's action, then back
  // out to row selection (ascend) and re-announce the row. Group-level short
  // Enter DESCENDS into the row (handled by ScanController.select via our
  // descend override).
  function onScanItemSelect() {
    const group = kbScan.getCurrentGroup();
    syncLegacyFromScan();

    if (group.type === "predictive") {
      const chips = predictBar.querySelectorAll(".chip");
      const chip = chips[currentButtonIndex];
      if (chip && chip.textContent.trim()) {
        applyPrediction(chip.textContent.trim());
      }
      kbScan.ascend();
      syncLegacyFromScan();
      clearAllHighlights();
      // Predictions changed - re-render, then re-highlight + read the row.
      updatePredictiveButtons().then(() => {
        highlightPredictiveRow();
        speakPredictions();
      });
      return;
    }

    // Keyboard-row button.
    const key = rows[group.rowIndex][currentButtonIndex];
    if (group.rowIndex === 0) {
      handleControl(key);
    } else {
      insertKey(key);
    }
    kbScan.ascend();
    syncLegacyFromScan();
    clearAllHighlights();
    highlightRow(currentRowIndex - 1);
    speakRowTitle(currentRowIndex - 1);
  }

  // Long Enter (hold) == the legacy handleLongPress: at the row level jump
  // straight to the predictive row; in button mode back out to row selection.
  function onScanPause() {
    if (kbScan.getLevel() === "item") {
      kbScan.ascend();
      kbScan.focusIndex(kbScan.getIndex()); // re-highlight + read the restored row
    } else {
      kbScan.focusIndex(PREDICTIVE_GROUP_INDEX);
    }
  }

  // Settings-menu scanning: single-axis ScanController over the settings items.
  function renderSettingsFocus(index) {
    settingsRowIndex = index;
    highlightSettingsItem(index);
    const item = settingsItems[index];
    if (item) {
      const label = item.querySelector(".setting-label");
      if (label) speak(label.textContent.toLowerCase());
    }
  }

  function buildScanControllers() {
    const ScanControllerClass = window.ScanController;
    if (!ScanControllerClass) {
      console.error("ScanController not loaded - scanning will be unavailable.");
      return;
    }

    // Manual hold timings come from the keyboard's own scanSpeeds table - the
    // legacy behaviour: scan-speed cycling delegates to NarbeScanManager for the
    // AUTO-scan cadence, while the press-and-hold thresholds stay fixed here.
    const hold = scanSpeeds[currentScanSpeed] || scanSpeeds.medium;

    kbScan = new ScanControllerClass({
      getGroups,
      getItems,
      onFocus: () => renderScanFocus(),
      onAnnounce: () => {}, // speech is produced inside renderScanFocus
      onSelect: () => onScanItemSelect(),
      onPause: () => onScanPause(),
      spaceHoldMs: hold.longPress, // hold Space -> reverse scanning
      reverseCadenceMs: hold.backward, // reverse step cadence
      enterHoldMs: 3000, // hold Enter (>=3s) -> jump-to-predictive / back-out
      wrap: true,
      autoScan: false, // auto-scan stays app-driven (local kb_settings.autoScan)
      getInterval: getScanInterval,
    });

    // The text bar is a scannable row, but a short Enter on it SPEAKS the text
    // rather than descending into sub-buttons. Override descend on the instance
    // so ScanController.select() routes the text bar to speak-and-stay.
    const baseDescend = kbScan.descend.bind(kbScan);
    kbScan.descend = function () {
      const groups = getGroups();
      const group = groups[kbScan.getIndex()];
      if (group && group.type === "textbar") {
        speakTextBar();
        return kbScan; // stay at the row level
      }
      const result = baseDescend();
      // Legacy parity: drilling into a row immediately focuses + reads button 0
      // (the old selectButton drilled in AND highlighted/spoke the first button).
      kbScan.focusIndex(0);
      return result;
    };

    settingsScan = new ScanControllerClass({
      getTargets: () => settingsItems,
      onFocus: (item, index) => renderSettingsFocus(index),
      onAnnounce: () => {},
      onSelect: () => selectSettingsItem(),
      spaceHoldMs: hold.longPress,
      reverseCadenceMs: hold.backward,
      wrap: true,
      autoScan: false,
      getInterval: getScanInterval,
    });
  }

  async function updatePredictiveButtons() {
    await renderPredictions();
  }

  async function renderPredictions() {
    try {
      const wasPredictiveRowHighlighted = (currentRowIndex === rows.length + 1 && inRowSelectionMode);
      const wasInButtonMode = (currentRowIndex === rows.length + 1 && !inRowSelectionMode);
      const savedButtonIndex = currentButtonIndex;
      
      let predictions = ["YES", "NO", "HELP", "THE", "I", "YOU"]; // Default fallback
      
      if (window.predictionSystem && window.predictionSystem.getHybridPredictions) {
        try {
          predictions = await window.predictionSystem.getHybridPredictions(buffer);
        } catch (e) {
          console.error('Error getting predictions:', e);
        }
      }
      
      console.log("Final predictions to render:", predictions);

      predictBar.innerHTML = "";
      predictions.slice(0, 6).forEach(w => {
        const chip = document.createElement("button");
        chip.className = "chip";
        chip.textContent = w;
        chip.addEventListener("click", () => {
          applyPrediction(w);
        });
        predictBar.appendChild(chip);
      });

      while (predictBar.children.length < 6) {
        const chip = document.createElement("button");
        chip.className = "chip";
        chip.textContent = "";
        chip.disabled = true;
        predictBar.appendChild(chip);
      }
      
      if (wasPredictiveRowHighlighted) {
        highlightPredictiveRow();
      } else if (wasInButtonMode) {
        const chips = predictBar.querySelectorAll(".chip");
        if (chips[savedButtonIndex]) {
          highlightPredictiveButton(savedButtonIndex);
        }
      }
    } catch (error) {
      console.error('Error in renderPredictions:', error);
    }
  }

  function currentWord() {
    const trimmed = buffer.replace(/\|/g, "").trimEnd();
    const parts = trimmed.split(/\s+/);
    if (buffer.endsWith(" ")) return "";
    return parts[parts.length - 1] || "";
  }

  function clearAllHighlights() {
    textBar.classList.remove("highlighted");
    const allKeys = kb.querySelectorAll(".key");
    allKeys.forEach(key => key.classList.remove("highlighted"));
    const allChips = predictBar.querySelectorAll(".chip");
    allChips.forEach(chip => chip.classList.remove("highlighted"));
  }

  function highlightTextBox() {
    clearAllHighlights();
    textBar.classList.add("highlighted");
  }

  function highlightRow(rowIndex) {
    clearAllHighlights();
    const rowStart = rowIndex * 6;
    const allKeys = kb.querySelectorAll(".key");
    
    for (let i = 0; i < 6; i++) {
      if (allKeys[rowStart + i]) {
        allKeys[rowStart + i].classList.add("highlighted");
      }
    }
  }

  function highlightButton(buttonIndex, prevButtonIndex = null) {
    const rowStart = (currentRowIndex - 1) * 6; // Adjust for keyboard rows starting at index 1
    const allKeys = kb.querySelectorAll(".key");
    
    if (prevButtonIndex !== null && allKeys[rowStart + prevButtonIndex]) {
      allKeys[rowStart + prevButtonIndex].classList.remove("highlighted");
    }
    
    if (allKeys[rowStart + buttonIndex]) {
      allKeys[rowStart + buttonIndex].classList.add("highlighted");
    }
  }

  function highlightPredictiveRow() {
    clearAllHighlights();
    const allChips = predictBar.querySelectorAll(".chip");
    allChips.forEach(chip => chip.classList.add("highlighted"));
  }

  function highlightPredictiveButton(buttonIndex, prevButtonIndex = null) {
    const chips = predictBar.querySelectorAll(".chip");
    
    if (prevButtonIndex !== null && chips[prevButtonIndex]) {
      chips[prevButtonIndex].classList.remove("highlighted");
    }
    
    if (chips[buttonIndex]) {
      chips[buttonIndex].classList.add("highlighted");
    }
  }

  function speakRowTitle(rowIndex) {
    const rowTitles = [
      "controls", 
      "a b c d e f", 
      "g h i j k l", 
      "m n o p q r", 
      "s t u v w x", 
      "y z 0 1 2 3", 
      "4 5 6 7 8 9", 
      "predictive text"
    ];
    
    // Check if it's the predictive text row (index 7)
    if (rowIndex === 7) {
      speakPredictions();
      return;
    }
    
    if (rowIndex < rowTitles.length) {
      speak(rowTitles[rowIndex]);
    }
  }

  function speakButtonLabel(buttonIndex) {
    const label = rows[currentRowIndex - 1][buttonIndex];
    let spokenLabel = label.toLowerCase();
    
    if (spokenLabel === "del letter") spokenLabel = "delete letter";
    if (spokenLabel === "del word") spokenLabel = "delete word";
    
    // For single letters and short words, let the voice manager handle pronunciation
    // Remove the special case handling here since voice manager now handles it
    speak(spokenLabel);
  }

  function speakPredictiveButtonLabel(buttonIndex) {
    const chips = predictBar.querySelectorAll(".chip");
    if (chips[buttonIndex] && chips[buttonIndex].textContent.trim()) {
      const word = chips[buttonIndex].textContent.trim();
      console.log(`Speaking predictive button: "${word}"`);
      speak(word); // Voice manager will handle proper pronunciation processing
    }
  }

  function speakPredictions() {
    const predictButtons = document.querySelectorAll('#predictBar .chip');
    if (predictButtons.length > 0) {
      const predictions = Array.from(predictButtons)
        .map(btn => btn.textContent)
        .filter(text => text.trim());
      
      if (predictions.length > 0) {
        // Process each prediction individually through the voice manager BEFORE joining
        console.log(`Speaking predictions: ${predictions}`);
        
        // Process each word through the voice manager's pronunciation mapping
        const processedPredictions = predictions.map(word => {
          let processed = word;
          // Fix for short uppercase words (like "IT", "IS") being read as letters
          if (processed && processed.length > 1 && processed.length <= 4 && processed === processed.toUpperCase()) {
            processed = processed.toLowerCase();
          }

          if (window.NarbeVoiceManager && window.NarbeVoiceManager.processTextForSpeech) {
            return window.NarbeVoiceManager.processTextForSpeech(processed);
          }
          return processed;
        });
        
        const announcement = processedPredictions.join(", ");
        console.log(`Processed predictions announcement: "${announcement}"`);
        
        // Use the voice manager's speak function directly to avoid double-processing
        if (window.NarbeVoiceManager && window.NarbeVoiceManager.speak) {
          window.NarbeVoiceManager.speak(announcement);
        } else {
          speak(announcement);
        }
      } else {
        speak("no predictions available");
      }
    } else {
      speak("no predictions available");
    }
  }

  function openSettings() {
    inSettingsMode = true;
    settingsMenu.classList.remove("hidden");
    kb.style.display = "none";
    predictBar.style.display = "none";
    textBar.style.display = "none"; // Hide text bar too
    
    settingsItems = Array.from(settingsMenu.querySelectorAll(".settings-item"));
    settingsRowIndex = 0;
    highlightSettingsItem(0);
    
    updateThemeDisplay();
    updateScanSpeedDisplay();
    updateVoiceDisplay();
    updateHighlightDisplay();
    updateTTSToggleDisplay(); // Add TTS toggle display update
    updateAutoScanDisplay(); // Add Auto Scan display update

    // Route scanning to the settings list. Index starts at 0 (item already
    // highlighted above); the first scan advances to item 1, matching legacy.
    if (kbScan) kbScan.detach();
    if (settingsScan) {
      settingsScan.attach(document);
      settingsScan.setIndex(0);
    }
  }
  
  // Initialize settings click handlers ONCE using event delegation
  function initSettingsClickHandlers() {
    const settingsGrid = document.getElementById('settingsGrid');
    if (!settingsGrid) return;
    
    settingsGrid.addEventListener('click', (e) => {
      const item = e.target.closest('.settings-item');
      if (!item) return;
      
      const allItems = Array.from(settingsMenu.querySelectorAll(".settings-item"));
      const index = allItems.indexOf(item);
      if (index !== -1) {
        settingsRowIndex = index;
        highlightSettingsItem(settingsRowIndex);
        selectSettingsItem();
      }
    });
    
    settingsGrid.addEventListener('mouseenter', (e) => {
      const item = e.target.closest('.settings-item');
      if (!item) return;
      
      const allItems = Array.from(settingsMenu.querySelectorAll(".settings-item"));
      const index = allItems.indexOf(item);
      if (index !== -1) {
        settingsRowIndex = index;
        highlightSettingsItem(settingsRowIndex);
        
        const label = item.querySelector(".setting-label");
        if (label) speak(label.textContent.toLowerCase());
      }
    }, true); // Use capture to catch mouseenter on child elements
  }

  function closeSettings() {
    inSettingsMode = false;
    settingsMenu.classList.add("hidden");
    kb.style.display = "grid";
    predictBar.style.display = "grid";
    textBar.style.display = "flex"; // Show text bar again
    
    // No need to clone/replace elements - we use event delegation now
    
    if (settingsScan) settingsScan.detach();
    if (kbScan) {
      kbScan.attach(document);
      kbScan.ascend(); // ensure group level (no-op if already there)
      kbScan.setIndex(0); // back to the text-bar row
    }

    inRowSelectionMode = true;
    currentRowIndex = 0;
    highlightTextBox();
  }

  function highlightSettingsItem(index) {
    settingsItems.forEach(item => item.classList.remove("highlighted"));
    if (settingsItems[index]) {
      settingsItems[index].classList.add("highlighted");
    }
  }

  function selectSettingsItem() {
    const item = settingsItems[settingsRowIndex];
    const setting = item.dataset.setting;
    
    switch (setting) {
      case "theme":
        cycleTheme();
        break;
        
      case "scan-speed":
        cycleScanSpeed();
        break;
        
      case "voice":
        cycleVoice();
        break;
        
      case "highlight":
        cycleHighlightColor();
        break;
        
      case "tts-toggle":
        toggleTTS();
        break;
        
      case "auto-scan":
        toggleAutoScan();
        break;
        
      case "volume-up":
        adjustVolume("up");
        break;
        
      case "volume-down":
        adjustVolume("down");
        break;
        
      case "close":
        closeSettings();
        speak("settings closed");
        break;
    }
  }

  async function adjustVolume(direction) {
    try {
      
      const response = await fetch('/system/volume/' + direction, {
        method: 'POST'
      });
      
      if (response.ok) {
        // const result = await response.json();
        console.log('Volume adjusted:', direction);
        speak(direction === "up" ? "volume up" : "volume down");
      } else {
        console.error('Failed to control volume');
        speak("volume control failed");
      }
    } catch (error) {
      console.error('Error controlling volume:', error);
      speak("volume control error");
    }
  }

  function cycleTheme() {
    currentThemeIndex = (currentThemeIndex + 1) % themes.length;
    const newTheme = themes[currentThemeIndex];
    applyTheme(newTheme);
    speak(newTheme);
  }

  function updateThemeDisplay() {
    const themeValue = $("#themeValue");
    if (themeValue) {
      themeValue.textContent = themes[currentThemeIndex];
    }
  }

  function cycleScanSpeed() {
    if (window.NarbeScanManager) {
        window.NarbeScanManager.cycleScanSpeed();
        // Update is handled by subscription
        const speed = getScanInterval();
        speak(`scan speed ${speed/1000} seconds`);
    } else {
        // Fallback if manager missing
        const speeds = ["slow", "medium", "fast"];
        const currentIndex = speeds.indexOf(currentScanSpeed);
        const nextIndex = (currentIndex + 1) % speeds.length;
        currentScanSpeed = speeds[nextIndex];
        
        settings.scanSpeed = currentScanSpeed;
        saveSettings();
        updateScanSpeedDisplay();
        speak(currentScanSpeed);
        
        if (isAutoScanning) {
          stopAutoScan();
          startAutoScan();
        }
    }
  }

  function updateScanSpeedDisplay() {
    const speedValue = $("#scanSpeedValue");
    if (speedValue) {
      if (window.NarbeScanManager) {
          const names = ["Fast (1s)", "Medium (2s)", "Slow (3s)", "Extra Slow (4s)"];
          const idx = window.NarbeScanManager.getSettings().scanSpeedIndex;
          speedValue.textContent = names[idx] || "Medium (2s)";
      } else {
        speedValue.textContent = "Medium";
      }
    }
  }

  function cycleVoice() {
    // Check if voices are loaded using shared manager API
    if (window.NarbeVoiceManager && window.NarbeVoiceManager.areVoicesLoaded && !window.NarbeVoiceManager.areVoicesLoaded()) {
      if (window.NarbeVoiceManager.waitForVoices) {
          window.NarbeVoiceManager.waitForVoices().then(() => {
            updateVoiceDisplay();
          });
      }
      speak("initializing voices");
      return;
    }
    
    // Cycle voice using shared manager
    if (window.NarbeVoiceManager && window.NarbeVoiceManager.cycleVoice) {
        const voiceChanged = window.NarbeVoiceManager.cycleVoice();
        if (voiceChanged) {
            updateVoiceDisplay();
            const currentVoice = window.NarbeVoiceManager.getCurrentVoice();
            const displayName = window.NarbeVoiceManager.getVoiceDisplayName(currentVoice);
            speak(`voice changed to ${displayName}`);
        } else {
             speak("refreshing voice list");
        }
    }
  }

  function updateVoiceDisplay() {
    const voiceValue = $("#voiceValue");
    if (voiceValue && window.NarbeVoiceManager) {
      const currentVoice = window.NarbeVoiceManager.getCurrentVoice();
      const displayName = window.NarbeVoiceManager.getVoiceDisplayName(currentVoice);
      voiceValue.textContent = displayName;
    }
  }

  function cycleHighlightColor() {
    currentHighlightIndex = (currentHighlightIndex + 1) % highlightColors.length;
    const newColor = highlightColors[currentHighlightIndex];
    applyHighlightColor(newColor);
    speak(newColor);
  }

  function updateHighlightDisplay() {
    const highlightValue = $("#highlightValue");
    if (highlightValue) {
      const colorName = highlightColors[currentHighlightIndex];
      highlightValue.textContent = colorName.charAt(0).toUpperCase() + colorName.slice(1);
    }
  }

  function toggleTTS() {
    const ttsEnabled = window.NarbeVoiceManager.toggleTTS();
    updateTTSToggleDisplay();
    speak(ttsEnabled ? "TTS enabled" : "TTS disabled");
  }

  function updateTTSToggleDisplay() {
    const ttsValue = $("#ttsToggleValue");
    if (ttsValue) {
      const voiceSettings = window.NarbeVoiceManager.getSettings();
      ttsValue.textContent = voiceSettings.ttsEnabled ? "On" : "Off";
    }
  }

  function toggleAutoScan() {
    isAutoScanning = !isAutoScanning;
    settings.autoScan = isAutoScanning;
    saveSettings();
    updateAutoScanDisplay();
    speak(isAutoScanning ? "Auto Scan enabled" : "Auto Scan disabled");
    
    if (isAutoScanning) {
      startAutoScan();
    } else {
      stopAutoScan();
    }
  }

  function updateAutoScanDisplay() {
    const autoScanValue = $("#autoScanValue");
    if (autoScanValue) {
      autoScanValue.textContent = isAutoScanning ? "On" : "Off";
    }
  }

  function startAutoScan() {
    if (autoScanInterval) return;
    
    // Use unified speed from manager
    const speed = getScanInterval();
    
    autoScanInterval = setInterval(() => {
      if (inSettingsMode) {
        if (settingsScan) settingsScan.advance();
      } else {
        if (kbScan) kbScan.advance();
      }
    }, speed);
  }

  function stopAutoScan() {
    if (autoScanInterval) {
      clearInterval(autoScanInterval);
      autoScanInterval = null;
    }
  }

  function readInstructions() {
    const instructions = `
      Welcome to Ben's Keyboard. Here are the instructions for using this keyboard.
      
      Navigation controls:
      Spacebar short press will advance forward through rows and buttons.
      Spacebar long hold will move backward through rows and buttons until released.
      
      Selection controls:
      Return key short press will select the highlighted item.
      Return key long press in button mode will return you to row selection mode.
      Return key long hold in row selection mode will jump directly to predictive text.
      
      The keyboard has several rows:
      First is the text bar where your typed text appears. Click or select it to hear your text read aloud.
      Second is the predictive text row with word suggestions.
      Third is the controls row with space, delete, clear, settings, and exit.
      Then letter rows A through Z and number rows 0 through 9.
      
      Tips:
      Saying the same text three times will save those words to your predictions for faster typing later.
      You can change themes, scan speed, voice, and highlight colors in settings.
      The TTS toggle controls whether items are read aloud as you navigate.
      The Auto Scan toggle enables automatic scanning through rows and buttons.
      
      Press return to continue using the keyboard.
    `;
    
    if (window.NarbeVoiceManager) {
      window.NarbeVoiceManager.cancel();
      window.NarbeVoiceManager.speak(instructions, { rate: 0.9 });
    }
  }

  function handleControl(key) {
    if (key === "Space") return insertKey(" ");
    if (key === "Del Letter") { setBuffer(buffer.slice(0, -1)); return; }
    if (key === "Del Word")   { setBuffer(buffer.trimEnd().replace(/\S+\s*$/, "")); return; }
    if (key === "Clear")      { setBuffer(""); return; }
    if (key === "Settings")   { 
      openSettings();
      return; 
    }
    if (key === "Exit")       { 
      console.log("Exit button pressed - closing Chrome");
      closeChrome();
      return; 
    }
  }

  async function closeChrome() {
      speak("exiting");
      // Since we are running in an iframe within Benny's Hub, we should communicate with the parent
      // to close this app (which just hides the iframe).
      try {
          window.parent.postMessage({ action: 'closeApp' }, '*');
      } catch (e) {
          console.error("Failed to post message to parent:", e);
          speak("error exiting");
      }
  }

  function insertKey(k) {
    if (settings.autocapI && k.length === 1) {
      const prev = buffer.slice(-1);
      if ((k === "i" || k === "I") && (!prev || /\s/.test(prev))) k = "I";
    }
    
    if (k === " ") {
      const currentText = buffer.replace('|', '').trim();
      const words = currentText.split(' ');
      if (words.length > 0) {
        const lastWord = words[words.length - 1];
        if (lastWord && lastWord.length > 0 && window.predictionSystem) {
          try {
            window.predictionSystem.recordLocalWord(lastWord);
            console.log(`Auto-learned word: ${lastWord}`);
            
            if (words.length > 1) {
              const context = words.slice(0, -1).join(' ');
              window.predictionSystem.recordNgram(context, lastWord);
            }
          } catch (e) {
            console.error('Error recording word:', e);
          }
        }
      }
    }
    
    setBuffer(buffer + k);
  }

  function saveTextToPredictive(text) {
    console.log(`Text repeated 3 times via TTS: "${text}"`);
    const words = text.split(/\s+/).filter(word => word.trim().length > 0);
    
    // Record each word individually with higher priority
    words.forEach((word, index) => {
      if (word && word.trim().length > 0 && window.predictionSystem) {
        try {
          const cleanWord = word.trim().toUpperCase();
          
          // Record the word multiple times to give it higher priority
          for (let i = 0; i < 5; i++) {
            window.predictionSystem.recordLocalWord(cleanWord);
          }
          console.log(`Recorded word "${cleanWord}" 5 times for high priority`);
          
          // Record n-grams for context
          if (index > 0) {
            const context = words.slice(0, index).join(' ');
            for (let i = 0; i < 3; i++) {
              window.predictionSystem.recordNgram(context, cleanWord);
            }
            console.log(`Recorded n-gram: "${context}" -> "${cleanWord}" 3 times`);
          }
        } catch (e) {
          console.error('Error recording word:', e);
        }
      }
    });
    
    // Force immediate re-merge and re-render
    setTimeout(() => {
      if (
        window.predictionSystem &&
        typeof window.predictionSystem.mergeData === "function"
      ) {
        window.predictionSystem.mergeData();
      }
      renderPredictions();
      console.log('Forced prediction system update after TTS recording');
    }, 200);
  }

  textBar.addEventListener("click", () => {
    const text = buffer.replace(/\|/g, "").trim();
    if (text) {
      window.NarbeVoiceManager.speakProcessed(text);
      
      ttsUseCount++;
      console.log(`TTS use count: ${ttsUseCount} for text: "${text}"`);
      
      if (ttsUseCount >= 3) {
        console.log("3x TTS usage detected - recording words with high priority");
        saveTextToPredictive(text);
        ttsUseCount = 0;
        
        // Clear the buffer after saving to predictions to start fresh
        setTimeout(() => {
          setBuffer("");
          console.log('Buffer cleared after 3x TTS - ready for fresh input');
        }, 1000);
      }
    }
  });

  const originalSetBuffer = setBuffer;
  setBuffer = function(newBuffer) {
    const wasPredictiveRowHighlighted = (currentRowIndex === rows.length + 1 && inRowSelectionMode);
    
    originalSetBuffer(newBuffer);
    updatePredictiveButtons().then(() => {
      if (wasPredictiveRowHighlighted) {
        setTimeout(() => {
          highlightPredictiveRow();
        }, 50);
      }
    });
  };

  // ---- Prediction engine (shared Predict, IP-3) ----
  // Behaviourally identical to the former local predictions.js engine (same
  // schema + same trigram->bigram->frequency cascade; see shared/predict.js).
  // The base-data load + persistence seam replicate the original Electron/HTTP
  // paths so swapping engines is transparent for Ben's text path.
  function buildPredictionsProvider() {
    const kbApi =
      typeof window !== "undefined" &&
      window.electronAPI &&
      window.electronAPI.keyboard
        ? window.electronAPI.keyboard
        : null;
    return {
      async getPredictions() {
        if (kbApi && kbApi.getPredictions) {
          return kbApi.getPredictions();
        }
        try {
          const res = await fetch("/shared/predictive_ngrams.json");
          if (res.ok) return res.json();
        } catch (e) {
          console.error("Error loading predictions:", e);
        }
        return null;
      },
      async savePrediction(data) {
        if (kbApi && kbApi.savePrediction) {
          return kbApi.savePrediction(data);
        }
        try {
          await fetch("/api/save_prediction", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
        } catch (e) {
          console.error("Error saving to server:", e);
        }
      },
      async saveNgram(data) {
        if (kbApi && kbApi.saveNgram) {
          return kbApi.saveNgram(data);
        }
        try {
          await fetch("/api/save_ngram", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
        } catch (e) {
          console.error("Error saving n-gram to server:", e);
        }
      },
    };
  }

  if (window.Predict && !window.predictionSystem) {
    window.predictionSystem = window.Predict.create({
      predictions: buildPredictionsProvider(),
    });
    // Load base data; sets dataLoaded = true (the init poll waits on this).
    window.predictionSystem.load();
  }

  function init() {
    console.log('Initializing keyboard...');
    
    // Wait for voice manager to load voices, then update display
    if (window.NarbeVoiceManager && window.NarbeVoiceManager.waitForVoices) {
      window.NarbeVoiceManager.waitForVoices().then(() => {
        console.log('Voice manager initialized with', window.NarbeVoiceManager.voices.length, 'voices');
        updateVoiceDisplay();
        updateTTSToggleDisplay();
      }).catch(e => {
        console.log('Voice manager error:', e);
        updateVoiceDisplay();
        updateTTSToggleDisplay();
      });
    } else {
      // Fallback if voice manager not available
      setTimeout(() => {
        updateVoiceDisplay();
        updateTTSToggleDisplay();
      }, 100);
    }
    
    // Listen for voice settings changes from other apps or voice manager
    if (window.NarbeVoiceManager && window.NarbeVoiceManager.onSettingsChange) {
      window.NarbeVoiceManager.onSettingsChange(() => {
        updateVoiceDisplay();
        updateTTSToggleDisplay();
      });
    }
    
    
    // Periodic voice validation handled by Shared Manager events
    // (setInterval removed as it used deprecated local methods)

    
    applyTheme(settings.theme);
    applyHighlightColor(settings.highlightColor || "yellow");
    currentScanSpeed = settings.scanSpeed || "medium";
    
    console.log('Rendering keyboard...');
    renderKeyboard();
    
    console.log('Setting initial buffer...');
    setBuffer("");

    // Build the scan controllers now the keyboard DOM + speed are ready, then
    // attach the keyboard scanner and focus the text-bar row (silent - matches
    // the legacy initial highlightTextBox()).
    buildScanControllers();
    if (kbScan) {
      kbScan.attach(document);
      kbScan.focusIndex(0);
    }
    
    // Wait for prediction system to initialize
    const initPredictions = () => {
      if (window.predictionSystem && window.predictionSystem.dataLoaded) {
        console.log('Prediction system ready, rendering predictions');
        renderPredictions();
      } else {
        console.log('Waiting for prediction system...');
        setTimeout(initPredictions, 100);
      }
    };
    
    setTimeout(initPredictions, 100);
    
    // Initialize settings click handlers (event delegation)
    initSettingsClickHandlers();
    
    if (settings.autoScan) {
      isAutoScanning = true;
      startAutoScan();
    }
    
    console.log('Keyboard initialization complete');
  }

  // Test seam (no-op in the browser, where `module` is undefined): expose the
  // controller handles so jsdom tests can detach key listeners between runs.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      __getKbScan: () => kbScan,
      __getSettingsScan: () => settingsScan,
    };
  }

  init();
})();
