import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings as applicationSettings } from "./settings";
// These tests exercise the legacy model-generation contract.
const defaultSettings = { ...applicationSettings, conversionEngine: "llm" as const };
import { ConversionResponseError } from "../../../src/lib/conversionDiagnostics";

describe("conversion failure diagnostics", () => {
  it.each([
    ["not json", "response-format"],
    [JSON.stringify({ completedKana: "ほん。", convertedText: "本。\u0001" }), "reading-format"],
    [JSON.stringify({ completedKana: "10じほん。", convertedText: "10時本。" }), "protected-content"],
    [JSON.stringify({ correctedKana: "かんしゃ。", completedKana: "かんしゃ。", convertedText: "感謝。" }), "local-correction"],
    [JSON.stringify({ completedKana: "ほんをよむことにしました。", convertedText: "本を読むことにしました。" }), "completion-shape"],
    [JSON.stringify({ completedKana: "ほんをよむ。", convertedText: "ほ" }), "text-length"],
  ])("retains a detailed cause without introducing a rescue call: %s", async (response, detail) => {
    const generate = vi.fn().mockResolvedValue({ response });
    const result = await convertRomajiToJapaneseDetailed("honwoyomu.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "diverged", rejectionDetail: detail });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("keeps malformed faithful responses as typed errors and does not retry transport failures", async () => {
    const generate = vi.fn().mockResolvedValue({ response: '{"completedKana":"ほん。"}' });
    await expect(convertRomajiToJapaneseDetailed("hon.", defaultSettings, { models: vi.fn(), generate }, { avoidOutputs: ["本。"] }))
      .rejects.toMatchObject({ name: "ConversionResponseError", diagnostic: "response-format" });
    expect(generate).toHaveBeenCalledTimes(1);
    const networkError = new Error("offline");
    generate.mockRejectedValue(networkError);
    await expect(convertRomajiToJapaneseDetailed("hon.", defaultSettings, { models: vi.fn(), generate })).rejects.toBe(networkError);
    expect(networkError).not.toBeInstanceOf(ConversionResponseError);
  });
});
