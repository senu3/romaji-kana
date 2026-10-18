import { describe, expect, it } from "vitest";
import { parseConversionOutput } from "./conversionOutput";

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
