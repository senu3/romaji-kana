import { describe, expect, it } from "vitest";
import { isAllowedLocalKanaCorrection } from "../../../src/lib/localKanaCorrection";

describe("bounded local kana correction", () => {
  it.each([
    ["あしたのよってい。", "あしたのよてい。"],
    ["あしたのよでい。", "あしたのよてい。"],
    ["あしたのかいぎのよいて。", "あしたのかいぎのよてい。"],
    ["あしたのよい。", "あしたのよてい。"],
  ])("allows one bounded kana edit: %s → %s", (source, corrected) => {
    expect(isAllowedLocalKanaCorrection(source, corrected)).toBe(true);
  });
  it.each([
    ["あしたのよてい。", "きょうのかいぎ。"],
    ["あした10じ。", "あした11じ。"],
    ["あした10じ。", "あしたじ。"],
    ["あしたのよてい。", "あしたのよてい！"],
    ["あしたはいかない。", "あしたはいく。"],
    ["あしたのよてい。", "あしたの予定。"],
    ["ありが。", "ありがとう。"],
    ["よて。", "よで。"],
    ["ほん をよむ。", "ほんをよむ。"],
  ])("rejects an unsafe or nonlocal correction: %s → %s", (source, corrected) => {
    expect(isAllowedLocalKanaCorrection(source, corrected)).toBe(false);
  });
});
