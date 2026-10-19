import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";
import { requiresExplicitAcceptance } from "../../../src/lib/readingAssessment";

const engine = () => ({ search: vi.fn(), verify: vi.fn().mockResolvedValue("verified") });
describe("current conversion purposes", () => {
  it("uses context and a user rejection for explicit speculation, without normal conversion", async () => {
    const kanaEngine = engine();
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ convertedText: "確認", completedKana: "かくにん" }) });
    const result = await convertRomajiToJapaneseDetailed("kakuni", defaultSettings, { models: vi.fn(), generate }, {
      userRequestedSpeculation: true, kanaEngine, avoidOutputs: ["角煮"], contextBefore: "資料を", contextAfter: "してください。",
    });
    expect(result).toMatchObject({ text: "確認", conversionStrategy: "speculative" });
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(kanaEngine.search).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(generate.mock.calls)).toContain("user explicitly rejected");
    expect(JSON.stringify(generate.mock.calls)).toContain("資料を");
    expect(JSON.stringify(generate.mock.calls)).toContain("角煮");
    expect(result).not.toHaveProperty("inputCompletionApplied");
  });
  it.each([
    { convertedText: "角煮", completedKana: "かくに" },
    { convertedText: "かくに", completedKana: "かくに" },
    { convertedText: "", completedKana: "" },
  ])("keeps no candidate when explicit speculation returns $convertedText", async output => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify(output) });
    const result = await convertRomajiToJapaneseDetailed("kakuni", defaultSettings, { models: vi.fn(), generate }, {
      userRequestedSpeculation: true, kanaEngine: engine(), avoidOutputs: ["角煮"],
    });
    expect(result.suggestionRejected).toBe(true);
    expect(result.text).toBe("");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("rejects plain text and contradictory readings without a compatibility retry", async () => {
    const generate = vi.fn().mockResolvedValue({ response: "確認" });
    await expect(convertRomajiToJapaneseDetailed("kakuni", defaultSettings, { models: vi.fn(), generate }, {
      purpose: "speculative", kanaEngine: engine(),
    })).rejects.toMatchObject({ diagnostic: "response-format" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
