import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";
import { requiresExplicitAcceptance } from "../../../src/lib/readingAssessment";

function harness(text: string, reading: string) {
  const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ convertedText: text, completedKana: reading }) });
  const kanaEngine = { search: vi.fn(), verify: vi.fn().mockResolvedValue("verified") };
  return { generate, kanaEngine, transport: { models: vi.fn(), generate } };
}
const options = { userRequestedSpeculation: true, avoidOutputs: ["MR-62の講師は終わらなかった。"] };

describe("whole-target user reinterpretation", () => {
  it("aligns original input, context, literals and full rejections in one request, without leaking reference into the target", async () => {
    const h = harness("MR-62の更新は終わらなかった。", "MR-62のこうしんはおわらなかった。");
    const input = "`MR-62`nokoushihaowaranakatta.";
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, {
      ...options, kanaEngine: h.kanaEngine, contextBefore: "更新の報告です。別装置ZZ-99は完了。", contextAfter: "明日再開する。",
    });
    expect(result.text).toBe("MR-62の更新は終わらなかった。");
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(h.generate).toHaveBeenCalledTimes(1);
    const request = h.generate.mock.calls[0][2];
    expect(JSON.parse(request.prompt)).toMatchObject({
      target: { originalInput: "MR-62nokoushihaowaranakatta。", protectedLiterals: ["MR-62"] },
      rejectedOutputs: options.avoidOutputs,
      context: { before: "更新の報告です。別装置ZZ-99は完了。", after: "明日再開する。" },
    });
    expect(JSON.parse(request.prompt).target).not.toHaveProperty("mechanicalReading");
    expect(request.system).not.toContain(options.avoidOutputs[0]);
    expect(h.kanaEngine.verify).toHaveBeenCalledWith("の更新は終わらなかった。", "のこうしんはおわらなかった。", [], undefined);
    expect(h.kanaEngine.search).not.toHaveBeenCalled();
  });

  it("keeps multiple and repeated anchors in order, including a protected final span", async () => {
    const h = harness("A-1からB-2へ配信しません。A-1", "A-1からB-2へはいしんしません。A-1");
    const result = await convertRomajiToJapaneseDetailed("`A-1`kara`B-2`hehaishishimasen.`A-1`", defaultSettings, h.transport, {
      userRequestedSpeculation: true, kanaEngine: h.kanaEngine, avoidOutputs: ["A-1からB-2へ廃止しません。A-1"],
    });
    expect(result.text).toBe("A-1からB-2へ配信しません。A-1");
    expect(result.reviewKana).toBe("A-1からB-2へはいしんしません。A-1");
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("copies protected dictionary kanji in both fields but independently verifies the generated spans", async () => {
    const h = harness("灯里の登記は終わらなかった。", "灯里のとうきはおわらなかった。");
    const settings = { ...defaultSettings, userDictionary: [{ id: "person", reading: "akari", output: "灯里", enabled: true, note: "" }] };
    const result = await convertRomajiToJapaneseDetailed("akarinotoukihaowaranakatta.", settings, h.transport, {
      userRequestedSpeculation: true, kanaEngine: h.kanaEngine, avoidOutputs: ["灯里の陶器は終わらなかった。"],
    });
    expect(result.text).toBe("灯里の登記は終わらなかった。");
    expect(h.kanaEngine.verify).toHaveBeenCalledWith("の登記は終わらなかった。", "のとうきはおわらなかった。", [], undefined);
    expect(result.changes?.readingAssessment?.status).toBe("verified");
  });

  it.each([
    ["の更新は終わらなかった。", "のこうしんはおわらなかった。"],
    ["MR-62のMR-62の更新は終わらなかった。", "MR-62のMR-62のこうしんはおわらなかった。"],
    ["ZZ-99の更新は終わらなかった。", "ZZ-99のこうしんはおわらなかった。"],
  ])("rejects broken protected anchors before accepting %s", async (text, reading) => {
    const h = harness(text, reading);
    const result = await convertRomajiToJapaneseDetailed("`MR-62`nokoushihaowaranakatta.", defaultSettings, h.transport, { ...options, kanaEngine: h.kanaEngine });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, rejectionDetail: "protected-content" });
    expect(h.kanaEngine.verify).not.toHaveBeenCalled();
  });

  it("rejects changed numbers even when text and claimed reading agree", async () => {
    const h = harness("まだ9件の申告は終わっていない。", "まだ9けんのしんこくはおわっていない。");
    const result = await convertRomajiToJapaneseDetailed("mada8kennoshinkouhaowatteinai.", defaultSettings, h.transport, {
      userRequestedSpeculation: true, kanaEngine: h.kanaEngine, avoidOutputs: ["まだ8件の進行は終わっていない。"],
    });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, rejectionDetail: "protected-content" });
  });

  it("still rejects invented reading kanji outside protected spans and contradictory readings", async () => {
    const h = harness("MR-62の更新は終わらなかった。", "MR-62の更新はおわらなかった。");
    await expect(convertRomajiToJapaneseDetailed("`MR-62`nokoushihaowaranakatta.", defaultSettings, h.transport, {
      ...options, kanaEngine: h.kanaEngine,
    })).rejects.toMatchObject({ diagnostic: "reading-format" });
    h.generate.mockResolvedValue({ response: JSON.stringify({ convertedText: "MR-62の更新は終わらなかった。", completedKana: "MR-62のこうしはおわらなかった。" }) });
    h.kanaEngine.verify.mockResolvedValue("contradicted");
    const result = await convertRomajiToJapaneseDetailed("`MR-62`nokoushihaowaranakatta.", defaultSettings, h.transport, { ...options, kanaEngine: h.kanaEngine });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, rejectionDetail: "reading-contradiction" });
  });
});
