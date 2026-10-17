import { describe, expect, it, vi } from "vitest";
import { isAllowedInputCompletion } from "./completionValidation";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings } from "./settings";
import { selectSegmentRoute } from "./conversionPolicy";

const json = (completedKana: string, convertedText = completedKana, correctedKana?: string) =>
  ({ response: JSON.stringify({ completedKana, convertedText, ...(correctedKana ? { correctedKana } : {}) }) });

describe("word completion versus phrase continuation", () => {
  it.each([
    ["ありが。", "ありがとう。"], ["すみませ。", "すみません。"],
    ["あしたのよていをおねが。", "あしたのよていをおねがい。"],
  ])("accepts a suffix within the started word: %s", (source, candidate) => {
    expect(isAllowedInputCompletion(source, candidate, "word")).toBe(true);
  });
  it.each([
    ["お", "おめでとうございます"], ["ほんをよむ", "ほんをよむことにしました"],
    ["おねがい", "おねがいします"], ["ありが", "ありがとうございます"],
  ])("reserves continuation for sentence mode: %s → %s", (source, candidate) => {
    expect(isAllowedInputCompletion(source, candidate, "word")).toBe(false);
    expect(isAllowedInputCompletion(source, candidate, "sentence")).toBe(true);
  });
  it("checks the final reading rather than trusting a model's additions declaration", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({
      completedKana: "ほんをよむことにしました。", convertedText: "本を読むことにしました。", additions: [],
    }) });
    const transport = { models: vi.fn(), generate };
    const word = await convertRomajiToJapaneseDetailed("honwoyomu.", { ...defaultSettings, inputCompletionLevel: "word" }, transport);
    expect(word).toMatchObject({ text: "", suggestionRejectedReason: "diverged" });
    expect(word.inputCompletionAdditions).toBeUndefined();
    const sentence = await convertRomajiToJapaneseDetailed("honwoyomu.", { ...defaultSettings, inputCompletionLevel: "sentence" }, transport);
    expect(sentence.text).toBe("本を読むことにしました。");
    expect(sentence.changes).toMatchObject({ kind: "completion", additions: ["ことにしました"] });
    expect(sentence.changes?.additionKind).toBe("phrase");
  });
  it("classifies a word completion by the actual change even in sentence mode", async () => {
    const generate = vi.fn().mockResolvedValue(json("ありがとう。"));
    const result = await convertRomajiToJapaneseDetailed("ariga.", { ...defaultSettings, inputCompletionLevel: "sentence" }, { models: vi.fn(), generate });
    expect(result.changes).toMatchObject({ additionKind: "word", additions: ["とう"] });
  });
  it("accepts a verified surface word when kana segmentation splits the word", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({
      correctedKana: "しょるいのかくに。", completedKana: "しょるいのかくにん。", convertedText: "書類の確認。",
      wordCompletion: { sourceKana: "かくに", completedKana: "かくにん", convertedText: "確認" },
    }) });
    const result = await convertRomajiToJapaneseDetailed("shoruinokakuni.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result.text).toBe("書類の確認。");
    expect(result.changes).toMatchObject({ additionKind: "word", additions: ["ん"] });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it.each([
    { sourceKana: "ほんをよむ", completedKana: "ほんをよむことにしました", convertedText: "本を読むことにしました" },
    { sourceKana: "ちがう", completedKana: "ほんをよむことにしました", convertedText: "決定" },
    { sourceKana: "ほんをよむ", completedKana: "ほんをよむことにしました", convertedText: "確認" },
  ])("does not accept a phrase from a false word declaration: %j", async wordCompletion => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({
      completedKana: "ほんをよむことにしました。", convertedText: "本を読むことにしました。", wordCompletion,
    }) });
    const result = await convertRomajiToJapaneseDetailed("honwoyomu.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "diverged" });
  });
  it("rejects a completed-word declaration contradicting the final reading", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ completedKana: "かくに。", convertedText: "確認。",
      wordCompletion: { sourceKana: "かくに", completedKana: "かくにん", convertedText: "確認" } }) });
    const result = await convertRomajiToJapaneseDetailed("kakuni.", { ...defaultSettings, inputCompletionLevel: "word" }, { models: vi.fn(), generate });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "diverged" });
  });
  it("keeps unchanged input usable when word segmentation is unavailable", () => {
    vi.stubGlobal("Intl", { Segmenter: undefined });
    try {
      expect(isAllowedInputCompletion("ほん。", "ほん。", "word")).toBe(true);
      expect(isAllowedInputCompletion("ありが。", "ありがとう。", "word")).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("alternative spelling versus typo rescue", () => {
  it.each(["none", "word", "sentence"] as const)("prioritizes explicit purpose over %s mode", level => {
    expect(selectSegmentRoute(level, { alternativeMode: true }).kind).toBe("alternative");
    expect(selectSegmentRoute(level, { completionMode: true }).kind).toBe("typo-repair");
    expect(selectSegmentRoute(level, { speculativeMode: true }).kind).toBe("speculative");
  });
  it("retains a completed reading while exploring its spelling, without completing again", async () => {
    const generate = vi.fn().mockResolvedValue(json("ありがとう。", "有難う。"));
    const result = await convertRomajiToJapaneseDetailed("ariga.", { ...defaultSettings, inputCompletionLevel: "word" },
      { models: vi.fn(), generate }, { avoidOutputs: ["ありがとう。"], alternativeReading: "ありがとう。" });
    expect(result.text).toBe("有難う。");
    expect(result.changes).toMatchObject({ kind: "completion", additions: ["とう"] });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][2].prompt).toBe("ありがとう。");
    expect(generate.mock.calls[0][2].system).not.toContain("one Japanese writing suggestion");
  });
  it("rejects reading changes in alternatives and retries only the spelling route", async () => {
    const generate = vi.fn().mockResolvedValueOnce(json("かんしゃします。", "感謝します。"))
      .mockResolvedValueOnce(json("ありがとう。", "有難う。"));
    const result = await convertRomajiToJapaneseDetailed("ariga.", defaultSettings, { models: vi.fn(), generate },
      { avoidOutputs: ["ありがとう。"], alternativeReading: "ありがとう。" });
    expect(result.text).toBe("有難う。");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls.every(call => call[2].prompt === "ありがとう。")).toBe(true);
  });
  it("retains literal boundaries and correction/completion metadata in alternatives", async () => {
    const generate = vi.fn().mockResolvedValue(json("あしたのよていをおねがい。", "明日の予定をお願い。"));
    const result = await convertRomajiToJapaneseDetailed("`OpenAI`ashitanoyotteiwoonega.", defaultSettings,
      { models: vi.fn(), generate }, {
        avoidOutputs: ["OpenAI明日の予定をおねがい。"],
        alternativeReading: "OpenAIあしたのよていをおねがい。",
        alternativeCorrectedReading: "OpenAIあしたのよていをおねが。",
        alternativeAdditionKind: "word",
      });
    expect(result.text).toBe("OpenAI明日の予定をお願い。");
    expect(result.changes).toMatchObject({ kind: "completion", correctedReading: "OpenAIあしたのよていをおねが。", additions: ["い"], additionKind: "word" });
    expect(generate.mock.calls[0][2].prompt).toContain("Prepared kana (conversion target):\nあしたのよていをおねがい。");
    expect(generate.mock.calls[0][2].prompt).toContain("Read-only context before the target:\nOpenAI");
  });
  it("rejects a previous reading that lost protected original digits before any API call", async () => {
    const generate = vi.fn();
    const result = await convertRomajiToJapaneseDetailed("10ji.", defaultSettings, { models: vi.fn(), generate },
      { alternativeMode: true, alternativeReading: "11じ。" });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "protected" });
    expect(generate).not.toHaveBeenCalled();
  });
  it("does not repeat uncertain-fragment repair while exploring alternatives", async () => {
    const generate = vi.fn().mockResolvedValue(json("あなたはよくわるじひよだ", "あなたはよく悪じひよだ"));
    const result = await convertRomajiToJapaneseDetailed("anatahayokuwarujhiyoda", defaultSettings,
      { models: vi.fn(), generate }, { alternativeMode: true, alternativeReading: "あなたはよくわるじひよだ" });
    expect(result.text).toBe("あなたはよく悪じひよだ");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][2].system).not.toContain("uncertain kana fragment");
  });
  it("permits a local correction only when typo rescue is explicitly requested", async () => {
    const generate = vi.fn().mockResolvedValue(json("あしたのよてい。", "明日の予定。"));
    await expect(convertRomajiToJapaneseDetailed("ashitanoyottei.", defaultSettings, { models: vi.fn(), generate },
      { avoidOutputs: ["明日の夜って。"] })).rejects.toThrow("別候補に変換できませんでした。");
    expect(generate).toHaveBeenCalledTimes(3);
    generate.mockClear();
    const result = await convertRomajiToJapaneseDetailed("ashitanoyottei.", defaultSettings,
      { models: vi.fn(), generate }, { completionMode: true });
    expect(result.text).toBe("明日の予定。");
    expect(result.conversionStrategy).toBe("completion");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("rejects a phrase added through the typo-rescue route", async () => {
    const generate = vi.fn().mockResolvedValue(json("ほんをよむことにしました。", "本を読むことにしました。"));
    const result = await convertRomajiToJapaneseDetailed("honwoyomu.", defaultSettings,
      { models: vi.fn(), generate }, { completionMode: true });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "diverged" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("does not mix a stale alternative baseline into an explicit rescue request", async () => {
    const generate = vi.fn().mockResolvedValue(json("あしたのよてい。", "明日の予定。"));
    const result = await convertRomajiToJapaneseDetailed("ashitanoyottei.", defaultSettings, { models: vi.fn(), generate },
      { completionMode: true, alternativeMode: true, alternativeReading: "11じ。" });
    expect(result.text).toBe("明日の予定。");
    expect(generate.mock.calls[0][2].prompt).toContain("Mechanical kana:\nあしたのよってい。");
  });
  it("stops an alternative request without retrying after cancellation", async () => {
    const generate = vi.fn(() => new Promise<never>(() => undefined));
    const controller = new AbortController();
    const conversion = convertRomajiToJapaneseDetailed("hon.", defaultSettings, { models: vi.fn(), generate },
      { avoidOutputs: ["本。"], signal: controller.signal });
    controller.abort();
    await expect(conversion).rejects.toMatchObject({ name: "AbortError" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
