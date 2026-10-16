import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings } from "./settings";

describe("successful hiragana candidates", () => {
  it.each(["none", "word", "sentence"] as const)("keeps a natural greeting in %s mode", async level => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ convertedText: "ありがとう。", completedKana: "ありがとう。" }) });
    const result = await convertRomajiToJapaneseDetailed("arigatou.", { ...defaultSettings, inputCompletionLevel: level }, { models: vi.fn(), generate });
    expect(result).toMatchObject({ text: "ありがとう。", changes: { kind: "notation" } });
    expect(result.suggestionRejected).toBeUndefined();
    expect(result.conversionStrategy).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("keeps the completed word and its inserted span without requesting a rewrite", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ convertedText: "ありがとう。", completedKana: "ありがとう。" }) });
    const result = await convertRomajiToJapaneseDetailed("ariga.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result).toMatchObject({ text: "ありがとう。", inputCompletionApplied: true, inputCompletionAdditions: ["とう"], changes: { kind: "completion" } });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("accepts a distinct kana alternative when it is not an avoided output", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ convertedText: "どうもありがとう。", completedKana: "どうもありがとう。" }) });
    const result = await convertRomajiToJapaneseDetailed("doumoarigatou.", defaultSettings, { models: vi.fn(), generate }, { avoidOutputs: ["ありがとう。"] });
    expect(result.text).toBe("どうもありがとう。");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
