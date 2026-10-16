import { describe, expect, it } from "vitest";
import {
  buildKanaKanjiSystemPrompt, buildSpeculativeConversionSystemPrompt,
  buildSuggestionConversionSystemPrompt, completionKanaKanjiFewShotExamples,
  defaultConversionPrompt, finalConversionOutputContract, kanaKanjiFewShotExamples,
} from "./prompts";
import { isAllowedInputCompletion } from "./completionValidation";
import { MAX_WORD_COMPLETION_KANA } from "./conversionLimits";

describe("shared conversion prompt contracts", () => {
  it("uses one declared word limit for prompt and executable acceptance", () => {
    expect(buildSuggestionConversionSystemPrompt("word", defaultConversionPrompt)).toContain(`Append at most ${MAX_WORD_COMPLETION_KANA} kana`);
    expect(isAllowedInputCompletion("お", "お" + "あ".repeat(MAX_WORD_COMPLETION_KANA), "word")).toBe(true);
    expect(isAllowedInputCompletion("お", "お" + "あ".repeat(MAX_WORD_COMPLETION_KANA + 1), "word")).toBe(false);
  });
  it("does not duplicate the default preference or demand plain-text output", () => {
    const faithful = buildKanaKanjiSystemPrompt(defaultConversionPrompt);
    expect(faithful).toContain("Additional user preference:\nNone.");
    expect(faithful).not.toContain("Return only the converted Japanese text");
    expect(buildSpeculativeConversionSystemPrompt(defaultConversionPrompt)).not.toContain("Return only one Japanese candidate");
    expect(buildKanaKanjiSystemPrompt("Prefer familiar words.")).toContain("Prefer familiar words.");
    const suggestion = buildSuggestionConversionSystemPrompt("sentence", defaultConversionPrompt);
    expect(suggestion).toContain("correctedKana FIRST, convertedText SECOND, completedKana THIRD");
    expect(suggestion).toContain("After writing convertedText, transcribe THAT TEXT into completedKana.");
    expect(finalConversionOutputContract).toContain("Write convertedText (the FINAL Japanese output) FIRST");
  });
  it.each([kanaKanjiFewShotExamples, completionKanaKanjiFewShotExamples])("uses parseable JSON final responses in every example", examples => {
    const outputs = examples.split("出力:\n").slice(1);
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) {
      const response = JSON.parse(output.split("\n")[0]);
      expect(response.convertedText).toEqual(expect.any(String));
      expect(response.completedKana).toEqual(expect.any(String));
      expect(response.completedKana).not.toMatch(/[\p{Script=Han}々〆]/u);
      expect(Object.keys(response)).toEqual(["convertedText", "completedKana"]);
    }
  });
});
