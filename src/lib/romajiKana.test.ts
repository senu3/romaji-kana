import { describe, expect, it } from "vitest";
import { romajiToKana } from "./romajiKana";

describe("romajiToKana", () => {
  it("mechanically converts high-confidence romaji to kana", () => {
    const result = romajiToKana("wakkatahuriwosurunowoyametekudasai");

    expect(result.kana).toBe("わかったふりをするのをやめてください");
    expect(result.lowConfidenceSpans).toEqual([]);
    expect(result.tokens.every((token) => token.confidence === 1)).toBe(true);
    expect(result.tokens.map((token) => token.romaji)).toEqual([
      "wa",
      "kkata",
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
