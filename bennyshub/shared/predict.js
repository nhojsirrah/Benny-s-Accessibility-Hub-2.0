/**
 * Unified n-gram word/letter prediction engine (IP-3).
 *
 * This is the single, shared home for the prediction engine that was previously
 * copy-pasted three times: the keyboard tool (`apps/tools/keyboard/predictions.js`,
 * the canonical implementation), a near-identical journal copy, and a third
 * variant baked into the `.io` build. Promoting it here keeps Ben's text-input
 * path on ONE engine so a fix lands once instead of three times.
 *
 * Behaviour is preserved verbatim from the keyboard engine:
 *   - Same `{ frequent_words, bigrams, trigrams }` word-data schema (entries are
 *     `{ count, last_used }`), plus the default letter-frequency tables used for
 *     letter prediction.
 *   - Same recency-weighted `calculateScore`.
 *   - Same trigram -> bigram -> frequency cascade in `getHybridPredictions`
 *     (trigrams scored x100, bigrams x50, then frequent-word completions, then
 *     most-frequent words, then the DEFAULT_WORDS fallback), padded to 6 slots.
 *   - Same `getLetterPredictions` letter cascade and the same learning methods
 *     (`recordLocalWord`, `recordNgram`, `recordLetterNgrams`).
 *
 * What changed (additive, non-behavioural):
 *   - A storage-adapter SEAM. Instead of reaching for `window.electronAPI` or
 *     `fetch()` inline, the engine takes an injected `predictions` provider
 *     (load base data + persist words/ngrams) and an optional `storage` adapter.
 *     Both default to `window.platform` (the IP-6 facade) when present, then fall
 *     back to localStorage, then to a no-op — so the engine never hard-couples to
 *     a host and stays trivially testable with an in-memory corpus.
 *   - A factory surface: `Predict.create({ data, predictions, storage })` returns
 *     an engine instance. `predict(context)` / `learn(text)` are the IP-3 contract
 *     names; `getHybridPredictions` / `getLetterPredictions` / `recordLocalWord`
 *     / `recordNgram` remain as the faithful keyboard-engine surface so existing
 *     call sites can adopt this module unchanged.
 *
 * Loaded as an IIFE-style global via <script src> (sets `window.Predict`),
 * matching the other shared modules, with a dual CommonJS export for jsdom tests.
 */
