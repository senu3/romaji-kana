import { describe, expect, it, vi } from "vitest";
import { normalizeReading, normalizeComparableReading, normalizeNumericAlignment, splitTerminalPunctuation } from "./readingComparison";
import { isAllowedInputCompletion } from "./completionValidation";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings } from "./settings";

describe("comparison policies keep protection separate", () => {
  it("distinguishes phonetics, change classification and numeric alignment", () => {
    expect(normalizeReading("ﾃｽﾄ \n。" )).toBe("てすと。");
    expect(normalizeComparableReading("ﾃｽﾄ \n。" )).toBe("てすと");
    expect(normalizeNumericAlignment("ﾃｽﾄ \n。" )).toBe("てすと\n。");
    expect(splitTerminalPunctuation("ほん\nよむ。" )).toEqual({ body: "ほん\nよむ", punctuation: "。" });
  });
  it("allows kana spacing cleanup but preserves ASCII boundaries and newlines", () => {
    expect(isAllowedInputCompletion("ほん をよむ。", "ほんをよむ。", "word")).toBe(true);
    expect(isAllowedInputCompletion("A B。", "AB。", "word")).toBe(false);
    expect(isAllowedInputCompletion("10 20。", "1020。", "word")).toBe(false);
    expect(isAllowedInputCompletion("ほん\nよむ。", "ほんよむ。", "word")).toBe(false);
    expect(isAllowedInputCompletion("ほん 。", "ほん、", "word")).toBe(false);
  });
  it("returns spacing cleanup as notation through the public word route", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "ほんをよむ。", convertedText: "本を読む。" }) });
    const result = await convertRomajiToJapaneseDetailed("hon woyomu.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result.suggestionRejected).not.toBe(true);
    expect(result.changes).toMatchObject({ kind: "notation", additions: [] });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
