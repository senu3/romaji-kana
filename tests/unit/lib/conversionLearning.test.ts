// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversionLearningSnapshot, recordConversionChoice, conversionLearningChoices, forgetConversionChoice, clearConversionLearning } from "../../../src/lib/conversionLearning";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";

describe("conversion learning snapshot", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("forgets only the selected pair and can clear all preferences", () => {
    recordConversionChoice("きしゃ", "汽車"); recordConversionChoice("きしゃ", "記者");
    const pending = conversionLearningSnapshot();
    expect(forgetConversionChoice("きしゃ", "汽車")).toBe(true);
    expect(conversionLearningChoices().map(c => c.text)).toEqual(["記者"]);
    expect(conversionLearningSnapshot()("きしゃ", "汽車")).toBe(0);
    expect(pending("きしゃ", "汽車")).toBe(1500);
    expect(clearConversionLearning()).toBe(true);
    expect(conversionLearningChoices()).toEqual([]);
  });
  it("reports deletion failures without claiming success", () => {
    recordConversionChoice("きしゃ", "汽車");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("unavailable"); });
    expect(forgetConversionChoice("きしゃ", "汽車")).toBe(false);
    expect(conversionLearningChoices()).toHaveLength(1);
  });

  it("keeps the request's preferences stable and picks up new choices on the next request", () => {
    recordConversionChoice("きしゃ", "汽車");
    const snapshot = conversionLearningSnapshot();
    recordConversionChoice("きしゃ", "汽車");
    expect(snapshot("きしゃ", "汽車")).toBe(1500);
    expect(conversionLearningSnapshot()("きしゃ", "汽車")).toBe(3000);
    expect(snapshot("きしゃ", "記者")).toBe(0);
  });

  it("reads storage only once across local sorting and deferred ranking", async () => {
    recordConversionChoice("きしゃ", "汽車");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const generate = vi.fn().mockResolvedValue({ response: '{"order":["candidate-1"]}' });
    let rank!: () => Promise<void>;
    const result = await convertRomajiToJapaneseDetailed("kisha", defaultSettings, { models: vi.fn(), generate }, {
      kanaEngine: { verify: vi.fn(), search: vi.fn().mockResolvedValue({ dictionaryRevision: "test", truncated: false,
        candidates: ["記者", "汽車"].map(text => ({ text, reading: "きしゃ", cost: 100,
          tokens: [{ text, reading: "きしゃ", from: 0, to: 3, source: "mozc", entryId: text, lid: 0, rid: 0, wordCost: 100 }] })) }) },
      deferRanking: run => { rank = run; },
    });
    expect(result.text).toBe("汽車");
    await rank();
    expect(read).toHaveBeenCalledOnce();
    expect(JSON.parse(generate.mock.calls[0][2].prompt).candidates.find((c: { text: string }) => c.text === "汽車").personalPreference).toBe(1500);
  });
});
