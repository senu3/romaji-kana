import { describe, expect, it, vi } from "vitest";
import { classifyConversionChanges } from "./conversionChanges";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings } from "./settings";

describe("observed conversion changes", () => {
  it("normalizes spacing, kana width and terminal punctuation without claiming completion", () => {
    expect(classifyConversionChanges("ほん を よむ。", "ほんをよむ", "model-reading").kind).toBe("notation");
    expect(classifyConversionChanges("ﾃｽﾄ", "てすと", "literal").kind).toBe("notation");
  });
  it("separates additions, local corrections and broader rewrites", () => {
    expect(classifyConversionChanges("ありが。", "ありがとう。", "model-reading")).toMatchObject({ kind: "completion", additions: ["とう"] });
    expect(classifyConversionChanges("あしたのよってい。", "あしたのよてい。", "model-reading").kind).toBe("correction");
    expect(classifyConversionChanges("ありがとう。", "かんしゃします。", "model-reading")).toMatchObject({ kind: "rewrite", additions: [] });
  });
  it("does not guess a missing reading or call a reverted repair a correction", () => {
    expect(classifyConversionChanges("ほん。", undefined, "model-reading")).toMatchObject({ kind: "unknown", evidence: "unavailable", additions: [] });
    expect(classifyConversionChanges("ほん。", "ほん。", "repair-stage", true).kind).toBe("notation");
  });

  it.each(["none", "word", "sentence"] as const)("classifies an unchanged reading as notation in %s mode", async level => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "ほんをよむ。", convertedText: "本を読む。", additions: [] }) });
    const result = await convertRomajiToJapaneseDetailed("honwoyomu.", { ...defaultSettings, inputCompletionLevel: level }, { models: vi.fn(), generate });
    expect(result.changes).toMatchObject({ kind: "notation", evidence: "model-reading", sourceReading: "ほんをよむ。", resultReading: "ほんをよむ。", additions: [] });
    expect(result.inputCompletionApplied).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("uses the final speculative reading instead of stale completion metadata", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "かんしゃします。", convertedText: "感謝します。" }) });
    const result = await convertRomajiToJapaneseDetailed("ariga.", defaultSettings, { models: vi.fn(), generate }, { speculativeMode: true });
    expect(result.conversionStrategy).toBe("speculative");
    expect(result.reviewKana).toBe("かんしゃします。");
    expect(result.changes).toMatchObject({ kind: "rewrite", resultReading: "かんしゃします。", additions: [] });
    expect(result.inputCompletionAdditions).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("clears earlier additions when a plain-text fallback has no known reading", async () => {
    const generate = vi.fn().mockResolvedValue({ response: "感謝します。" });
    const result = await convertRomajiToJapaneseDetailed("ariga.", defaultSettings, { models: vi.fn(), generate }, { speculativeMode: true });
    expect(result.changes).toMatchObject({ kind: "unknown", additions: [] });
    expect(result.inputCompletionAdditions).toBeUndefined();
    expect(result.inputCompletionApplied).toBeUndefined();
  });

  it("recognizes a correction in the final reading without relying on the requested mode", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "あしたのよてい。", convertedText: "明日の予定。" }) });
    const result = await convertRomajiToJapaneseDetailed("ashitanoyottei.", defaultSettings, { models: vi.fn(), generate });
    expect(result.changes).toMatchObject({ kind: "correction", sourceReading: "あしたのよってい。", resultReading: "あしたのよてい。", additions: [] });
    expect(result.reviewKana).toBe("あしたのよてい。");
  });
  it.each([
    '{"completedKana":"本。","convertedText":"本。"}',
    '{"completedKana":"","convertedText":"本。"}',
    '{"completedKana":"ほん。"}',
  ])("rejects malformed final-reading responses instead of treating JSON as candidate text", async response => {
    const generate = vi.fn().mockResolvedValue({ response });
    await expect(convertRomajiToJapaneseDetailed("hon.", defaultSettings, { models: vi.fn(), generate })).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
