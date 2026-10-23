import { describe, expect, it, vi } from "vitest";
import type { KanaEngine } from "../../../src/lib/kanaEngine";
import { missingLetterReadings, searchMissingLetter } from "../../../src/lib/missingLetterCorrection";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { requiresExplicitAcceptance } from "../../../src/lib/readingAssessment";
import { defaultSettings } from "../../../src/lib/settings";
import { romajiToKana } from "../../../src/lib/romajiKana";

function harness() {
  const engine: KanaEngine = {
    verify: vi.fn().mockResolvedValue("unverified"), search: vi.fn(async reading => ({
      dictionaryRevision: "test", truncated: false,
      candidates: reading === "じかん" ? [{
        text: "時間", reading, cost: 100, tokens: [{
          text: "時間", reading,
          from: 0, to: 3, source: "mozc" as const, entryId: "test", lid: 0, rid: 0, wordCost: 100
        }]
      }] : [],
    }))
  };
  const transport = { models: vi.fn(), generate: vi.fn().mockResolvedValue({ response: '{"order":["repair-0"]}' }) };
  return { engine, transport };
}

describe("single missing romaji letter", () => {
  it("automatically generates internal insertions and coalesces equal readings", () => {
    const { plans } = missingLetterReadings("jkan");
    expect(plans.map(p => p.reading)).toContain("じかん");
    expect(plans.map(p => p.reading)).toContain("じゃかん");
    expect(new Set(plans.map(p => p.reading)).size).toBe(plans.length);
    expect(plans.every(p => p.value.length === 5 && p.offset < 4)).toBe(true);
    expect(plans.find(p => p.reading === "じかん")).toMatchObject({ offset: 1, inserted: "i", value: "jikan" });
  });
  it("can explore already interpretable kana but excludes suffix completion and negation changes", () => {
    expect(missingLetterReadings("kakuniwoshite").plans.some(p => p.reading === "かくにんをして")).toBe(true);
    expect(missingLetterReadings("ikima").plans.some(p => p.value === "ikimas")).toBe(false);
    expect(missingLetterReadings("ikanai").plans.every(p => p.reading.includes("ない"))).toBe(true);
    expect(missingLetterReadings("a".repeat(97)).truncated).toBe(true);
    expect(missingLetterReadings("https://QX-73").plans).toEqual([]);
  });
  it("reaches a missing n near the end of a sentence within the search budget", async () => {
    const input = "ashitanokaiginoshiryouwosakuseishitekakunishitekudasai.";
    const repaired = "ashitanokaiginoshiryouwosakuseishitekakuninshitekudasai.";
    const reading = romajiToKana(repaired).kana;
    expect(missingLetterReadings(input).plans.findIndex(plan => plan.reading === reading)).toBeLessThan(128);
    const { engine, transport } = harness();
    const target = reading.replace(/\.$/, "");
    vi.mocked(engine.search).mockImplementation(async value => ({
      dictionaryRevision: "test", truncated: false, candidates: value === target ? [{
        text: "明日の会議の資料を作成して確認してください", reading: value, cost: 100,
        tokens: [{ text: "明日の会議の資料を作成して確認してください", reading: value, from: 0,
          to: [...value].length, source: "mozc", entryId: "late-n", lid: 0, rid: 0, wordCost: 100 }],
      }] : [],
    }));
    const result = await searchMissingLetter(input, defaultSettings, transport, { kanaEngine: engine });
    expect(result?.text).toBe("明日の会議の資料を作成して確認してください。");
    expect(result?.romajiCorrection?.after).toBe(repaired.replace(/\.$/, "。"));
    expect(vi.mocked(engine.search).mock.calls.length).toBeLessThanOrEqual(128);
  });
  it("shares exploration across editable parts separated by a protected literal", async () => {
    const { engine, transport } = harness();
    const prefix = "ashitanokaiginoshiryouwosakuseishitekudasai";
    const prefixReading = romajiToKana(prefix).kana;
    const repaired = "かくにんしてください";
    vi.mocked(engine.search).mockImplementation(async reading => ({
      dictionaryRevision: "test", truncated: false, candidates: [prefixReading, repaired].includes(reading) ? [{
        text: reading === repaired ? "確認してください" : "明日の会議の資料を作成してください", reading, cost: 100,
        tokens: [{ text: reading === repaired ? "確認してください" : "明日の会議の資料を作成してください", reading,
          from: 0, to: [...reading].length, source: "mozc", entryId: reading, lid: 0, rid: 0, wordCost: 100 }],
      }] : [],
    }));
    const result = await searchMissingLetter(`${prefix}\n\x60QX-73\x60\nkakunishitekudasai`, defaultSettings, transport, { kanaEngine: engine });
    expect(result?.text).toBe("明日の会議の資料を作成してください\nQX-73\n確認してください");
    expect(result?.romajiCorrection?.inserted).toBe("n");
    expect(vi.mocked(engine.search).mock.calls.length).toBeLessThanOrEqual(128);
  });
  it("keeps different repaired readings instead of filling the pool with cheap homophones", async () => {
    const { engine, transport } = harness();
    const readings = missingLetterReadings("kakuniwoshite").plans.slice(0, 9).map(plan => plan.reading);
    const desired = readings[8];
    vi.mocked(engine.search).mockImplementation(async reading => {
      const index = readings.indexOf(reading);
      return { dictionaryRevision: "test", truncated: false, candidates: index < 0 ? [] : ["甲", "乙", "丙"].map(text => ({
        text: text + reading, reading, cost: index * 100,
        tokens: [{ text: text + reading, reading, from: 0, to: [...reading].length, source: "mozc" as const,
          entryId: text, lid: 0, rid: 0, wordCost: index * 100 }],
      })) };
    });
    transport.generate.mockImplementation(async (_provider, _url, request) => {
      const prompt = JSON.parse(request.prompt);
      const selected = prompt.candidates.find((candidate: { reading: string }) => candidate.reading === desired);
      expect(selected).toBeDefined();
      return { response: JSON.stringify({ order: [selected.id] }) };
    });
    const result = await searchMissingLetter("kakuniwoshite", defaultSettings, transport, { kanaEngine: engine });
    expect(result?.reviewKana).toBe(desired);
    expect(result?.session?.candidates).toHaveLength(24);
  });
  it("tries model correction when all dictionary repairs are rejected", async () => {
    const { engine, transport } = harness();
    // Select a generated internal insertion rather than suffix completion.
    const plan = missingLetterReadings("ashitanoyottei").plans[0];
    vi.mocked(engine.search).mockImplementation(async reading => ({
      dictionaryRevision: "test", truncated: false, candidates: reading === plan.reading ? [{
        text: "仮候補", reading, cost: 100, tokens: [{ text: "仮候補", reading, from: 0,
          to: [...reading].length, source: "mozc", entryId: "repair", lid: 0, rid: 0, wordCost: 100 }],
      }] : [],
    }));
    transport.generate.mockResolvedValueOnce({ response: '{"order":[]}' })
      .mockResolvedValueOnce({ response: '{"convertedText":"明日の予定","completedKana":"あしたのよてい"}' });
    const result = await convertRomajiToJapaneseDetailed("ashitanoyottei", defaultSettings, transport, { kanaEngine: engine });
    expect(result.text).toBe("明日の予定");
    expect(result.conversionStrategy).toBe("correction");
    expect(result.attempts?.map(attempt => attempt.stage)).toEqual(["normal", "correction"]);
    expect(transport.generate).toHaveBeenCalledTimes(2);
  });
  it("ranks dictionary-backed repairs, including a single candidate, without changing original input", async () => {
    const { engine, transport } = harness();
    const result = await searchMissingLetter("jkan", defaultSettings, transport, { kanaEngine: engine });
    expect(result).toMatchObject({
      text: "時間", reviewKana: "じかん", conversionStrategy: "correction",
      romajiCorrection: { before: "jkan", after: "jikan", inserted: "i" }, changes: { kind: "correction", sourceReading: "jかん", correctedReading: "じかん" }
    });
    expect(requiresExplicitAcceptance(result!)).toBe(true);
    expect(result!.session!.originalInput).toBe("jkan");
    expect(transport.generate).toHaveBeenCalledOnce();
    const prompt = JSON.parse(transport.generate.mock.calls[0][2].prompt);
    expect(prompt.originalInput).toBe("jkan");
    expect(prompt.candidates[0]).toMatchObject({ kind: "correction", cost: 3100, reading: "じかん", edit: { inserted: "i" } });
  });
  it("preserves protected text, digits and newlines", async () => {
    const { engine, transport } = harness();
    const result = await searchMissingLetter("`QX-73`\n15jkan", defaultSettings, transport, { kanaEngine: engine });
    expect(result?.text).toBe("QX-73\n15時間");
    expect(result?.changes?.sourceReading).toBe("QX-73\n15jかん");
    expect(vi.mocked(engine.search).mock.calls.every(([reading]) => !reading.includes("QX"))).toBe(true);
  });
  it("returns no repair for an unchanged reading or unavailable dictionary paths", async () => {
    const { engine, transport } = harness();
    vi.mocked(engine.search).mockResolvedValue({ candidates: [], truncated: false, dictionaryRevision: "test" });
    expect(await searchMissingLetter("hon", defaultSettings, transport, { kanaEngine: engine })).toBeUndefined();
    expect(transport.generate).not.toHaveBeenCalled();
  });
  it("allows rejection of every repair instead of forcing the cheapest word", async () => {
    const { engine, transport } = harness();
    transport.generate.mockResolvedValue({ response: '{"order":[]}' });
    expect(await searchMissingLetter("jkan", defaultSettings, transport, { kanaEngine: engine }))
      .toMatchObject({ suggestionRejected: true, rejectionDetail: "no-plausible-candidate" });
  });
  it.each([
    "not JSON", "null", "[]", '{}', '{"order":"repair-0"}',
    '{"order":["unknown"]}', '{"order":["repair-0","repair-0"]}',
    '{"order":[],"explanation":"no"}',
  ])("does not expose or regenerate an unselected correction after invalid ranking: %s", async response => {
    const { engine, transport } = harness();
    transport.generate.mockResolvedValue({ response });
    const onLocalCandidates = vi.fn();
    const result = await convertRomajiToJapaneseDetailed("jkan", defaultSettings, transport, {
      kanaEngine: engine, onLocalCandidates,
    });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, rejectionDetail: "ranking-invalid" });
    expect(result.session).toBeUndefined();
    expect(result.attempts?.map(attempt => attempt.stage)).toEqual(["normal", "correction"]);
    expect(onLocalCandidates).not.toHaveBeenCalled();
    expect(transport.generate).toHaveBeenCalledOnce();
  });
  it("propagates a failed correction ranking connection without selecting a local candidate or generating again", async () => {
    const { engine, transport } = harness();
    const failure = new Error("ranking offline");
    transport.generate.mockRejectedValue(failure);
    await expect(convertRomajiToJapaneseDetailed("jkan", defaultSettings, transport, { kanaEngine: engine }))
      .rejects.toBe(failure);
    expect(transport.generate).toHaveBeenCalledOnce();
  });
  it("uses the same missing-letter search for an explicit correction request", async () => {
    const { engine, transport } = harness();
    const result = await convertRomajiToJapaneseDetailed("jkan", defaultSettings, transport, {
      kanaEngine: engine, purpose: "correction",
    });
    expect(result.text).toBe("時間");
    expect(result.romajiCorrection).toMatchObject({ before: "jkan", after: "jikan" });
    expect(transport.generate).toHaveBeenCalledOnce();
  });
  it("cancels an in-flight correction ranking without returning the local repair", async () => {
    const { engine, transport } = harness();
    const controller = new AbortController();
    transport.generate.mockImplementation(async () => {
      controller.abort();
      return { response: '{"order":["repair-0"]}' };
    });
    await expect(searchMissingLetter("jkan", defaultSettings, transport, {
      kanaEngine: engine, signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("bounds dictionary requests and reports truncated exploration", async () => {
    const { engine, transport } = harness();
    const metrics = vi.fn();
    await searchMissingLetter("kakuninshitekudasai".repeat(3), defaultSettings, transport, { kanaEngine: engine, onMissingLetterSearch: metrics });
    expect(vi.mocked(engine.search).mock.calls.length).toBeLessThanOrEqual(128);
    expect(metrics.mock.calls[0][0]).toMatchObject({ truncated: true, candidates: 0 });
  });
  it("propagates cancellation and dictionary failures", async () => {
    const { engine, transport } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(searchMissingLetter("jkan", defaultSettings, transport, { kanaEngine: engine, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(engine.search).not.toHaveBeenCalled();
    vi.mocked(engine.search).mockRejectedValue(new Error("engine offline"));
    await expect(searchMissingLetter("jkan", defaultSettings, transport, { kanaEngine: engine })).rejects.toThrow("engine offline");
  });
  it("stops dictionary exploration immediately after cancellation during a request", async () => {
    const { engine, transport } = harness();
    const controller = new AbortController();
    vi.mocked(engine.search).mockImplementation(async () => {
      controller.abort(); return { candidates: [], truncated: false, dictionaryRevision: "test" };
    });
    await expect(searchMissingLetter("jkan", defaultSettings, transport, { kanaEngine: engine, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(engine.search).toHaveBeenCalledOnce();
    expect(transport.generate).not.toHaveBeenCalled();
  });
  it("enters the bounded correction stage only after normal rejection and can disable the experiment", async () => {
    const { engine, transport } = harness();
    const result = await convertRomajiToJapaneseDetailed("jkan", defaultSettings, transport, { kanaEngine: engine });
    expect(result.attempts?.map(attempt => attempt.stage)).toEqual(["normal", "correction"]);
    expect(result.text).toBe("時間");
    vi.mocked(engine.search).mockClear();
    transport.generate.mockResolvedValue({ response: '{"convertedText":"","completedKana":""}' });
    await convertRomajiToJapaneseDetailed("jkan", defaultSettings, transport, { kanaEngine: engine, missingLetterCorrection: false });
    expect(engine.search).not.toHaveBeenCalled();
  });
  it("leaves a valid normal conversion alone without starting missing-letter exploration", async () => {
    const { engine, transport } = harness();
    const metrics = vi.fn();
    const result = await convertRomajiToJapaneseDetailed("jikan", defaultSettings, transport, {
      kanaEngine: engine, onMissingLetterSearch: metrics,
    });
    expect(result.text).toBe("時間");
    expect(result.conversionStrategy).toBeUndefined();
    expect(metrics).not.toHaveBeenCalled();
    expect(transport.generate).not.toHaveBeenCalled();
    expect(engine.search).toHaveBeenCalledOnce();
  });
});
