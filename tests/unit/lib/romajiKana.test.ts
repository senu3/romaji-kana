import { describe, expect, it } from "vitest";
import { romajiToKana } from "../../../src/lib/romajiKana";

describe("romajiToKana", () => {
  it("mechanically converts high-confidence romaji to kana", () => {
    const result = romajiToKana("wakattahuriwosurunowoyametekudasai");

    expect(result.kana).toBe("わかったふりをするのをやめてください");
    expect(result.lowConfidenceSpans).toEqual([]);
    expect(result.tokens.every((token) => token.confidence === 1)).toBe(true);
    expect(result.tokens.map((token) => token.romaji)).toEqual([
      "wa",
      "ka",
      "tta",
      "hu",
      "ri",
      "wo",
      "su",
      "ru",
      "no",
      "wo",
      "ya",
      "me",
      "te",
      "ku",
      "da",
      "sa",
      "i",
    ]);
  });

  it.each([
    ["fairu", "ふぁいる"], ["firumu", "ふぃるむ"], ["kafe", "かふぇ"], ["fooku", "ふぉおく"],
    ["thi", "てぃ"], ["dhi", "でぃ"], ["twu", "とぅ"], ["dwu", "どぅ"],
    ["va", "ゔぁ"], ["vu", "ゔ"], ["she", "しぇ"], ["che", "ちぇ"], ["je", "じぇ"],
    ["xa", "ぁ"], ["la", "ぁ"], ["xya", "ゃ"], ["lyu", "ゅ"], ["xwa", "ゎ"],
    ["ltsu", "っ"], ["xtsu", "っ"], ["ltu", "っ"], ["xtu", "っ"],
    ["n'a", "んあ"], ["nn", "ん"], ["nna", "んな"], ["FAIRU", "ふぁいる"],
  ])("converts supported spelling %s without repair", (input, kana) => {
    const result = romajiToKana(input);
    expect(result.kana).toBe(kana);
    expect(result.lowConfidenceSpans).toEqual([]);
    expect(result.tokens.map(token => token.romaji).join("")).toBe(input);
  });

  it("keeps misspellings in the mechanical reading for the correction route", () => {
    expect(romajiToKana("wakkata").kana).toBe("わっかた");
    expect(romajiToKana("kakkata").kana).toBe("かっかた");
    expect(romajiToKana("wakatta").kana).toBe("わかった");
  });

  it("marks unrecognized fragments as low confidence", () => {
    const result = romajiToKana("anatahayokuwarujhiyoda");

    expect(result.kana).toBe("あなたはよくわるjひよだ");
    expect(result.lowConfidenceSpans).toHaveLength(1);
    expect(result.lowConfidenceSpans[0]).toEqual(
      expect.objectContaining({
        romaji: "j",
        kana: "j",
        contextKana: expect.stringContaining("わるjひよだ"),
      }),
    );
  });

  it("supports common spelling variants, sokuon, n, yoon, and punctuation", () => {
    expect(romajiToKana("shinjyukunitsuite.").kana).toBe("しんじゅくについて.");
    expect(romajiToKana("sittyattayo").kana).toBe("しっちゃったよ");
    expect(romajiToKana("konnichiha").kana).toBe("こんにちは");
    expect(romajiToKana("hon").kana).toBe("ほん");
    expect(romajiToKana("kyouha, samui.").kana).toBe("きょうは, さむい.");
  });
});
