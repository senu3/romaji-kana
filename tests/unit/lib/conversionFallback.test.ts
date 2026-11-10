import { describe, expect, it, vi } from "vitest";
import type { JapaneseConversionResult } from "../../../src/lib/japaneseConversionTypes";
import type { EngineCandidate, KanaEngine } from "../../../src/lib/kanaEngine";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { requiresExplicitAcceptance } from "../../../src/lib/readingAssessment";
import { defaultSettings } from "../../../src/lib/settings";

const json = (text: string, reading: string) => ({ response: JSON.stringify({ convertedText: text, completedKana: reading }) });
function harness(candidates: EngineCandidate[] = []) {
  const engine: KanaEngine = { search: vi.fn(async reading => ({ candidates: candidates.filter(c => c.reading === reading), truncated: false, dictionaryRevision: "test" })), verify: vi.fn().mockResolvedValue("verified") };
  const generate = vi.fn();
  return { engine, generate, transport: { models: vi.fn(), generate } };
}
function candidate(text: string, source = "mozc", reading = "ほん"): EngineCandidate {
  return { text, reading, cost: 100, tokens: [{ text, reading, source: source as "mozc" | "literal", from: 0, to: [...reading].length, entryId: "test", lid: 0, rid: 0, wordCost: 100 }] };
}

