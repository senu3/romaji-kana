// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ghostSuggestionField } from "../components/MarkdownEditor";
import { convertRomajiToJapaneseDetailed, type JapaneseConversionResult } from "../lib/ollama";
import { defaultSettings } from "../lib/settings";
import type { ConversionRange } from "../lib/types";
import { deferred, mountHook, stateEditor } from "./testUtils";
import { useConversion } from "./useConversion";

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
    await act(async () => { second.resolve({ text: "さようなら", reviewKana: "さようなら" }); });
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
