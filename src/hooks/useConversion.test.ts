// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ghostSuggestionField } from "../components/MarkdownEditor";
import { convertRomajiToJapaneseDetailed, type JapaneseConversionResult } from "../lib/ollama";
import { defaultSettings } from "../lib/settings";
import type { ConversionRange } from "../lib/types";
import { deferred, mountHook, stateEditor } from "./testUtils";
import { useConversion } from "./useConversion";
import { assessReading } from "../lib/readingAssessment";
import { classifyConversionChanges } from "../lib/conversionChanges";

vi.mock("../lib/ollama", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/ollama")>(),
  convertRomajiToJapaneseDetailed: vi.fn(),
}));

const range = (text: string, trigger: ConversionRange["trigger"] = "shortcut", from = 0): ConversionRange =>
  ({ from, to: from + text.length, text, trigger });

function harness(content = "konnichiha") {
  const editor = stateEditor(content);
  const options = {
    editorViewRef: { current: editor.view },
    settingsRef: { current: { ...defaultSettings } },
    setStatus: vi.fn(),
    saveCurrentDocumentSession: vi.fn(),
    docVersionRef: { current: 0 },
    activePanel: null,
    setupComplete: true,
  };
  const hook = mountHook(() => useConversion(options));
  return { hook, ...editor, options };
}

