import { describe, expect, it, vi } from "vitest";
import { normalizeReading, normalizeComparableReading, normalizeNumericAlignment, splitTerminalPunctuation } from "../../../src/lib/readingComparison";
import { isAllowedInputCompletion } from "./completionValidation";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings as applicationSettings } from "./settings";
// These tests exercise the legacy model-generation contract.
const defaultSettings = { ...applicationSettings, conversionEngine: "llm" as const };

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
  it.each(["none", "word", "sentence"] as const)("preserves multiline targets in %s mode", async level => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "ほん。\nよむ。", convertedText: "本。\n読む。" }) });
    const result = await convertRomajiToJapaneseDetailed("hon.\nyomu.", { ...defaultSettings, inputCompletionLevel: level }, { models: vi.fn(), generate });
    expect(result.text).toBe("本。\n読む。");
    expect(result.changes?.kind).toBe("notation");
    generate.mockResolvedValue({ response: JSON.stringify({ completedKana: "ほん。よむ。", convertedText: "本。読む。" }) });
    const removed = await convertRomajiToJapaneseDetailed("hon.\nyomu.", { ...defaultSettings, inputCompletionLevel: level }, { models: vi.fn(), generate });
    expect(removed.suggestionRejected).toBe(true);
  });
});
