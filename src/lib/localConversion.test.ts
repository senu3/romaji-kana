import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed, type JapaneseConversionResult } from "./ollama";
import { defaultSettings } from "./settings";
import { defaultKanaEngine, type EngineCandidate, type KanaEngine } from "./kanaEngine";
import { nextSessionCandidate } from "./conversionSession";
import { romajiToKana } from "./romajiKana";
import { requiresExplicitAcceptance } from "./readingAssessment";

function candidate(text: string, reading = "きしゃ", cost = 100): EngineCandidate {
  return { text, reading, cost, tokens: [{ text, reading, from: 0, to: Array.from(reading).length,
    source: "mozc", entryId: text, lid: 1851, rid: 1851, wordCost: cost }] };
}
function harness() {
  const search = vi.fn().mockResolvedValue({ candidates: [candidate("記者"), candidate("汽車", "きしゃ", 200)],
    truncated: false, dictionaryRevision: "test" });
  const engine: KanaEngine = { search, verify: vi.fn().mockResolvedValue("unverified") };
  const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ order: ["candidate-1", "candidate-0"] }) });
  return { engine, search, generate, transport: { models: vi.fn(), generate } };
}
describe("local faithful conversion", () => {
  it("returns dictionary candidates before ranking and publishes the ranked result separately", async () => {
    const h = harness();
    let run!: () => Promise<void>;
    const onRankedCandidates = vi.fn();
    const result = await convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport, {
      kanaEngine: h.engine, deferRanking: task => { run = task; }, onRankedCandidates,
    });
    expect(result.text).toBe("記者");
    expect(result.session?.rerankStatus).toBe("pending");
    expect(h.generate).not.toHaveBeenCalled();
    await run();
    expect(onRankedCandidates.mock.calls[0][0].text).toBe("汽車");
  });
  it.each(["accepted", "dismissed", "locked"] as const)("skips queued ranking after %s", async state => {
    const h = harness();
    let run!: () => Promise<void>;
    const result = await convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport, {
      kanaEngine: h.engine, deferRanking: task => { run = task; },
    });
    if (state === "locked") result.session!.locked = true;
    else result.session!.state = state;
    await run();
    expect(h.generate).not.toHaveBeenCalled();
  });
  it("uses the configured local engine through the public API without a UI-specific injection", async () => {
    const h = harness();
    const spy = vi.spyOn(defaultKanaEngine, "search").mockImplementation(h.search);
    try {
      const result = await convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport);
      expect(result.session?.dictionaryRevision).toBe("test");
      expect(spy).toHaveBeenCalledWith("きしゃ", [], undefined);
    } finally { spy.mockRestore(); }
  });
  it("selects only retained candidates by ID and preserves their dictionary paths", async () => {
    const h = harness();
    const result = await convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport, {
      kanaEngine: h.engine, contextBefore: "列車の話。", contextAfter: "が到着した。",
    });
    expect(result.text).toBe("汽車");
    expect(result.reviewKana).toBe("きしゃ");
    expect(result.changes?.readingAssessment).toMatchObject({ status: "verified", proof: "independent" });
    expect(result.session?.candidates.find(c => c.result.text === "記者")?.tokens?.[0].entryId).toBe("記者");
    expect(JSON.parse(h.generate.mock.calls[0][2].prompt)).toMatchObject({ before: "列車の話。", after: "が到着した。" });
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
  it.each([
    { order: ["invented", "candidate-0", "candidate-2"] },
    { order: ["candidate-0", "candidate-0", "candidate-2"] },
    { convertedText: "記事を追加しました" },
  ])("falls back to local order for invalid ranking %j", async response => {
    const h = harness();
    h.generate.mockResolvedValue({ response: JSON.stringify(response) });
    const result = await convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.text).toBe("記者");
    expect(result.session?.rerankStatus).toBe("invalid");
  });
  it("promotes a valid short list and keeps all remaining candidates in local order", async () => {
    const h = harness();
    h.generate.mockResolvedValue({ response: JSON.stringify({ order: ["candidate-1"] }) });
    const result = await convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.text).toBe("汽車");
    expect(result.session?.candidates.map(c => c.id)).toEqual(["candidate-1", "candidate-0"]);
    expect(h.generate.mock.calls[0][2].outputSchema.properties.order.items.enum).toEqual(["candidate-0", "candidate-1"]);
  });
  it("retains local results on a failed model connection", async () => {
    const h = harness();
    h.generate.mockRejectedValue(new Error("offline"));
    const result = await convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.text).toBe("記者");
    expect(result.session?.rerankStatus).toBe("failed");
  });
  it("freezes order once the user starts navigating", async () => {
    const h = harness();
    const result = await convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport, {
      kanaEngine: h.engine, onLocalCandidates: local => { expect(local.text).toBe("記者"); nextSessionCandidate(local.session!); },
    });
    expect(result.text).toBe("汽車");
    expect(result.session?.candidates[0].result.text).toBe("記者");
    expect(result.session?.rerankStatus).toBe("skipped");
  });
  it("does not silently repair the mechanical reading in normal conversion", async () => {
    const h = harness();
    h.search.mockImplementation(async (reading: string) => ({ candidates: [candidate(reading, reading)], truncated: false, dictionaryRevision: "test" }));
    const input = "dseu";
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, { kanaEngine: h.engine, rerank: false, autoRescue: false });
    expect(result.suggestionRejectedReason).toBe("unconvertible");
    expect(result.reviewKana).toBe(romajiToKana(input).kana);
    expect(h.generate).not.toHaveBeenCalled();
  });
  it("keeps numeric and literal anchors out of dictionary exploration", async () => {
    const h = harness();
    h.search.mockImplementation(async (reading: string) => ({ candidates: [candidate(reading === "じ" ? "時" : reading, reading)], truncated: false, dictionaryRevision: "test" }));
    const result = await convertRomajiToJapaneseDetailed("10ji`OpenAI`", defaultSettings, h.transport, { kanaEngine: h.engine, rerank: false });
    expect(result.text).toBe("10時OpenAI");
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search.mock.calls[0][0]).toBe("じ");
  });
  it("rejects inconsistent engine wire data instead of treating it as verified", async () => {
    const h = harness();
    h.search.mockResolvedValue({ candidates: [{ ...candidate("記者"), reading: "きじ" }], truncated: false });
    await expect(convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport, { kanaEngine: h.engine })).rejects.toThrow("有効な候補");
  });
  it.each(["\u0001", "\u007f", "\u0085", "\u009f"])("filters forbidden controls before ranking or displaying local candidates: %j", async control => {
    const h = harness();
    h.search.mockResolvedValue({ candidates: [candidate(`記${control}者`), candidate("汽車", "きしゃ", 200)],
      truncated: false, dictionaryRevision: "test" });
    const onLocalCandidates = vi.fn();
    const result = await convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport,
      { kanaEngine: h.engine, onLocalCandidates });
    expect(result.text).toBe("汽車");
    expect(result.session?.candidates.map(c => c.result.text)).not.toContain(`記${control}者`);
    expect(onLocalCandidates.mock.calls[0][0].session.candidates.map((c: { result: JapaneseConversionResult }) => c.result.text))
      .not.toContain(`記${control}者`);
    expect(h.generate).not.toHaveBeenCalled();
  });
  it("rejects forbidden controls in the reading as well as in candidate text", async () => {
    const h = harness();
    h.search.mockImplementation(async (reading: string) => ({ candidates: [candidate(reading, reading)], truncated: false, dictionaryRevision: "test" }));
    const result = await convertRomajiToJapaneseDetailed("kisha\u0085", defaultSettings, h.transport, { kanaEngine: h.engine, rerank: false });
    expect(result.suggestionRejected).toBe(true);
    expect(result.text).toBe("");
    expect(h.generate).not.toHaveBeenCalled();
  });
  it("keeps preserved Kanji and permitted whitespace when checking local candidates", async () => {
    const h = harness();
    h.search.mockImplementation(async (reading: string) => ({ candidates: [candidate(reading, reading)], truncated: false, dictionaryRevision: "test" }));
    const result = await convertRomajiToJapaneseDetailed("`既存の漢字`kisha\nhon", defaultSettings, h.transport, { kanaEngine: h.engine, rerank: false });
    expect(result.text).toBe("既存の漢字きしゃ\nほん");
    expect(result.suggestionRejected).not.toBe(true);
  });
  it("propagates cancellation instead of falling back to an abandoned session", async () => {
    const h = harness();
    const controller = new AbortController();
    await expect(convertRomajiToJapaneseDetailed("kisha", defaultSettings, h.transport, {
      kanaEngine: h.engine, signal: controller.signal, onLocalCandidates: () => controller.abort(),
    })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("converts dictionary prefix completions as separate reading plans requiring explicit acceptance", async () => {
    const h = harness();
    h.engine.complete = vi.fn().mockResolvedValue(["しょるい", "しょり"]);
    h.search.mockImplementation(async (reading: string) => ({ candidates: [candidate(reading === "しょるい" ? "書類" : "処理", reading)], truncated: false, dictionaryRevision: "test" }));
    const result = await convertRomajiToJapaneseDetailed("sho.", { ...defaultSettings, inputCompletionLevel: "word" }, h.transport,
      { kanaEngine: h.engine, rerank: false });
    expect(result.text).toBe("書類。");
    expect(result.changes).toMatchObject({ kind: "completion", sourceReading: "しょ。", resultReading: "しょるい。" });
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(result.session?.readingPlans.map(p => p.reading)).toEqual(["しょるい。", "しょり。"]);
    expect(result.session?.candidates.every(c => c.kind === "completion")).toBe(true);
    expect(h.generate).not.toHaveBeenCalled();
  });
});
