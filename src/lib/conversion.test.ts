import { describe, expect, it } from "vitest";
import {
  extractConversionRange,
  extractSelectedConversionRange,
  isTriggerEnabled,
  isInsideExcludedMarkdown,
  isJapaneseDominant,
  normalizeInputForPrompt,
  punctuationSuffixForGhostCommit,
  triggerFromCharacter,
  shouldTriggerAutoConversion,
} from "./conversion";
import { defaultSettings } from "./settings";

describe("extractConversionRange", () => {
  it.each(["nedanwa1.5endesu.", "kingakuwa1,000endesu.", "10:30niiku.", "2026/10/17niiku.", "10%desu."])("keeps complete numeric tokens in %s", doc => {
    expect(extractConversionRange(doc, doc.length, "period")?.text).toBe(doc);
  });
  it.each(["nedanwa1.", "kingakuwa1,"])("waits for ambiguous numeric punctuation in %s", doc => {
    expect(extractConversionRange(doc, doc.length, doc.endsWith(".") ? "period" : "comma")).toBeNull();
    expect(extractConversionRange(doc, doc.length, "shortcut")?.text).toBe(doc);
  });
  it("keeps punctuation inside complete protected literals out of sentence boundaries", () => {
    const doc = "`v1.2`wotukau.";
    expect(extractConversionRange(doc, doc.length, "period")?.text).toBe(doc);
  });
  it("starts after a URL instead of converting its suffix", () => {
    const doc = "https://example.com/path yomu.";
    expect(extractConversionRange(doc, doc.length, "period")?.text).toBe("yomu.");
  });
  it("extracts an unfinished phrase for predictive typing", () => {
    const doc = "ashita no yotei";
    expect(extractConversionRange(doc, doc.length, "typing")).toEqual({
      from: 0,
      to: doc.length,
      text: doc,
      trigger: "typing",
    });
  });

  it("extracts the current phrase including a space trigger", () => {
    const doc = "ashita no yotei ";
    expect(extractConversionRange(doc, doc.length, "space")).toEqual({
      from: 0,
      to: doc.length,
      text: doc,
      trigger: "space",
    });
  });

  it("skips punctuation-only input", () => {
    expect(extractConversionRange(".", 1, "period")).toBeNull();
  });

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

  it("stays inside the current line even when the previous line has no punctuation", () => {
    const doc = "maenobun\ntsuginobun.";
    const range = extractConversionRange(doc, doc.length, "period");
    expect(range).toEqual({
      from: "maenobun\n".length,
      to: doc.length,
      text: "tsuginobun.",
      trigger: "period",
    });
  });

  it("extracts the current line before an enter trigger", () => {
    const doc = "maenobun.\ntsuginobun";
    const range = extractConversionRange(doc, doc.length, "enter");
    expect(range?.text).toBe("tsuginobun");
    expect(range?.trigger).toBe("enter");
  });

  it("extracts only the current line before an enter trigger after an unpunctuated line", () => {
    const doc = "maenobun\ntsuginobun";
    const range = extractConversionRange(doc, doc.length, "enter");
    expect(range).toEqual({
      from: "maenobun\n".length,
      to: doc.length,
      text: "tsuginobun",
      trigger: "enter",
    });
  });

  it("extracts only appended romaji after existing Japanese text on the same line", () => {
    const doc = "今日は会議です ashita no yotei.";
    const appended = "ashita no yotei.";
    const range = extractConversionRange(doc, doc.length, "period");
    expect(range).toEqual({
      from: doc.indexOf(appended),
      to: doc.length,
      text: appended,
      trigger: "period",
    });
  });

  it("extracts appended romaji after existing Japanese text before an enter trigger", () => {
    const doc = "今日は会議です ashita no yotei";
    const appended = "ashita no yotei";
    const range = extractConversionRange(doc, doc.length, "enter");
    expect(range).toEqual({
      from: doc.indexOf(appended),
      to: doc.length,
      text: appended,
      trigger: "enter",
    });
  });

  it("extracts appended romaji after multiple spaces following existing Japanese text", () => {
    const doc = "今日は会議です  ashita no yotei.";
    const appended = "ashita no yotei.";
    const range = extractConversionRange(doc, doc.length, "period");
    expect(range).toEqual({
      from: doc.indexOf(appended),
      to: doc.length,
      text: appended,
      trigger: "period",
    });
  });

  it("keeps kanji-mixed romaji input in the conversion range", () => {
    const doc = "watasiha迎賓館niikoutoomoimasu.";
    const range = extractConversionRange(doc, doc.length, "period");
    expect(range).toEqual({
      from: 0,
      to: doc.length,
      text: doc,
      trigger: "period",
    });
  });

  it("extracts appended kanji-mixed romaji after existing Japanese text", () => {
    const doc = "今日は会議です watasiha迎賓館niikoutoomoimasu.";
    const appended = "watasiha迎賓館niikoutoomoimasu.";
    const range = extractConversionRange(doc, doc.length, "period");
    expect(range).toEqual({
      from: doc.indexOf(appended),
      to: doc.length,
      text: appended,
      trigger: "period",
    });
  });

  it("allows kanji-first mixed romaji input", () => {
    const doc = "国立国会図書館niikimasu.";
    const range = extractConversionRange(doc, doc.length, "period");
    expect(range).toEqual({
      from: 0,
      to: doc.length,
      text: doc,
      trigger: "period",
    });
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

describe("triggerFromCharacter", () => {
  it("uses a typed space as a conversion suggestion trigger", () => {
    expect(triggerFromCharacter(" ")).toBe("space");
  });
});

describe("isTriggerEnabled", () => {
  it("uses the predictive suggestion setting for typing previews", () => {
    expect(isTriggerEnabled("typing", defaultSettings)).toBe(true);
    expect(
      isTriggerEnabled("typing", {
        ...defaultSettings,
        triggers: { ...defaultSettings.triggers, typing: false },
      }),
    ).toBe(false);
    expect(isTriggerEnabled("typing", { ...defaultSettings, triggers: { ...defaultSettings.triggers, typing: true, space: false } })).toBe(true);
    expect(isTriggerEnabled("space", { ...defaultSettings, triggers: { ...defaultSettings.triggers, typing: false, space: true } })).toBe(true);
  });
});

describe("automatic editing events", () => {
  it.each(["input.paste", "input.drop", "input.type.compose", "undo", "redo", "document.open", "input.convert", undefined])("does not generate after %s", event => {
    expect(shouldTriggerAutoConversion(event)).toBe(false);
  });
  it.each(["input.type", "delete.backward", "delete.selection", "input.delete"])("allows a pause preview after %s", event => {
    expect(shouldTriggerAutoConversion(event)).toBe(true);
  });
});

describe("punctuationSuffixForGhostCommit", () => {
  it("uses the configured Japanese punctuation", () => {
    expect(punctuationSuffixForGhostCommit(".", "明日", defaultSettings)).toBe("。");
    expect(punctuationSuffixForGhostCommit(",", "明日", defaultSettings)).toBe("、");
  });

  it("keeps ASCII punctuation when conversion is disabled", () => {
    const settings = {
      ...defaultSettings,
      punctuationConversion: {
        periodToJapanese: false,
        commaToJapanese: false,
      },
    };

    expect(punctuationSuffixForGhostCommit(".", "明日", settings)).toBe(".");
    expect(punctuationSuffixForGhostCommit(",", "明日", settings)).toBe(",");
  });

  it("does not duplicate equivalent punctuation already in the candidate", () => {
    expect(punctuationSuffixForGhostCommit(".", "明日。", defaultSettings)).toBe("");
    expect(punctuationSuffixForGhostCommit(",", "明日,", defaultSettings)).toBe("");
  });
});

describe("extractSelectedConversionRange", () => {
  it.each(["mae\n```ts\nconst x = 1\n```\nato", "mae\n~~~\ncode\n~~~\nato", "mae\n```\ncode", "mae ``code`value`` ato", "mae https://example.com ato"])("rejects a selection containing excluded content: %s", doc => {
    expect(extractSelectedConversionRange(doc, 0, doc.length, "shortcut")).toBeNull();
  });
  it("preserves complete single-backtick literals and supports Kanji-mixed selections", () => {
    for (const doc of ["`OpenAI`wotukau", "明日の予定wo"]) {
      expect(extractSelectedConversionRange(doc, 0, doc.length, "shortcut")?.text).toBe(doc);
    }
  });
  it("extracts only the selected text for manual conversion", () => {
    const doc = "今日は会議の要点を確認します。 ashita no yotei mo kakunin shimasu";
    const selected = "ashita no yotei mo kakunin shimasu";
    const from = doc.indexOf(selected);
    const to = from + selected.length;

    expect(extractSelectedConversionRange(doc, from, to, "shortcut")).toEqual({
      from,
      to,
      text: selected,
      trigger: "shortcut",
    });
  });

  it("trims surrounding whitespace from the selected range", () => {
    const doc = "今日は会議です。  ashita no yotei  ";
    const from = doc.indexOf("  ashita");
    const to = doc.length;

    expect(extractSelectedConversionRange(doc, from, to, "shortcut")).toEqual({
      from: from + 2,
      to: to - 2,
      text: "ashita no yotei",
      trigger: "shortcut",
    });
  });

  it("allows Japanese-dominant selections containing protected Kanji and romaji", () => {
    const doc = "今日はいい tenki";
    expect(extractSelectedConversionRange(doc, 0, doc.length, "shortcut")?.text).toBe(doc);
    expect(extractSelectedConversionRange("きょうは tenki", 0, 11, "shortcut")).toBeNull();
  });

  it("skips selections without romaji", () => {
    const doc = "1234.,";
    expect(extractSelectedConversionRange(doc, 0, doc.length, "shortcut")).toBeNull();
  });

  it("skips selected text inside excluded markdown", () => {
    const doc = "`anatahadaredesuka.`";
    expect(extractSelectedConversionRange(doc, 1, doc.length - 1, "shortcut")).toBeNull();
  });
});

describe("markdown exclusions", () => {
  it("excludes fenced code blocks", () => {
    const doc = "```txt\nanatahadaredesuka.\n```";
    expect(isInsideExcludedMarkdown(doc, "```txt\nanata".length)).toBe(true);
  });

  it("does not close a fenced block with a different fence marker", () => {
    const doc = "```txt\n~~~\nanatahadaredesuka.\n```";
    expect(isInsideExcludedMarkdown(doc, doc.indexOf("anata") + 3)).toBe(true);
  });

  it("excludes inline code", () => {
    const doc = "`anatahadaredesuka.`";
    expect(isInsideExcludedMarkdown(doc, doc.length - 1)).toBe(true);
  });

  it("excludes inline code delimited by multiple backticks", () => {
    const doc = "``anata`hadaredesuka.``";
    expect(isInsideExcludedMarkdown(doc, doc.indexOf("hadare") + 3)).toBe(true);
  });

  it("excludes urls", () => {
    const doc = "https://example.com/anatahadaredesuka.";
    expect(isInsideExcludedMarkdown(doc, doc.length)).toBe(true);
  });
});

describe("normalization", () => {
  it("keeps punctuation inside protected literals and URLs exact", () => {
    expect(normalizeInputForPrompt("`v1.beta,a`wotukau.", defaultSettings)).toBe("`v1.beta,a`wotukau。");
    expect(normalizeInputForPrompt("https://example.com/a,b yomu.", defaultSettings)).toBe("https://example.com/a,b yomu。");
  });
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
