import { describe, expect, it, vi } from "vitest";
import { isAllowedInputCompletion } from "./completionValidation";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { requiresExplicitAcceptance } from "./readingAssessment";
import { defaultSettings as applicationSettings } from "./settings";
// These tests exercise the legacy model-generation contract.
const defaultSettings = { ...applicationSettings, conversionEngine: "llm" as const };

describe("already-started endings and provisional boundaries", () => {
  it.each([
    ["よみま", "よみます"], ["いきませ", "いきません"], ["よみまし", "よみました"],
    ["はれで", "はれです"], ["はれでし", "はれでした"], ["いかな", "いかない"], ["いかなかっ", "いかなかった"],
  ])("finishes only the started ending: %s → %s", (source, candidate) => {
    expect(isAllowedInputCompletion(source, candidate, "word")).toBe(true);
  });
  it.each([
    ["よみ", "よみます"], ["よみ", "よみました"], ["よみま", "よみません"],
    ["よみま", "よみました"], ["いきませ", "いきませんでした"],
  ])("does not infer new politeness, tense or negation: %s → %s", async (source, candidate) => {
    const input = source === "よみ" ? "yomi." : source === "よみま" ? "yomima." : "ikimase.";
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ correctedKana: source + "。", completedKana: candidate + "。", convertedText: candidate + "。" }) });
    const result = await convertRomajiToJapaneseDetailed(input, { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    // Direct string policy and the actual generator must both reject it.
    expect(isAllowedInputCompletion(source, candidate, "word")).toBe(false);
    expect(result.suggestionRejected).toBe(true);
  });
  it("keeps a plausible uncertain boundary as a preview without calling it a verified word", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "かくにん。", convertedText: "かくにん。" }) });
    const result = await convertRomajiToJapaneseDetailed("kakuni.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result.text).toBe("かくにん。");
    expect(result.changes).toMatchObject({ wordBoundary: "unverified", additionKind: "unverified", readingAssessment: { status: "verified" } });
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("uses the same uncertain boundary classification in sentence mode", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "かくにん。", convertedText: "かくにん。" }) });
    const result = await convertRomajiToJapaneseDetailed("kakuni.", { ...defaultSettings, inputCompletionLevel: "sentence" }, { models: vi.fn(), generate });
    expect(result.changes).toMatchObject({ additionKind: "unverified", additions: ["ん"] });
    expect(requiresExplicitAcceptance(result)).toBe(true);
  });
});
