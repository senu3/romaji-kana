import { describe, expect, it } from "vitest";
import { convertedSuggestTarget, matchesSuggestionReading, rankSuggestions, suggestDocumentContinuation, suggestTargets, suggestTarget, wordSuggestionLabel } from "../../../src/lib/autoSuggest";
import type { WordSuggestion } from "../../../src/lib/kanaEngine";

describe("independent word suggestions", () => {
  it("keeps trailing punctuation and newlines separate from the lookup reading", () => {
    expect(convertedSuggestTarget(3, "効果、\n", "こうか、\n")).toEqual({ from: 3, to: 7, original: "効果、\n", reading: "こうか", suffix: "、\n" });
  });
  it("extracts only the trailing complete reading and its replacement range", () => {
    expect(suggestTarget("出発、kouka", 8)).toEqual({ from: 3, to: 8, original: "kouka", reading: "こうか" });
    expect(suggestTarget("コウカ", 3)?.reading).toBe("こうか");
    expect(suggestTarget("こうか", 3)?.reading).toBe("こうか");
  });
  it.each(["a", "kouk", "`kouka`", "https://kouka", "```\nkouka", "foo_kouka", "42kouka", "航海"])("does not complete excluded input: %s", text => {
    expect(suggestTarget(text, text.length)).toBeNull();
  });
  it("does not replace a prefix in the middle of a token", () => {
    expect(suggestTarget("koukai", 5)).toBeNull();
    expect(suggestTarget("kouka1", 5)).toBeNull();
  });
  it.each([
    ["arig", "ありがと", true],
    ["arig", "ありさま", false],
    ["densh", "でんしゃ", true],
    ["densh", "でんせん", false],
    ["gakukk", "がくっこう", true],
    ["gakukk", "がくこう", false],
    ["hiran", "ひらなか", true],
    ["hiran", "ひらんだ", true],
    ["hiran", "ひらがな", false],
    ["arizg", "ありがと", false],
  ])("matches %s against %s: %s", (text, candidate, expected) => {
    const targets = suggestTargets(text, text.length, { retainedFrom: 0 });
    expect(targets.some(({ reading, pendingRomaji }) => matchesSuggestionReading(reading, candidate, pendingRomaji))).toBe(expected);
  });
  it.each([
    ["ありg", "arig", "あり", "g"],
    ["ひらん", "hiran", "ひら", "n"],
  ])("keeps unfinished live kana within the current input run: %s", (text, source, reading, pendingRomaji) => {
    const doc = "確定したかな" + text;
    const from = doc.length - text.length;
    expect(suggestTargets(doc, doc.length, { liveInput: { from, to: doc.length, source }, retainedFrom: from }))
      .toContainEqual({ from, to: doc.length, original: text, reading, pendingRomaji });
  });
  it.each(["もしかして", "モシカシテ", "確定した文"])('isolates romaji after committed Japanese: %s', before => {
    const doc = before + "watasiha";
    expect(suggestTarget(doc, doc.length)).toEqual({ from: before.length, to: doc.length, original: "watasiha", reading: "わたしは" });
    expect(suggestTarget(before + "watasih", before.length + 7)).toBeNull();
  });
  it("finds bounded suffixes after a long phrase without replacing its prefix", () => {
    const text = "kana".repeat(100) + "kouka";
    const targets = suggestTargets(text, text.length);
    expect(targets.length).toBeLessThanOrEqual(12);
    expect(targets).toContainEqual({ from: 400, to: 405, original: "kouka", reading: "こうか" });
    expect(targets.every(target => target.reading.length <= 80)).toBe(true);
  });
  it.each(["どうすれば", "dousureba"])("does not look up a suffix from inside %s", text => {
    expect(suggestTargets(text, text.length).map(target => target.reading)).toEqual(["どうすれば"]);
  });
  it.each(["これはこうか", "korehakouka"])("looks up the whole reading and the final word of %s", text => {
    expect(suggestTargets(text, text.length).map(target => target.reading)).toEqual(["これはこうか", "こうか"]);
  });
  it("keeps a retained suffix eligible as it grows beyond the lookup limit", () => {
    const doc = "かな".repeat(50);
    const retainedFrom = 87;
    expect(suggestTargets(doc, doc.length).some(target => target.from === retainedFrom)).toBe(false);
    expect(suggestTargets(doc, doc.length, { retainedFrom })).toEqual([
      { from: retainedFrom, to: doc.length, original: doc.slice(retainedFrom), reading: doc.slice(retainedFrom) },
    ]);
  });
  const item = (text: string, reading = "こうかい", cost = 10, source: WordSuggestion["source"] = "mozc"): WordSuggestion => ({ text, reading, cost, source });
  it("reuses learning and personal vocabulary, removes duplicates, and limits to five", () => {
    const choices = [{ text: "航海", reading: "こうかい", count: 2, updated: 1 }];
    const candidates = [item("公開"), item("航海"), item("個人語", "こうかいご", 100, "user"), ...Array.from({ length: 8 }, (_, i) => item(`候補${i}`))];
    const ranked = rankSuggestions(convertedSuggestTarget(0, "効果", "こうか"), candidates, choices);
    expect(ranked).toHaveLength(5);
    expect(ranked.slice(0, 2).map(c => c.text)).toEqual(["航海", "個人語"]);
    expect(ranked.filter(c => c.text === "航海")).toHaveLength(1);
    expect(choices[0].count).toBe(2);
    expect(candidates).toHaveLength(11);
  });
  it("only returns longer prefix matches within bounded length", () => {
    expect(rankSuggestions(convertedSuggestTarget(0, "効果", "こうか"), [item("効果", "こうか"), item("効果、", "こうか、"), item("海", "かい"), item("長すぎ", "こうか" + "い".repeat(13)), item("改\n行"), item("航海")], []).map(c => c.text)).toEqual(["航海"]);
  });
  it("prefers a short noun completion over a lower-cost long continuation", () => {
    const target = convertedSuggestTarget(0, "すい", "すい");
    const noun = { ...item("すいか", "すいか", 100), lexical: true };
    const phrase = item("すいません", "すいません", 0);
    expect(rankSuggestions(target, [phrase, noun], [])).toEqual([noun, phrase]);
    expect(wordSuggestionLabel(target, noun.text, noun.lexical)).toBe("か");
  });
  it("skips short visible additions before taking the top five and keeps whole-word replacements", () => {
    const target = convertedSuggestTarget(0, "たべ", "たべ");
    const short = ["る", "た", "て", "ない", "ます"].map(tail => item(`たべ${tail}`, `たべ${tail}`, 0));
    const longer = item("たべられる", "たべられる", 100);
    const replacement = item("食べる", "たべる", 100);
    expect(rankSuggestions(target, [...short, longer, replacement], [])).toEqual([replacement, longer]);
    expect(wordSuggestionLabel(target, longer.text)).toBe("られる");
    expect(wordSuggestionLabel(convertedSuggestTarget(0, "たべら", "たべら"), longer.text)).toBeNull();
  });
});

