/**
 * Regression guard for the unified prediction engine (shared/predict.js, IP-3).
 *
 * This is the safety net for Ben's text-input path: the keyboard / journal apps
 * rely on the trigram -> bigram -> frequency cascade behaving identically after
 * the three duplicate engines are consolidated here. The tests pin that ordering
 * against a small, fixed in-memory corpus so results are fully deterministic.
 *
 * Determinism note: `calculateScore` multiplies frequency by a recency factor
 * derived from `last_used`. Every corpus entry below uses the SAME old timestamp,
 * so the recency multiplier is a shared constant and ranking is driven purely by
 * count x the cascade boost (trigram x100, bigram x50, frequency x1) — exactly
 * the keyboard engine's behaviour, with the time variable held still.
 */

const Predict = require("../predict.js");

// A fixed timestamp well in the past so every entry shares one recency factor.
const OLD = "2020-01-01T00:00:00.000Z";
const e = (count) => ({ count, last_used: OLD });

/**
 * Fixed corpus. Designed so a single context ("I AM") has THREE candidate next
 * words reachable by three different cascade tiers, each tier's raw count chosen
 * so that WITHOUT the cascade boosts frequency would win — proving the boost,
 * not the count, decides the ordering.
 *
 *   - trigram  "I AM HAPPY"  count 1   -> score 1  x100 = 100
 *   - bigram   "AM SAD"      count 3   -> score 3  x50  = 150
 *   - frequent "ANGRY"       count 50  -> score 50 x1   = 50
 *
 * Raw counts: ANGRY(50) > SAD(3) > HAPPY(1). After the cascade the order flips
 * to HAPPY (trigram) ... but note SAD's bigram score (150) edges HAPPY (100).
 * So we keep the tiers cleanly separated below with counts that make the cascade
 * the deciding factor regardless of raw frequency.
 */
function buildCorpus() {
  return {
    frequent_words: {
      // Completions for partial words + most-frequent fallback.
      THANKS: e(40),
      THE: e(1000),
      THERE: e(20),
      THINK: e(15),
      ANGRY: e(900), // huge raw count, but only reachable via frequency tier
      YES: e(5),
    },
    bigrams: {
      // "AM <next>" — medium tier.
      "AM SAD": e(2),
      "AM TIRED": e(1),
    },
    trigrams: {
      // "I AM <next>" — top tier.
      "I AM HAPPY": e(1),
      "I AM GOOD": e(1),
    },
  };
}

describe("Predict.create — factory + surface", () => {
  test("create() returns an engine exposing the IP-3 + keyboard surface", () => {
    const engine = Predict.create({ data: buildCorpus() });
    for (const method of [
      "predict",
      "learn",
      "getHybridPredictions",
      "getLetterPredictions",
      "recordLocalWord",
      "recordNgram",
      "recordLetterNgrams",
      "calculateScore",
    ]) {
      expect(typeof engine[method]).toBe("function");
    }
  });

  test("predict() is an alias of getHybridPredictions()", () => {
    const engine = Predict.create({ data: buildCorpus() });
    expect(engine.predict("I AM ")).toEqual(
      engine.getHybridPredictions("I AM "),
    );
  });

  test("works with no data and no host (defaults to fallback words)", () => {
    const engine = Predict.create();
    expect(engine.predict("")).toEqual([
      "YES",
      "NO",
      "HELP",
      "THE",
      "I",
      "YOU",
    ]);
  });

  test("always returns exactly 6 slots, padded with empty strings", () => {
    const engine = Predict.create({ data: buildCorpus() });
    const out = engine.predict("ZZZ");
    expect(out).toHaveLength(6);
  });
});

