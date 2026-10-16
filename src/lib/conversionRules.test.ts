import { describe, expect, it } from "vitest";
import { isAllowedInputCompletion, isAllowedStructuredSuggestion, reportedSuggestionAdditions } from "./completionValidation";
import { isAllowedSpeculativeConversion } from "./conversionPolicy";
import { protectedContentPrompt } from "./conversionProtection";
import { finalReadingRule, fragmentRepairRule } from "./conversionRules";
import { isAllowedLocalKanaCorrection } from "./localKanaCorrection";
import { buildKanaKanjiSystemPrompt, buildKanaRepairSystemPrompt, buildSpeculativeConversionSystemPrompt, buildSuggestionConversionSystemPrompt, defaultConversionPrompt } from "./prompts";

describe("route guidance and executable guards", () => {
  it("uses the shared original-content contract in all final-output routes", () => {
    for (const prompt of [
      buildKanaKanjiSystemPrompt(defaultConversionPrompt),
      buildKanaKanjiSystemPrompt(defaultConversionPrompt, [], false, 0, true),
      buildSpeculativeConversionSystemPrompt(defaultConversionPrompt),
      buildSuggestionConversionSystemPrompt("word", defaultConversionPrompt),
      buildSuggestionConversionSystemPrompt("sentence", defaultConversionPrompt),
    ]) expect(prompt).toContain(protectedContentPrompt);
  });

  it("keeps faithful reading preservation out of the typo-repair route", () => {
    const faithful = buildKanaKanjiSystemPrompt(defaultConversionPrompt);
    const typo = buildKanaKanjiSystemPrompt(defaultConversionPrompt, [], true, 0, true);
    expect(faithful).toContain("Preserve the phonetic reading of the input kana.");
    expect(typo).toContain("infer a minimal romaji typo repair");
    expect(typo).not.toContain("Preserve the phonetic reading of the input kana.");
    expect(typo).not.toContain("Reject kanji candidates whose common reading drops, adds, or changes kana");
  });

  it("uses the same two-character / quarter-input limit for local correction", () => {
    expect(buildSuggestionConversionSystemPrompt("word", defaultConversionPrompt)).toContain("at most 2 characters and at most 1/4");
    expect(isAllowedLocalKanaCorrection("あいうえかきくけ", "あいうえかしすけ")).toBe(true);
    expect(isAllowedLocalKanaCorrection("あいうえかきくけ", "あいうえさしすけ")).toBe(false);
    expect(isAllowedLocalKanaCorrection("あいうかきくけ", "あいうかしすけ")).toBe(false);
  });

  it("renders the uncertain-fragment limit using the actual romaji span", () => {
    expect(buildKanaRepairSystemPrompt("j")).toContain("at most 2 kana characters");
    expect(fragmentRepairRule.accepts("j", "じい")).toBe(true);
    expect(fragmentRepairRule.accepts("j", "じいい")).toBe(false);
    expect(buildKanaRepairSystemPrompt("abcde")).toContain("at most 5 kana characters");
    expect(fragmentRepairRule.accepts("abcde", "あ".repeat(5))).toBe(true);
    expect(fragmentRepairRule.accepts("abcde", "あ".repeat(6))).toBe(false);
    for (const fragment of ["じ。", "123", "じ じ", '{"kana":"じ"}']) {
      expect(fragmentRepairRule.accepts("abcde", fragment)).toBe(false);
    }
  });

  it("keeps sentence reading length and shared-character bounds in its guidance", () => {
    const prompt = buildSuggestionConversionSystemPrompt("sentence", defaultConversionPrompt);
    expect(prompt).toContain("input length * 0.25");
    expect(prompt).toContain("max(32, input length * 3)");
    expect(prompt).toContain("ceil(input length * 0.12)");
    const source = "あ".repeat(40);
    expect(isAllowedInputCompletion(source, "あ".repeat(10), "sentence")).toBe(true);
    expect(isAllowedInputCompletion(source, "あ".repeat(9), "sentence")).toBe(false);
    expect(isAllowedInputCompletion(source, "あ".repeat(120), "sentence")).toBe(true);
    expect(isAllowedInputCompletion(source, "あ".repeat(121), "sentence")).toBe(false);
    expect(isAllowedInputCompletion(source, "い".repeat(40), "sentence")).toBe(false);
  });

  it("retains the sentence declared-addition fallback cap", () => {
    const source = "あ".repeat(10);
    const additions = (length: number) => reportedSuggestionAdditions(source, source, {
      completedKana: source, convertedText: source + "い".repeat(length), additions: ["い".repeat(length)],
    }, "sentence");
    expect(additions(24)).toEqual(["い".repeat(24)]);
    expect(additions(25)).toEqual([]);
    expect(buildSuggestionConversionSystemPrompt("sentence", defaultConversionPrompt)).toContain("max(24, ceil(input length * 1.25))");
  });

  it.each([[1, false], [2, true], [24, true], [25, false]] as const)("applies the same output-length boundary (%s) to suggestion and speculation", (length, allowed) => {
    const source = "あ".repeat(10), convertedText = "あ".repeat(length);
    expect(isAllowedSpeculativeConversion(source, convertedText)).toBe(allowed);
    expect(isAllowedStructuredSuggestion(source, { completedKana: source, convertedText, additions: [] }, "word", {})).toBe(allowed);
    expect(buildSpeculativeConversionSystemPrompt(defaultConversionPrompt)).toContain("max(24, input length * 2)");
    expect(buildSuggestionConversionSystemPrompt("word", defaultConversionPrompt)).toContain("max(24, completedKana length * 2)");
  });

  it("keeps final-reading shape validation shared with explicit control-character differences", () => {
    const multiline = { completedKana: "あ\nい", convertedText: "あ\nい" };
    expect(finalReadingRule.accepts(multiline, "final")).toBe(true);
    expect(finalReadingRule.accepts(multiline, "suggestion")).toBe(false);
    for (const mode of ["final", "suggestion"] as const) {
      expect(finalReadingRule.accepts({ completedKana: "本", convertedText: "本" }, mode)).toBe(false);
      expect(finalReadingRule.accepts({ completedKana: "10じ", convertedText: "11時" }, mode)).toBe(false);
      expect(finalReadingRule.accepts({ completedKana: "ほん", convertedText: "本\u0000" }, mode)).toBe(false);
    }
  });
});