describe("document continuations", () => {
  it("returns only the suffix of the most recent sentence with the same beginning", () => {
    const doc = "効果を確認します。効果が確認できました。\n効果";
    expect(suggestDocumentContinuation(doc, doc.length)).toBe("が確認できました。");
  });
  it("supports a comma in the existing text", () => {
    const doc = "詳細は、後ほどお知らせします。\n詳細は、";
    expect(suggestDocumentContinuation(doc, doc.length)).toBe("後ほどお知らせします。");
  });
  it("skips a more recent short ending in favor of a longer continuation", () => {
    const doc = "食べる前に手を洗います。食べる。\n食べ";
    expect(suggestDocumentContinuation(doc, doc.length)).toBe("る前に手を洗います。");
    const shortOnly = "食べる。\n食べ";
    expect(suggestDocumentContinuation(shortOnly, shortOnly.length)).toBeNull();
  });
  it.each([
    "検証の効果が確認できました。\n効果",
    "効果。\n効果",
    "効果が確認できました。\n効果。",
    "```\n効果が確認できました。\n```\n効果",
    "効果を`確認`しました。\n効果",
    "効果が確認できました。\n```\n効果",
    "効果" + "が".repeat(33) + "。\n効果",
  ])("has no eligible earlier continuation for %s", doc => {
    expect(suggestDocumentContinuation(doc, doc.length)).toBeNull();
  });
  it("only offers a continuation at the end of the line and uses earlier text", () => {
    const doc = "効果がありました。\n効果を確認\n効果が残っています。";
    expect(suggestDocumentContinuation(doc, doc.indexOf("を"))).toBeNull();
    const lineEnd = "効果がありました。\n効果";
    expect(suggestDocumentContinuation(`${lineEnd}\n効果が残っています。`, lineEnd.length)).toBe("がありました。");
  });
});
