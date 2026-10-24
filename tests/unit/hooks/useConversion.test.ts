// @vitest-environment jsdom
import { act } from "react";
import { StateEffect } from "@codemirror/state";
import { completionSelection } from "../../../src/lib/completionSelection";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ghostSuggestionField, showGhostSuggestion } from "../../../src/components/MarkdownEditor";
import { classifyConversionChanges } from "../../../src/lib/conversionChanges";
import { applySessionRanking, createConversionSession, sessionResult } from "../../../src/lib/conversionSession";
import { defaultKanaEngine } from "../../../src/lib/kanaEngine";
import { convertRomajiToJapaneseDetailed, type JapaneseConversionResult } from "../../../src/lib/ollama";
import { defaultOllamaTransport } from "../../../src/lib/ollamaProxy";
import { assessReading } from "../../../src/lib/readingAssessment";
import { defaultSettings } from "../../../src/lib/settings";
import type { ConversionRange } from "../../../src/lib/types";
import { deferred, mountHook, stateEditor } from "./testUtils";
import { useConversion } from "../../../src/hooks/useConversion";
import { commitConversion } from "../../../src/lib/conversionCommit";
import { conversionLearningChoices } from "../../../src/lib/conversionLearning";

vi.mock("../../../src/lib/ollama", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/lib/ollama")>(),
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

function chooseNext({ hook, view }: Pick<ReturnType<typeof harness>, "hook" | "view">) {
  const ghost = view.state.field(ghostSuggestionField).suggestion!;
  const id = ghost.session!.candidates.find(c => c.id !== ghost.session!.selectedId)!.id;
  act(() => { hook.current.openGhostCandidates(ghost); });
  act(() => { hook.current.selectListedCandidate(id); });
}

describe("conversion lifecycle", () => {
  it("keeps automatic results provisional while completion selection is active", async () => {
    vi.mocked(convertRomajiToJapaneseDetailed).mockResolvedValue({ text: "本", reviewKana: "ほん" });
    const { hook, view, options } = harness("hon");
    view.dispatch({ effects: StateEffect.appendConfig.of(completionSelection.of(true)) });
    await act(async () => { hook.current.handleConvert(range("hon")); });
    expect(view.state.doc.toString()).toBe("hon");
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("本");
    expect(options.saveCurrentDocumentSession).not.toHaveBeenCalled();
  });
  it.each([false, true])("preserves learning policy and records one history/save (explicit=%s)", async explicit => {
    localStorage.clear();
    const session = createConversionSession("hon", [{ id: "first", kind: "conversion", result: {
      text: "本", reviewKana: "ほん", changes: {
        ...classifyConversionChanges("ほん", "ほん", "dictionary-path"),
        readingAssessment: { status: "verified", origin: "dictionary", proof: "independent" },
      },
    } }]);
    vi.mocked(convertRomajiToJapaneseDetailed).mockResolvedValue(sessionResult(session));
    const { hook, view, options } = harness("hon");
    options.settingsRef.current.conversionMode = explicit ? "ghost" : "replace";
    await act(async () => { hook.current.handleConvert(range("hon")); });
    if (explicit) {
      const value = view.state.field(ghostSuggestionField).suggestion!;
      act(() => {
        expect(commitConversion(view, value, "explicit")).toBe(true);
        hook.current.handleAcceptGhost(value);
      });
    }
    expect(conversionLearningChoices()).toHaveLength(explicit ? 1 : 0);
    if (explicit) expect(conversionLearningChoices()[0].count).toBe(1);
    expect(hook.current.history).toHaveLength(1);
    expect(options.saveCurrentDocumentSession).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("本");
  });
  beforeEach(() => { vi.mocked(convertRomajiToJapaneseDetailed).mockReset(); });

  const candidateSession = () => createConversionSession("kisha", [
    { id: "one", kind: "conversion", result: { text: "記者", reviewKana: "きしゃ" } },
    { id: "two", kind: "conversion", result: { text: "汽車", reviewKana: "きしゃ" } },
    { id: "typo", kind: "correction", result: { text: "会社", reviewKana: "かいしゃ" } },
  ]);
  it.each(["typing", "shortcut"] as const)("passes only the current document vocabulary when enabled: %s", async trigger => {
    vi.mocked(convertRomajiToJapaneseDetailed).mockResolvedValue({ text: "本", reviewKana: "ほん" });
    const { hook, view, options } = harness("航海 hon");
    options.settingsRef.current.conversionMode = "ghost";
    options.settingsRef.current.useDocumentVocabulary = true;
    await act(async () => { hook.current.handleConvert(range("hon", trigger, 3)); });
    expect(vi.mocked(convertRomajiToJapaneseDetailed).mock.lastCall?.[3]?.documentVocabulary).toContain("航海");
    act(() => { hook.current.handleDismissGhost(); view.dispatch({ changes: { from: 0, to: 2, insert: "校正" } }); });
    await act(async () => { hook.current.handleConvert(range("hon", trigger, 3)); });
    expect(vi.mocked(convertRomajiToJapaneseDetailed).mock.lastCall?.[3]?.documentVocabulary).toEqual(["校正"]);
    act(() => hook.current.handleDismissGhost());
    options.settingsRef.current.useDocumentVocabulary = false;
    await act(async () => { hook.current.handleConvert(range("hon", trigger, 3)); });
    expect(vi.mocked(convertRomajiToJapaneseDetailed).mock.lastCall?.[3]?.documentVocabulary).toBeUndefined();
  });

  it.each(["typing", "shortcut"] as const)("keeps a failed ranking provisional and reports it for %s", async trigger => {
    const session = candidateSession();
    vi.mocked(convertRomajiToJapaneseDetailed).mockImplementation(async (_input, _settings, _transport, callbacks) => {
      session.rerankStatus = "pending";
      callbacks?.onLocalCandidates?.(sessionResult(session));
      session.rerankStatus = "failed";
      return sessionResult(session);
    });
    const { hook, view, options } = harness("kisha");
    options.settingsRef.current.conversionMode = "replace";
    await act(async () => { hook.current.handleConvert(range("kisha", trigger)); });
    expect(view.state.doc.toString()).toBe("kisha");
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("記者");
    expect(session.selectedId).toBe("one");
    expect(session.state).toBe("open");
    expect(options.saveCurrentDocumentSession).not.toHaveBeenCalled();
    expect(options.setStatus).toHaveBeenLastCalledWith({ kind: "warning", message: "文脈による順位付けなし（暫定候補を表示しています）。" });
  });

  it("lists only the same reading, freezes late ranking and previews a selected stored candidate", () => {
    const { hook, view } = harness("kisha");
    const session = candidateSession();
    const ghost = {
      id: "normal", from: 0, to: 5, originalText: "kisha", inputText: "kisha", convertedText: "記者",
      reviewKana: "きしゃ", source: "editor" as const, session
    };
    act(() => { view.dispatch({ effects: showGhostSuggestion.of(ghost) }); hook.current.openGhostCandidates(ghost); });
    expect(hook.current.candidateList?.session.candidates.map(c => c.result.text)).toEqual(["記者", "汽車"]);
    expect(applySessionRanking(session, ["two", "one", "typo"])).toBe(false);
    expect(convertRomajiToJapaneseDetailed).not.toHaveBeenCalled();
    act(() => { hook.current.selectListedCandidate("two"); });
    expect(hook.current.candidateList).toBeNull();
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("汽車");
    expect(view.state.field(ghostSuggestionField).suggestion?.session?.selectedId).toBe("two");
    expect(view.state.doc.toString()).toBe("kisha");
  });

  it("previews a history candidate without overwriting the committed output or mutating the accepted session", () => {
    const { hook, view } = harness("記者");
    const session = candidateSession(); session.state = "accepted";
    act(() => {
      hook.current.openCandidateList({
        id: "old", input: "kisha", output: "記者", reviewKana: "きしゃ", session,
        status: "success", source: "editor", createdAt: 0, modelName: "test",
        anchor: { from: 0, to: 2, originalText: "kisha", appliedText: "記者", docVersion: 0 }
      });
    });
    act(() => { hook.current.selectListedCandidate("two"); });
    expect(view.state.doc.toString()).toBe("記者");
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("汽車");
    expect(session.selectedId).toBe("one");
    expect(session.state).toBe("accepted");
  });

  it("does not change the document or generate when a candidate list is dismissed", () => {
    const { hook, view } = harness("kisha");
    const ghost = {
      id: "normal", from: 0, to: 5, originalText: "kisha", inputText: "kisha", convertedText: "記者",
      reviewKana: "きしゃ", source: "editor" as const, session: candidateSession()
    };
    act(() => { view.dispatch({ effects: showGhostSuggestion.of(ghost) }); hook.current.openGhostCandidates(ghost); });
    act(() => { hook.current.closeCandidateList(); });
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("記者");
    expect(view.state.doc.toString()).toBe("kisha");
    expect(convertRomajiToJapaneseDetailed).not.toHaveBeenCalled();
  });

  it("rejects a list selection after the target document has changed", () => {
    const { hook, view } = harness("kisha");
    const ghost = {
      id: "normal", from: 0, to: 5, originalText: "kisha", inputText: "kisha", convertedText: "記者",
      reviewKana: "きしゃ", source: "editor" as const, session: candidateSession()
    };
    act(() => { view.dispatch({ effects: showGhostSuggestion.of(ghost) }); hook.current.openGhostCandidates(ghost); });
    act(() => { view.dispatch({ changes: { from: 0, to: 5, insert: "changed" } }); hook.current.selectListedCandidate("two"); });
    expect(hook.current.candidateList).toBeNull();
    expect(view.state.field(ghostSuggestionField).suggestion).toBeNull();
    expect(view.state.doc.toString()).toBe("changed");
  });

  it("starts speculation only when the explicit action inside the list is chosen", async () => {
    const { hook, view } = harness("kisha");
    const ghost = {
      id: "normal", from: 0, to: 5, originalText: "kisha", inputText: "kisha", convertedText: "記者",
      reviewKana: "きしゃ", source: "editor" as const, session: candidateSession()
    };
    vi.mocked(convertRomajiToJapaneseDetailed).mockResolvedValue({ text: "会社", reviewKana: "かいしゃ", conversionStrategy: "speculative" });
    act(() => { view.dispatch({ effects: showGhostSuggestion.of(ghost) }); hook.current.openGhostCandidates(ghost); });
    expect(convertRomajiToJapaneseDetailed).not.toHaveBeenCalled();
    await act(async () => { hook.current.speculateFromCandidateList(); });
    expect(vi.mocked(convertRomajiToJapaneseDetailed).mock.lastCall?.[3]).toMatchObject({ userRequestedSpeculation: true, avoidOutputs: ["記者"] });
    expect(view.state.doc.toString()).toBe("kisha");
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("会社");
  });

  it.each(["rejected", "canceled"] as const)("keeps an applied conversion when explicit speculation is %s", async outcome => {
    const { hook, view } = harness("資料を角煮してください。");
    const result = deferred<JapaneseConversionResult>();
    vi.mocked(convertRomajiToJapaneseDetailed).mockReturnValue(result.promise);
    act(() => {
      hook.current.handleSpeculateHistory({
        id: "applied", status: "success", input: "kakuni", output: "角煮",
        modelName: "test", createdAt: 0, source: "editor", anchor: { from: 3, to: 5, originalText: "kakuni", appliedText: "角煮", docVersion: 0 }
      });
    });
    if (outcome === "canceled") act(() => { hook.current.cancelConversion(hook.current.pending[0]); });
    await act(async () => {
      result.resolve(outcome === "rejected"
        ? { text: "", reviewKana: "かくに", suggestionRejected: true, suggestionRejectedReason: "speculative" }
        : { text: "確認", reviewKana: "かくにん", conversionStrategy: "speculative" });
    });
    expect(view.state.doc.toString()).toBe("資料を角煮してください。");
    expect(view.state.field(ghostSuggestionField).suggestion).toBeNull();
  });

  it("clears provisional UI on direct application even when the result equals the source", async () => {
    const session = createConversionSession("ありがとう", [{
      id: "first", kind: "conversion", result: {
        text: "ありがとう", reviewKana: "ありがとう", changes: {
          ...classifyConversionChanges("ありがとう", "ありがとう", "literal"),
          readingAssessment: assessReading("ありがとう", "ありがとう", false),
        },
      }
    }]);
    vi.mocked(convertRomajiToJapaneseDetailed).mockImplementation(async (_input, _settings, _transport, options) => {
      session.rerankStatus = "pending";
      options?.onLocalCandidates?.(sessionResult(session));
      session.rerankStatus = "applied";
      return sessionResult(session);
    });
    const { hook, view } = harness("ありがとう");
    await act(async () => { hook.current.handleConvert(range("ありがとう")); });
    expect(view.state.field(ghostSuggestionField).suggestion).toBeNull();
    expect(view.state.doc.toString()).toBe("ありがとう");
    expect(session.state).toBe("accepted");
    expect(hook.current.history[0].status).toBe("success");
  });

  it.each(["editor", "history"] as const)("applies %s results once when both callback and return publish the same session", async source => {
    const result = { text: "本", reviewKana: "ほん", changes: {
      ...classifyConversionChanges("ほん", "ほん", "dictionary-path"),
      readingAssessment: { status: "verified" as const, origin: "dictionary" as const, proof: "independent" as const },
    } };
    const session = createConversionSession("hon", [{ id: "first", kind: "conversion", result }]);
    vi.mocked(convertRomajiToJapaneseDetailed).mockImplementation(async (_input, _settings, _transport, options) => {
      options?.onLocalCandidates?.(sessionResult(session));
      return sessionResult(session);
    });
    const { hook, view, options } = harness("hon");
    await act(async () => {
      if (source === "editor") hook.current.handleConvert(range("hon"));
      else hook.current.handleRerunHistory({ id: "old", input: "hon", output: "本", status: "success",
        source: "editor", modelName: "test", createdAt: 0,
        anchor: { from: 0, to: 3, originalText: "hon", docVersion: 0 } });
    });
    expect(view.state.doc.toString()).toBe("本");
    expect(session.state).toBe("accepted");
    expect(hook.current.history).toHaveLength(1);
    expect(options.saveCurrentDocumentSession).toHaveBeenCalledOnce();
  });

  it("clears the visible candidate when dismiss is called without a supplied suggestion", async () => {
    const session = createConversionSession("hon", [{ id: "first", kind: "conversion", result: { text: "本", reviewKana: "ほん" } }]);
    vi.mocked(convertRomajiToJapaneseDetailed).mockResolvedValue(sessionResult(session));
    const { hook, view } = harness("hon");
    await act(async () => { hook.current.handleConvert(range("hon", "typing")); });
    expect(view.state.field(ghostSuggestionField).suggestion).not.toBeNull();
    act(() => { hook.current.handleDismissGhost(); });
    expect(view.state.field(ghostSuggestionField).suggestion).toBeNull();
    expect(session.state).toBe("dismissed");
  });

  it("clears an abstained provisional candidate while rescue runs and keeps romaji if all stages fail", async () => {
    const actual = await vi.importActual<typeof import("../../../src/lib/ollama")>("../../../src/lib/ollama");
    vi.mocked(convertRomajiToJapaneseDetailed).mockImplementation(actual.convertRomajiToJapaneseDetailed);
    const candidates = ["本", "奔"].map(text => ({
      text, reading: "ほん", cost: 100,
      tokens: [{ text, reading: "ほん", from: 0, to: 2, source: "mozc" as const, entryId: "test", lid: 0, rid: 0, wordCost: 100 }]
    }));
    vi.spyOn(defaultKanaEngine, "search").mockImplementation(async reading => ({ candidates: candidates.filter(c => c.reading === reading), truncated: false, dictionaryRevision: "test" }));
    const ranking = deferred<{ response: string }>();
    const correction = deferred<{ response: string }>();
    const echo = { response: JSON.stringify({ convertedText: "ほん", completedKana: "ほん" }) };
    const generate = vi.spyOn(defaultOllamaTransport, "generate").mockReturnValueOnce(ranking.promise)
      .mockReturnValueOnce(correction.promise).mockResolvedValue(echo);
    const { hook, view } = harness("hon");
    await act(async () => { hook.current.handleConvert(range("hon")); });
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("本");
    await act(async () => { ranking.resolve({ response: '{"order":[]}' }); });
    expect(view.state.field(ghostSuggestionField).suggestion).toBeNull();
    expect(view.state.doc.toString()).toBe("hon");
    await act(async () => { correction.resolve(echo); });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(view.state.field(ghostSuggestionField).suggestion).toBeNull();
    expect(view.state.doc.toString()).toBe("hon");
    expect(hook.current.history[0].status).toBe("skipped");
    expect(hook.current.pending).toHaveLength(0);
  });

  it("keeps explicit ownership when its source moves during an edit", async () => {
    const response = deferred<JapaneseConversionResult>();
    vi.mocked(convertRomajiToJapaneseDetailed).mockReturnValue(response.promise);
    const { hook, view } = harness("hon");
    act(() => { hook.current.handleConvert(range("hon")); });
    act(() => { view.dispatch({ changes: { from: 0, insert: "前の文です。\n" } }); });
    const from = view.state.doc.toString().indexOf("hon");
    act(() => { expect(hook.current.handleConvert(range("hon", "typing", from))).toBe(false); });
    await act(async () => { response.resolve({ text: "本", reviewKana: "ほん" }); });
    expect(view.state.field(ghostSuggestionField).suggestion?.from).toBe(from);
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("本");
  });

  it("shows predictive dictionary candidates immediately and releases the next conversion before ranking", async () => {
    const ranking = deferred<void>();
    const sessions = ["hon", "yomu"].map((input, i) => createConversionSession(input, [
      { id: "first", kind: "conversion", result: { text: i ? "読む" : "本", reviewKana: i ? "よむ" : "ほん" } },
      { id: "second", kind: "conversion", result: { text: i ? "よむ" : "ほん", reviewKana: i ? "よむ" : "ほん" } },
    ]));
    const convert = vi.mocked(convertRomajiToJapaneseDetailed);
    convert.mockImplementation(async (input, _settings, _transport, options) => {
      const session = sessions[input === "hon" ? 0 : 1];
      session.rerankStatus = "pending";
      options?.onLocalCandidates?.(sessionResult(session));
      options?.deferRanking?.(async () => {
        await ranking.promise;
        session.rerankStatus = "applied";
        if (session.state === "open" && !session.locked) options.onRankedCandidates?.(sessionResult(session));
      }, () => { session.rerankStatus = "skipped"; });
      return sessionResult(session);
    });
    const { hook, view } = harness("hon yomu");
    await act(async () => { hook.current.handleConvert(range("hon", "typing")); });
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("本");
    await act(async () => { hook.current.handleConvert(range("yomu", "shortcut", 4)); });
    expect(convert).toHaveBeenCalledTimes(2);
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("読む");
    chooseNext({ hook, view });
    await act(async () => { ranking.resolve(); });
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("よむ");
    expect(view.state.doc.toString()).toBe("hon yomu");
    expect(hook.current.pending).toHaveLength(0);
  });

  it.each(["shortcut", "period"] as const)("does not let a prediction replace a newer %s result", async trigger => {
    const old = deferred<JapaneseConversionResult>();
    const convert = vi.mocked(convertRomajiToJapaneseDetailed);
    const session = createConversionSession("hon", [
      { id: "first", kind: "conversion", result: { text: "本", reviewKana: "ほん" } },
      { id: "second", kind: "conversion", result: { text: "ほん", reviewKana: "ほん" } },
    ]);
    convert.mockReturnValueOnce(old.promise).mockResolvedValueOnce(sessionResult(session));
    const { hook, view } = harness("hon");
    act(() => { hook.current.handleConvert(range("hon", "typing")); });
    const signal = convert.mock.calls[0][3]?.signal;
    await act(async () => { hook.current.handleConvert(range("hon", trigger)); });
    expect(signal?.aborted).toBe(true);
    const chosen = view.state.field(ghostSuggestionField).suggestion!;
    chooseNext({ hook, view });
    await act(async () => { old.resolve({ text: "ほん", reviewKana: "ほん" }); });
    expect(view.state.field(ghostSuggestionField).suggestion?.id).toBe(chosen.id);
    expect(view.state.field(ghostSuggestionField).suggestion?.session?.selectedId).toBe("second");
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("ほん");
  });

  it("keeps unrelated pending work and prevents an older result taking over the display", async () => {
    const old = deferred<JapaneseConversionResult>();
    const convert = vi.mocked(convertRomajiToJapaneseDetailed);
    convert.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ text: "読む", reviewKana: "よむ" });
    const { hook, view } = harness("hon yomu");
    act(() => { hook.current.handleConvert(range("hon", "typing")); });
    const signal = convert.mock.calls[0][3]?.signal;
    await act(async () => { hook.current.handleConvert(range("yomu", "shortcut", 4)); });
    expect(signal?.aborted).toBe(false);
    await act(async () => { old.resolve({ text: "本", reviewKana: "ほん" }); });
    expect(view.state.field(ghostSuggestionField).suggestion?.convertedText).toBe("読む");
  });

  it("does not enqueue a prediction over an explicit request", async () => {
    const response = deferred<JapaneseConversionResult>();
    vi.mocked(convertRomajiToJapaneseDetailed).mockReturnValue(response.promise);
    const { hook } = harness("hon");
    act(() => { hook.current.handleConvert(range("hon")); });
    act(() => { expect(hook.current.handleConvert(range("hon", "typing"))).toBe(false); });
    expect(convertRomajiToJapaneseDetailed).toHaveBeenCalledTimes(1);
    await act(async () => { response.resolve({ text: "本", reviewKana: "ほん" }); });
  });

  it("preserves observed changes when a candidate is accepted into history", async () => {
    const changes = {
      kind: "notation" as const, evidence: "model-reading" as const,
      sourceReading: "ほんをよむ", resultReading: "ほんをよむ", additions: [],
    };
    vi.mocked(convertRomajiToJapaneseDetailed).mockResolvedValue({ text: "本を読む", reviewKana: "ほんをよむ", changes });
    const { hook, view } = harness("honwoyomu");
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

  it.each([false, true])("dismisses displayed local candidates on cancellation, including navigated=%s", async navigated => {
    const response = deferred<JapaneseConversionResult>();
    const session = createConversionSession("hon", [
      { id: "first", kind: "conversion", result: { text: "本", reviewKana: "ほん" } },
      { id: "second", kind: "conversion", result: { text: "ほん", reviewKana: "ほん" } },
    ]);
    vi.mocked(convertRomajiToJapaneseDetailed).mockImplementation((_input, _settings, _transport, options) => {
      options?.onLocalCandidates?.(sessionResult(session));
      return response.promise;
    });
    const { hook, view, options } = harness("hon");
    act(() => { hook.current.handleConvert(range("hon")); });
    expect(view.state.field(ghostSuggestionField).suggestion?.session).toBe(session);
    if (navigated) chooseNext({ hook, view });
    act(() => { hook.current.cancelConversion(hook.current.pending[0]); });
    expect(session.state).toBe("dismissed");
    expect(view.state.field(ghostSuggestionField).suggestion).toBeNull();
    expect(applySessionRanking(session, ["second", "first"])).toBe(false);
    await act(async () => { response.resolve(sessionResult(session)); });
    expect(view.state.field(ghostSuggestionField).suggestion).toBeNull();
    expect(view.state.doc.toString()).toBe("hon");
    expect(hook.current.history.map(item => item.status)).toEqual(["canceled"]);
    expect(hook.current.pending).toEqual([]);
    expect(options.saveCurrentDocumentSession).not.toHaveBeenCalled();
  });

  it("preserves an unrelated visible candidate when another request is canceled", async () => {
    const response = deferred<JapaneseConversionResult>();
    vi.mocked(convertRomajiToJapaneseDetailed).mockReturnValue(response.promise);
    const { hook, view } = harness("hon");
    act(() => { hook.current.handleConvert(range("hon")); });
    const session = createConversionSession("hon", [{ id: "other-candidate", kind: "conversion", result: { text: "本", reviewKana: "ほん" } }]);
    act(() => {
      view.dispatch({
        effects: showGhostSuggestion.of({
          id: "other-request", from: 0, to: 3,
          originalText: "hon", inputText: "hon", convertedText: "本", source: "editor", session
        })
      });
      hook.current.cancelConversion(hook.current.pending[0]);
    });
    expect(view.state.field(ghostSuggestionField).suggestion?.id).toBe("other-request");
    expect(session.state).toBe("open");
    await act(async () => { response.resolve({ text: "ほん", reviewKana: "ほん" }); });
    expect(view.state.field(ghostSuggestionField).suggestion?.id).toBe("other-request");
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
    await act(async () => {
      second.resolve({
        text: "さようなら", reviewKana: "さようなら", changes: {
          ...classifyConversionChanges("さようなら", "さようなら", "literal"),
          readingAssessment: assessReading("さようなら", "さようなら", false),
        }
      });
    });
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
