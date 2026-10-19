import { describe, expect, it } from "vitest";
import { candidatePresentation } from "../../../src/lib/candidatePresentation";
describe("current route presentation", () => {
  it("labels only normal, correction and speculative routes", () => {
    expect(candidatePresentation({}).label).toBe("通常変換");
    expect(candidatePresentation({ conversionStrategy: "correction" }).label).toBe("誤字修正候補");
    expect(candidatePresentation({ conversionStrategy: "speculative" }).label).toBe("推測候補");
  });
});
