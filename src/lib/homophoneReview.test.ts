import { describe, expect, it } from "vitest";
import {
  buildHomophoneFixedTermSuggestions,
  buildHomophoneReviewSuggestions,
  formatReplaceTargets,
  parseReplaceTargets,
} from "./homophoneReview";

describe("buildHomophoneReviewSuggestions", () => {
  it("builds a chip suggestion when registered reading and replace target both match", () => {
    expect(
      buildHomophoneReviewSuggestions("このあたりのごじをなおす", "このあたりの五時を直す", [
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
        id: "goji:6:五時",
        entryId: "goji",
        reading: "ごじ",
        preferred: "誤字",
        target: "五時",
        from: 6,
        to: 8,
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

  it("suggests a registered correction for goji when the model outputs 午後", () => {
    expect(
      buildHomophoneReviewSuggestions("ごじにけーきをたべよう", "午後にケーキを食べよう", [
        {
          id: "goji",
          reading: "ごじ",
          preferred: "五時",
          replaceFrom: ["午後"],
          note: "",
          enabled: true,
        },
      ]),
    ).toEqual([
      {
        id: "goji:0:午後",
        entryId: "goji",
        reading: "ごじ",
        preferred: "五時",
        target: "午後",
        from: 0,
        to: 2,
      },
    ]);
  });

  it("suggests a registered correction for giji when the model outputs 記事", () => {
    expect(
      buildHomophoneReviewSuggestions("ぎじにさんかしよう", "記事に参加しよう", [
        {
          id: "giji",
          reading: "ぎじ",
          preferred: "議事",
          replaceFrom: ["記事"],
          note: "",
          enabled: true,
        },
      ]),
    ).toEqual([
      {
        id: "giji:0:記事",
        entryId: "giji",
        reading: "ぎじ",
        preferred: "議事",
        target: "記事",
        from: 0,
        to: 2,
      },
    ]);
  });
});

describe("buildHomophoneFixedTermSuggestions", () => {
  it("suggests a fixed-term rerun when reading matches but replace targets do not", () => {
    expect(
      buildHomophoneFixedTermSuggestions("ぎじにさんかしよう", "記事に参加しよう", [
        {
          id: "giji",
          reading: "ぎじ",
          preferred: "議事",
          replaceFrom: [],
          note: "",
          enabled: true,
        },
      ]),
    ).toEqual([
      {
        id: "giji:fixed:議事",
        entryId: "giji",
        reading: "ぎじ",
        preferred: "議事",
      },
    ]);
  });

  it("can surface a fixed-term rerun for goji even when 午後 was not listed as replaceFrom", () => {
    expect(
      buildHomophoneFixedTermSuggestions("ごじにけーきをたべよう", "午後にケーキを食べよう", [
        {
          id: "goji",
          reading: "ごじ",
          preferred: "五時",
          replaceFrom: ["五時"],
          note: "",
          enabled: true,
        },
      ]),
    ).toEqual([
      {
        id: "goji:fixed:五時",
        entryId: "goji",
        reading: "ごじ",
        preferred: "五時",
      },
    ]);
  });

  it("does not suggest a fixed-term rerun inside longer kana words", () => {
    expect(
      buildHomophoneFixedTermSuggestions("りんごじゅーすをかった", "リンゴジュースを買った", [
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
});

describe("replace target helpers", () => {
  it("parses comma and japanese comma separated targets", () => {
    expect(parseReplaceTargets("五時, ごじ、5時\n五時")).toEqual(["五時", "ごじ", "5時"]);
    expect(formatReplaceTargets(["五時", " ごじ ", "五時"])).toBe("五時, ごじ");
  });
});
