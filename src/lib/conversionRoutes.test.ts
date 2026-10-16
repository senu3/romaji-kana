import { describe, expect, it, vi } from "vitest";
import { isAllowedInputCompletion } from "./completionValidation";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { buildSuggestionConversionSystemPrompt, defaultConversionPrompt } from "./prompts";
import { defaultSettings } from "./settings";

// These document current boundary problems, not desired long-term policy.
// When intentionally fixing one, change its assertion alongside the policy.
describe("current conversion route boundaries", () => {
  it("rejects a local typo repair in word mode", () => {
    expect(isAllowedInputCompletion("あしたのよってい。", "あしたのよてい。", "word")).toBe(false);
    expect(isAllowedInputCompletion("すみませ。", "すみません。", "word")).toBe(true);
  });

  it("permits more kana and a new phrase than the word prompt asks for", () => {
    const prompt = buildSuggestionConversionSystemPrompt("word", defaultConversionPrompt);
    expect(prompt).toContain("Append at most 6 kana");
    expect(isAllowedInputCompletion("お", "おめでとうございます", "word")).toBe(true);
    expect(isAllowedInputCompletion("ほんをよむ", "ほんをよむことにしました", "word")).toBe(true);
    expect(isAllowedInputCompletion("ほん をよむ", "ほんをよむ", "word")).toBe(false);
  });

  it("discards a successful hiragana word completion after the speculative pass", async () => {
    const response = JSON.stringify({ completedKana: "ありがとう。", convertedText: "ありがとう。" });
    const generate = vi.fn().mockResolvedValue({ response });
    const result = await convertRomajiToJapaneseDetailed("ariga.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "speculative" });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("allows speculative rewriting to exceed word-mode permissions", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ response: JSON.stringify({ completedKana: "ありがとう。", convertedText: "ありがとう。" }) })
      .mockResolvedValueOnce({ response: JSON.stringify({ completedKana: "かんしゃします。", convertedText: "感謝します。" }) });
    const result = await convertRomajiToJapaneseDetailed("ariga.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result).toMatchObject({ text: "感謝します。", conversionStrategy: "speculative", changes: { kind: "rewrite" } });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("skips uncertain-kana repair in suggestion modes and then protects the typo as Latin text", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({
      completedKana: "あなたはよくわるじひよだ", convertedText: "あなたはよく悪じひよだ",
    }) });
    const result = await convertRomajiToJapaneseDetailed("anatahayokuwarujhiyoda", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result.suggestionRejectedReason).toBe("diverged");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][2].system).toContain("Complete only an unfinished final Japanese word.");
    expect(generate.mock.calls[0][2].system).not.toContain("uncertain kana fragment");
  });

  it("repeats the suggestion route even on the last typo-completion retry", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "あした。", convertedText: "明日。" }) });
    await expect(convertRomajiToJapaneseDetailed("ashita.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate }, { avoidOutputs: ["明日。"] })).rejects.toThrow("別候補に変換できませんでした。");
    expect(generate).toHaveBeenCalledTimes(4);
    for (const call of generate.mock.calls) {
      expect(call[2].system).toContain("Complete only an unfinished final Japanese word.");
      expect(call[2].system).not.toContain("Typo completion request:");
    }
  });

  it("returns a wrong but non-hiragana candidate without triggering typo completion", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "あしたのよって。", convertedText: "明日の夜って。" }) });
    const result = await convertRomajiToJapaneseDetailed("ashitanoyottei.", defaultSettings, { models: vi.fn(), generate });
    expect(result.text).toBe("明日の夜って。");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not route malformed faithful responses through a retry", async () => {
    const generate = vi.fn().mockResolvedValue({ response: '{"completedKana":"ほん。"}' });
    await expect(convertRomajiToJapaneseDetailed("hon.", defaultSettings, { models: vi.fn(), generate }, { avoidOutputs: ["本。"] })).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("treats two mutually consistent model fields as sufficient despite dropping an input number", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "じです。", convertedText: "時です。" }) });
    const result = await convertRomajiToJapaneseDetailed("10zidesu.", defaultSettings, { models: vi.fn(), generate });
    expect(result.text).toBe("時です。");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
