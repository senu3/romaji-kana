import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed, convertRomajiToJapanese } from "./ollama";
import type { JapaneseConversionResult } from "./japaneseConversionTypes";
import { defaultSettings } from "./settings";
import type { KanaEngine, EngineCandidate } from "./kanaEngine";
import { requiresExplicitAcceptance } from "./readingAssessment";

const json = (text: string, reading: string) => ({ response: JSON.stringify({ convertedText: text, completedKana: reading }) });
function harness(candidates: EngineCandidate[] = []) {
  const engine: KanaEngine = { search: vi.fn().mockResolvedValue({ candidates, truncated: false, dictionaryRevision: "test" }), verify: vi.fn().mockResolvedValue("verified") };
  const generate = vi.fn();
  return { engine, generate, transport: { models: vi.fn(), generate } };
}
function candidate(text: string, source = "mozc", reading = "ほん"): EngineCandidate {
  return { text, reading, cost: 100, tokens: [{ text, reading, source: source as "mozc" | "literal", from: 0, to: [...reading].length, entryId: "test", lid: 0, rid: 0, wordCost: 100 }] };
}

describe("normal → correction → speculation → unchanged romaji", () => {
  it("removes synthetic passthrough from candidates and sends dictionary ranking evidence", async () => {
    const h = harness([candidate("本"), candidate("ほん", "literal"), candidate("奔")]);
    h.generate.mockResolvedValue({ response: '{"order":["candidate-0"]}' });
    const result = await convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.session?.candidates.map(c => c.result.text)).toEqual(["本", "奔"]);
    const prompt = JSON.parse(h.generate.mock.calls[0][2].prompt);
    expect(prompt).not.toHaveProperty("styleGuidance");
    expect(prompt.candidates[0]).toMatchObject({ localRank: 1, cost: 100 });
  });
  it("keeps natural dictionary-backed hiragana without correction or speculation", async () => {
    const h = harness([candidate("ありがとう", "mozc", "ありがとう")]);
    const result = await convertRomajiToJapaneseDetailed("arigatou", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.text).toBe("ありがとう");
    expect(h.generate).not.toHaveBeenCalled();
  });
  it("tries a bounded typo correction after normal conversion has no candidate", async () => {
    const h = harness();
    h.generate.mockResolvedValue(json("明日の予定。", "あしたのよてい。"));
    const result = await convertRomajiToJapaneseDetailed("ashitanoyottei.", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.text).toBe("明日の予定。");
    expect(result.conversionStrategy).toBe("completion");
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(result.attempts?.map(a => [a.stage, a.outcome])).toEqual([["normal", "rejected"], ["correction", "candidate"]]);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0][2].outputSchema).toEqual({ type: "object",
      properties: { convertedText: { type: "string" }, completedKana: { type: "string" } },
      required: ["convertedText", "completedKana"], additionalProperties: false });
  });
  it("discards an unchanged reading echo and tries speculation once", async () => {
    const h = harness();
    h.generate.mockResolvedValueOnce(json("ほん。", "ほん。")).mockResolvedValueOnce(json("本。", "ほん。"));
    const result = await convertRomajiToJapaneseDetailed("hon.", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.text).toBe("本。");
    expect(result.conversionStrategy).toBe("speculative");
    expect(result.attempts?.map(a => a.stage)).toEqual(["normal", "correction", "speculative"]);
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(h.generate.mock.calls[0][2].system).toContain("minimally repair");
    expect(h.generate.mock.calls[1][2].system).toContain("speculative Japanese");
    expect(h.generate.mock.calls[1][2].outputSchema.required).toEqual(["convertedText", "completedKana"]);
  });
  it("allows an inferred natural hiragana word without inventing a kanji paraphrase", async () => {
    const h = harness();
    h.generate.mockResolvedValueOnce(json("ありが。", "ありが。")).mockResolvedValueOnce(json("ありがとう。", "ありがとう。"));
    const result = await convertRomajiToJapaneseDetailed("ariga.", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.text).toBe("ありがとう。");
    expect(result.conversionStrategy).toBe("speculative");
    expect(h.generate.mock.calls[1][2].system).not.toContain("Candidate: 感謝します");
  });
  it("leaves the original romaji when both rescues fail instead of returning kana", async () => {
    const h = harness();
    h.generate.mockResolvedValue(json("ほん。", "ほん。"));
    const result = await convertRomajiToJapaneseDetailed("hon.", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, suggestionRejectedReason: "unconvertible" });
    expect(result.session).toBeUndefined();
    expect(result.attempts?.every(a => a.outcome === "rejected")).toBe(true);
    expect(h.generate).toHaveBeenCalledTimes(2);
    // The string API also preserves the input on a rejected conversion.
    const { defaultKanaEngine } = await import("./kanaEngine");
    const spy = vi.spyOn(defaultKanaEngine, "search").mockImplementation(h.engine.search);
    try { expect(await convertRomajiToJapanese("hon.", defaultSettings, h.transport)).toBe("hon."); }
    finally { spy.mockRestore(); }
  });
  it("rejects invented numbers in both rescue stages", async () => {
    const h = harness();
    h.generate.mockResolvedValue(json("11時。", "11じ。"));
    const result = await convertRomajiToJapaneseDetailed("10ji.", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.text).toBe("");
    expect(result.attempts).toHaveLength(3);
  });
  it("awaits rescue after deferred ranking abstains and dismisses the provisional session", async () => {
    const h = harness([candidate("本"), candidate("奔")]);
    h.generate.mockResolvedValueOnce({ response: '{"order":[]}' }).mockResolvedValueOnce(json("本", "ほん"));
    let run!: () => Promise<void>;
    const start = vi.fn();
    const ranked = vi.fn<(result: JapaneseConversionResult) => void>();
    const initial = await convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, {
      kanaEngine: h.engine, deferRanking: task => { run = task; }, onRescueStart: start, onRankedCandidates: ranked,
    });
    expect(initial.session?.rerankStatus).toBe("pending");
    expect(ranked).not.toHaveBeenCalled();
    await run();
    expect(initial.session?.state).toBe("dismissed");
    expect(start).toHaveBeenCalledOnce();
    expect(ranked.mock.calls[0][0]).toMatchObject({ text: "本", conversionStrategy: "completion" });
    expect(h.generate).toHaveBeenCalledTimes(2);
  });
  it("does not treat transport failure as a request to run the next rescue", async () => {
    const h = harness();
    h.generate.mockRejectedValue(new Error("offline"));
    await expect(convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, { kanaEngine: h.engine })).rejects.toThrow("offline");
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
  it("does not accept legacy unvalidated plain text as an automatic rescue candidate", async () => {
    const h = harness();
    h.generate.mockResolvedValue({ response: "変換できません" });
    const result = await convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, suggestionRejectedReason: "unconvertible" });
    expect(result.attempts?.slice(1).map(attempt => attempt.detail)).toEqual(["response-format", "response-format"]);
  });
  it("never starts speculation after correction is canceled", async () => {
    const h = harness();
    const controller = new AbortController();
    h.generate.mockImplementation(() => { controller.abort(); return new Promise(() => {}); });
    await expect(convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, { kanaEngine: h.engine, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
});
