import { describe, expect, it } from "vitest";
import { preservesProtectedContent } from "../../../src/lib/conversionProtection";
import { normalizeInputForPrompt } from "../../../src/lib/conversion";
import { defaultSettings } from "../../../src/lib/settings";

describe("original-content protection", () => {
  it("checks repeated literal terms and their order, including regex metacharacters", () => {
    expect(preservesProtectedContent("咲良と咲良、東京", "咲良、東京", ["咲良", "東京"])).toBe(false);
    expect(preservesProtectedContent("咲良、東京", "東京、咲良", ["咲良", "東京"])).toBe(false);
    expect(preservesProtectedContent("C++とa.b", "C++とa.b", ["C++", "a.b"])).toBe(true);
    expect(preservesProtectedContent("[ほん]", "]ほん[", [])).toBe(false);
    expect(preservesProtectedContent("ほん\nかいぎ", "本 会議", [])).toBe(false);
  });

  it("preserves signs, dates, percentages, numeric order and multiplicity", () => {
    for (const [source, output] of [["-10", "10"], ["10%", "10"], ["2026/10/16", "2026/10/17"], ["10 30", "30 10"], ["10 10", "10"]]) {
      expect(preservesProtectedContent(source, output)).toBe(false);
    }
    expect(preservesProtectedContent("-10 1,500.25 2026/10/16 10%", "-10 1,500.25 2026/10/16 10%")).toBe(true);
  });

  it("does not convert decimal points or numeric grouping separators into Japanese punctuation", () => {
    expect(normalizeInputForPrompt("yosan1,500.25en, kion-3.5do.", defaultSettings)).toBe("yosan1,500.25en、 kion-3.5do。");
  });
});