describe("conversion lifecycle", () => {
  beforeEach(() => vi.mocked(convertRomajiToJapaneseDetailed).mockReset());

  it("passes corrected/completed readings through ghost and history alternatives, including legacy text responses", async () => {
    const changes = { kind: "completion" as const, evidence: "repair-stage" as const,
      sourceReading: "ありっが", correctedReading: "ありが", resultReading: "ありがとう", additions: ["とう"] };
    const legacyChanges = { kind: "unknown" as const, evidence: "unavailable" as const,
      sourceReading: "ありっが", correctedReading: "ありが", additions: [] };
    const convert = vi.mocked(convertRomajiToJapaneseDetailed);
    convert.mockResolvedValueOnce({ text: "ありがとう", reviewKana: "ありがとう", changes, inputCompletionApplied: true })
      .mockResolvedValue({ text: "有難う", reviewKana: "ありがとう", changes: legacyChanges });
    const { hook, view, options } = harness("arigga");
    options.settingsRef.current.inputCompletionLevel = "word";
    await act(async () => { hook.current.handleConvert(range("arigga")); });
    const first = view.state.field(ghostSuggestionField).suggestion!;
    await act(async () => { hook.current.handleRetryGhost(first); });
    expect(convert.mock.calls[1][3]).toMatchObject({ alternativeReading: "ありがとう", alternativeCorrectedReading: "ありが", avoidOutputs: ["ありがとう"] });
    const alternative = view.state.field(ghostSuggestionField).suggestion!;
    await act(async () => { hook.current.handleAcceptGhost(alternative); });
    const history = hook.current.history[0];
    expect(history.reviewKana).toBe("ありがとう");
    await act(async () => { hook.current.handleAlternativeHistory(history); });
    expect(convert.mock.calls[2][3]).toMatchObject({ alternativeReading: "ありがとう", alternativeCorrectedReading: "ありが" });
  });

  it("preserves observed changes when a candidate is accepted into history", async () => {
    const changes = {
      kind: "notation" as const, evidence: "model-reading" as const,
      sourceReading: "ほんをよむ", resultReading: "ほんをよむ", additions: [],
    };
    vi.mocked(convertRomajiToJapaneseDetailed).mockResolvedValue({ text: "本を読む", reviewKana: "ほんをよむ", changes });
    const { hook, view, options } = harness("honwoyomu");
    options.settingsRef.current.inputCompletionLevel = "sentence";
    await act(async () => { hook.current.handleConvert(range("honwoyomu")); });
    const suggestion = view.state.field(ghostSuggestionField).suggestion;
    expect(suggestion?.changes).toEqual(changes);
    await act(async () => { hook.current.handleAcceptGhost(suggestion!); });
    expect(hook.current.history[0].changes).toEqual(changes);
  });

  it("does not apply a delayed result after switching documents, even with identical text", async () => {
    const response = deferred<JapaneseConversionResult>();
    vi.mocked(convertRomajiToJapaneseDetailed).mockReturnValue(response.promise);
    const { hook, view, options } = harness();
    act(() => { hook.current.handleConvert(range("konnichiha")); });
    expect(hook.current.pending).toHaveLength(1);
    act(() => {
      hook.current.clearPendingConversions();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "konnichiha" } });
      options.docVersionRef.current += 1;
    });
    await act(async () => { response.resolve({ text: "こんにちは", reviewKana: "こんにちは" }); });
    expect(view.state.doc.toString()).toBe("konnichiha");
    expect(hook.current.pending).toEqual([]);
    expect(hook.current.history).toEqual([]);
    expect(options.saveCurrentDocumentSession).not.toHaveBeenCalled();
  });

  it("records cancellation once and ignores the late response", async () => {
    const response = deferred<JapaneseConversionResult>();
    vi.mocked(convertRomajiToJapaneseDetailed).mockReturnValue(response.promise);
    const { hook, view } = harness();
    act(() => { hook.current.handleConvert(range("konnichiha")); });
    act(() => hook.current.cancelConversion(hook.current.pending[0]));
    await act(async () => { response.resolve({ text: "こんにちは", reviewKana: "こんにちは" }); });
    expect(view.state.doc.toString()).toBe("konnichiha");
    expect(hook.current.history.map(item => item.status)).toEqual(["canceled"]);
    expect(hook.current.pending).toEqual([]);
  });

  it("serializes queued requests and still processes the next request after cancellation", async () => {
    const first = deferred<JapaneseConversionResult>();
    const second = deferred<JapaneseConversionResult>();
    vi.mocked(convertRomajiToJapaneseDetailed)
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { hook, view } = harness("konnichiha sayounara");
    act(() => { hook.current.handleConvert(range("konnichiha")); });
    act(() => { hook.current.handleConvert(range("sayounara", "shortcut", 11)); });
    expect(convertRomajiToJapaneseDetailed).toHaveBeenCalledTimes(1);
    act(() => hook.current.cancelConversion(hook.current.pending[0]));
    await act(async () => { first.resolve({ text: "こんにちは", reviewKana: "こんにちは" }); });
    expect(convertRomajiToJapaneseDetailed).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve({ text: "さようなら", reviewKana: "さようなら", changes: {
      ...classifyConversionChanges("さようなら", "さようなら", "literal"),
      readingAssessment: assessReading("さようなら", "さようなら", false),
    } }); });
    expect(view.state.doc.toString()).toBe("konnichiha さようなら");
    expect(hook.current.history.map(item => item.status)).toEqual(["success", "canceled"]);
  });

  it.each(["edit", "invalidate", "unmount"] as const)("discards stale predictive results after %s", async (action) => {
    const response = deferred<JapaneseConversionResult>();
    vi.mocked(convertRomajiToJapaneseDetailed).mockReturnValue(response.promise);
    const { hook, view } = harness();
    act(() => { hook.current.handleConvert(range("konnichiha", "typing")); });
    act(() => {
      if (action === "edit") view.dispatch({ changes: { from: 0, to: 10, insert: "sayounara" } });
      if (action === "invalidate") hook.current.invalidatePredictiveSuggestions();
    });
    if (action === "unmount") hook.unmount();
    await act(async () => { response.resolve({ text: "こんにちは", reviewKana: "こんにちは" }); });
    expect(view.state.field(ghostSuggestionField).suggestion).toBeNull();
  });
  it("keeps unverified Kanji in a candidate even when direct replacement is configured", async () => {
    const changes = { ...classifyConversionChanges("ほん", "ほん", "model-reading"), readingAssessment: assessReading("本", "ほん", true) };
    vi.mocked(convertRomajiToJapaneseDetailed).mockResolvedValue({ text: "本", reviewKana: "ほん", changes });
    const { hook, view, options } = harness("hon");
    await act(async () => { hook.current.handleConvert(range("hon")); });
    expect(view.state.doc.toString()).toBe("hon");
    expect(options.saveCurrentDocumentSession).not.toHaveBeenCalled();
    const candidate = view.state.field(ghostSuggestionField).suggestion!;
    expect(candidate.changes?.readingAssessment?.status).toBe("unverified");
    // MarkdownEditor's Tab command applies the edit before this callback.
    view.dispatch({ changes: { from: candidate.from, to: candidate.to, insert: candidate.convertedText } });
    await act(async () => { hook.current.handleAcceptGhost(candidate); });
    expect(view.state.doc.toString()).toBe("本");
    expect(hook.current.history[0].changes?.readingAssessment?.status).toBe("unverified");
  });

  it("shows a valid prediction and clears the retry timer on unmount", async () => {
    vi.useFakeTimers();
    vi.mocked(convertRomajiToJapaneseDetailed).mockResolvedValue({ text: "こんにちは", reviewKana: "こんにちは" });
    const { hook, view } = harness();
    await act(async () => { hook.current.handleConvert(range("konnichiha", "typing")); });
    const suggestion = view.state.field(ghostSuggestionField).suggestion;
    expect(suggestion?.convertedText).toBe("こんにちは");
    act(() => { hook.current.handleAcceptGhost(suggestion!); });
    expect(hook.current.recentRetryItem?.output).toBe("こんにちは");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