describe("normal → correction → speculation → unchanged romaji", () => {
  it("stops automatic rescue after correction unless reinterpretation was opted into", async () => {
    const h = harness();
    h.generate.mockResolvedValue(json("", ""));
    const result = await convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.attempts?.map(a => a.stage)).toEqual(["normal", "correction"]);
    expect(h.generate).toHaveBeenCalledOnce();
  });
  it("rejects an explicit speculative proposal that reverses attendance", async () => {
    const h = harness();
    h.generate.mockResolvedValue(json("明日は欠席します。", "あしたはけっせきします。"));
    const result = await convertRomajiToJapaneseDetailed("ashitahaiku.", defaultSettings, h.transport, { kanaEngine: h.engine, purpose: "speculative" });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, rejectionDetail: "semantic-conflict" });
    expect(h.generate).toHaveBeenCalledOnce();
  });
  it("reports a repaired misspelling as a correction with the original reading retained", async () => {
    const h = harness();
    h.generate.mockResolvedValue(json("分かったふりをする", "わかったふりをする"));
    const result = await convertRomajiToJapaneseDetailed("wakatahuriwosuru", defaultSettings, h.transport, {
      autoSpeculation: true, kanaEngine: h.engine, missingLetterCorrection: false,
    });
    expect(result).toMatchObject({ text: "分かったふりをする", conversionStrategy: "correction",
      changes: { sourceReading: "わかたふりをする", resultReading: "わかったふりをする" } });
    expect(requiresExplicitAcceptance(result)).toBe(true);
  });
  it("uses a contextual paraphrase only after both earlier routes fail, with one speculative generation", async () => {
    const h = harness();
    h.generate.mockResolvedValueOnce(json("", ""))
      .mockResolvedValueOnce(json("同じ手順で進めてください。", "おなじてじゅんですすめてください。"));
    const result = await convertRomajiToJapaneseDetailed("houkouwokaenaidekudasai.", defaultSettings, h.transport, {
      autoSpeculation: true, kanaEngine: h.engine, contextBefore: "全員が同じ作業手順で進めます。",
    });
    expect(result.text).toBe("同じ手順で進めてください。");
    expect(result.attempts?.map(a => a.stage)).toEqual(["normal", "correction", "speculative"]);
    expect(result.conversionStrategy).toBe("speculative");
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(h.generate).toHaveBeenCalledTimes(2);
  });
  it("can evaluate normal conversion and correction without launching speculative rescue", async () => {
    const h = harness();
    h.generate.mockResolvedValue(json("", ""));
    const result = await convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, {
      kanaEngine: h.engine, autoSpeculation: false,
    });
    expect(result.suggestionRejected).toBe(true);
    expect(result.attempts?.map(attempt => attempt.stage)).toEqual(["normal", "correction"]);
    expect(h.generate).toHaveBeenCalledOnce();
  });
  it("removes synthetic passthrough from candidates and sends dictionary ranking evidence", async () => {
    const h = harness([candidate("本"), candidate("ほん", "literal"), candidate("奔")]);
    h.generate.mockResolvedValue({ response: '{"order":["candidate-0"]}' });
    const result = await convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, { autoSpeculation: true, kanaEngine: h.engine });
    expect(result.session?.candidates.map(c => c.result.text)).toEqual(["本", "奔"]);
    const prompt = JSON.parse(h.generate.mock.calls[0][2].prompt);
    expect(prompt).not.toHaveProperty("styleGuidance");
    expect(prompt.candidates[0]).toMatchObject({ localRank: 1, cost: 100 });
  });
  it("keeps the sole dictionary-backed hiragana candidate without rescue", async () => {
    const h = harness([candidate("ありがとう", "mozc", "ありがとう")]);
    const result = await convertRomajiToJapaneseDetailed("arigatou", defaultSettings, h.transport, { autoSpeculation: true, kanaEngine: h.engine });
    expect(result.text).toBe("ありがとう");
    expect(result.session?.candidates).toHaveLength(1);
    expect(h.generate).not.toHaveBeenCalled();
  });
  it("tries a bounded typo correction after normal conversion has no candidate", async () => {
    const h = harness();
    h.generate.mockResolvedValue(json("明日の予定。", "あしたのよてい。"));
    const result = await convertRomajiToJapaneseDetailed("ashitanoyottei.", defaultSettings, h.transport, { autoSpeculation: true, kanaEngine: h.engine });
    expect(result.text).toBe("明日の予定。");
    expect(result.conversionStrategy).toBe("correction");
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(result.attempts?.map(a => [a.stage, a.outcome])).toEqual([["normal", "rejected"], ["correction", "candidate"]]);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0][2].outputSchema).toEqual({
      type: "object",
      properties: { convertedText: { type: "string" }, completedKana: { type: "string" } },
      required: ["convertedText", "completedKana"], additionalProperties: false
    });
  });
  it("discards an unchanged reading echo and tries speculation once", async () => {
    const h = harness();
    h.generate.mockResolvedValueOnce(json("ほん。", "ほん。")).mockResolvedValueOnce(json("本。", "ほん。"));
    const result = await convertRomajiToJapaneseDetailed("hon.", defaultSettings, h.transport, { autoSpeculation: true, kanaEngine: h.engine });
    expect(result.text).toBe("本。");
    expect(result.conversionStrategy).toBe("speculative");
    expect(result.attempts?.map(a => a.stage)).toEqual(["normal", "correction", "speculative"]);
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(h.generate.mock.calls[0][2].system).toContain("minimally repair");
    expect(h.generate.mock.calls[1][2].system).toContain("本来入力したかった内容");
    expect(h.generate.mock.calls[1][2].outputSchema.required).toEqual(["convertedText", "completedKana"]);
  });
  it("keeps a sole inferred hiragana candidate including terminal punctuation", async () => {
    const h = harness();
    h.generate.mockResolvedValueOnce(json("ありが。", "ありが。")).mockResolvedValueOnce(json("ありがとう。", "ありがとう。"));
    const result = await convertRomajiToJapaneseDetailed("ariga.", defaultSettings, h.transport, { autoSpeculation: true, kanaEngine: h.engine });
    expect(result.text).toBe("ありがとう。");
    expect(result.conversionStrategy).toBe("speculative");
    expect(h.generate.mock.calls[1][2].system).not.toContain("Candidate: 感謝します");
  });
  it("leaves the original romaji when both rescues fail instead of returning kana", async () => {
    const h = harness();
    h.generate.mockResolvedValue(json("ほん。", "ほん。"));
    const result = await convertRomajiToJapaneseDetailed("hon.", defaultSettings, h.transport, { autoSpeculation: true, kanaEngine: h.engine });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, suggestionRejectedReason: "unconvertible" });
    expect(result.session).toBeUndefined();
    expect(result.attempts?.every(a => a.outcome === "rejected")).toBe(true);
    expect(h.generate).toHaveBeenCalledTimes(2);
  });
  it("rejects invented numbers in both rescue stages", async () => {
    const h = harness();
    h.generate.mockResolvedValue(json("11時。", "11じ。"));
    const result = await convertRomajiToJapaneseDetailed("10ji.", defaultSettings, h.transport, { autoSpeculation: true, kanaEngine: h.engine });
    expect(result.text).toBe("");
    expect(result.attempts).toHaveLength(3);
  });
  it("awaits rescue after deferred ranking abstains and dismisses the provisional session", async () => {
    const h = harness([candidate("本"), candidate("奔")]);
    h.generate.mockResolvedValueOnce({ response: '{"order":[]}' }).mockResolvedValueOnce(json("本", "ほん"));
    let run!: () => Promise<void>;
    const start = vi.fn();
    const ranked = vi.fn<(result: JapaneseConversionResult) => void>();
    const initial = await convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, {
      autoSpeculation: true, kanaEngine: h.engine, deferRanking: task => { run = task; }, onRescueStart: start, onRankedCandidates: ranked,
    });
    expect(initial.session?.rerankStatus).toBe("pending");
    expect(ranked).not.toHaveBeenCalled();
    await run();
    expect(initial.session?.state).toBe("dismissed");
    expect(start).toHaveBeenCalledOnce();
    expect(ranked.mock.calls[0][0]).toMatchObject({ text: "本", conversionStrategy: "correction" });
    expect(h.generate).toHaveBeenCalledTimes(2);
  });
  it("does not treat transport failure as a request to run the next rescue", async () => {
    const h = harness();
    h.generate.mockRejectedValue(new Error("offline"));
    await expect(convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, { autoSpeculation: true, kanaEngine: h.engine })).rejects.toThrow("offline");
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
  it("does not accept legacy unvalidated plain text as an automatic rescue candidate", async () => {
    const h = harness();
    h.generate.mockResolvedValue({ response: "変換できません" });
    const result = await convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, { autoSpeculation: true, kanaEngine: h.engine });
    expect(result).toMatchObject({ text: "", suggestionRejected: true, suggestionRejectedReason: "unconvertible" });
    expect(result.attempts?.slice(1).map(attempt => attempt.detail)).toEqual(["response-format", "response-format"]);
  });
  it("never starts speculation after correction is canceled", async () => {
    const h = harness();
    const controller = new AbortController();
    h.generate.mockImplementation(() => { controller.abort(); return new Promise(() => { }); });
    await expect(convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, { autoSpeculation: true, kanaEngine: h.engine, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
});

describe("experimental speculation after an unresolved comparison", () => {
  const input = "ashitanoyottei.";
  const original = "あしたのよってい";
  const corrected = "あしたのよてい";
  const options = { autoSpeculation: true, typoSpeculation: "suspected" as const, missingLetterCorrection: false };

  function suspectedTypo(...extra: EngineCandidate[]) {
    const h = harness([candidate("明日のよっ程", "mozc", original), candidate("明日のよってい", "mozc", original), ...extra]);
    h.generate.mockResolvedValueOnce({ response: '{"order":["candidate-0"],"repairNeeded":true}' });
    return h;
  }

  it("tries a targeted dictionary lookup for the guessed reading and keeps the result in review", async () => {
    const h = suspectedTypo(candidate("明日の予定", "mozc", corrected));
    h.generate.mockResolvedValueOnce(json("明日のよてい。", corrected + "。"));
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, { ...options, kanaEngine: h.engine });
    expect(result).toMatchObject({
      text: "明日の予定。", conversionStrategy: "speculative", changes: { evidence: "dictionary-path" },
      romajiCorrection: { before: "ashitanoyottei。", after: "ashitanoyotei。" },
    });
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(h.engine.search).toHaveBeenCalledWith(corrected, expect.anything(), expect.any(AbortSignal));
  });

  it("returns the verified proposal for review when the targeted dictionary lookup has no candidate", async () => {
    const h = suspectedTypo();
    h.generate.mockResolvedValueOnce(json("明日の予定。", corrected + "。"));
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, { ...options, kanaEngine: h.engine });
    expect(result).toMatchObject({ text: "明日の予定。", conversionStrategy: "speculative", changes: { evidence: "model-reading" } });
    expect(result.romajiCorrection).toBeUndefined();
    expect(requiresExplicitAcceptance(result)).toBe(true);
  });

  it("retains the selected spelling when the proposed reading is unchanged", async () => {
    const h = suspectedTypo();
    h.generate.mockResolvedValueOnce(json("明日のよってい。", original + "。"));
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, { ...options, kanaEngine: h.engine });
    expect(result.text).toBe("明日のよっ程。");
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(h.engine.search).toHaveBeenCalledTimes(1);
  });

  it("probes an accepted candidate without a typo signal only in the broad arm", async () => {
    for (const typoSpeculation of ["suspected", "all-normal"] as const) {
      const h = harness([candidate("明日のよってい", "mozc", original)]);
      h.generate.mockResolvedValueOnce(json("明日の予定。", corrected + "。"));
      const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, { ...options, typoSpeculation, kanaEngine: h.engine });
      expect(result.text).toBe(typoSpeculation === "all-normal" ? "明日の予定。" : "明日のよってい。");
      expect(h.generate).toHaveBeenCalledTimes(typoSpeculation === "all-normal" ? 1 : 0);
    }
  });

  it("retains the user's selection when the session locks during speculation", async () => {
    const h = suspectedTypo();
    let lock: () => void;
    h.generate.mockImplementationOnce(async () => {
      lock();
      return json("明日の予定。", corrected + "。");
    });
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, {
      ...options, kanaEngine: h.engine, onLocalCandidates: initial => { lock = () => { initial.session!.locked = true; }; },
    });
    expect(result.text).toBe("明日のよっ程。");
    expect(h.engine.search).toHaveBeenCalledTimes(1);
  });
});

