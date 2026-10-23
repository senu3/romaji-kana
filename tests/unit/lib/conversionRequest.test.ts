import { describe, expect, it, vi } from "vitest";
import { prepareConversionRequest } from "../../../src/lib/conversionRequest";
import { preservesInputLineBreaks } from "../../../src/lib/conversionProtection";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";

describe("shared conversion input", () => {
  it.each(["\n", "\r\n", "\r"])("captures original line breaks before particle normalization: %j", newline => {
    for (const prefix of ["hon", "本", "`Book` "]) {
      const input = prefix + newline + " wo " + newline + "yomu";
      const prepared = prepareConversionRequest(input, defaultSettings, {});
      expect(preservesInputLineBreaks(prepared.protection, prepared.sourceReading)).toBe(true);
      expect(preservesInputLineBreaks(prepared.protection, "本を読む")).toBe(false);
      expect(preservesInputLineBreaks(prepared.protection, "本\nを\n読む")).toBe(newline === "\n");
    }
  });

  it("includes remaining protected and editable parts in correction context", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ response: '{"convertedText":"読む","completedKana":"よむ"}' })
      .mockResolvedValueOnce({ response: '{"convertedText":"書く","completedKana":"かく"}' });
    await convertRomajiToJapaneseDetailed("yomu`Book`kaku", defaultSettings, { models: vi.fn(), generate }, {
      purpose: "correction", missingLetterCorrection: false,
      contextBefore: "前の文。", contextAfter: "後の文。",
      kanaEngine: { search: vi.fn(), verify: vi.fn().mockResolvedValue("verified") },
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][2].prompt).toContain("Bookkaku後の文。");
    expect(generate.mock.calls[1][2].prompt).toContain("前の文。読むBook");
  });
});
