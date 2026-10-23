import { describe, expect, it, vi } from "vitest";
import { nearbySpeculationContext } from "../../../src/lib/conversionRequest";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";

describe("reduced speculation information", () => {
  it.each([false, true])("uses identical generation requests and one call across both entry points (literals: %s)", async literals => {
    const requests: unknown[] = [];
    for (const userRequestedSpeculation of [false, true]) {
      const response = literals
        ? { segments: [
          { id: "edit-1", convertedText: "の確認は未完了です。", completedKana: "のかくにんはみかんりょうです。" },
          { id: "edit-3", convertedText: "の確認は未完了です。", completedKana: "のかくにんはみかんりょうです。" },
        ] }
        : { convertedText: "確認してください。", completedKana: "かくにんしてください。" };
      const generate = vi.fn().mockResolvedValue({ response: JSON.stringify(response) });
      const result = await convertRomajiToJapaneseDetailed(
        literals ? "`A-1`nokakunihamadaowatteinai.`B-2`nokakunihamadaowatteinai." : "kakunishitekudasai.",
        defaultSettings, { models: vi.fn(), generate }, {
          purpose: "speculative", userRequestedSpeculation, contextBefore: "装置の確認作業です。",
          avoidOutputs: ["前の候補"], kanaEngine: { search: vi.fn(), verify: vi.fn().mockResolvedValue("verified") },
        },
      );
      expect(generate).toHaveBeenCalledOnce();
      expect(result.text).toBe(literals ? "A-1の確認は未完了です。B-2の確認は未完了です。" : "確認してください。");
      requests.push(generate.mock.calls[0][2]);
    }
    expect(requests[0]).toEqual(requests[1]);
  });

  it.each([false, true])("rejects a polite repetition at either entry point (%s)", async userRequestedSpeculation => {
    const generate = vi.fn().mockResolvedValue({ response: '{"convertedText":"まだ確認していません。","completedKana":"まだかくにんしていません。"}' });
    const result = await convertRomajiToJapaneseDetailed("madakakunishiteinai.", defaultSettings, { models: vi.fn(), generate }, {
      purpose: "speculative", userRequestedSpeculation, avoidOutputs: ["まだ確認していない。"],
      kanaEngine: { search: vi.fn(), verify: vi.fn().mockResolvedValue("verified") },
    });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, rejectionDetail: "avoided-output" });
    expect(generate).toHaveBeenCalledOnce();
  });
  it("keeps adjacent sentences and unfinished fragments on the correct side", () => {
    expect(nearbySpeculationContext("旧件。直前の文。途中の", "before")).toBe("直前の文。途中の");
    expect(nearbySpeculationContext("続きです。次の文！離れた話。", "after")).toBe("続きです。次の文！");
    expect(nearbySpeculationContext("あ".repeat(500), "before")).toHaveLength(400);
    expect(nearbySpeculationContext("", "after")).toBe("");
  });

  it.each([false, true])("sends only input and nearby context, with one generation (whole target: %s)", async whole => {
    const generate = vi.fn().mockResolvedValue({ response: '{"convertedText":"確認してください。","completedKana":"かくにんしてください。"}' });
    await convertRomajiToJapaneseDetailed("kakunishitekudasai.", defaultSettings, { models: vi.fn(), generate }, {
      purpose: "speculative", userRequestedSpeculation: whole,
      contextBefore: "遠い話。資料の内容です。提出前です。", contextAfter: "内容を見ます。確認の依頼です。遠い後方。",
      avoidOutputs: ["書くにしてください。"], documentVocabulary: ["無関係な語彙"],
      kanaEngine: { search: vi.fn(), verify: vi.fn().mockResolvedValue("verified") },
    });
    expect(generate).toHaveBeenCalledOnce();
    const { system, prompt } = generate.mock.calls[0][2];
    expect(prompt).toContain("かくにしてください");
    expect(prompt).not.toContain("kakunishitekudasai");
    for (const omitted of ["遠い話", "遠い後方", "書くに", "無関係な語彙", "Mechanical kana", "Prepared kana"]) {
      expect(system + prompt).not.toContain(omitted);
    }
    expect(prompt).toContain("資料の内容です。提出前です。");
  });

  it("sends kana parts, keeps literals exact and omits rejected text", async () => {
    const generate = vi.fn().mockResolvedValue({ response: '{"segments":[{"id":"edit-1","convertedText":"の更新。","completedKana":"のこうしん。"}]}' });
    await convertRomajiToJapaneseDetailed("`MR-62`nokoushi.", defaultSettings, { models: vi.fn(), generate }, {
      userRequestedSpeculation: true, avoidOutputs: ["MR-62の講師。"],
      kanaEngine: { search: vi.fn(), verify: vi.fn().mockResolvedValue("verified") },
    });
    const prompt = generate.mock.calls[0][2].prompt;
    const parts = JSON.parse(prompt.split("Original input (ordered parts):\n")[1].split("\nContext after:")[0]);
    expect(parts).toEqual([{ literal: "MR-62" }, { id: "edit-1", originalInput: "のこうし。" }]);
    expect(prompt).not.toContain("MR-62の講師。");
    expect(generate).toHaveBeenCalledOnce();
  });
});
