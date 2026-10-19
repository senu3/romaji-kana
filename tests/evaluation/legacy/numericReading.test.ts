import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings as applicationSettings } from "./settings";
// These tests exercise the legacy model-generation contract.
const defaultSettings = { ...applicationSettings, conversionEngine: "llm" as const };

describe("source-aligned integer readings", () => {
  it.each(["none", "word", "sentence"] as const)("normalizes the reading, keeps exact text numbers, and preserves the original claim in %s mode", async level => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ correctedKana: "10じです。", completedKana: "じゅうじです。", convertedText: "10時です。" }) });
    const result = await convertRomajiToJapaneseDetailed("10jidesu.", { ...defaultSettings, inputCompletionLevel: level }, { models: vi.fn(), generate });
    expect(result.text).toBe("10時です。");
    expect(result.reviewKana).toBe("10じです。");
    expect(result.changes).toMatchObject({ additions: [], readingAssessment: {
      status: "unverified", reportedReading: "じゅうじです。", numericReadingNormalized: true,
    } });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("does not allow a changed number in both text and reading", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "じゅういちじ。", convertedText: "11時。" }) });
    await expect(convertRomajiToJapaneseDetailed("10ji.", defaultSettings, { models: vi.fn(), generate })).rejects.toThrow();
  });
  it("allows the same numeric pronunciation in an independently verified reading", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "じゅうじ。", convertedText: "10時。" }) });
    const result = await convertRomajiToJapaneseDetailed("10ji.", defaultSettings, { models: vi.fn(), generate }, {
      readingVerifier: { lookupReadings: () => ["じゅうじ。"] },
    });
    expect(result.changes?.readingAssessment).toMatchObject({ status: "verified", proof: "independent", numericReadingNormalized: true });
  });
  it("uses the same canonical reading during alternative spelling exploration", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "じゅうじ。", convertedText: "10時。" }) });
    const result = await convertRomajiToJapaneseDetailed("10ji.", defaultSettings, { models: vi.fn(), generate },
      { alternativeReading: "10じ。", avoidOutputs: ["10じ。"] });
    expect(result.text).toBe("10時。");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
