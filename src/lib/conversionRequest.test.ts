import { describe, expect, it, vi } from "vitest";
import { prepareConversionRequest, suggestionTargetPrompt } from "./conversionRequest";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings } from "./settings";

describe("target and reference roles", () => {
  it("snapshots vocabulary without adding its numbers or syntax to source protection", () => {
    const vocabulary = ["10時", "[参考]", "東京"];
    const request = prepareConversionRequest("hon.", defaultSettings, { documentVocabulary: vocabulary });
    vocabulary.push("後で変わる語彙");
    expect(request.protection).toEqual({ source: "ほん。", literalTerms: [] });
    expect(request.documentVocabulary).toEqual(["10時", "[参考]", "東京"]);
  });
  it("renders mechanical/prepared readings and read-only context in distinct sections", () => {
    const prompt = suggestionTargetPrompt({
      target: { originalRomaji: "jh", mechanicalReading: "jひ", preparedReading: "じひ", completionSeed: "じひ" },
      reference: { beforeTarget: "東京10時", documentVocabulary: ["参考語彙"] },
    });
    expect(prompt).toContain("Mechanical kana:\njひ\n\nPrepared kana (correction/completion target):\nじひ");
    expect(prompt).toContain("Read-only context before the target:\n東京10時");
    expect(prompt).not.toContain("参考語彙"); // Vocabulary belongs to the system's reference section.
  });
  it("rejects reference vocabulary inserted into the target instead of requiring it", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "ほん。", convertedText: "本。" }) });
    const result = await convertRomajiToJapaneseDetailed("hon.", { ...defaultSettings, inputCompletionLevel: "word" },
      { models: vi.fn(), generate }, { documentVocabulary: ["10時"] });
    expect(result.text).toBe("本。");
    generate.mockResolvedValue({ response: JSON.stringify({ completedKana: "10じほん。", convertedText: "10時本。" }) });
    const invalid = await convertRomajiToJapaneseDetailed("hon.", defaultSettings, { models: vi.fn(), generate }, { documentVocabulary: ["10時"] });
    expect(invalid.suggestionRejectedReason).toBe("protected");
  });
  it("keeps the converted surface and its target reading distinct in later suggestion context", async () => {
    const generate = vi.fn().mockResolvedValueOnce({ response: JSON.stringify({ completedKana: "ほん", convertedText: "本" }) })
      .mockResolvedValueOnce({ response: JSON.stringify({ completedKana: "よむ。", convertedText: "読む。" }) });
    const result = await convertRomajiToJapaneseDetailed("hon`OpenAI`yomu.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result.text).toBe("本OpenAI読む。");
    expect(generate.mock.calls[1][2].prompt).toContain("Read-only context before the target:\n本OpenAI");
    expect(generate.mock.calls[1][2].prompt).toContain("Read-only input reading before the target:\nほんOpenAI");
    expect(generate.mock.calls[1][2].prompt).toContain("Prepared kana (correction/completion target):\nよむ。");
  });
});
