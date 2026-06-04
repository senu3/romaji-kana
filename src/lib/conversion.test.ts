import { describe, expect, it } from "vitest";
import {
  extractConversionRange,
  isInsideExcludedMarkdown,
  isJapaneseDominant,
  normalizeInputForPrompt,
} from "./conversion";
import { defaultSettings } from "./settings";

describe("extractConversionRange", () => {
  it("extracts the sentence before a period trigger", () => {
    const doc = "anatahadonnakotogasukidesuka.";
    expect(extractConversionRange(doc, doc.length, "period")).toEqual({
      from: 0,
      to: doc.length,
      text: doc,
      trigger: "period",
    });
  });

  it("stops at previous punctuation", () => {
    const doc = "korehasakana. sorehaebi.";
    const range = extractConversionRange(doc, doc.length, "period");
    expect(range?.text).toBe("sorehaebi.");
    expect(range?.from).toBe("korehasakana. ".length);
  });

  it("stays inside the current line", () => {
    const doc = "maenobun.\ntsuginobun.";
    const range = extractConversionRange(doc, doc.length, "period");
    expect(range?.text).toBe("tsuginobun.");
  });

  it("extracts the current line before an enter trigger", () => {
    const doc = "maenobun.\ntsuginobun";
    const range = extractConversionRange(doc, doc.length, "enter");
    expect(range?.text).toBe("tsuginobun");
    expect(range?.trigger).toBe("enter");
  });

  it("does not include markdown heading markers", () => {
    const doc = "## kyouhayoi tenkidesu.";
    const range = extractConversionRange(doc, doc.length, "period");
    expect(range?.text).toBe("kyouhayoi tenkidesu.");
    expect(range?.from).toBe(3);
  });

  it("does not include markdown list markers", () => {
    const doc = "- kyouhayoi tenkidesu.";
    const range = extractConversionRange(doc, doc.length, "period");
    expect(range?.text).toBe("kyouhayoi tenkidesu.");
    expect(range?.from).toBe(2);
  });

  it("skips Japanese-dominant text", () => {
    const doc = "今日はいい天気です。";
    expect(extractConversionRange(doc, doc.length, "enter")).toBeNull();
  });
});

describe("markdown exclusions", () => {
  it("excludes fenced code blocks", () => {
    const doc = "```txt\nanatahadaredesuka.\n```";
    expect(isInsideExcludedMarkdown(doc, "```txt\nanata".length)).toBe(true);
  });

  it("excludes inline code", () => {
    const doc = "`anatahadaredesuka.`";
    expect(isInsideExcludedMarkdown(doc, doc.length - 1)).toBe(true);
  });

  it("excludes urls", () => {
    const doc = "https://example.com/anatahadaredesuka.";
    expect(isInsideExcludedMarkdown(doc, doc.length)).toBe(true);
  });
});

describe("normalization", () => {
  it("converts ascii punctuation when enabled", () => {
    expect(normalizeInputForPrompt("anata, watashi.", defaultSettings)).toBe(
      "anata、 watashi。",
    );
  });

  it("detects Japanese-dominant strings", () => {
    expect(isJapaneseDominant("今日はいい tenki")).toBe(true);
    expect(isJapaneseDominant("kyouha ii tenki")).toBe(false);
  });
});
