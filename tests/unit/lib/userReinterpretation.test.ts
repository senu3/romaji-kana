import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";
import { requiresExplicitAcceptance } from "../../../src/lib/readingAssessment";

function harness(text: string, reading: string) {
  const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ segments: [{ id: "edit-1", convertedText: text.replace(/^MR-62|^灯里/u, ""), completedKana: reading.replace(/^MR-62|^灯里/u, "") }] }) });
  const kanaEngine = { search: vi.fn(), verify: vi.fn().mockResolvedValue("verified") };
  return { generate, kanaEngine, transport: { models: vi.fn(), generate } };
}
const options = { userRequestedSpeculation: true, avoidOutputs: ["MR-62の講師は終わらなかった。"] };

describe("whole-target user reinterpretation", () => {
  it.each([
    ["ashitahaikanai.", "明日の会議には出席しないと返答します。", "明日の会議への参加は見送ります。", "あしたのかいぎへのさんかはみおくります。"],
    ["houkouwokaenaidekudasai.", "全員が同じ作業手順で進めます。", "同じ手順で進めてください。", "おなじてじゅんですすめてください。"],
    ["ashitaha", "明日の会議には出席しないと返答します。", "明日は欠席します。", "あしたはけっせきします。"],
  ])("accepts a context-supported paraphrase through the contract, without extra generation: %s", async (input, contextBefore, text, reading) => {
    // Stubbed verification tests the contract, not the model's semantic accuracy.
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ convertedText: text, completedKana: reading }) });
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, { models: vi.fn(), generate }, {
      userRequestedSpeculation: true, contextBefore, avoidOutputs: ["退けた候補。"],
      kanaEngine: { search: vi.fn(), verify: vi.fn().mockResolvedValue("verified") },
    });
    expect(result.text).toBe(text);
    expect(result.conversionStrategy).toBe("speculative");
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("aligns context and immutable parts in the shared reduced request", async () => {
    const h = harness("MR-62の更新は終わらなかった。", "MR-62のこうしんはおわらなかった。");
    const input = "`MR-62`nokoushihaowaranakatta.";
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, {
      ...options, kanaEngine: h.kanaEngine, contextBefore: "更新の報告です。別装置ZZ-99は完了。", contextAfter: "明日再開する。",
    });
    expect(result.text).toBe("MR-62の更新は終わらなかった。");
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(h.generate).toHaveBeenCalledTimes(1);
    const request = h.generate.mock.calls[0][2];
    expect(JSON.parse(request.prompt.split("Original input (ordered parts):\n")[1].split("\nContext after:")[0])).toEqual([
      { literal: "MR-62" }, { id: "edit-1", originalInput: "のこうしはおわらなかった。" },
    ]);
    expect(request.prompt).toContain("更新の報告です。別装置ZZ-99は完了。");
    expect(request.prompt).toContain("明日再開する。");
    expect(request.prompt).not.toContain(options.avoidOutputs[0]);
    expect(request.system).not.toContain(options.avoidOutputs[0]);
    expect(h.kanaEngine.verify).toHaveBeenCalledWith("の更新は終わらなかった。", "のこうしんはおわらなかった。", [], expect.any(AbortSignal));
    expect(h.kanaEngine.search).not.toHaveBeenCalled();
  });

  it("keeps multiple and repeated anchors in order, including a protected final span", async () => {
    const h = harness("A-1からB-2へ配信しません。A-1", "A-1からB-2へはいしんしません。A-1");
    h.generate.mockResolvedValue({ response: JSON.stringify({ segments: [
      { id: "edit-3", convertedText: "へ配信しません。", completedKana: "へはいしんしません。" },
    ] }) });
    const result = await convertRomajiToJapaneseDetailed("`A-1`kara`B-2`hehaishishimasen.`A-1`", defaultSettings, h.transport, {
      userRequestedSpeculation: true, kanaEngine: h.kanaEngine, avoidOutputs: ["A-1からB-2へ廃止しません。A-1"],
    });
    expect(result.text).toBe("A-1からB-2へ配信しません。A-1");
    expect(result.reviewKana).toBe("A-1からB-2へはいしんしません。A-1");
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("restores explicitly protected kanji without requiring a model-supplied reading", async () => {
    const h = harness("灯里の登記は終わらなかった。", "灯里のとうきはおわらなかった。");
    const result = await convertRomajiToJapaneseDetailed("`灯里`notoukihaowaranakatta.", defaultSettings, h.transport, {
      userRequestedSpeculation: true, kanaEngine: h.kanaEngine, avoidOutputs: ["灯里の陶器は終わらなかった。"],
    });
    expect(result.text).toBe("灯里の登記は終わらなかった。");
    expect(h.kanaEngine.verify).toHaveBeenCalledWith("の登記は終わらなかった。", "のとうきはおわらなかった。", [], expect.any(AbortSignal));
    expect(result.changes?.readingAssessment?.status).toBe("verified");
  });

  it("fixes separated particles without counting matching kana inside editable words", async () => {
    const h = harness("", "");
    h.generate.mockResolvedValue({ response: JSON.stringify({ segments: [
      { id: "edit-4", convertedText: "変更しません。", completedKana: "へんこうしません。" },
    ] }) });
    const result = await convertRomajiToJapaneseDetailed("`A-1` kara `B-2` he henkoushimasen.", defaultSettings, h.transport, {
      userRequestedSpeculation: true, kanaEngine: h.kanaEngine, avoidOutputs: ["A-1からB-2へ返答しません。"],
    });
    expect(JSON.parse(h.generate.mock.calls[0][2].prompt.split("Original input (ordered parts):\n")[1].split("\nContext after:")[0])).toEqual([
      { literal: "A-1" }, { literal: "から" }, { literal: "B-2" }, { literal: "へ" },
      { id: "edit-4", originalInput: "へんこうしません。" },
    ]);
    expect(result.text).toBe("A-1からB-2へ変更しません。");
    expect(result.reviewKana).toBe("A-1からB-2へへんこうしません。");
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("does not split an ambiguous word prefix into a fixed particle", async () => {
    const h = harness("", "");
    h.generate.mockResolvedValue({ response: JSON.stringify({ segments: [
      { id: "edit-1", convertedText: "変更しません。", completedKana: "へんこうしません。" },
    ] }) });
    const result = await convertRomajiToJapaneseDetailed("`A-1`henkoushimasen.", defaultSettings, h.transport, {
      userRequestedSpeculation: true, kanaEngine: h.kanaEngine, avoidOutputs: ["A-1返答しません。"],
    });
    expect(JSON.parse(h.generate.mock.calls[0][2].prompt.split("Original input (ordered parts):\n")[1].split("\nContext after:")[0])).toEqual([
      { literal: "A-1" }, { id: "edit-1", originalInput: "へんこうしません。" },
    ]);
    expect(result.text).toBe("A-1変更しません。");
  });

  it.each([
    { segments: [{ id: "edit-0", convertedText: "更新", completedKana: "こうしん" }] },
    { segments: [{ id: "edit-1", convertedText: "更新", completedKana: "こうしん" }, { id: "edit-1", convertedText: "更新", completedKana: "こうしん" }] },
    { convertedText: "MR-62の更新は終わらなかった。", completedKana: "MR-62のこうしんはおわらなかった。" },
  ])("rejects missing, duplicate, unknown or legacy segment structures: %j", async response => {
    const h = harness("", "");
    h.generate.mockResolvedValue({ response: JSON.stringify(response) });
    await expect(convertRomajiToJapaneseDetailed("`MR-62`nokoushihaowaranakatta.", defaultSettings, h.transport, {
      ...options, kanaEngine: h.kanaEngine,
    })).rejects.toMatchObject({ diagnostic: "response-format" });
    expect(h.kanaEngine.verify).not.toHaveBeenCalled();
  });

  it("rejects protected text smuggled into an editable segment", async () => {
    const h = harness("のMR-62更新は終わらなかった。", "のMR-62こうしんはおわらなかった。");
    const result = await convertRomajiToJapaneseDetailed("`MR-62`nokoushihaowaranakatta.", defaultSettings, h.transport, { ...options, kanaEngine: h.kanaEngine });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, rejectionDetail: "protected-content" });
  });

  it("rejects changed numbers even when text and claimed reading agree", async () => {
    const h = harness("", "");
    h.generate.mockResolvedValue({ response: JSON.stringify({ convertedText: "まだ9件の申告は終わっていない。", completedKana: "まだ9けんのしんこくはおわっていない。" }) });
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
    h.generate.mockResolvedValue({ response: JSON.stringify({ segments: [{ id: "edit-1", convertedText: "の更新は終わらなかった。", completedKana: "のこうしはおわらなかった。" }] }) });
    h.kanaEngine.verify.mockResolvedValue("contradicted");
    const result = await convertRomajiToJapaneseDetailed("`MR-62`nokoushihaowaranakatta.", defaultSettings, h.transport, { ...options, kanaEngine: h.kanaEngine });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, rejectionDetail: "reading-contradiction" });
  });

  it("rejects out-of-order editable IDs without verifying or assembling partial results", async () => {
    const h = harness("", "");
    h.generate.mockResolvedValue({ response: JSON.stringify({ segments: [
      { id: "edit-3", convertedText: "の登記。", completedKana: "のとうき。" },
      { id: "edit-1", convertedText: "を見て", completedKana: "をみて" },
    ] }) });
    await expect(convertRomajiToJapaneseDetailed("`A-1`womite`B-2`notouki.", defaultSettings, h.transport, {
      ...options, kanaEngine: h.kanaEngine,
    })).rejects.toMatchObject({ diagnostic: "response-format" });
    expect(h.kanaEngine.verify).not.toHaveBeenCalled();
  });

  it("treats an empty segment list as abstention, without returning literal-only text", async () => {
    const h = harness("", "");
    h.generate.mockResolvedValue({ response: '{"segments":[]}' });
    const result = await convertRomajiToJapaneseDetailed("`MR-62`nokoushihaowaranakatta.", defaultSettings, h.transport, { ...options, kanaEngine: h.kanaEngine });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, rejectionDetail: "no-candidate" });
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("does not return a completed literal layout after cancellation during reading verification", async () => {
    const h = harness("MR-62の更新は終わらなかった。", "MR-62のこうしんはおわらなかった。");
    const controller = new AbortController();
    h.kanaEngine.verify.mockImplementation(async () => { controller.abort(); return "verified"; });
    await expect(convertRomajiToJapaneseDetailed("`MR-62`nokoushihaowaranakatta.", defaultSettings, h.transport, {
      ...options, kanaEngine: h.kanaEngine, signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects the same interpretation with only a known polite negative ending changed", async () => {
    const h = harness("", "");
    h.generate.mockResolvedValue({ response: JSON.stringify({ convertedText: "この教材の廃止はまだしていません。", completedKana: "このきょうざいのはいしはまだしていません。" }) });
    const result = await convertRomajiToJapaneseDetailed("konokyouzainohaishihamadasiteinai.", defaultSettings, h.transport, {
      ...options, kanaEngine: h.kanaEngine, avoidOutputs: ["この教材の廃止はまだしていない。"],
    });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, rejectionDetail: "avoided-output" });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(result.session).toBeUndefined();
  });
});
