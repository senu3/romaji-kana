import { describe, expect, it } from "vitest";
import { reportedSuggestionAdditions } from "./completionValidation";

describe("reported suggestion additions", () => {
  it("does not label existing particles as additions when the reading is unchanged", () => {
    expect(reportedSuggestionAdditions("これはほん。", "これはほん。", {
      completedKana: "これはほん。", convertedText: "これは本。", additions: ["は"],
    }, "sentence")).toEqual([]);
  });

  it("does not trust existing particles after a sentence rewrite", () => {
    expect(reportedSuggestionAdditions("これはほんです。", "これはほんです。", {
      completedKana: "これはあたらしいほん。", convertedText: "これは新しい本。", additions: ["は"],
    }, "sentence")).toEqual([]);
  });

  it("still reports a visible new particle when the model omits it from the reading", () => {
    expect(reportedSuggestionAdditions("しょるい かくにん。", "しょるい かくにん。", {
      completedKana: "しょるい かくにん。", convertedText: "書類を確認。", additions: ["を"],
    }, "sentence")).toEqual(["を"]);
  });

  it("prefers computed insertions over the model's declaration", () => {
    expect(reportedSuggestionAdditions("これはほん。", "これはほん。", {
      completedKana: "これはほんです。", convertedText: "これは本です。", additions: ["は"],
    }, "sentence")).toEqual(["です"]);
  });
});
