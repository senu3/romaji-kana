import { describe, expect, it, vi } from "vitest";
import { nearbySpeculationContext } from "../../../src/lib/conversionRequest";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";

describe("current explicit speculation information", () => {
  it("keeps adjacent sentences and unfinished fragments on the correct side", () => {
    expect(nearbySpeculationContext("旧件。直前の文。途中の", "before")).toBe("直前の文。途中の");
    expect(nearbySpeculationContext("続きです。次の文！離れた話。", "after")).toBe("続きです。次の文！");
    expect(nearbySpeculationContext("あ".repeat(500), "before")).toHaveLength(400);
    expect(nearbySpeculationContext("", "after")).toBe("");
  });

  it.each([false, true])("sends romaji, kana and nearby context in one candidate request (protected: %s)", async protectedInput => {
    const generate = vi.fn().mockResolvedValue({ response: '{"candidates":[]}' });
    const search = vi.fn();
    await convertRomajiToJapaneseDetailed(protectedInput ? "`MR-62`nokoushi." : "kakunishitekudasai.", defaultSettings, { models: vi.fn(), generate }, {
      userRequestedSpeculation: true, speculationCandidates: true,
      contextBefore: "遠い話。資料の内容です。提出前です。", contextAfter: "内容を見ます。確認の依頼です。遠い後方。",
      avoidOutputs: ["退けた文章"], documentVocabulary: ["無関係な語彙"],
      kanaEngine: { search, verify: vi.fn() },
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(search).not.toHaveBeenCalled();
    const { system, prompt, outputSchema } = generate.mock.calls[0][2];
    expect(outputSchema.properties.candidates.maxItems).toBe(3);
    expect(prompt).toContain("資料の内容です。提出前です。");
    for (const omitted of ["遠い話", "遠い後方", "退けた文章", "無関係な語彙"]) expect(system + prompt).not.toContain(omitted);
    if (protectedInput) {
      expect(prompt).toContain("MR-62");
      expect(prompt).toContain("のこうし。");
      expect(prompt).not.toContain("`MR-62`");
    } else {
      expect(prompt).toContain("kakunishitekudasai。");
      expect(prompt).toContain("かくにしてください。");
    }
  });
});
