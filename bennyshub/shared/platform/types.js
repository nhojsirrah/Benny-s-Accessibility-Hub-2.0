/**
 * Shared JSDoc type definitions for the platform facade (IP-6).
 *
 * This file carries no runtime code — it is a pure `@typedef` surface so that
 * editors and a future `tsc --checkJs` pass (driven by the repo-root
 * jsconfig.json) can type-check the hub's plain-JS modules. There is
 * intentionally NO tsc step wired into CI or npm scripts yet; these types are
 * an inert, CI-ready foundation. Jest ignores them.
 *
 * Three groups are defined:
 *   1. The storage adapter + Platform facade shapes (what platform.js builds).
 *   2. The Electron IPC contract, mirroring the namespaces in preload.js.
 *   3. GlobalSettings — the persisted settings bag the hub reads/writes.
 */

// ===================================================================== //
//  Storage + Platform facade                                            //
// ===================================================================== //

/**
 * Uniform async key/value store. Implementations: LocalStorageAdapter,
 * ElectronStorageAdapter, MemoryStorageAdapter.
 *
 * @typedef {Object} StorageAdapter
 * @property {(key: string) => Promise<*>} get   Read a value (parsed); null if absent.
 * @property {(key: string, value: *) => Promise<void>} set   Persist a value.
 * @property {(key: string) => Promise<void>} remove   Delete a single key.
 * @property {() => Promise<string[]>} keys   List all stored keys.
 * @property {() => Promise<void>} clear   Remove every key.
 */

/**
 * Word/phrase prediction + n-gram learning surface.
 *
 * @typedef {Object} PredictionsService
 * @property {() => Promise<*>} getPredictions
 * @property {(data: *) => Promise<*>} savePrediction
 * @property {(data: *) => Promise<*>} saveNgram
 * @property {() => Promise<*>} clearPredictions
 */

/**
 * Text-to-speech + voice settings surface.
 *
 * @typedef {Object} VoiceService
 * @property {() => Promise<GlobalSettings|Object>} getSettings
 * @property {(settings: Object) => Promise<*>} saveSettings
 * @property {(text: string, opts?: Object) => Promise<*>} speak
 */

/**
 * Machine-level controls (volume, power). No-ops on hosts that can't perform
 * them (e.g. a browser tab) rather than throwing.
 *
 * @typedef {Object} SystemService
 * @property {() => Promise<*>} volumeUp
 * @property {() => Promise<*>} volumeDown
 * @property {() => Promise<*>} volumeMute
 * @property {() => Promise<*>} volumeMax
 * @property {(minutes: number) => Promise<*>} shutdownTimer
 * @property {() => Promise<*>} cancelShutdown
 * @property {() => Promise<*>} restart
 * @property {() => Promise<*>} shutdown
 * @property {() => Promise<*>} closeApp
 */

/**
 * External app / window launchers.
 *
 * @typedef {Object} LaunchService
 * @property {() => Promise<*>} messenger
 * @property {() => Promise<*>} search
 * @property {(editorName?: string) => Promise<*>} editor
 * @property {(data: *) => Promise<*>} openWindow
 * @property {() => Promise<*>} aiBridge
 * @property {(url: string) => Promise<*>} openExternal
 */

/**
 * The host-agnostic facade every app consumes via `window.platform`.
 *
 * @typedef {Object} Platform
 * @property {("web"|"electron"|"server")} kind
 * @property {boolean} isElectron
 * @property {StorageAdapter} storage
 * @property {PredictionsService} predictions
 * @property {VoiceService} voice
 * @property {SystemService} system
 * @property {LaunchService} launch
 */

// ===================================================================== //
//  Electron IPC contract — mirrors preload.js namespaces                //
// ===================================================================== //

/**
 * @typedef {Object} ElectronVoiceAPI
 * @property {() => Promise<GlobalSettings>} getSettings
 * @property {(settings: GlobalSettings) => Promise<*>} saveSettings
 * @property {(cb: (settings: GlobalSettings) => void) => void} onSettingsChanged
 */

/**
 * @typedef {Object} ElectronKeyboardAPI
 * @property {() => Promise<*>} getPredictions
 * @property {(data: *) => Promise<*>} savePrediction
 * @property {(data: *) => Promise<*>} saveNgram
 * @property {() => Promise<*>} clearPredictions
 */

/**
 * @typedef {Object} ElectronJournalAPI
 * @property {() => Promise<*>} getEntries
 * @property {(data: *) => Promise<*>} saveEntries
 * @property {() => Promise<*>} getQuestions
 */

/**
 * @typedef {Object} ElectronStreamingAPI
 * @property {() => Promise<*>} getData
 * @property {(showTitle: string) => Promise<*>} getEpisodes
 * @property {(showTitle: string) => Promise<*>} getLastWatched
 * @property {(data: *) => Promise<*>} saveProgress
 * @property {() => Promise<*>} getSearchHistory
 * @property {(term: string) => Promise<*>} saveSearch
 * @property {() => Promise<*>} clearSearchHistory
 * @property {(data: *) => Promise<*>} launch
 */

