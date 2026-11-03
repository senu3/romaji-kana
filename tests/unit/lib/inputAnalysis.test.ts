import { describe, expect, it, vi } from "vitest";
import { analyzeInput, cutsFixedInput } from "../../../src/lib/inputAnalysis";
import { extractConversionRange, extractSelectedConversionRange, normalizeInputForPrompt } from "../../../src/lib/conversion";
import { prepareConversionRequest } from "../../../src/lib/conversionRequest";
import { suggestTarget } from "../../../src/lib/autoSuggest";
import { defaultSettings } from "../../../src/lib/settings";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import type { KanaEngine } from "../../../src/lib/kanaEngine";
import { EditorState } from "@codemirror/state";
import { rememberUnconvertedRange, retainedConversionRange, unconvertedRanges } from "../../../src/lib/unconvertedRanges";

const tick = "`";

describe("shared protected input", () => {
  it("does not reuse a remembered conversion range that now cuts a protected path", () => {
    const input = String.raw`docs\Sample.psd wo hiraku`;
    const state = EditorState.create({ doc: input, extensions: [unconvertedRanges] })
      .update({ effects: rememberUnconvertedRange.of({ from: 5, to: input.length }) }).state;
    expect(retainedConversionRange(state, input.length, "typing")).toBeNull();
  });
  it.each([String.raw`docs\Sample`, "docs/Sample.psd", String.raw`C:\Work\sample.psd`, String.raw`\\server\share\file`, "./assets/logo.png", "../assets/", "~/assets/logo.png", "/tmp/sample"])("preserves a path across normalization, ranges and completion: %s", path => {
    expect(analyzeInput(path).map(span => span.kind)).toEqual(["path"]);
    expect(extractConversionRange(path, path.length, "typing")).toBeNull();
    expect(suggestTarget(path, path.length)).toBeNull();
    const input = path + " wohiraku.";
    expect(normalizeInputForPrompt(input, defaultSettings)).toBe(path + " wohiraku。");
    expect(extractConversionRange(input, input.length, "period")?.text).toBe(input);
    expect(prepareConversionRequest(input, defaultSettings, {}).parts[0]).toEqual({ type: "literal", output: path });
    expect(cutsFixedInput(input, 1, input.length)).toBe(true);
    expect(extractSelectedConversionRange(input, 1, input.length, "shortcut")).toBeNull();
    expect(extractSelectedConversionRange(input, 0, input.length, "shortcut")?.text).toBe(input);
  });

  it.each(["ASHITA", "PSD", "API", "A"])("never converts or completes uppercase-only input: %s", input => {
    expect(prepareConversionRequest(input, defaultSettings, {}).parts).toEqual([{ type: "literal", output: input }]);
    expect(extractConversionRange(input, input.length, "shortcut")).toBeNull();
    expect(suggestTarget(input, input.length)).toBeNull();
  });

  it("isolates the editable suffix after an abbreviation without swallowing it into a path", () => {
    expect(prepareConversionRequest("PSDfairu", defaultSettings, {}).parts).toEqual([
      { type: "literal", output: "PSD" }, { type: "text", value: "fairu" },
    ]);
    expect(suggestTarget("PSDfairu", 8)).toEqual({ from: 3, to: 8, original: "fairu", reading: "ふぁいる" });
    expect(extractSelectedConversionRange("PSDfairu", 1, 8, "shortcut")).toBeNull();
  });

  it.each(["PSD ha nai", "PSDha nai", "`PSD` ha nai", "`PSD`ha nai"])("recognizes the separated particle before removing spaces: %s", input => {
    expect(prepareConversionRequest(input, defaultSettings, {}).parts).toEqual([
      { type: "literal", output: "PSD" }, { type: "particle", output: "は" }, { type: "text", value: "nai" },
    ]);
  });

  it("does not invent a particle boundary inside a word", () => {
    expect(prepareConversionRequest("PSDhanai", defaultSettings, {}).parts).toEqual([
      { type: "literal", output: "PSD" }, { type: "text", value: "hanai" },
    ]);
    expect(prepareConversionRequest("PSDhanashi", defaultSettings, {}).parts[1]).toEqual({ type: "text", value: "hanashi" });
    expect(prepareConversionRequest("onegaismasu", defaultSettings, {}).parts).toEqual([{ type: "text", value: "onegaismasu" }]);
  });

  it.each(["\\", "\\\\"])("closes explicit path literals after trailing backslashes: %s", ending => {
    const path = "docs\\Sample" + ending;
    const input = tick + path + tick + "wohiraku.";
    expect(analyzeInput(input)[0].kind).toBe("literal");
    expect(extractConversionRange(input, input.length, "shortcut")?.text).toBe(input);
    expect(prepareConversionRequest(input, defaultSettings, {}).parts[0]).toEqual({ type: "literal", output: path });
  });

  it.each(["```\ndocs/Sample PSDfairu", "~~~\nASHITA\n~~~", "``docs/Sample``", "`docs\\Sample", "https://example.com/PSDfairu"])("never reinterprets protected code or URLs as editable text: %s", input => {
    expect(extractSelectedConversionRange(input, 0, input.length, "shortcut")).toBeNull();
    expect(suggestTarget(input, input.length)).toBeNull();
  });

  it.each(["2026/10/17niiku.", "10/3niiku.", "ashita", "fooPSDfairu", "OpenAI"])("does not promote ordinary or mixed-case input to protected literals: %s", input => {
    expect(analyzeInput(input).every(span => span.kind === "text")).toBe(true);
  });

  it("covers original UTF-16 coordinates including newlines and surrogate pairs", () => {
    const input = "😊 PSDfairu\r\n`docs\\Sample\\`wohiraku.\n```ts\nPSDfairu\n```\nato";
    const spans = analyzeInput(input);
    expect(spans.map(span => input.slice(span.from, span.to)).join("")).toBe(input);
    expect(spans.every((span, index) => span.from === (index ? spans[index - 1].to : 0))).toBe(true);
  });
});

