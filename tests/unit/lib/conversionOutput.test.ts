import { describe, expect, it } from "vitest";
import { parseConversionOutput, isRejectedSurfaceVariant } from "../../../src/lib/conversionOutput";

describe("current structured output contract", () => {
  it("allows an explicit abstention as well as a text and reading pair", () => {
    expect(parseConversionOutput('{"convertedText":"確認","completedKana":"かくにん"}')).toEqual({ convertedText: "確認", completedKana: "かくにん" });
    expect(parseConversionOutput('{"convertedText":"","completedKana":""}')).toEqual({ convertedText: "", completedKana: "" });
  });
  it.each(['確認', '{"convertedText":"確認"}', '{"convertedText":"確認","completedKana":"かくにん","additions":[]}'])
    ("rejects incomplete or retired response forms: %s", response => {
      expect(parseConversionOutput(response)).toBeNull();
    });
});

describe("occurrence-local rejection surface comparison", () => {
  it.each([
    ["廃止はまだしていない。", "廃止はまだしていません。"],
    ["更新は終わっていなかった。", "更新は終わっていませんでした。"],
    ["変更はなかった。", "変更はありませんでした。"],
    ["確認。", "確認."],
  ])("rejects only a known surface variant: %s / %s", (before, after) => {
    expect(isRejectedSurfaceVariant(after, [before])).toBe(true);
  });
  it.each([
    ["角煮", "確認"], ["陶器", "登記"], ["方向", "方角"],
    ["終わっていない。", "終わっていなかった。"],
    ["終わっていません。", "終わっている。"],
    ["変更はない。", "変更はないか。"],
    ["B-2へ廃止しません。", "B-2廃止しません。"],
    ["B-2へ発送しません。", "B-2から発送しません。"],
  ])("does not infer synonymy, a word ban or equivalence of tense/polarity: %s / %s", (before, after) => {
    expect(isRejectedSurfaceVariant(after, [before])).toBe(false);
  });
});
