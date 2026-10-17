import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings } from "./settings";

// These characterize unresolved issues; passing does NOT mean the behavior is
// desirable. On a fix, replace the characterization with an acceptance test in
// the relevant regression suite. See conversionPolicy.md for the remaining work.
describe("known conversion limitations (not acceptance criteria)", () => {
  it("returns a wrong but non-hiragana candidate without triggering typo completion", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "あしたのよって。", convertedText: "明日の夜って。" }) });
    const result = await convertRomajiToJapaneseDetailed("ashitanoyottei.", defaultSettings, { models: vi.fn(), generate });
    expect(result.text).toBe("明日の夜って。");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not route malformed faithful responses through a retry", async () => {
    const generate = vi.fn().mockResolvedValue({ response: '{"completedKana":"ほん。"}' });
    await expect(convertRomajiToJapaneseDetailed("hon.", defaultSettings, { models: vi.fn(), generate }, { avoidOutputs: ["本。"] })).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
  });


});
