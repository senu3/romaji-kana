import { describe, expect, it } from "vitest";
import { normalizeNumericReading } from "../../../src/lib/numericReading";

describe("source-aligned integer readings", () => {
  it.each([
    ["あした10じ。", "あしたじゅうじ。"], ["10じと20じ。", "じゅうじとにじゅうじ。"],
    ["3000えん。", "さんぜんえん。"], ["800えん。", "はっぴゃくえん。"], ["4。", "し。"],
    ["あした10じにいかない。", "あしたじゅうじに いかない。"],
  ])("normalizes only the pronunciation of the same integer: %s", (source, reported) => {
    expect(normalizeNumericReading(source, reported)).toEqual({ reading: source, normalized: true });
  });
  it.each([
    ["10じ。", "じゅういちじ。"], ["10じと20じ。", "にじゅうじとじゅうじ。"],
    ["10じと10じ。", "じゅうじ。"], ["10じ。", "じゅうじとじゅうじ。"],
    ["あした10じ。", "きょうじゅうじ。"], ["10じのおねが。", "じゅうじのおねがい。"],
    ["-10ど。", "まいなすじゅうど。"], ["1.5こ。", "いってんごこ。"], ["1,000えん。", "せんえん。"],
    ["10%です。", "じゅっぱーせんとです。"], ["04じ。", "よんじ。"], ["v10。", "vじゅう。"],
    ["10こ。", "じゅっこ。"], ["10000えん。", "いちまんえん。"],
    ["10じ。", "じゅうじ。\n"], ["10じ。", "じゅう\nじ。"],
  ])("does not guess different values or unsupported formats: %s → %s", (source, reported) => {
    expect(normalizeNumericReading(source, reported)).toEqual({ reading: reported, normalized: false });
  });
});