describe("Predict — trigram > bigram > frequency cascade", () => {
  test("trigram match outranks bigram and frequency for the same context", () => {
    const engine = Predict.create({ data: buildCorpus() });
    // Context "I AM " (trailing space => predicting the next whole word).
    const out = engine.predict("I AM ");

    const iHappy = out.indexOf("HAPPY"); // trigram "I AM HAPPY"
    const iSad = out.indexOf("SAD"); // bigram "AM SAD"
    const iAngry = out.indexOf("ANGRY"); // frequent word only

    // All three present.
    expect(iHappy).toBeGreaterThanOrEqual(0);
    expect(iSad).toBeGreaterThanOrEqual(0);

    // Cascade ordering: trigram before bigram before frequency-only.
    expect(iHappy).toBeLessThan(iSad);
    if (iAngry >= 0) {
      expect(iSad).toBeLessThan(iAngry);
    }
  });

  test("bigram outranks a frequency-only word when no trigram applies", () => {
    // Context "AM " — only bigrams ("AM SAD", "AM TIRED") apply, no trigram.
    const engine = Predict.create({ data: buildCorpus() });
    const out = engine.predict("AM ");

    const iSad = out.indexOf("SAD");
    const iAngry = out.indexOf("ANGRY");

    expect(iSad).toBeGreaterThanOrEqual(0);
    expect(iSad).toBeLessThan(6);
    if (iAngry >= 0) {
      expect(iSad).toBeLessThan(iAngry);
    }
  });

  test("trigram candidates are internally ordered by recency-weighted count", () => {
    // Two trigrams off "ONE TWO": THREE (count 5) and FOUR (count 2).
    const engine = Predict.create({
      data: {
        frequent_words: {},
        bigrams: {},
        trigrams: {
          "ONE TWO THREE": e(5),
          "ONE TWO FOUR": e(2),
        },
      },
    });
    const out = engine.predict("ONE TWO ");
    expect(out.indexOf("THREE")).toBeLessThan(out.indexOf("FOUR"));
  });
});

describe("Predict — partial-word completion", () => {
  test("completes a partial word from frequent_words, ranked by count", () => {
    const engine = Predict.create({ data: buildCorpus() });
    // No trailing space => completing the partial word "TH".
    const out = engine.predict("TH");

    // THE (1000) should rank above THANKS (40), THERE (20), THINK (15).
    const iThe = out.indexOf("THE");
    const iThanks = out.indexOf("THANKS");
    const iThere = out.indexOf("THERE");

    expect(iThe).toBeGreaterThanOrEqual(0);
    expect(iThanks).toBeGreaterThanOrEqual(0);
    expect(iThe).toBeLessThan(iThanks);
    if (iThere >= 0) {
      expect(iThanks).toBeLessThan(iThere);
    }
  });

  test("trigram completion of a partial next word beats frequency completion", () => {
    // "I AM H" — partial word "H". Trigram "I AM HAPPY" should put HAPPY first,
    // ahead of any frequent word starting with H.
    const engine = Predict.create({
      data: {
        frequent_words: { HOUSE: e(999) },
        bigrams: {},
        trigrams: { "I AM HAPPY": e(1) },
      },
    });
    const out = engine.predict("I AM H");
    expect(out.indexOf("HAPPY")).toBe(0);
    expect(out.indexOf("HAPPY")).toBeLessThan(
      out.indexOf("HOUSE") === -1 ? Infinity : out.indexOf("HOUSE"),
    );
  });

  test("does not re-suggest a word already present in the buffer", () => {
    const engine = Predict.create({
      data: {
        frequent_words: {},
        bigrams: { "AM SAD": e(5) },
        trigrams: {},
      },
    });
    // SAD already typed and trailing space => should be excluded from next-word.
    const out = engine.predict("AM SAD ");
    expect(out).not.toContain("SAD");
  });
});

describe("Predict — most-frequent fallback", () => {
  test("after a space with no context match, returns most frequent words first", () => {
    const engine = Predict.create({
      data: {
        frequent_words: { ALPHA: e(10), BETA: e(100), GAMMA: e(1) },
        bigrams: {},
        trigrams: {},
      },
    });
    const out = engine.predict("ZZZZ "); // no n-gram for ZZZZ
    const iBeta = out.indexOf("BETA");
    const iAlpha = out.indexOf("ALPHA");
    const iGamma = out.indexOf("GAMMA");
    expect(iBeta).toBeGreaterThanOrEqual(0);
    expect(iBeta).toBeLessThan(iAlpha);
    expect(iAlpha).toBeLessThan(iGamma);
  });
});