(function () {
  "use strict";

  const GLOBAL =
    typeof window !== "undefined"
      ? window
      : typeof globalThis !== "undefined"
        ? globalThis
        : {};

  // --- Profiles (IP-7) ----------------------------------------------------
  //
  // The engine's durable storage keys are namespaced by the active profile so
  // each user of the same machine keeps a separate learned corpus. Back-compat
  // is the rule: for the "default" profile the keys are UNCHANGED, so existing
  // data IS the default profile (no migration). For a profile `p`:
  //   "narbe.predict.words" -> "narbe.profile.<p>.predict.words"
  // mirroring SettingsStore's namespacing exactly.
  //
  // The active profile is read from SettingsStore.getActiveProfile() when that
  // module is present (guarded), else "default", and is RE-RESOLVED on every key
  // build so a profile switch takes effect immediately without re-wiring.

  const DEFAULT_PROFILE = "default";
  const PROFILE_PREFIX = "narbe.profile.";
  const PREDICT_KEY_PREFIX = "narbe.predict.";

  /** Resolve the active profile id from SettingsStore if available, else default. */
  function resolveActiveProfile() {
    try {
      const ss = GLOBAL.SettingsStore;
      if (ss && typeof ss.getActiveProfile === "function") {
        const id = ss.getActiveProfile();
        if (typeof id === "string" && id) return id;
      }
    } catch (e) {
      /* fall through to default */
    }
    return DEFAULT_PROFILE;
  }

  /**
   * Namespace a "narbe.*" key for a profile.
   *   default -> key UNCHANGED; p -> "narbe.profile.<p>." + key-without-"narbe."
   */
  function namespaceKey(baseKey, profile) {
    if (!profile || profile === DEFAULT_PROFILE) return baseKey;
    return PROFILE_PREFIX + profile + "." + baseKey.slice("narbe.".length);
  }

  /** Profile-scoped predict storage key for a suffix (re-resolves the profile). */
  function predictStorageKey(suffix, profile) {
    const p = profile || resolveActiveProfile();
    return namespaceKey(PREDICT_KEY_PREFIX + suffix, p);
  }

  const DEFAULT_WORDS = ["YES", "NO", "HELP", "THE", "I", "YOU"];

  // Default English letter frequencies (starting point for letter prediction).
  const DEFAULT_LETTER_FREQUENCIES = {
    E: 127,
    T: 91,
    A: 82,
    O: 75,
    I: 70,
    N: 67,
    S: 63,
    H: 61,
    R: 60,
    D: 43,
    L: 40,
    C: 28,
    U: 28,
    M: 24,
    W: 24,
    F: 22,
    G: 20,
    Y: 20,
    P: 19,
    B: 15,
    V: 10,
    K: 8,
    J: 2,
    X: 2,
    Q: 1,
    Z: 1,
  };

  // Common English letter bigrams.
  const DEFAULT_LETTER_BIGRAMS = {
    TH: 100,
    HE: 95,
    IN: 90,
    ER: 85,
    AN: 80,
    RE: 75,
    ON: 70,
    AT: 65,
    EN: 60,
    ND: 55,
    TI: 50,
    ES: 48,
    OR: 46,
    TE: 44,
    OF: 42,
    ED: 40,
    IS: 38,
    IT: 36,
    AL: 34,
    AR: 32,
    ST: 30,
    TO: 28,
    NT: 26,
    NG: 24,
    SE: 22,
    HA: 20,
    AS: 18,
    OU: 16,
    IO: 14,
    LE: 12,
    VE: 10,
    CO: 9,
    ME: 8,
    DE: 7,
    HI: 6,
  };

  // Common English letter trigrams.
  const DEFAULT_LETTER_TRIGRAMS = {
    THE: 100,
    AND: 90,
    ING: 85,
    ION: 80,
    TIO: 75,
    ENT: 70,
    ATI: 65,
    FOR: 60,
    HER: 55,
    TER: 50,
    HAT: 48,
    THA: 46,
    ERE: 44,
    ATE: 42,
    HIS: 40,
    CON: 38,
    RES: 36,
    VER: 34,
    ALL: 32,
    ONS: 30,
    NCE: 28,
    MEN: 26,
    ITH: 24,
    TED: 22,
    ERS: 20,
  };

  /**
   * Resolve the predictions provider (loads base data, persists words/ngrams).
   * Prefers an explicit injection, then the IP-6 platform facade, else a no-op.
   */
  function resolvePredictionsProvider(injected) {
    if (injected) return injected;
    if (GLOBAL.platform && GLOBAL.platform.predictions) {
      return GLOBAL.platform.predictions;
    }
    return {
      async getPredictions() {
        return null;
      },
      async savePrediction() {},
      async saveNgram() {},
      async clearPredictions() {},
    };
  }

  /**
   * Resolve a key/value storage adapter. Prefers an explicit injection, then the
   * IP-6 platform facade's storage, else a thin localStorage wrapper, else no-op.
   * Reserved for durable user-data persistence; the engine works without it.
   */
  function resolveStorageAdapter(injected) {
    if (injected) return injected;
    if (GLOBAL.platform && GLOBAL.platform.storage) {
      return GLOBAL.platform.storage;
    }
    if (typeof GLOBAL.localStorage !== "undefined") {
      const ls = GLOBAL.localStorage;
      return {
        async get(key) {
          const raw = ls.getItem(String(key));
          if (raw === null || raw === undefined) return null;
          try {
            return JSON.parse(raw);
          } catch {
            return raw;
          }
        },
        async set(key, value) {
          ls.setItem(String(key), JSON.stringify(value ?? null));
        },
        async remove(key) {
          ls.removeItem(String(key));
        },
      };
    }
    return {
      async get() {
        return null;
      },
      async set() {},
      async remove() {},
    };
  }

  /** Shallow-merge a `{ frequent_words, bigrams, trigrams }` shape. */
  function normaliseWordData(data) {
    const d = data || {};
    return {
      frequent_words: d.frequent_words || {},
      bigrams: d.bigrams || {},
      trigrams: d.trigrams || {},
    };
  }

  /**
   * The prediction engine. One instance owns its in-memory word data + letter
   * data and talks to the host only through the injected provider/adapter seams.
   */
  class PredictionEngine {
    /**
     * @param {object} [options]
     * @param {object} [options.data] Initial `{ frequent_words, bigrams, trigrams }`.
     * @param {object} [options.predictions] Predictions provider (load/persist).
     * @param {object} [options.storage] Key/value storage adapter.
     * @param {string[]} [options.defaultWords] Override the fallback word list.
     * @param {string} [options.profile] Pin a profile id; otherwise the active
     *   profile is re-resolved on each key build (from SettingsStore, else default).
     */
    constructor(options = {}) {
      const opts = options || {};
      this.data = normaliseWordData(opts.data);
      this.letterData = { unigrams: {}, bigrams: {}, trigrams: {} };
      this.defaultWords = opts.defaultWords
        ? opts.defaultWords.slice()
        : DEFAULT_WORDS.slice();
      this.predictionsProvider = resolvePredictionsProvider(opts.predictions);
      this.storage = resolveStorageAdapter(opts.storage);
      // When set, pins persistence to one profile; when null, the active profile
      // is re-resolved per call so a SettingsStore profile switch is picked up.
      this.profile =
        typeof opts.profile === "string" && opts.profile ? opts.profile : null;
      this.dataLoaded = false;
      this.initializeLetterFrequencies();
    }

    /** Seed the letter n-gram tables with default English frequencies. */
    initializeLetterFrequencies() {
      const timestamp = new Date().toISOString();
      for (const [letter, count] of Object.entries(
        DEFAULT_LETTER_FREQUENCIES,
      )) {
        this.letterData.unigrams[letter] = { count, last_used: timestamp };
      }
      for (const [bigram, count] of Object.entries(DEFAULT_LETTER_BIGRAMS)) {
        this.letterData.bigrams[bigram] = { count, last_used: timestamp };
      }
      for (const [trigram, count] of Object.entries(DEFAULT_LETTER_TRIGRAMS)) {
        this.letterData.trigrams[trigram] = { count, last_used: timestamp };
      }
    }

    /**
     * Load base word data through the predictions seam. No-ops gracefully when
     * the provider has nothing (the engine then runs on whatever `data` it was
     * constructed with). Resolves to the loaded data.
     */
    async load() {
      try {
        const loaded = await this.predictionsProvider.getPredictions();
        if (loaded && typeof loaded === "object" && loaded.frequent_words) {
          this.data = normaliseWordData(loaded);
        }
      } catch (error) {
        // Distinguish "nothing to load" from "load failed" for the operator.
        console.error("[Predict] Error loading base data:", error);
      }
      this.dataLoaded = true;
      return this.data;
    }

    /**
     * Frequency x recency score. Recency dominates: very recently used entries
     * are boosted enormously so they surface first. Verbatim from the keyboard
     * engine — the constant ladder is load-bearing for the cascade ordering.
     */
    calculateScore(data) {
      const count = (data && data.count) || 0;
      const lastUsed =
        data && data.last_used ? new Date(data.last_used) : new Date(0);
      const hoursSinceUse =
        (Date.now() - lastUsed.getTime()) / (1000 * 60 * 60);
      const daysSinceUse = hoursSinceUse / 24;

      let recencyMultiplier;
      if (hoursSinceUse < 0.5) {
        recencyMultiplier = 100000; // last 30 minutes
      } else if (hoursSinceUse < 1) {
        recencyMultiplier = 50000; // last hour
      } else if (hoursSinceUse < 4) {
        recencyMultiplier = 20000; // last 4 hours
      } else if (daysSinceUse < 1) {
        recencyMultiplier = 5000; // today
      } else if (daysSinceUse < 7) {
        recencyMultiplier = 100; // this week
      } else if (daysSinceUse < 30) {
        recencyMultiplier = 10; // this month
      } else if (daysSinceUse < 90) {
        recencyMultiplier = 1; // last 3 months
      } else {
        recencyMultiplier = 0.1; // older
      }

      return count * recencyMultiplier;
    }

    /**
     * Word prediction with the trigram -> bigram -> frequency cascade.
     *
     * Returns exactly 6 entries (padded with "" when fewer are found), matching
     * the keyboard engine's `getHybridPredictions` contract. `buffer` may contain
     * a "|" caret marker (stripped) and a trailing space (signals "next word").
     */
    getHybridPredictions(buffer) {
      const hasTrailingSpace = String(buffer).replace("|", "").endsWith(" ");
      const cleaned = String(buffer).toUpperCase().replace("|", "").trim();
      const words = cleaned ? cleaned.split(" ") : [];

      if (!words.length) {
        return this.defaultWords.slice();
      }

      let context = "";
      let currentWord = "";

      if (hasTrailingSpace) {
        context = cleaned;
        currentWord = "";
      } else {
        currentWord = words[words.length - 1];
        context = words.slice(0, -1).join(" ");
      }

      const existingWords = new Set(words.map((w) => w.toUpperCase()));
      const finalPredictions = [];

      const shouldExcludeWord = (word) => {
        const upperWord = word.toUpperCase();
        if (hasTrailingSpace && existingWords.has(upperWord)) {
          return true;
        }
        return false;
      };

      // PRIORITY 1: N-gram predictions (trigrams beat bigrams).
      const predictionsNgram = {};

      if (context) {
        const ctxWords = context.split(" ");

        // Trigrams — highest priority (x100 boost).
        if (ctxWords.length >= 2) {
          const triCtx = ctxWords.slice(-2).join(" ");

          for (const [key, data] of Object.entries(this.data.trigrams || {})) {
            const trigramParts = key.split(" ");
            if (trigramParts.length === 3) {
              const trigramContext = trigramParts.slice(0, 2).join(" ");
              const nextWord = trigramParts[2];

              if (trigramContext === triCtx) {
                if (
                  (!currentWord || nextWord.startsWith(currentWord)) &&
                  !shouldExcludeWord(nextWord)
                ) {
                  const score = this.calculateScore(data) * 100;
                  predictionsNgram[nextWord] =
                    (predictionsNgram[nextWord] || 0) + score;
                }
              }
            }
          }
        }

        // Also check 2-word key match (rare legacy data format).
        if (ctxWords.length === 2 && hasTrailingSpace) {
          const exactContext = ctxWords.join(" ");
          for (const [key, data] of Object.entries(this.data.trigrams || {})) {
            if (key.startsWith(exactContext + " ")) {
              const nextWord = key.split(" ").pop();
              if (nextWord && !shouldExcludeWord(nextWord)) {
                const score = this.calculateScore(data) * 100;
                predictionsNgram[nextWord] =
                  (predictionsNgram[nextWord] || 0) + score;
              }
            }
          }
        }

        // Bigrams — medium priority (x50 boost).
        if (ctxWords.length >= 1) {
          const biCtx = ctxWords[ctxWords.length - 1];

          for (const [key, data] of Object.entries(this.data.bigrams || {})) {
            if (key.startsWith(biCtx + " ")) {
              const parts = key.split(" ");
              if (parts.length === 2 && parts[0] === biCtx) {
                const nextWord = parts[1];
                if (
                  (!currentWord || nextWord.startsWith(currentWord)) &&
                  !shouldExcludeWord(nextWord)
                ) {
                  const score = this.calculateScore(data) * 50;
                  predictionsNgram[nextWord] =
                    (predictionsNgram[nextWord] || 0) + score;
                }
              }
            }
          }
        }
      }

      const sortedNgrams = Object.entries(predictionsNgram)
        .sort((a, b) => b[1] - a[1])
        .map(([word]) => word);

      for (const word of sortedNgrams) {
        if (finalPredictions.length < 6 && !finalPredictions.includes(word)) {
          finalPredictions.push(word);
        }
      }

      // PRIORITY 2: Frequent-word completions for a partial word.
      if (
        currentWord &&
        currentWord.length >= 1 &&
        finalPredictions.length < 6
      ) {
        const otherMatches = Object.entries(this.data.frequent_words || {})
          .filter(([word]) => {
            return (
              word.startsWith(currentWord) &&
              word !== currentWord &&
              !finalPredictions.includes(word) &&
              !shouldExcludeWord(word)
            );
          })
          .map(([word, data]) => ({ word, score: this.calculateScore(data) }))
          .sort((a, b) => b.score - a.score);

        for (const match of otherMatches) {
          if (finalPredictions.length < 6) {
            finalPredictions.push(match.word);
          }
        }
      }

      // PRIORITY 3: Most frequent words (after a space, no partial word).
      if (hasTrailingSpace && !currentWord && finalPredictions.length < 6) {
        const sortedWords = Object.entries(this.data.frequent_words || {})
          .filter(
            ([word]) =>
              !finalPredictions.includes(word) && !shouldExcludeWord(word),
          )
          .map(([word, data]) => ({ word, score: this.calculateScore(data) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 20);

        for (const match of sortedWords) {
          if (finalPredictions.length < 6) {
            finalPredictions.push(match.word);
          }
        }
      }

      // PRIORITY 4: Default words fallback.
      for (const word of this.defaultWords) {
        if (finalPredictions.length >= 6) break;
        if (!finalPredictions.includes(word) && !shouldExcludeWord(word)) {
          if (currentWord) {
            if (word.startsWith(currentWord)) {
              finalPredictions.push(word);
            }
          } else {
            finalPredictions.push(word);
          }
        }
      }

      while (finalPredictions.length < 6) {
        finalPredictions.push("");
      }

      return finalPredictions.slice(0, 6);
    }

    /**
     * IP-3 contract alias for word prediction. Identical to
     * `getHybridPredictions` — `context` is the input buffer.
     */
    predict(context) {
      return this.getHybridPredictions(context);
    }

    /**
     * Letter prediction. Mirrors the keyboard engine: when the buffer ends on a
     * space it ranks likely next-word starting letters; otherwise it ranks likely
     * next letters for the partial word, weighting word predictions, frequent
     * words, then letter trigrams/bigrams. Returns up to 6 letters.
     */
    getLetterPredictions(buffer, wordPredictions = []) {
      const cleaned = String(buffer).toUpperCase().replace("|", "");
      const hasTrailingSpace = cleaned.endsWith(" ");
      const trimmedCleaned = cleaned.trim();

      const words = trimmedCleaned.split(" ").filter((w) => w);
      const currentPartialWord = hasTrailingSpace
        ? ""
        : words[words.length - 1] || "";

      if (!currentPartialWord && hasTrailingSpace && words.length > 0) {
        const letterScores = {};
        const allLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

        for (const letter of allLetters) {
          letterScores[letter] = 1;
        }

        if (wordPredictions && wordPredictions.length > 0) {
          wordPredictions.forEach((word, index) => {
            const cleanWord = (word || "").toUpperCase().trim();
            if (cleanWord && cleanWord.length > 0) {
              const startLetter = cleanWord[0];
              const priorityBoost = (6 - index) * 1000;
              letterScores[startLetter] =
                (letterScores[startLetter] || 0) + priorityBoost;
            }
          });
        }

        const lastWord = words[words.length - 1] || "";
        const secondLastWord = words.length > 1 ? words[words.length - 2] : "";

        // Preserved verbatim: the keyboard engine reads `this.data.ngrams`, which
        // is not part of the schema, so these two loops are inert. Kept for exact
        // behavioural parity rather than silently "fixing" a quirk Ben relies on.
        for (const [ngram, data] of Object.entries(this.data.ngrams || {})) {
          if (ngram.startsWith(lastWord + " ")) {
            const nextWord = ngram.split(" ")[1];
            if (nextWord && nextWord.length > 0) {
              const startLetter = nextWord[0].toUpperCase();
              letterScores[startLetter] =
                (letterScores[startLetter] || 0) + data.count * 50;
            }
          }
        }

        if (secondLastWord) {
          const trigramPrefix = secondLastWord + " " + lastWord + " ";
          for (const [ngram, data] of Object.entries(this.data.ngrams || {})) {
            if (ngram.startsWith(trigramPrefix)) {
              const nextWord = ngram.split(" ")[2];
              if (nextWord && nextWord.length > 0) {
                const startLetter = nextWord[0].toUpperCase();
                letterScores[startLetter] =
                  (letterScores[startLetter] || 0) + data.count * 100;
              }
            }
          }
        }

        return Object.entries(letterScores)
          .sort((a, b) => b[1] - a[1])
          .map(([letter]) => letter)
          .slice(0, 6);
      }

      if (!currentPartialWord) {
        return ["T", "A", "I", "S", "W", "H"];
      }

      const letterScores = {};
      const allLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

      for (const letter of allLetters) {
        letterScores[letter] = 1;
      }

      // HIGHEST PRIORITY: next letters drawn from word predictions.
      if (wordPredictions && wordPredictions.length > 0) {
        const partialLen = currentPartialWord.length;
        wordPredictions.forEach((word, index) => {
          const cleanWord = (word || "").toUpperCase().trim();
          if (
            cleanWord &&
            cleanWord.length > partialLen &&
            cleanWord.startsWith(currentPartialWord)
          ) {
            const nextLetter = cleanWord[partialLen];
            const priorityBoost = (6 - index) * 1000;
            letterScores[nextLetter] =
              (letterScores[nextLetter] || 0) + priorityBoost;
          }
        });
      }

      // PRIORITY 2: frequent words starting with the partial word.
      const partialLen = currentPartialWord.length;
      for (const [word, data] of Object.entries(
        this.data.frequent_words || {},
      )) {
        if (word.length > partialLen && word.startsWith(currentPartialWord)) {
          const nextLetter = word[partialLen];
          const score = this.calculateScore(data) * 100;
          letterScores[nextLetter] = (letterScores[nextLetter] || 0) + score;
        }
      }

      // PRIORITY 3: letter trigrams within the current word.
      if (currentPartialWord.length >= 2) {
        const last2 = currentPartialWord.slice(-2);
        for (const [trigram, data] of Object.entries(
          this.letterData.trigrams,
        )) {
          if (trigram.startsWith(last2) && trigram.length === 3) {
            const nextLetter = trigram[2];
            letterScores[nextLetter] =
              (letterScores[nextLetter] || 0) + data.count * 2;
          }
        }
      }

      // PRIORITY 4: letter bigrams within the current word.
      if (currentPartialWord.length >= 1) {
        const last1 = currentPartialWord.slice(-1);
        for (const [bigram, data] of Object.entries(this.letterData.bigrams)) {
          if (bigram.startsWith(last1) && bigram.length === 2) {
            const nextLetter = bigram[1];
            letterScores[nextLetter] =
              (letterScores[nextLetter] || 0) + data.count * 1;
          }
        }
      }

      return Object.entries(letterScores)
        .sort((a, b) => b[1] - a[1])
        .map(([letter]) => letter)
        .slice(0, 6);
    }

    /** Record letter n-grams (unigram/bigram/trigram) from a single word. */
    recordLetterNgrams(word) {
      const upperWord = String(word)
        .toUpperCase()
        .replace(/[^A-Z]/g, "");
      const timestamp = new Date().toISOString();

      for (let i = 0; i < upperWord.length; i++) {
        const letter = upperWord[i];

        if (!this.letterData.unigrams[letter]) {
          this.letterData.unigrams[letter] = { count: 0, last_used: timestamp };
        }
        this.letterData.unigrams[letter].count++;
        this.letterData.unigrams[letter].last_used = timestamp;

        if (i >= 1) {
          const bigram = upperWord.slice(i - 1, i + 1);
          if (!this.letterData.bigrams[bigram]) {
            this.letterData.bigrams[bigram] = {
              count: 0,
              last_used: timestamp,
            };
          }
          this.letterData.bigrams[bigram].count++;
          this.letterData.bigrams[bigram].last_used = timestamp;
        }

        if (i >= 2) {
          const trigram = upperWord.slice(i - 2, i + 1);
          if (!this.letterData.trigrams[trigram]) {
            this.letterData.trigrams[trigram] = {
              count: 0,
              last_used: timestamp,
            };
          }
          this.letterData.trigrams[trigram].count++;
          this.letterData.trigrams[trigram].last_used = timestamp;
        }
      }
    }

    /** Update in-memory frequent-word data for a single word (no persistence). */
    recordLocalWord(word) {
      const upperWord = String(word).toUpperCase();
      if (!upperWord) return;
      const timestamp = new Date().toISOString();

      if (!this.data.frequent_words[upperWord]) {
        this.data.frequent_words[upperWord] = {
          count: 0,
          last_used: timestamp,
        };
      }
      this.data.frequent_words[upperWord].count++;
      this.data.frequent_words[upperWord].last_used = timestamp;
    }

    /**
     * Update in-memory bigram/trigram data for `context -> nextWord` (no
     * persistence). If the context already ends with `nextWord` (a known caller
     * quirk where the buffer was updated first), the duplicate tail is dropped.
     */
    recordNgram(context, nextWord) {
      let ctxWords = String(context)
        .toUpperCase()
        .split(" ")
        .filter((w) => w);
      const nextUpper = String(nextWord).toUpperCase();
      const timestamp = new Date().toISOString();

      if (ctxWords.length > 0 && ctxWords[ctxWords.length - 1] === nextUpper) {
        ctxWords.pop();
      }

      if (ctxWords.length >= 1) {
        const bigramKey = `${ctxWords[ctxWords.length - 1]} ${nextUpper}`;
        if (!this.data.bigrams[bigramKey]) {
          this.data.bigrams[bigramKey] = { count: 0, last_used: timestamp };
        }
        this.data.bigrams[bigramKey].count++;
        this.data.bigrams[bigramKey].last_used = timestamp;
      }

      if (ctxWords.length >= 2) {
        const trigramKey = `${ctxWords.slice(-2).join(" ")} ${nextUpper}`;
        if (!this.data.trigrams[trigramKey]) {
          this.data.trigrams[trigramKey] = { count: 0, last_used: timestamp };
        }
        this.data.trigrams[trigramKey].count++;
        this.data.trigrams[trigramKey].last_used = timestamp;
      }
    }

    /**
     * IP-3 contract learn step. Tokenises `text` into words and folds them into
     * the in-memory model: each word bumps its frequency + letter n-grams, and
     * each adjacency bumps the matching bigram/trigram. In-memory only — durable
     * persistence is the caller's decision via `saveWordToFile` / `saveNgramToFile`.
     */
    learn(text) {
      const words = String(text)
        .toUpperCase()
        .split(/\s+/)
        .filter((w) => w);

      words.forEach((word, index) => {
        this.recordLocalWord(word);
        this.recordLetterNgrams(word);
        if (index >= 1) {
          this.recordNgram(words.slice(0, index).join(" "), word);
        }
      });
    }

    /**
     * Persist a word through the predictions seam (called after Ben confirms the
     * text, e.g. speaks it 3x in the keyboard flow). Also updates in-memory data.
     */
    async saveWordToFile(word) {
      const upperWord = String(word).toUpperCase();
      const timestamp = new Date().toISOString();
      this.recordLocalWord(upperWord);
      try {
        await this.predictionsProvider.savePrediction({
          word: upperWord,
          timestamp,
        });
      } catch (error) {
        console.error("[Predict] Error saving word:", error);
      }
    }

    /** Persist an n-gram through the predictions seam. Also updates in-memory. */
    async saveNgramToFile(context, nextWord) {
      const timestamp = new Date().toISOString();
      const ctxWords = String(context)
        .toUpperCase()
        .split(" ")
        .filter((w) => w);
      this.recordNgram(context, nextWord);
      const cleanContext = ctxWords.join(" ");
      if (!cleanContext) return;
      try {
        await this.predictionsProvider.saveNgram({
          context: cleanContext,
          next_word: nextWord,
          timestamp,
        });
      } catch (error) {
        console.error("[Predict] Error saving n-gram:", error);
      }
    }

    /** Current in-memory word data (the `{ frequent_words, bigrams, trigrams }`). */
    getData() {
      return this.data;
    }

    /** Replace the in-memory word data (e.g. after an external reload). */
    setData(data) {
      this.data = normaliseWordData(data);
      return this.data;
    }

    // --- Profile-scoped durable storage (IP-7) ---------------------------
    //
    // The prediction MATH is untouched; only the storage destination is
    // profile-scoped. These use the injected `storage` adapter (localStorage by
    // default) under a key that re-resolves the active profile on each call.

    /** The active profile this engine persists under (pinned or re-resolved). */
    activeProfile() {
      return this.profile || resolveActiveProfile();
    }

    /**
     * Profile-scoped storage key for a suffix.
     *   default -> "narbe.predict.<suffix>"
     *   p       -> "narbe.profile.<p>.predict.<suffix>"
     */
    storageKey(suffix) {
      return predictStorageKey(suffix, this.activeProfile());
    }

    /**
     * Persist the in-memory word corpus to durable storage under the active
     * profile's key. Returns the key written. No-op semantics if storage is a
     * no-op adapter.
     */
    async persist() {
      const key = this.storageKey("words");
      try {
        await this.storage.set(key, this.data);
      } catch (error) {
        console.error("[Predict] Error persisting corpus:", error);
      }
      return key;
    }

    /**
     * Restore the word corpus from durable storage for the active profile. When
     * nothing is stored the in-memory data is left as-is. Resolves to the data.
     */
    async restore() {
      const key = this.storageKey("words");
      try {
        const stored = await this.storage.get(key);
        if (stored && typeof stored === "object" && stored.frequent_words) {
          this.data = normaliseWordData(stored);
        }
      } catch (error) {
        console.error("[Predict] Error restoring corpus:", error);
      }
      return this.data;
    }
  }

  /** Factory: build an engine instance. The IP-3 entry point. */
  function create(options) {
    return new PredictionEngine(options || {});
  }

  const Predict = {
    create,
    PredictionEngine,
    DEFAULT_WORDS,
    DEFAULT_LETTER_FREQUENCIES,
    DEFAULT_LETTER_BIGRAMS,
    DEFAULT_LETTER_TRIGRAMS,
    // Profiles (IP-7): exposed so the hub/tests can resolve and namespace keys.
    DEFAULT_PROFILE,
    resolveActiveProfile,
    storageKey: predictStorageKey,
  };

  if (typeof window !== "undefined") {
    window.Predict = Predict;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Predict;
  }
})();
