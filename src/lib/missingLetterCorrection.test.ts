import { describe, expect, it, vi } from "vitest";
import { missingLetterReadings, searchMissingLetter } from "./missingLetterCorrection";
import { defaultSettings } from "./settings";
import type { KanaEngine } from "./kanaEngine";
import { requiresExplicitAcceptance } from "./readingAssessment";
import { convertRomajiToJapaneseDetailed } from "./ollama";

function harness() {
  const engine: KanaEngine = { verify: vi.fn(), search: vi.fn(async reading => ({
    dictionaryRevision: "test", truncated: false,
    candidates: reading === "じかん" ? [{ text: "時間", reading, cost: 100, tokens: [{ text: "時間", reading,
      from: 0, to: 3, source: "mozc" as const, entryId: "test", lid: 0, rid: 0, wordCost: 100 }] }] : [],
  })) };
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
  it("ranks dictionary-backed repairs, including a single candidate, without changing original input", async () => {
    const { engine, transport } = harness();
    const result = await searchMissingLetter("jkan", defaultSettings, transport, { kanaEngine: engine });
    expect(result).toMatchObject({ text: "時間", reviewKana: "じかん", conversionStrategy: "completion",
      romajiCorrection: { before: "jkan", after: "jikan", inserted: "i" }, changes: { kind: "correction", sourceReading: "jかん", correctedReading: "じかん" } });
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
});
