import { describe, expect, it, vi } from "vitest";
import { isAllowedInputCompletion, parseStructuredSuggestion } from "./completionValidation";
import { isAllowedLocalKanaCorrection } from "./localKanaCorrection";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings } from "./settings";

const response = (correctedKana: string, completedKana = correctedKana, convertedText = completedKana) =>
  ({ response: JSON.stringify({ correctedKana, completedKana, convertedText }) });
const settings = { ...defaultSettings, inputCompletionLevel: "word" as const };

describe("local correction before completion", () => {
  it.each([
    ["あしたのよってい。", "あしたのよてい。"],
    ["あしたのよでい。", "あしたのよてい。"],
    ["あしたのかいぎのよいて。", "あしたのかいぎのよてい。"],
    ["あしたのよい。", "あしたのよてい。"],
  ])("allows one bounded kana edit: %s → %s", (source, corrected) => {
    expect(isAllowedLocalKanaCorrection(source, corrected)).toBe(true);
  });
  it.each([
    ["あしたのよてい。", "きょうのかいぎ。"],
    ["あした10じ。", "あした11じ。"],
    ["あした10じ。", "あしたじ。"],
    ["あしたのよてい。", "あしたのよてい！"],
    ["あしたはいかない。", "あしたはいく。"],
    ["あしたのよてい。", "あしたの予定。"],
    ["ありが。", "ありがとう。"],
    ["よて。", "よで。"],
    ["ほん をよむ。", "ほんをよむ。"],
  ])("rejects an unsafe or nonlocal correction: %s → %s", (source, corrected) => {
    expect(isAllowedLocalKanaCorrection(source, corrected)).toBe(false);
  });
  it("accepts high-confidence typo correction in one request while retaining the original reading", async () => {
    const generate = vi.fn().mockResolvedValue(response("あしたのよてい。", undefined, "明日の予定。"));
    const result = await convertRomajiToJapaneseDetailed("ashitanoyottei.", settings, { models: vi.fn(), generate });
    expect(result.text).toBe("明日の予定。");
    expect(result.changes).toMatchObject({ kind: "correction", sourceReading: "あしたのよってい。", correctedReading: "あしたのよてい。", additions: [] });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("checks completion against the corrected baseline and reports only the appended text", async () => {
    const generate = vi.fn().mockResolvedValue(response("あしたのよていをおねが。", "あしたのよていをおねがい。", "明日の予定をお願い。"));
    const result = await convertRomajiToJapaneseDetailed("ashitanoyotteiwoonega.", settings, { models: vi.fn(), generate });
    expect(result.changes).toMatchObject({ kind: "completion", sourceReading: "あしたのよっていをおねが。", correctedReading: "あしたのよていをおねが。", additions: ["い"] });
    expect(result.inputCompletionAdditions).toEqual(["い"]);
    expect(generate).toHaveBeenCalledTimes(1);
    // The public completion validator remains strict; repair is a separate step.
    expect(isAllowedInputCompletion("あしたのよってい。", "あしたのよてい。", "word")).toBe(false);
  });
  it.each(["word", "sentence"] as const)("repairs uncertain romaji before %s suggestions", async level => {
    const generate = vi.fn().mockResolvedValueOnce({ response: "じ" })
      .mockResolvedValueOnce(response("あなたはよくわるじひよだ", undefined, "あなたはよく悪じひよだ"));
    const result = await convertRomajiToJapaneseDetailed("anatahayokuwarujhiyoda", { ...settings, inputCompletionLevel: level }, { models: vi.fn(), generate });
    expect(result.text).toBe("あなたはよく悪じひよだ");
    expect(result.changes).toMatchObject({ kind: "correction", sourceReading: "あなたはよくわるjひよだ", correctedReading: "あなたはよくわるじひよだ" });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][2].system).toContain("uncertain kana fragment");
    expect(generate.mock.calls[1][2].prompt).toContain("Mechanical kana:\nあなたはよくわるじひよだ");
  });
  it("rejects rewrites disguised as correction and completion that deletes the corrected prefix", async () => {
    for (const candidate of [response("きょうのかいぎ。"), response("あしたのよてい。", "あしたのよて。")]) {
      const generate = vi.fn().mockResolvedValue(candidate);
      const result = await convertRomajiToJapaneseDetailed("ashitanoyottei.", settings, { models: vi.fn(), generate });
      expect(result.text).toBe("");
      expect(result.suggestionRejectedReason).toBe("diverged");
      expect(result.inputCompletionAdditions).toBeUndefined();
    }
  });
  it("still checks original digits even if the repair stage and final response agree", async () => {
    const generate = vi.fn().mockResolvedValue(response("あした11じ。", undefined, "明日11時。"));
    const result = await convertRomajiToJapaneseDetailed("ashita10ji.", settings, { models: vi.fn(), generate });
    expect(result.suggestionRejected).toBe(true);
    expect(result.text).toBe("");
  });
  it("supports older responses without a correction field and rejects invalid field types", async () => {
    expect(parseStructuredSuggestion('{"correctedKana":42,"completedKana":"ほん","convertedText":"本"}')).toBeNull();
    const generate = vi.fn().mockResolvedValue({ response: '{"completedKana":"ほん。","convertedText":"本。"}' });
    const result = await convertRomajiToJapaneseDetailed("hon.", settings, { models: vi.fn(), generate });
    expect(result.text).toBe("本。");
    expect(result.changes?.kind).toBe("notation");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("does not start completion after cancellation during repair, even when a late response arrives", async () => {
    let resolve!: (value: { response: string }) => void;
    const generate = vi.fn(() => new Promise<{ response: string }>(done => { resolve = done; }));
    const controller = new AbortController();
    const promise = convertRomajiToJapaneseDetailed("anatahayokuwarujhiyoda", settings, { models: vi.fn(), generate }, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    resolve({ response: "じ" });
    await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it.each(["じ。さらにかきます", "123", '{"kana":"じ"}', "じ".repeat(20)])("does not insert an invalid uncertain-fragment repair: %s", async repair => {
    const generate = vi.fn().mockResolvedValueOnce({ response: repair })
      .mockResolvedValueOnce(response("あなたはよくわるじひよだ"));
    const result = await convertRomajiToJapaneseDetailed("anatahayokuwarujhiyoda", settings, { models: vi.fn(), generate });
    expect(generate.mock.calls[1][2].prompt).toContain("Mechanical kana:\nあなたはよくわるjひよだ");
    expect(result.suggestionRejected).toBe(true);
    expect(result.text).toBe("");
  });
});
