import { describe, expect, it, vi } from "vitest";
import { normalizeNumericReading } from "./numericReading";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings } from "./settings";

describe("source-aligned integer readings", () => {
  it.each([
    ["あした10じ。", "あしたじゅうじ。"], ["10じと20じ。", "じゅうじとにじゅうじ。"],
    ["3000えん。", "さんぜんえん。"], ["800えん。", "はっぴゃくえん。"], ["4。", "し。"],
    ["あした10じにいかない。", "あしたじゅうじに いかない。"],
  ])("normalizes only the pronunciation of the same integer: %s", (source, reported) => {
    expect(normalizeNumericReading(source, reported)).toEqual({ reading: source, normalized: true });
  });
  it.each([
    ["10じ。", "じゅういちじ。"], ["10じと20じ。", "にじゅうじとじゅうじ。"],
    ["10じと10じ。", "じゅうじ。"], ["10じ。", "じゅうじとじゅうじ。"],
    ["あした10じ。", "きょうじゅうじ。"], ["10じのおねが。", "じゅうじのおねがい。"],
    ["-10ど。", "まいなすじゅうど。"], ["1.5こ。", "いってんごこ。"], ["1,000えん。", "せんえん。"],
    ["10%です。", "じゅっぱーせんとです。"], ["04じ。", "よんじ。"], ["v10。", "vじゅう。"],
    ["10こ。", "じゅっこ。"], ["10000えん。", "いちまんえん。"],
    ["10じ。", "じゅうじ。\n"], ["10じ。", "じゅう\nじ。"],
  ])("does not guess different values or unsupported formats: %s → %s", (source, reported) => {
    expect(normalizeNumericReading(source, reported)).toEqual({ reading: reported, normalized: false });
  });
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