/**
 * @typedef {Object} ElectronLaunchAPI
 * @property {() => Promise<*>} messenger
 * @property {() => Promise<*>} search
 * @property {() => Promise<*>} ytsearchServer
 * @property {(editorName: string) => Promise<*>} editor
 * @property {(data: *) => Promise<*>} openWindow
 * @property {() => Promise<*>} aiBridge
 */

/**
 * @typedef {Object} ElectronEditorAPI
 * @property {() => Promise<*>} list
 * @property {(editorName: string) => Promise<*>} open
 */

/**
 * @typedef {Object} ElectronWindowAPI
 * @property {() => Promise<*>} focus
 * @property {() => Promise<*>} minimize
 * @property {() => Promise<*>} close
 * @property {() => Promise<*>} toggleFullscreen
 */

/**
 * @typedef {Object} ElectronSystemAPI
 * @property {() => Promise<*>} volumeUp
 * @property {() => Promise<*>} volumeDown
 * @property {() => Promise<*>} volumeMute
 * @property {() => Promise<*>} volumeMax
 * @property {(minutes: number) => Promise<*>} shutdownTimer
 * @property {() => Promise<*>} cancelShutdown
 * @property {() => Promise<*>} restart
 * @property {() => Promise<*>} shutdown
 * @property {() => Promise<*>} closeApp
 */

/**
 * @typedef {Object} ElectronCalendarAPI
 * @property {() => Promise<*>} getSettings
 * @property {(settings: *) => Promise<*>} saveSettings
 * @property {() => Promise<*>} fetchWeek
 */

/**
 * @typedef {Object} ElectronSpeechAPI
 * @property {() => Promise<*>} start
 * @property {() => Promise<*>} stop
 * @property {(cb: (text: string) => void) => void} onResult
 * @property {(cb: (msg: string) => void) => void} onError
 */

/**
 * Optional forward-looking generic key/value namespace. Not present in the
 * current preload.js — ElectronStorageAdapter prefers it when a build exposes
 * it and otherwise falls back to localStorage.
 *
 * @typedef {Object} ElectronStorageAPI
 * @property {(key: string) => Promise<*>} get
 * @property {(key: string, value: *) => Promise<void>} set
 * @property {(key: string) => Promise<void>} remove
 * @property {() => Promise<string[]>} keys
 * @property {() => Promise<void>} [clear]
 */

/**
 * The full `window.electronAPI` surface exposed by preload.js via contextBridge.
 *
 * @typedef {Object} ElectronAPI
 * @property {ElectronVoiceAPI} voice
 * @property {ElectronKeyboardAPI} keyboard
 * @property {ElectronJournalAPI} journal
 * @property {ElectronStreamingAPI} streaming
 * @property {ElectronLaunchAPI} launch
 * @property {ElectronEditorAPI} editor
 * @property {ElectronWindowAPI} window
 * @property {ElectronSystemAPI} system
 * @property {ElectronCalendarAPI} calendar
 * @property {ElectronSpeechAPI} speech
 * @property {{ close: () => Promise<*> }} chrome
 * @property {{ close: () => Promise<*> }} controlBar
 * @property {{ fetchHighlights: (payload: *) => Promise<*> }} news
 * @property {ElectronStorageAPI} [storage]
 * @property {() => Promise<*>} closeToolWindow
 * @property {(data: *) => Promise<*>} aiCall
 * @property {(name: string) => Promise<string>} getPath
 * @property {(url: string) => Promise<*>} openExternal
 * @property {() => Promise<string>} getServerUrl
 * @property {(cb: (signal: *) => void) => void} onNavSignal
 * @property {boolean} isElectron
 */

// ===================================================================== //
//  GlobalSettings                                                       //
// ===================================================================== //

/**
 * The persisted settings bag shared across the hub. Combines the voice/TTS
 * settings (voice-settings.example.json) with the switch-scan settings managed
 * by NarbeScanManager. SettingsStore (sibling PR) will own reading/writing this
 * through `platform.storage`.
 *
 * @typedef {Object} GlobalSettings
 * @property {boolean} [ttsEnabled]      Whether text-to-speech is on.
 * @property {number}  [voiceIndex]      Index into the available voices list.
 * @property {string}  [voiceName]       Preferred voice name (re-resolved on load).
 * @property {number}  [rate]            Speech rate multiplier.
 * @property {number}  [pitch]           Speech pitch multiplier.
 * @property {number}  [volume]          Speech volume (0..1).
 * @property {boolean} [autoScan]        Whether auto-advance scanning is on.
 * @property {number}  [scanSpeedIndex]  Index into the scan-speed cadence table.
 */

// No runtime export — type-only module.
module.exports = {};