describe("first-pass comparison of normal and one-key repairs", () => {
  it.each([false, true])("repairs a standalone request before ranking (boundary=%s)", async boundary => {
    const h = harness([
      candidate("尾根がします", "mozc", "おねがします"),
      candidate("お願いします", "mozc", "おねがいします"),
    ]);
    const publish = vi.fn();
    const queue = vi.fn();
    const result = await convertRomajiToJapaneseDetailed("onegasimasu", defaultSettings, h.transport, {
      repairStandaloneRequests: true, kanaEngine: h.engine,
      ...(boundary ? { compareRepairsEarly: "compact", shortRepairId: true, decisionDeadline: Date.now() + 500,
        onRankedCandidates: publish, deferRanking: queue } : { rerank: false, autoRescue: false }),
    });
    expect(result).toMatchObject({ text: "お願いします", conversionStrategy: "correction", romajiCorrection: { inserted: "i" } });
    expect(h.engine.search).toHaveBeenCalledTimes(2);
    expect(h.generate).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    if (boundary) expect(publish).toHaveBeenCalledExactlyOnceWith(result);
  });

  it.each([
    ["onegaisimasu", "お願いします", "おねがいします", "mozc"],
    ["okusuriwonomimasu", "お薬を飲みます", "おくすりをのみます", "mozc"],
    ["onegasimasu", "登録語", "おねがします", "user"],
  ])("preserves ordinary readings and personal dictionary entries (%s)", async (input, text, reading, source) => {
    const h = harness([candidate(text, source, reading)]);
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, {
      repairStandaloneRequests: true, kanaEngine: h.engine, autoRescue: false, rerank: false,
    });
    expect(result.text).toBe(text);
    expect(result.conversionStrategy).toBeUndefined();
    expect(h.engine.search).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["annwoonegasimasu.", "あんをおねがします", "案をおねがします", "あんをおねがいします", "案をお願いします", "i"],
    ["konoshiryouwokakkuninshimasu.", "このしりょうをかっくにんします", "この資料を各区にんします",
      "このしりょうをかくにんします", "この資料を確認します", ""],
  ])("compares both readings in a single model call for %s", async (input, source, unchanged, fixed, corrected, edit) => {
    const h = harness([candidate(unchanged, "mozc", source), candidate(corrected, "mozc", fixed)]);
    h.generate.mockImplementation(async (_provider, _url, request) => {
      const prompt = JSON.parse(request.prompt);
      expect(prompt.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: unchanged + "。", kind: "conversion" }),
        expect.objectContaining({ text: corrected + "。", kind: "correction", edit: expect.objectContaining({ inserted: edit }) }),
      ]));
      return { response: JSON.stringify({ order: [prompt.candidates.find((c: { kind: string }) => c.kind === "correction").id], repairNeeded: false }) };
    });
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, {
      compareRepairsEarly: "compact", kanaEngine: h.engine,
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: corrected + "。", conversionStrategy: "correction" });
  });

  it.each(["select", "-", "invalid"])("handles a short ranking response (%s)", async response => {
    const source = "あんをおねがします";
    const repaired = "あんをおねがいします";
    const h = harness([
      candidate("案をおねがします", "mozc", source),
      candidate("案を尾根がします", "mozc", source),
      candidate("あんをおねがします", "mozc", source),
      candidate("餡をおねがします", "mozc", source),
      candidate("案をお願いします", "mozc", repaired),
    ]);
    h.generate.mockImplementation(async (_provider, _url, request) => {
      const prompt = JSON.parse(request.prompt);
      const fixed = prompt.candidates.find((c: { kind: string }) => c.kind === "correction");
      expect(fixed.id).toMatch(/^[a-f]$/u);
      expect(request.outputSchema).toMatchObject({
        properties: { c: { enum: expect.arrayContaining([fixed.id, "-"]) } },
        required: ["c"], additionalProperties: false,
      });
      return { response: JSON.stringify({ c: response === "select" ? fixed.id : response }) };
    });
    const result = await convertRomajiToJapaneseDetailed("annwoonegasimasu.", defaultSettings, h.transport, {
      compareRepairsEarly: "compact", shortRepairId: true, kanaEngine: h.engine,
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(result.text).toBe(response === "select" ? "案をお願いします。" : "案をおねがします。");
    expect(result.session?.candidates.map(candidate => candidate.result.text)).toContain("餡をおねがします。");
  });

  it("maps an alias for a contextual spelling back to its candidate", async () => {
    const h = harness([
      candidate("案をおねがします", "mozc", "あんをおねがします"),
      candidate("餡をおねがします", "mozc", "あんをおねがします"),
      candidate("案をお願いします", "mozc", "あんをおねがいします"),
    ]);
    h.generate.mockImplementation(async (_provider, _url, request) => {
      const prompt = JSON.parse(request.prompt);
      const normal = prompt.candidates.find((c: { kind: string }) => c.kind === "conversion");
      expect(normal.alternativeSpellings).toEqual([{ id: expect.stringMatching(/^[a-f]$/u), text: "餡をおねがします。" }]);
      return { response: JSON.stringify({ c: normal.alternativeSpellings[0].id }) };
    });
    const result = await convertRomajiToJapaneseDetailed("annwoonegasimasu.", defaultSettings, h.transport, {
      compareRepairsEarly: "compact", shortRepairId: true, kanaEngine: h.engine, contextBefore: "和菓子を作ります。",
    });
    expect(result.text).toBe("餡をおねがします。");
  });
});
