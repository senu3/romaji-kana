import { describe, expect, it } from "vitest";
import { candidatePresentation } from "./candidatePresentation";

describe("candidate presentation", () => {
  it("prioritizes speculative fallback over the requested completion level", () => {
    expect(candidatePresentation({ conversionStrategy: "speculative", inputCompletionLevel: "word" }).label).toBe("推測候補");
    expect(candidatePresentation({ conversionStrategy: "speculative", inputCompletionLevel: "sentence" }).label).toBe("推測候補");
  });
  it("distinguishes sentence suggestions, word completion, and fallback conversion", () => {
    expect(candidatePresentation({ inputCompletionLevel: "sentence" }).label).toBe("文章提案");
    expect(candidatePresentation({ inputCompletionLevel: "word" }).label).toBe("単語補完");
    expect(candidatePresentation({ conversionStrategy: "completion", inputCompletionLevel: "none" }).label).toBe("補完変換");
    expect(candidatePresentation({}).label).toBe("通常変換");
  });
});
