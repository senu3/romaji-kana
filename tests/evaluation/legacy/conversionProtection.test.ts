import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings as applicationSettings } from "./settings";
// These tests exercise the legacy model-generation contract.
const defaultSettings = { ...applicationSettings, conversionEngine: "llm" as const };

describe("source protection across conversion routes", () => {
  it.each(["none", "word", "sentence"] as const)("rejects numeric loss in %s mode", async level => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "じです。", convertedText: "時です。" }) });
    const result = await convertRomajiToJapaneseDetailed("10zidesu.", { ...defaultSettings, inputCompletionLevel: level }, { models: vi.fn(), generate });
    expect(result.text).toBe("");
    expect(result.suggestionRejected).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(["none", "word", "sentence"] as const)("accepts intact original digits in %s mode", async level => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "10じです。", convertedText: "10時です。" }) });
    const result = await convertRomajiToJapaneseDetailed("10zidesu.", { ...defaultSettings, inputCompletionLevel: level }, { models: vi.fn(), generate });
    expect(result.text).toBe("10時です。");
    expect(result.suggestionRejected).toBeUndefined();
  });

  it("compares the original number even when both returned fields agree on a different one", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "11じです。", convertedText: "11時です。" }) });
    const result = await convertRomajiToJapaneseDetailed("10zidesu.", defaultSettings, { models: vi.fn(), generate });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "protected" });
  });

  for (const level of ["none", "word", "sentence"] as const) {
    it.each([
      { completedKana: "11じです。", convertedText: "10時です。" },
      { completedKana: "10じです。", convertedText: "11時です。" },
    ])(`rejects disagreement between final reading and text in ${level} mode`, async candidate => {
      const generate = vi.fn().mockResolvedValue({ response: JSON.stringify(candidate) });
      const conversion = convertRomajiToJapaneseDetailed("10zidesu.", { ...defaultSettings, inputCompletionLevel: level }, { models: vi.fn(), generate });
      if (level === "none") {
        await expect(conversion).rejects.toThrow("変換結果の読みと本文の形式が一致しませんでした。");
      } else {
        const result = await conversion;
        expect(result.text).toBe("");
        expect(result.suggestionRejected).toBe(true);
      }
      expect(generate).toHaveBeenCalledTimes(1);
    });
  }

  it("applies original-number protection to a legacy plain-text response", async () => {
    const generate = vi.fn().mockResolvedValue({ response: "11時です。" });
    const result = await convertRomajiToJapaneseDetailed("10zidesu.", defaultSettings, { models: vi.fn(), generate });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "protected", changes: { kind: "unknown", additions: [] } });
    expect(result.inputCompletionApplied).toBeUndefined();
    expect(result.inputCompletionAdditions).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(["none", "word", "sentence"] as const)("preserves grouped decimals through the complete %s route", async level => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "よさん1,500.25えん。", convertedText: "予算1,500.25円。" }) });
    const result = await convertRomajiToJapaneseDetailed("yosan1,500.25en.", { ...defaultSettings, inputCompletionLevel: level }, { models: vi.fn(), generate });
    expect(result.text).toBe("予算1,500.25円。");
    expect(result.suggestionRejected).toBeUndefined();
    expect(generate.mock.calls[0][2].prompt).toContain("1,500.25");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(["none", "word", "sentence"] as const)("rejects duplicated Japanese literal terms after aggregation in %s mode", async level => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "にかくにん。", convertedText: "東京に確認。" }) });
    const result = await convertRomajiToJapaneseDetailed("東京nikakunin.", { ...defaultSettings, inputCompletionLevel: level }, { models: vi.fn(), generate });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "protected" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("protects original digits through the speculative route", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "11じです。", convertedText: "11時です。" }) });
    const transport = { models: vi.fn(), generate };
    const result = await convertRomajiToJapaneseDetailed("10zidesu.", defaultSettings, transport, { speculativeMode: true });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "protected" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("allows a valid protected result on an explicit typo-repair request", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "10じです。", convertedText: "10時です。" }) });
    const result = await convertRomajiToJapaneseDetailed("10zidesu.", defaultSettings, { models: vi.fn(), generate }, { completionMode: true, avoidOutputs: ["10時だ。"] });
    expect(result).toMatchObject({ text: "10時です。", conversionStrategy: "completion" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retains dictionary and literal terms but rejects extra copies generated by the model", async () => {
    for (const input of ["`OpenAI`nikakunin.", "東京nikakunin."]) {
      const term = input.startsWith("`") ? "OpenAI" : "東京";
      const generate = vi.fn().mockResolvedValue({ response: `${term}に確認。` });
      const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, { models: vi.fn(), generate });
      expect(result).toMatchObject({ text: "", suggestionRejectedReason: "protected" });
    }
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "にかくにん。", convertedText: "に確認。" }) });
    const result = await convertRomajiToJapaneseDetailed("sakura nikakunin.", {
      ...defaultSettings, userDictionary: [{ id: "eval", reading: "sakura", output: "咲良", enabled: true, note: "" }],
    }, { models: vi.fn(), generate });
    expect(result.text).toBe("咲良に確認。");
  });


});
