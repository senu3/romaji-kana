import { describe, expect, it } from "vitest";
import { convertedSuggestTarget, rankSuggestions, suggestTarget } from "../../../src/lib/autoSuggest";
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
  it.each(["a", "kouk", "`kouka`", "https://kouka", "```\nkouka", "foo_kouka", "42kouka", "航海", "a".repeat(81)])("does not complete excluded input: %s", text => {
    expect(suggestTarget(text, text.length)).toBeNull();
  });
  it("does not replace a prefix in the middle of a token", () => {
    expect(suggestTarget("koukai", 5)).toBeNull();
    expect(suggestTarget("kouka1", 5)).toBeNull();
  });
  it.each(["もしかして", "モシカシテ", "確定した文"])('isolates romaji after committed Japanese: %s', before => {
    const doc = before + "watasiha";
    expect(suggestTarget(doc, doc.length)).toEqual({ from: before.length, to: doc.length, original: "watasiha", reading: "わたしは" });
    expect(suggestTarget(before + "watasih", before.length + 7)).toBeNull();
  });
  const item = (text: string, reading = "こうかい", cost = 10, source: WordSuggestion["source"] = "mozc"): WordSuggestion => ({ text, reading, cost, source });
  it("reuses learning and personal vocabulary, removes duplicates, and limits to five", () => {
    const choices = [{ text: "航海", reading: "こうかい", count: 2, updated: 1 }];
    const candidates = [item("公開"), item("航海"), item("個人語", "こうかいご", 100, "user"), ...Array.from({ length: 8 }, (_, i) => item(`候補${i}`))];
    const ranked = rankSuggestions("こうか", candidates, choices);
    expect(ranked).toHaveLength(5);
    expect(ranked.slice(0, 2).map(c => c.text)).toEqual(["航海", "個人語"]);
    expect(ranked.filter(c => c.text === "航海")).toHaveLength(1);
    expect(choices[0].count).toBe(2);
    expect(candidates).toHaveLength(11);
  });
  it("only returns longer prefix matches within bounded length", () => {
    expect(rankSuggestions("こうか", [item("効果", "こうか"), item("海", "かい"), item("長すぎ", "こうか" + "い".repeat(13)), item("改\n行"), item("航海")], []).map(c => c.text)).toEqual(["航海"]);
  });
});