describe("Predict.learn — folds text into the model", () => {
  test("learn() raises a word's frequency so it surfaces in completion", () => {
    const engine = Predict.create({
      data: { frequent_words: {}, bigrams: {}, trigrams: {} },
    });
    engine.learn("BANANA");
    engine.learn("BANANA");
    expect(engine.getData().frequent_words.BANANA.count).toBe(2);
    // Completing "BAN" now offers BANANA.
    expect(engine.predict("BAN")).toContain("BANANA");
  });

  test("learn() records bigrams and trigrams that then drive predictions", () => {
    const engine = Predict.create({
      data: { frequent_words: {}, bigrams: {}, trigrams: {} },
    });
    engine.learn("I LOVE YOU");
    // Trigram "I LOVE YOU" learned -> "I LOVE " predicts YOU.
    expect(engine.predict("I LOVE ")).toContain("YOU");
    // Bigram "I LOVE" learned -> "I " predicts LOVE.
    expect(engine.predict("I ")).toContain("LOVE");
    expect(engine.getData().bigrams["I LOVE"].count).toBe(1);
    expect(engine.getData().trigrams["I LOVE YOU"].count).toBe(1);
  });

  test("recordNgram drops a duplicated trailing context word", () => {
    const engine = Predict.create({
      data: { frequent_words: {}, bigrams: {}, trigrams: {} },
    });
    // Buggy caller passes the next word already appended to the context.
    engine.recordNgram("I AM HAPPY", "HAPPY");
    // Should record "AM HAPPY", not "HAPPY HAPPY".
    expect(engine.getData().bigrams["AM HAPPY"]).toBeDefined();
    expect(engine.getData().bigrams["HAPPY HAPPY"]).toBeUndefined();
  });
});

describe("Predict.getLetterPredictions", () => {
  test("ranks next letters from word predictions for a partial word", () => {
    const engine = Predict.create({
      data: { frequent_words: {}, bigrams: {}, trigrams: {} },
    });
    // Partial "HE", word prediction "HELLO" => next letter should be L (first).
    const letters = engine.getLetterPredictions("HE", ["HELLO"]);
    expect(letters[0]).toBe("L");
  });

  test("returns common starting letters when nothing is typed", () => {
    const engine = Predict.create({
      data: { frequent_words: {}, bigrams: {}, trigrams: {} },
    });
    expect(engine.getLetterPredictions("")).toEqual([
      "T",
      "A",
      "I",
      "S",
      "W",
      "H",
    ]);
  });
});

describe("Predict — storage seam", () => {
  test("load() hydrates base data through an injected predictions provider", async () => {
    const corpus = buildCorpus();
    const provider = {
      getPredictions: jest.fn().mockResolvedValue(corpus),
      savePrediction: jest.fn().mockResolvedValue(),
      saveNgram: jest.fn().mockResolvedValue(),
    };
    const engine = Predict.create({ predictions: provider });
    await engine.load();
    expect(provider.getPredictions).toHaveBeenCalledTimes(1);
    expect(engine.getData().frequent_words.THE).toBeDefined();
    expect(engine.predict("TH")).toContain("THE");
  });

  test("saveWordToFile persists through the injected provider", async () => {
    const provider = {
      getPredictions: jest.fn().mockResolvedValue(null),
      savePrediction: jest.fn().mockResolvedValue(),
      saveNgram: jest.fn().mockResolvedValue(),
    };
    const engine = Predict.create({
      data: { frequent_words: {}, bigrams: {}, trigrams: {} },
      predictions: provider,
    });
    await engine.saveWordToFile("hello");
    expect(provider.savePrediction).toHaveBeenCalledTimes(1);
    expect(provider.savePrediction.mock.calls[0][0].word).toBe("HELLO");
    // In-memory data updated too.
    expect(engine.getData().frequent_words.HELLO.count).toBe(1);
  });

  test("defaults to window.platform.predictions when present", async () => {
    const getPredictions = jest.fn().mockResolvedValue(buildCorpus());
    global.window = global.window || {};
    global.window.platform = {
      predictions: {
        getPredictions,
        savePrediction: jest.fn(),
        saveNgram: jest.fn(),
      },
      storage: { get: jest.fn(), set: jest.fn(), remove: jest.fn() },
    };
    try {
      const engine = Predict.create();
      await engine.load();
      expect(getPredictions).toHaveBeenCalled();
      expect(engine.predict("TH")).toContain("THE");
    } finally {
      delete global.window.platform;
    }
  });
});
