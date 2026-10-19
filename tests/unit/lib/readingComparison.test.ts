import { describe, expect, it } from "vitest";
import { normalizeReading, normalizeComparableReading, normalizeNumericAlignment, splitTerminalPunctuation } from "../../../src/lib/readingComparison";

describe("reading comparison policies", () => {
  it("distinguishes phonetics, change classification and numeric alignment", () => {
    expect(normalizeReading("ﾃｽﾄ \n。" )).toBe("てすと。");
    expect(normalizeComparableReading("ﾃｽﾄ \n。" )).toBe("てすと");
    expect(normalizeNumericAlignment("ﾃｽﾄ \n。" )).toBe("てすと\n。");
    expect(splitTerminalPunctuation("ほん\nよむ。" )).toEqual({ body: "ほん\nよむ", punctuation: "。" });
  });
});