describe("conversion consumers of shared input", () => {
  function harness() {
    const calls: string[] = [];
    const surfaces: Record<string, string> = { "ふぁいる": "ファイル", "ない": "ない", "ひらく": "開く", "かくにん": "確認" };
    const engine: KanaEngine = { verify: vi.fn().mockResolvedValue("verified"), search: vi.fn(async reading => {
      calls.push(reading);
      const text = surfaces[reading];
      return { dictionaryRevision: "test", truncated: false, candidates: text ? [{ text, reading, cost: 100,
        tokens: [{ text, reading, from: 0, to: [...reading].length, source: "mozc" as const, entryId: text, lid: 0, rid: 0, wordCost: 100 }] }] : [] };
    }) };
    const generate = vi.fn(async (_provider, _url, body) => {
      const prompt = JSON.parse(body.prompt);
      return { response: JSON.stringify({ order: [prompt.candidates[0].id], repairNeeded: false }) };
    });
    return { engine, calls, generate, transport: { models: vi.fn(), generate } };
  }

  it.each(["PSD", "ASHITA", String.raw`docs\Sample`, "`docs\\Sample`", "```\nPSDfairu\n```"])("does not call either engine or model for fixed-only input: %s", async input => {
    const h = harness();
    const result = await convertRomajiToJapaneseDetailed(input, defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.suggestionRejected).toBe(true);
    expect(h.engine.search).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("converts the suffix while preserving an unquoted abbreviation", async () => {
    const h = harness();
    const result = await convertRomajiToJapaneseDetailed("PSDfairu", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.text).toBe("PSDファイル");
    expect(h.calls).toEqual(["ふぁいる"]);
  });

  it("preserves a fixed particle rather than searching hanai", async () => {
    const h = harness();
    const result = await convertRomajiToJapaneseDetailed("PSD ha nai", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result.text).toBe("PSDはない");
    expect(h.calls).toEqual(["ない"]);
  });

  it("repairs a typo only in the editable suffix", async () => {
    const h = harness();
    const result = await convertRomajiToJapaneseDetailed("PSDfariu", defaultSettings, h.transport, { kanaEngine: h.engine });
    expect(result).toMatchObject({ text: "PSDファイル", conversionStrategy: "correction" });
    expect(result.romajiCorrection).toMatchObject({ before: "fariu", after: "fairu" });
    expect(JSON.parse(h.generate.mock.calls[0][2].prompt).candidates[0].text).toBe("PSDファイル");
  });

  it("supplies literals separately in speculative generation and restores exact paths", async () => {
    const path = String.raw`docs\Sample.psd`;
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ segments: [
      { id: "edit-1", convertedText: "を開く。", completedKana: "をひらく。" },
    ] }) });
    const h = harness();
    const result = await convertRomajiToJapaneseDetailed(path + " wohiraku.", defaultSettings, { models: vi.fn(), generate }, {
      userRequestedSpeculation: true, kanaEngine: h.engine,
    });
    expect(result.text).toBe(path + "を開く。");
    expect(generate.mock.calls[0][2].prompt).toContain(JSON.stringify({ literal: path }));
  });
});
