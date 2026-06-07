import { describe, expect, it } from "vitest";
import {
  buildHomophoneReviewSuggestions,
  formatReplaceTargets,
  parseReplaceTargets,
} from "./homophoneReview";

describe("buildHomophoneReviewSuggestions", () => {
  it("builds a chip suggestion when registered reading and replace target both match", () => {
    expect(
      buildHomophoneReviewSuggestions("きょうのごじにしゅうごうな", "今日の五時に集合な", [
        {
          id: "goji",
          reading: "ごじ",
          preferred: "誤字",
          replaceFrom: ["五時", "ごじ"],
          note: "",
          enabled: true,
        },
      ]),
    ).toEqual([
      {
        id: "goji:3:五時",
        entryId: "goji",
        reading: "ごじ",
        preferred: "誤字",
        target: "五時",
        from: 3,
        to: 5,
      },
    ]);
  });

  it("does not suggest replacement when the preferred spelling is already present", () => {
    expect(
      buildHomophoneReviewSuggestions("このあたりのごじ", "このあたりの誤字", [
        {
          id: "goji",
          reading: "ごじ",
          preferred: "誤字",
          replaceFrom: ["五時", "ごじ"],
          note: "",
          enabled: true,
        },
      ]),
    ).toEqual([]);
  });

  it("requires explicit replace targets before suggesting an edit", () => {
    expect(
      buildHomophoneReviewSuggestions("きょうのごじ", "今日の五時", [
        {
          id: "goji",
          reading: "ごじ",
          preferred: "誤字",
          replaceFrom: [],
          note: "",
          enabled: true,
        },
      ]),
    ).toEqual([]);
  });

  it("does not match registered readings inside longer kana words", () => {
    expect(
      buildHomophoneReviewSuggestions("りんごじゅーすをかった", "リンゴジュースと五時", [
        {
          id: "goji",
          reading: "ごじ",
          preferred: "誤字",
          replaceFrom: ["五時"],
          note: "",
          enabled: true,
        },
      ]),
    ).toEqual([]);
  });
});

describe("replace target helpers", () => {
  it("parses comma and japanese comma separated targets", () => {
    expect(parseReplaceTargets("五時, ごじ、5時\n五時")).toEqual(["五時", "ごじ", "5時"]);
    expect(formatReplaceTargets(["五時", " ごじ ", "五時"])).toBe("五時, ごじ");
  });
});
