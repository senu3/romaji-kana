import type { EditorView } from "@codemirror/view";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addLoadingDecoration,
  clearGhostSuggestion,
  ghostSuggestionField,
  removeLoadingDecoration,
  showGhostSuggestion,
} from "../components/MarkdownEditor";
import { formatConversionError } from "../lib/appErrors";
import type { ActivePanel } from "../lib/appTypes";
import { buildDocumentVocabularyProfile } from "../lib/documentVocabulary";
import { resolveConversionAnchor } from "../lib/historyAnchor";
import { createId } from "../lib/id";
import { buildProtectedDictionaryEntries, convertRomajiToJapaneseDetailed } from "../lib/ollama";
import { requiresExplicitAcceptance } from "../lib/readingAssessment";
import { defaultKanaEngine } from "../lib/kanaEngine";
import { nextSessionCandidate, sessionResult } from "../lib/conversionSession";
import { recordConversionChoice } from "../lib/conversionLearning";
import { RankingQueue } from "../lib/rankingQueue";
import type { JapaneseConversionResult } from "../lib/japaneseConversionTypes";
import { ConversionRequests, rangesOverlap } from "../lib/conversionRequests";
import type {
  AppSettings,
  ConversionAnchor,
  ConversionHistoryItem,
  ConversionRange,
  ConversionStatus,
  GhostConversionSuggestion,
  PendingConversion,
} from "../lib/types";

const CANCEL_UI_DELAY_MS = 1_200;

const RECENT_RETRY_CHIP_TIMEOUT_MS = 8_000;

const MAX_CONVERSION_HISTORY_ITEMS = 100;

interface PredictiveSuggestionRequest {
  id: string;
  revision: number;
  epoch: number;
  range: ConversionRange;
  settings: AppSettings;
  documentVocabulary?: string[];
  documentVocabularyRevision?: string;
}

function isPredictiveSuggestionTrigger(trigger: ConversionRange["trigger"] | undefined): boolean {
  return trigger === "typing" || trigger === "space";
}

function hasMatchingPendingEditorConversion(
  requests: PendingConversion[],
  range: ConversionRange,
): boolean {
  return requests.some(
    (request) =>
      request.source === "editor" &&
      request.range !== undefined &&
      request.range.from === range.from &&
      request.range.to === range.to &&
      request.range.text === range.text,
  );
}

function collectAvoidOutputs(existing: string[] | undefined, next: string | undefined): string[] {
  return Array.from(
    new Set(
      [...(existing ?? []), next]
        .map((output) => output?.trim())
        .filter((output): output is string => Boolean(output)),
    ),
  );
}

function hasDuplicatePendingHistoryConversion(
  requests: PendingConversion[],
  next: PendingConversion,
): boolean {
  const nextAvoidOutputs = next.avoidOutputs?.join("\u0000") ?? "";
  return requests.some((request) =>
    request.source === "history" &&
    request.originalText === next.originalText &&
    request.retryOf === next.retryOf &&
    request.alternativeReading === next.alternativeReading &&
    request.alternativeCorrectedReading === next.alternativeCorrectedReading &&
    request.alternativeAdditionKind === next.alternativeAdditionKind &&
    (request.avoidOutputs?.join("\u0000") ?? "") === nextAvoidOutputs &&
    request.anchor?.from === next.anchor?.from &&
    request.anchor?.to === next.anchor?.to &&
    request.anchor?.originalText === next.anchor?.originalText
  );
}

function prependConversionHistory(
  items: ConversionHistoryItem[],
  nextItem: ConversionHistoryItem,
): ConversionHistoryItem[] {
  return [nextItem, ...items].slice(0, MAX_CONVERSION_HISTORY_ITEMS);
}

function upsertConversionHistory(
  items: ConversionHistoryItem[],
  nextItem: ConversionHistoryItem,
): ConversionHistoryItem[] {
  return [nextItem, ...items.filter((item) => item.id !== nextItem.id)].slice(
    0,
    MAX_CONVERSION_HISTORY_ITEMS,
  );
}

interface ConversionOptions {
  editorViewRef: RefObject<EditorView | null>;
  settingsRef: RefObject<AppSettings>;
  setStatus: Dispatch<SetStateAction<ConversionStatus>>;
  saveCurrentDocumentSession: (documentText: string) => void;
  docVersionRef: RefObject<number>;
  activePanel: ActivePanel;
  setupComplete: boolean;
}

export function useConversion({
  editorViewRef,
  settingsRef,
  setStatus,
  saveCurrentDocumentSession,
  docVersionRef,
  activePanel,
  setupComplete,
}: ConversionOptions) {
  const [pending, setPending] = useState<PendingConversion[]>([]);

  const [history, setHistory] = useState<ConversionHistoryItem[]>([]);

  const [recentRetryItem, setRecentRetryItem] = useState<ConversionHistoryItem | null>(null);

  const [now, setNow] = useState(() => Date.now());

  const canceledRequestsRef = useRef(new Set<string>());
  const requestsRef = useRef(new ConversionRequests());

  const conversionQueueRef = useRef<PendingConversion[]>([]);

  const rankingQueueRef = useRef(new RankingQueue());
  const rankingRequestsRef = useRef(new Map<string, PendingConversion | undefined>());
  const syncPending = useCallback(() => {
    const requests = new Map(conversionQueueRef.current.map(request => [request.id, request]));
    for (const [id, request] of rankingRequestsRef.current) if (request) requests.set(id, request);
    setPending([...requests.values()].filter(request => requestsRef.current.valid(request.id)));
  }, []);
  const deferRanking = useCallback((id: string, request?: PendingConversion) =>
    (run: () => Promise<void>, skip: () => void) => {
      rankingRequestsRef.current.set(id, request);
      syncPending();
      const finish = () => {
        rankingRequestsRef.current.delete(id);
        requestsRef.current.finish(id);
        syncPending();
      };
      rankingQueueRef.current.schedule(async () => {
        try { await run(); }
        catch (error) {
          if (requestsRef.current.valid(id)) setStatus({ kind: "error", message: formatConversionError(error) });
        }
        finally { finish(); }
      }, () => { skip(); finish(); });
    }, [syncPending]);

  const processingQueueRef = useRef(false);

  const runningRequestIdRef = useRef<string | null>(null);

  const predictiveSuggestionQueueRef = useRef<PredictiveSuggestionRequest | null>(null);

  const processingPredictiveSuggestionRef = useRef(false);

  const predictiveSuggestionRevisionRef = useRef(0);

  const displayedSuggestionRevisionRef = useRef(0);

  const predictiveSuggestionEpochRef = useRef(0);

  const invalidatePredictiveSuggestions = useCallback((clearVisible = true) => {
    requestsRef.current.cancelPredictions();
    predictiveSuggestionEpochRef.current += 1;
    if (predictiveSuggestionQueueRef.current) requestsRef.current.finish(predictiveSuggestionQueueRef.current.id);
    predictiveSuggestionQueueRef.current = null;
    displayedSuggestionRevisionRef.current = 0;
    if (clearVisible) {
      const view = editorViewRef.current;
      if (view) {
        const session = view.state.field(ghostSuggestionField).suggestion?.session;
        if (session?.state === "open") session.state = "dismissed";
        view.dispatch({ effects: clearGhostSuggestion.of(null) });
      }
    }
  }, []);

  useEffect(() => {
    if (pending.length === 0) {
      return;
    }

    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [pending.length]);

  const clearPendingConversions = useCallback(() => {
    requestsRef.current.clear();
    rankingQueueRef.current.clear();
    rankingRequestsRef.current.clear();
    invalidatePredictiveSuggestions();
    const requests = conversionQueueRef.current;
    const runningId = runningRequestIdRef.current;
    for (const request of requests) {
      if (request.id === runningId) {
        canceledRequestsRef.current.add(request.id);
      }
    }
    conversionQueueRef.current = [];
    setPending([]);

    const view = editorViewRef.current;
    if (view) {
      for (const request of requests) {
        view.dispatch({ effects: removeLoadingDecoration.of(request.id) });
      }
    }
  }, [invalidatePredictiveSuggestions]);

  const recordCanceledConversion = useCallback((request: PendingConversion) => {
    setHistory((items) =>
      prependConversionHistory(items, {
        id: request.id,
        status: "canceled",
        input: request.originalText,
        error: "ユーザーがキャンセルしました。",
        modelName: settingsRef.current.modelName,
        createdAt: Date.now(),
        source: request.source,
        anchor: request.anchor,
        retryOf: request.retryOf,
        avoidOutputs: request.avoidOutputs,
        inputCompletionLevel:
          request.inputCompletionLevel ?? settingsRef.current.inputCompletionLevel,
        documentVocabulary: request.documentVocabulary,
        documentVocabularyRevision: request.documentVocabularyRevision,
      }),
    );
    setStatus({ kind: "warning", message: "変換をキャンセルしました。" });
  }, []);

  const skipQueuedConversion = useCallback((request: PendingConversion, message: string) => {
    setHistory((items) =>
      prependConversionHistory(items, {
        id: request.id,
        status: "skipped",
        input: request.originalText,
        error: message,
        modelName: settingsRef.current.modelName,
        createdAt: Date.now(),
        source: request.source,
        anchor: request.anchor,
        retryOf: request.retryOf,
        avoidOutputs: request.avoidOutputs,
        inputCompletionLevel:
          request.inputCompletionLevel ?? settingsRef.current.inputCompletionLevel,
        documentVocabulary: request.documentVocabulary,
        documentVocabularyRevision: request.documentVocabularyRevision,
      }),
    );
    setStatus({ kind: "warning", message });
  }, []);

  const processEditorConversion = useCallback(
    async (request: PendingConversion) => {
      const view = editorViewRef.current;
      const anchor = request.anchor;
      if (!view || !anchor) {
        skipQueuedConversion(request, "エディタを利用できないため、変換をスキップしました。");
        return;
      }

      const resolved = resolveConversionAnchor(view.state.doc.toString(), anchor);
      if (!resolved) {
        skipQueuedConversion(
          request,
          "キュー内の変換を開始する前に元のテキストが変わったため、スキップしました。",
        );
        return;
      }

      const inputCompletionLevel =
        request.inputCompletionLevel ?? settingsRef.current.inputCompletionLevel;
      const applyConversion = (conversion: JapaneseConversionResult) => {
        if (!requestsRef.current.valid(request.id)) {
          return;
        }
        if (conversion.session && (conversion.session.state !== "open" || conversion.session.locked)) return;

        if (conversion.suggestionRejected) {
          view.dispatch({ effects: [removeLoadingDecoration.of(request.id), clearGhostSuggestion.of(request.id)] });
          skipQueuedConversion(
            request,
          conversion.suggestionRejectedReason === "unconvertible"
            ? "通常変換・誤字修正・推測で候補が得られなかったため、ローマ字を残しました。"
            : conversion.suggestionRejectedReason === "speculative"
              ? "適切な推測候補を作れなかったため、ローマ字を残しました。入力を続けると再生成します。"
              : "候補を安全に適用できなかったため表示しませんでした。入力を続けると新しい候補を生成します。",
          );
          return;
        }

        const currentView = editorViewRef.current;
        if (!currentView) {
          skipQueuedConversion(request, "エディタを利用できないため、変換をスキップしました。");
          return;
        }

        const latestAnchor: ConversionAnchor = {
          ...anchor,
          from: resolved.from,
          to: resolved.to,
          originalText: resolved.matchedText,
      };
      const latestResolved = resolveConversionAnchor(currentView.state.doc.toString(), latestAnchor);
      if (!latestResolved || latestResolved.matchedText !== resolved.matchedText) {
        skipQueuedConversion(
          request,
          "キュー内の変換を適用する前に元のテキストが変わったため、スキップしました。",
        );
        return;
      }

      const converted = conversion.text;
      if (
        conversion.session?.rerankStatus === "pending" ||
        settingsRef.current.conversionMode === "ghost" ||
        requiresExplicitAcceptance(conversion) ||
        inputCompletionLevel !== "none" ||
        conversion.inputCompletionApplied ||
        conversion.conversionStrategy === "speculative" ||
        isPredictiveSuggestionTrigger(request.range?.trigger)
      ) {
        if (!requestsRef.current.display(request.id)) return;
        currentView.dispatch({
          effects: [
            removeLoadingDecoration.of(request.id),
            showGhostSuggestion.of({
              id: request.id,
              from: latestResolved.from,
              to: latestResolved.to,
              originalText: latestResolved.matchedText,
              convertedText: converted,
              inputText: request.originalText,
              reviewKana: conversion.reviewKana,
              conversionStrategy: conversion.conversionStrategy,
              changes: conversion.changes,
              session: conversion.session,
              inputCompletionLevel,
              inputCompletionApplied: conversion.inputCompletionApplied,
              inputCompletionSourceKana: conversion.inputCompletionSourceKana,
              inputCompletionAdditions: conversion.inputCompletionAdditions,
              trigger: request.range?.trigger,
              documentVocabulary: request.documentVocabulary,
              documentVocabularyRevision: request.documentVocabularyRevision,
              source: "editor",
              retryOf: request.retryOf,
              avoidOutputs: request.avoidOutputs,
            }),
          ],
        });
        setStatus({
          kind: "success",
          message: conversion.conversionStrategy === "speculative"
            ? "推測候補を生成しました。Tab で確定、Esc で破棄できます。"
            : inputCompletionLevel !== "none"
              ? "サジェストを生成しました。Tab で確定、Esc で破棄できます。"
              : conversion.conversionStrategy === "completion"
                ? "誤字修正候補を生成しました。Tab で確定、Ctrl/Cmd+/ で別候補を試せます。"
                : "変換候補の準備ができました。Tab で確定、Ctrl/Cmd+/ で別候補を試せます。",
        });
        return;
      }

      currentView.dispatch({
        changes: {
          from: latestResolved.from,
          to: latestResolved.to,
          insert: converted,
        },
        effects: removeLoadingDecoration.of(request.id),
        userEvent: "input.convert",
      });
      if (conversion.session) conversion.session.state = "accepted";
      saveCurrentDocumentSession(currentView.state.doc.toString());

      const nextAnchor: ConversionAnchor = {
        from: latestResolved.from,
        to: latestResolved.from + converted.length,
        originalText: latestResolved.matchedText,
        appliedText: converted,
        docVersion: docVersionRef.current,
      };
      const historyItem: ConversionHistoryItem = {
        id: request.id,
        status: "success",
        input: request.originalText,
        output: converted,
        reviewKana: conversion.reviewKana,
        modelName: settingsRef.current.modelName,
        createdAt: Date.now(),
        source: "editor",
        anchor: nextAnchor,
        conversionStrategy: conversion.conversionStrategy,
        changes: conversion.changes,
        session: conversion.session,
        inputCompletionLevel,
        inputCompletionApplied: conversion.inputCompletionApplied,
        inputCompletionSourceKana: conversion.inputCompletionSourceKana,
        documentVocabulary: request.documentVocabulary,
        documentVocabularyRevision: request.documentVocabularyRevision,
        retryOf: request.retryOf,
        avoidOutputs: request.avoidOutputs,
      };
      setHistory((items) => prependConversionHistory(items, historyItem));
      setRecentRetryItem(historyItem);
      setStatus({
        kind: "success",
        message: conversion.inputCompletionApplied
          ? "入力補完を適用しました。元に戻すとローマ字に戻ります。"
          : conversion.conversionStrategy === "completion"
            ? "誤字修正で変換しました。Ctrl/Cmd+/ で別候補を試せます。元に戻すとローマ字に戻ります。"
            : "変換しました。Ctrl/Cmd+/ で別候補を試せます。元に戻すとローマ字に戻ります。",
      });
      };
      const conversion = await convertRomajiToJapaneseDetailed(
        resolved.matchedText,
        { ...settingsRef.current, inputCompletionLevel },
        undefined,
        {
          kanaEngine: settingsRef.current.conversionEngine === "llm" ? undefined : defaultKanaEngine,
          signal: requestsRef.current.get(request.id)?.controller.signal,
          deferRanking: deferRanking(request.id, request),
          onRankedCandidates: applyConversion,
          onRescueStart: () => {
            if (!requestsRef.current.valid(request.id)) return;
            editorViewRef.current?.dispatch({ effects: clearGhostSuggestion.of(request.id) });
            setStatus({ kind: "loading", message: "通常変換で適切な候補がないため、誤字修正・推測を試しています。" });
          },
          anchor,
          contextBefore: view.state.doc.sliceString(Math.max(0, resolved.from - 1200), resolved.from),
          contextAfter: view.state.doc.sliceString(resolved.to, Math.min(view.state.doc.length, resolved.to + 600)),
          onLocalCandidates: (result) => {
            const current = editorViewRef.current;
            const position = current && resolveConversionAnchor(current.state.doc.toString(), anchor);
            if (!current || !position || !requestsRef.current.display(request.id)) return;
            current.dispatch({ effects: showGhostSuggestion.of({
              id: request.id, from: position.from, to: position.to, originalText: position.matchedText,
              convertedText: result.text, inputText: request.originalText, reviewKana: result.reviewKana,
              changes: result.changes, session: result.session, trigger: request.range?.trigger,
              inputCompletionApplied: result.inputCompletionApplied, inputCompletionSourceKana: result.inputCompletionSourceKana,
              inputCompletionAdditions: result.inputCompletionAdditions,
              inputCompletionLevel, source: request.source, documentVocabulary: request.documentVocabulary,
            }) });
          },
          avoidOutputs: request.avoidOutputs,
          alternativeReading: request.alternativeReading,
          alternativeCorrectedReading: request.alternativeCorrectedReading,
          alternativeAdditionKind: request.alternativeAdditionKind,
          documentVocabulary: request.documentVocabulary,
        },
      );
      applyConversion(conversion);
    },
    [saveCurrentDocumentSession, skipQueuedConversion],
  );

  const processHistoryConversion = useCallback(
    async (request: PendingConversion) => {
      const currentView = editorViewRef.current;
      const resolved = request.anchor && currentView
        ? resolveConversionAnchor(currentView.state.doc.toString(), request.anchor)
        : null;

      if (request.anchor && currentView && !resolved) {
        skipQueuedConversion(
          request,
          "適用位置を解決できなかったため、履歴からの変換を適用しませんでした。",
        );
        return;
      }

      const inputCompletionLevel =
        request.inputCompletionLevel ?? settingsRef.current.inputCompletionLevel;
      const applyConversion = (conversion: JapaneseConversionResult) => {
        if (!requestsRef.current.valid(request.id)) {
          return;
        }

        if (conversion.session && (conversion.session.state !== "open" || conversion.session.locked)) return;

        if (conversion.suggestionRejected) {
          currentView?.dispatch({ effects: clearGhostSuggestion.of(request.id) });
          skipQueuedConversion(
            request,
            conversion.suggestionRejectedReason === "speculative"
              ? "適切な推測候補を作れなかったため、ローマ字を残しました。"
              : "候補を安全に適用できなかったため、履歴からのサジェストを表示しませんでした。",
          );
          return;
        }

        const converted = conversion.text;
        const latestView = editorViewRef.current;
        if (!latestView || !request.anchor || !resolved) {
          setHistory((items) =>
            prependConversionHistory(items, {
              id: request.id,
              status: "success",
              input: request.originalText,
              output: converted,
              reviewKana: conversion.reviewKana,
              modelName: settingsRef.current.modelName,
              createdAt: Date.now(),
              source: "history",
              anchor: request.anchor,
              conversionStrategy: conversion.conversionStrategy,
              changes: conversion.changes,
              session: conversion.session,
              inputCompletionLevel,
              inputCompletionApplied: conversion.inputCompletionApplied,
              inputCompletionSourceKana: conversion.inputCompletionSourceKana,
              documentVocabulary: request.documentVocabulary,
              documentVocabularyRevision: request.documentVocabularyRevision,
              retryOf: request.retryOf,
              avoidOutputs: request.avoidOutputs,
            }),
          );
          setStatus({
            kind: "success",
            message: conversion.inputCompletionApplied
              ? "入力補完で履歴から再変換しました。適用先がないため結果のみ保存しました。"
              : conversion.conversionStrategy === "completion"
                ? "誤字修正で履歴から再変換しました。適用先がないため結果のみ保存しました。"
                : "履歴から再変換しました。適用先がないため結果のみ保存しました。",
          });
          return;
        }

        const latestResolved = resolveConversionAnchor(latestView.state.doc.toString(), {
          ...request.anchor,
          from: resolved.from,
          to: resolved.to,
          originalText: resolved.matchedText,
        });
        if (!latestResolved || latestResolved.matchedText !== resolved.matchedText) {
          skipQueuedConversion(
            request,
            "適用前に位置が変わったため、履歴からの変換を適用しませんでした。",
          );
          return;
        }

        if (
          conversion.session?.rerankStatus === "pending" ||
          settingsRef.current.conversionMode === "ghost" ||
          requiresExplicitAcceptance(conversion) ||
          inputCompletionLevel !== "none" ||
          conversion.inputCompletionApplied ||
          conversion.conversionStrategy === "speculative" ||
          isPredictiveSuggestionTrigger(request.range?.trigger)
        ) {
          if (!requestsRef.current.display(request.id)) return;
          latestView.dispatch({
            effects: showGhostSuggestion.of({
              id: request.id,
              from: latestResolved.from,
              to: latestResolved.to,
              originalText: latestResolved.matchedText,
              convertedText: converted,
              inputText: request.originalText,
              reviewKana: conversion.reviewKana,
              conversionStrategy: conversion.conversionStrategy,
              changes: conversion.changes,
              session: conversion.session,
              inputCompletionLevel,
              inputCompletionApplied: conversion.inputCompletionApplied,
              inputCompletionSourceKana: conversion.inputCompletionSourceKana,
              inputCompletionAdditions: conversion.inputCompletionAdditions,
              trigger: request.range?.trigger,
              documentVocabulary: request.documentVocabulary,
              documentVocabularyRevision: request.documentVocabularyRevision,
              source: "history",
              retryOf: request.retryOf,
              avoidOutputs: request.avoidOutputs,
            }),
          });
          latestView.focus();
          setStatus({
            kind: "success",
            message: conversion.conversionStrategy === "speculative"
              ? "履歴から推測候補を生成しました。Tab で適用、Esc で破棄できます。"
              : inputCompletionLevel !== "none"
                ? "履歴からサジェストを生成しました。Tab で適用、Esc で破棄できます。"
                : conversion.conversionStrategy === "completion"
                  ? "履歴から誤字修正候補を生成しました。Tab で適用、Ctrl/Cmd+/ で別候補を試せます。"
                  : "履歴から変換候補を生成しました。Tab で適用、Ctrl/Cmd+/ で別候補を試せます。",
          });
          return;
        }

        latestView.dispatch({
          changes: {
            from: latestResolved.from,
            to: latestResolved.to,
            insert: converted,
          },
          userEvent: "input.historyApply",
        });
        if (conversion.session) conversion.session.state = "accepted";
        saveCurrentDocumentSession(latestView.state.doc.toString());

        const nextAnchor: ConversionAnchor = {
          from: latestResolved.from,
          to: latestResolved.from + converted.length,
          originalText: request.originalText,
          appliedText: converted,
          docVersion: docVersionRef.current,
      };

      const historyItem: ConversionHistoryItem = {
        id: request.id,
        status: "success",
        input: request.originalText,
        output: converted,
        reviewKana: conversion.reviewKana,
        modelName: settingsRef.current.modelName,
        createdAt: Date.now(),
        source: "history",
        anchor: nextAnchor,
        conversionStrategy: conversion.conversionStrategy,
        changes: conversion.changes,
        session: conversion.session,
        inputCompletionLevel,
        inputCompletionApplied: conversion.inputCompletionApplied,
        inputCompletionSourceKana: conversion.inputCompletionSourceKana,
        documentVocabulary: request.documentVocabulary,
        documentVocabularyRevision: request.documentVocabularyRevision,
        retryOf: request.retryOf,
        avoidOutputs: request.avoidOutputs,
      };

      setHistory((items) => prependConversionHistory(items, historyItem));
      setRecentRetryItem(historyItem);
      setStatus({
        kind: "success",
        message: conversion.inputCompletionApplied
          ? "入力補完で履歴の変換を適用しました。"
          : conversion.conversionStrategy === "completion"
            ? "誤字修正で履歴の変換を適用しました。Ctrl/Cmd+/ で別候補を試せます。"
            : latestResolved.matchedBy === "nearby"
              ? "近くの一致位置に履歴の変換を適用しました。Ctrl/Cmd+/ で別候補を試せます。"
              : "履歴の変換を適用しました。Ctrl/Cmd+/ で別候補を試せます。",
      });
      };
      const conversion = await convertRomajiToJapaneseDetailed(
        request.originalText,
        { ...settingsRef.current, inputCompletionLevel },
        undefined,
        {
          kanaEngine: settingsRef.current.conversionEngine === "llm" ? undefined : defaultKanaEngine,
          signal: requestsRef.current.get(request.id)?.controller.signal,
          anchor: request.anchor,
          deferRanking: deferRanking(request.id, request),
          onRankedCandidates: applyConversion,
          onRescueStart: () => {
            if (requestsRef.current.valid(request.id)) editorViewRef.current?.dispatch({ effects: clearGhostSuggestion.of(request.id) });
          },
          contextBefore: resolved && currentView ? currentView.state.doc.sliceString(Math.max(0, resolved.from - 1200), resolved.from) : "",
          contextAfter: resolved && currentView ? currentView.state.doc.sliceString(resolved.to, Math.min(currentView.state.doc.length, resolved.to + 600)) : "",
          avoidOutputs: request.avoidOutputs,
          alternativeReading: request.alternativeReading,
          alternativeCorrectedReading: request.alternativeCorrectedReading,
          alternativeAdditionKind: request.alternativeAdditionKind,
          documentVocabulary: request.documentVocabulary,
          protectedDictionaryEntries: resolved
            ? buildProtectedDictionaryEntries(
              request.originalText,
              resolved.matchedText,
              settingsRef.current.userDictionary,
            )
            : [],
        },
      );
      applyConversion(conversion);
    },
    [saveCurrentDocumentSession, skipQueuedConversion],
  );

  const processConversionQueue = useCallback(async () => {
    if (processingQueueRef.current) {
      return;
    }

    processingQueueRef.current = true;
    try {
      while (conversionQueueRef.current.length > 0) {
        const request = conversionQueueRef.current[0];
        if (!requestsRef.current.valid(request.id)) {
          requestsRef.current.finish(request.id);
          editorViewRef.current?.dispatch({ effects: removeLoadingDecoration.of(request.id) });
          canceledRequestsRef.current.delete(request.id);
          conversionQueueRef.current = conversionQueueRef.current.slice(1);
          syncPending();
          continue;
        }

        request.status = "running";
        runningRequestIdRef.current = request.id;
        syncPending();
        setStatus({
          kind: "loading",
          message:
            request.retryOf
              ? `"${request.originalText}" の別候補を試しています`
              : request.source === "history"
                ? `"${request.originalText}" を再変換しています`
                : `"${request.originalText}" を変換しています`,
        });

        try {
          if (request.source === "history") {
            await processHistoryConversion(request);
          } else {
            await processEditorConversion(request);
          }
        } catch (error: unknown) {
          if (requestsRef.current.valid(request.id)) {
            const message = formatConversionError(error);
            setHistory((items) =>
              prependConversionHistory(items, {
                id: request.id,
                status: "error",
                input: request.originalText,
                error: message,
                modelName: settingsRef.current.modelName,
                createdAt: Date.now(),
                source: request.source,
                anchor: request.anchor,
                retryOf: request.retryOf,
                avoidOutputs: request.avoidOutputs,
                inputCompletionLevel:
                  request.inputCompletionLevel ?? settingsRef.current.inputCompletionLevel,
                documentVocabulary: request.documentVocabulary,
                documentVocabularyRevision: request.documentVocabularyRevision,
              }),
            );
            setStatus({ kind: "error", message });
          }
        } finally {
          if (!rankingRequestsRef.current.has(request.id)) requestsRef.current.finish(request.id);
          canceledRequestsRef.current.delete(request.id);
          runningRequestIdRef.current = null;
          const currentView = editorViewRef.current;
          if (currentView) {
            currentView.dispatch({ effects: removeLoadingDecoration.of(request.id) });
          }
          conversionQueueRef.current = conversionQueueRef.current.filter(
            (item) => item.id !== request.id,
          );
          syncPending();
        }
      }
    } finally {
      processingQueueRef.current = false;
      runningRequestIdRef.current = null;
    }
  }, [processEditorConversion, processHistoryConversion]);

  const enqueueConversion = useCallback(
    (request: PendingConversion) => {
      if (
        request.source === "history" &&
        hasDuplicatePendingHistoryConversion(conversionQueueRef.current, request)
      ) {
        setStatus({ kind: "warning", message: "同じ再変換はすでに処理待ちです。" });
        return false;
      }

      setRecentRetryItem(null);
      requestsRef.current.refresh(editorViewRef.current?.state.doc.toString() ?? "");
      requestsRef.current.register(request.id, request.anchor);
      const current = editorViewRef.current;
      const visible = current?.state.field(ghostSuggestionField).suggestion;
      if (visible && request.anchor && rangesOverlap(visible, request.anchor)) {
        if (visible.session) visible.session.state = "dismissed";
        current?.dispatch({ effects: clearGhostSuggestion.of(visible.id) });
      }
      conversionQueueRef.current = [...conversionQueueRef.current, request];
      syncPending();
      if (processingQueueRef.current) {
        setStatus({ kind: "loading", message: `"${request.originalText}" をキューに追加しました` });
      }
      void processConversionQueue();
      return true;
    },
    [processConversionQueue],
  );

  const cancelConversion = useCallback(
    (request: PendingConversion) => {
      requestsRef.current.cancel(request.id);
      canceledRequestsRef.current.add(request.id);
      const isRunning = runningRequestIdRef.current === request.id || rankingRequestsRef.current.has(request.id);
      if (!isRunning) {
        requestsRef.current.finish(request.id);
        conversionQueueRef.current = conversionQueueRef.current.filter(
          (item) => item.id !== request.id,
        );
        canceledRequestsRef.current.delete(request.id);
      }
      setPending((items) => items.filter((item) => item.id !== request.id));
      recordCanceledConversion(request);

      const view = editorViewRef.current;
      if (view) {
        const suggestion = view.state.field(ghostSuggestionField).suggestion;
        if (suggestion?.id === request.id && suggestion.session) {
          suggestion.session.state = "dismissed";
        }
        view.dispatch({ effects: [removeLoadingDecoration.of(request.id), clearGhostSuggestion.of(request.id)] });
      }
    },
    [recordCanceledConversion],
  );

  const handleAcceptGhost = useCallback((suggestion: GhostConversionSuggestion) => {
    requestsRef.current.cancel(suggestion.id);
    syncPending();
    if (suggestion.session) {
      suggestion.session.state = "accepted";
      suggestion.session.locked = true;
      const selected = suggestion.session.candidates.find(c => c.id === suggestion.session!.selectedId);
      if (selected?.kind === "conversion" && selected.result.changes?.readingAssessment?.status === "verified") {
        recordConversionChoice(selected.result.reviewKana, selected.result.text);
      }
    }
    invalidatePredictiveSuggestions(false);
    const view = editorViewRef.current;
    const nextAnchor: ConversionAnchor = {
      from: suggestion.from,
      to: suggestion.from + suggestion.convertedText.length,
      originalText: suggestion.inputText,
      appliedText: suggestion.convertedText,
      docVersion: docVersionRef.current,
    };

    if (view) {
      saveCurrentDocumentSession(view.state.doc.toString());
    }

    const historyItem: ConversionHistoryItem = {
      id: suggestion.id,
      status: "success",
      input: suggestion.inputText,
      output: suggestion.convertedText,
      reviewKana: suggestion.reviewKana,
      modelName: settingsRef.current.modelName,
      createdAt: Date.now(),
      source: suggestion.source,
      anchor: nextAnchor,
      conversionStrategy: suggestion.conversionStrategy,
      changes: suggestion.changes,
      session: suggestion.session,
      inputCompletionLevel: suggestion.inputCompletionLevel,
      inputCompletionApplied: suggestion.inputCompletionApplied,
      inputCompletionSourceKana: suggestion.inputCompletionSourceKana,
      documentVocabulary: suggestion.documentVocabulary,
      documentVocabularyRevision: suggestion.documentVocabularyRevision,
      retryOf: suggestion.retryOf,
      avoidOutputs: suggestion.avoidOutputs,
    };

    setHistory((items) =>
      upsertConversionHistory(items, historyItem),
    );
    setRecentRetryItem(historyItem);
    setStatus({
      kind: "success",
      message: suggestion.conversionStrategy === "speculative"
        ? "推測候補を確定しました。Ctrl/Cmd+/ で別候補を試せます。"
        : suggestion.inputCompletionApplied
          ? "入力補完候補を確定しました。"
          : suggestion.conversionStrategy === "completion"
            ? "誤字修正候補を確定しました。Ctrl/Cmd+/ で別候補を試せます。"
            : "変換候補を確定しました。Ctrl/Cmd+/ で別候補を試せます。",
    });
  }, [invalidatePredictiveSuggestions, saveCurrentDocumentSession]);

  const handleDismissGhost = useCallback((suggestion?: GhostConversionSuggestion) => {
    if (suggestion) requestsRef.current.cancel(suggestion.id);
    syncPending();
    const session = suggestion?.session ?? editorViewRef.current?.state.field(ghostSuggestionField).suggestion?.session;
    if (session) session.state = "dismissed";
    invalidatePredictiveSuggestions(false);
    setStatus({
      kind: "idle",
      message: "候補を破棄しました。入力を止めると新しい候補を生成します。",
    });
  }, [invalidatePredictiveSuggestions]);

  const handleRetryGhost = useCallback(
    (suggestion: GhostConversionSuggestion) => {
      invalidatePredictiveSuggestions(false);
      const view = editorViewRef.current;
      if (!view) {
        return;
      }

      const currentText = view.state.doc.sliceString(suggestion.from, suggestion.to);
      if (currentText !== suggestion.originalText) {
        view.dispatch({ effects: clearGhostSuggestion.of(suggestion.id) });
        setStatus({
          kind: "warning",
          message: "元のテキストが変わったため、Ghost suggestion を閉じました。",
        });
        return;
      }

      if (suggestion.session) {
        const next = nextSessionCandidate(suggestion.session);
        if (next) {
          view.dispatch({ effects: showGhostSuggestion.of({ ...suggestion, convertedText: next.text,
            reviewKana: next.reviewKana, changes: next.changes, session: next.session,
            inputCompletionApplied: next.inputCompletionApplied, inputCompletionSourceKana: next.inputCompletionSourceKana,
            inputCompletionAdditions: next.inputCompletionAdditions }) });
          setStatus({ kind: "success", message: "保持している別候補を表示しました。Tabで確定できます。" });
          return;
        }
      }

      const request: PendingConversion = {
        id: createId("conversion"),
        range: suggestion.trigger
          ? {
            from: suggestion.from,
            to: suggestion.to,
            text: suggestion.originalText,
            trigger: suggestion.trigger,
          }
          : undefined,
        anchor: {
          from: suggestion.from,
          to: suggestion.to,
          originalText: suggestion.originalText,
          docVersion: docVersionRef.current,
        },
        originalText: suggestion.inputText,
        createdAt: Date.now(),
        docVersion: docVersionRef.current,
        source: suggestion.source,
        status: "queued",
        retryOf: suggestion.retryOf ?? suggestion.id,
        avoidOutputs: collectAvoidOutputs(suggestion.avoidOutputs, suggestion.convertedText),
        alternativeReading: suggestion.changes?.resultReading ?? suggestion.reviewKana,
        alternativeCorrectedReading: suggestion.changes?.correctedReading,
        alternativeAdditionKind: suggestion.changes?.additionKind,
        inputCompletionLevel:
          suggestion.inputCompletionLevel ?? settingsRef.current.inputCompletionLevel,
        documentVocabulary: suggestion.documentVocabulary,
        documentVocabularyRevision: suggestion.documentVocabularyRevision,
      };

      view.dispatch({
        effects: [
          clearGhostSuggestion.of(suggestion.id),
          addLoadingDecoration.of({
            id: request.id,
            from: suggestion.from,
            to: suggestion.to,
          }),
        ],
      });

      enqueueConversion(request);
    },
    [enqueueConversion, invalidatePredictiveSuggestions],
  );

  const previewHistoryGhost = useCallback((item: ConversionHistoryItem) => {
    if (!item.output || !item.anchor) {
      return;
    }

    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    const activeSuggestion = view.state.field(ghostSuggestionField).suggestion;
    if (activeSuggestion && !activeSuggestion.id.startsWith("history-preview-")) {
      return;
    }

    const resolved = resolveConversionAnchor(view.state.doc.toString(), item.anchor);
    if (!resolved) {
      return;
    }

    view.dispatch({
      effects: showGhostSuggestion.of({
        id: `history-preview-${item.id}`,
        from: resolved.from,
        to: resolved.to,
        originalText: resolved.matchedText,
        convertedText: item.output,
        inputText: item.input,
        reviewKana: item.reviewKana,
        conversionStrategy: item.conversionStrategy,
        changes: item.changes,
        inputCompletionLevel: item.inputCompletionLevel,
        inputCompletionApplied: item.inputCompletionApplied,
        inputCompletionSourceKana: item.inputCompletionSourceKana,
        documentVocabulary: item.documentVocabulary,
        documentVocabularyRevision: item.documentVocabularyRevision,
        source: "history",
        retryOf: item.retryOf,
        avoidOutputs: item.avoidOutputs,
        previewOnly: resolved.matchedText === item.output,
      }),
    });
  }, []);

  const clearHistoryGhost = useCallback((item: ConversionHistoryItem) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    view.dispatch({ effects: clearGhostSuggestion.of(`history-preview-${item.id}`) });
  }, []);

  const handleRerunHistory = useCallback((item: ConversionHistoryItem) => {
    const request: PendingConversion = {
      id: createId("conversion"),
      anchor: item.anchor,
      originalText: item.input,
      createdAt: Date.now(),
      source: "history",
      status: "queued",
      inputCompletionLevel: item.inputCompletionLevel,
      documentVocabulary: item.documentVocabulary,
      documentVocabularyRevision: item.documentVocabularyRevision,
    };

    return enqueueConversion(request);
  }, [enqueueConversion]);

  const handleAlternativeHistory = useCallback((item: ConversionHistoryItem) => {
    const view = editorViewRef.current;
    const resolved = item.anchor && view ? resolveConversionAnchor(view.state.doc.toString(), item.anchor) : null;
    if (item.session && item.session.candidates.length > 1 && view && resolved) {
      const session = { ...item.session, state: "open" as const, locked: true };
      const next = nextSessionCandidate(session) ?? sessionResult(session);
      view.dispatch({ effects: showGhostSuggestion.of({ id: createId("conversion"), from: resolved.from, to: resolved.to,
        originalText: resolved.matchedText, convertedText: next.text, inputText: item.input, reviewKana: next.reviewKana,
        changes: next.changes, session, source: "history", retryOf: item.id, inputCompletionLevel: item.inputCompletionLevel }) });
      return true;
    }
    const request: PendingConversion = {
      id: createId("conversion"),
      anchor: item.anchor,
      originalText: item.input,
      createdAt: Date.now(),
      source: "history",
      status: "queued",
      retryOf: item.id,
      avoidOutputs: collectAvoidOutputs(item.avoidOutputs, item.output),
      alternativeReading: item.changes?.resultReading ?? item.reviewKana,
      alternativeCorrectedReading: item.changes?.correctedReading,
      alternativeAdditionKind: item.changes?.additionKind,
      inputCompletionLevel: item.inputCompletionLevel,
      documentVocabulary: item.documentVocabulary,
      documentVocabularyRevision: item.documentVocabularyRevision,
    };

    return enqueueConversion(request);
  }, [enqueueConversion]);

  const dismissRecentRetryChip = useCallback(() => {
    setRecentRetryItem(null);
  }, []);

  const retryRecentConversion = useCallback(() => {
    if (!recentRetryItem) {
      return false;
    }

    return handleAlternativeHistory(recentRetryItem);
  }, [handleAlternativeHistory, recentRetryItem]);

  useEffect(() => {
    if (!recentRetryItem) {
      return;
    }

    const timer = window.setTimeout(() => {
      setRecentRetryItem((current) =>
        current?.id === recentRetryItem.id ? null : current,
      );
    }, RECENT_RETRY_CHIP_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [recentRetryItem]);

  useEffect(() => {
    if (
      !recentRetryItem ||
      activePanel ||
      !setupComplete
    ) {
      return;
    }

    const retryOnShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        (!event.ctrlKey && !event.metaKey) ||
        event.key !== "/"
      ) {
        return;
      }

      event.preventDefault();
      retryRecentConversion();
    };

    document.addEventListener("keydown", retryOnShortcut);
    return () => document.removeEventListener("keydown", retryOnShortcut);
  }, [
    activePanel,
    recentRetryItem,
    retryRecentConversion,
    setupComplete,
  ]);

  const processPredictiveSuggestionRequest = useCallback(
    async (request: PredictiveSuggestionRequest) => {
      try {
        const applyConversion = (conversion: JapaneseConversionResult) => {
          if (conversion.session && (conversion.session.state !== "open" || conversion.session.locked)) return;
          if (
            request.epoch !== predictiveSuggestionEpochRef.current ||
            request.revision < displayedSuggestionRevisionRef.current ||
            !requestsRef.current.valid(request.id)
          ) {
            return;
          }

          const currentView = editorViewRef.current;
          const currentSource = currentView?.state.doc.sliceString(
            request.range.from,
            request.range.to,
          );
          if (!currentView || currentSource !== request.range.text) {
            return;
          }
          if (!requestsRef.current.display(request.id)) return;

          if (conversion.suggestionRejected) {
            displayedSuggestionRevisionRef.current = request.revision;
            currentView.dispatch({ effects: clearGhostSuggestion.of(null) });
            setStatus({
              kind: "warning",
              message: conversion.suggestionRejectedReason === "speculative"
                ? "適切な推測候補を作れなかったため、ローマ字を残しました。入力を続けると再生成します。"
                : "候補を安全に適用できなかったため表示しませんでした。入力を続けると再生成します。",
            });
            return;
          }

          displayedSuggestionRevisionRef.current = request.revision;
          currentView.dispatch({
            effects: showGhostSuggestion.of({
              id: request.id,
              from: request.range.from,
              to: request.range.to,
              originalText: request.range.text,
              convertedText: conversion.text,
              inputText: request.range.text,
              reviewKana: conversion.reviewKana,
              conversionStrategy: conversion.conversionStrategy,
              changes: conversion.changes,
              session: conversion.session,
              inputCompletionLevel: request.settings.inputCompletionLevel,
              inputCompletionApplied: conversion.inputCompletionApplied,
              inputCompletionSourceKana: conversion.inputCompletionSourceKana,
              inputCompletionAdditions: conversion.inputCompletionAdditions,
              trigger: request.range.trigger,
              documentVocabulary: request.documentVocabulary,
              documentVocabularyRevision: request.documentVocabularyRevision,
              source: "editor",
            }),
          });
          setStatus({
            kind: predictiveSuggestionQueueRef.current ? "loading" : "success",
            message: conversion.conversionStrategy === "speculative"
              ? "推測候補を表示しました。Tab で確定、Esc で破棄できます。"
              : conversion.inputCompletionAdditions?.length
                ? `補完差分 ${conversion.inputCompletionAdditions.map((text) => `+「${text}」`).join(" ")}。Tab で確定できます。`
                : predictiveSuggestionQueueRef.current
                  ? "候補を表示しました。より新しい入力の候補を更新しています。"
                  : "変換候補を表示しました。Tab で確定、Esc で破棄できます。",
          });
        };
        const conversion = await convertRomajiToJapaneseDetailed(
          request.range.text,
          request.settings,
          undefined,
          { documentVocabulary: request.documentVocabulary, kanaEngine: request.settings.conversionEngine === "llm" ? undefined : defaultKanaEngine,
            signal: requestsRef.current.get(request.id)?.controller.signal,
            deferRanking: deferRanking(request.id),
            onLocalCandidates: applyConversion,
            onRankedCandidates: applyConversion,
            onRescueStart: () => {
              if (requestsRef.current.valid(request.id)) editorViewRef.current?.dispatch({ effects: clearGhostSuggestion.of(request.id) });
            },
            contextBefore: editorViewRef.current?.state.doc.sliceString(Math.max(0, request.range.from - 1200), request.range.from),
            contextAfter: editorViewRef.current?.state.doc.sliceString(request.range.to, Math.min(editorViewRef.current.state.doc.length, request.range.to + 600)),
          },
        );
        applyConversion(conversion);
      } catch (error: unknown) {
        if (request.epoch === predictiveSuggestionEpochRef.current && requestsRef.current.valid(request.id)) {
          setStatus({ kind: "error", message: formatConversionError(error) });
        }
      } finally {
        if (!rankingRequestsRef.current.has(request.id)) requestsRef.current.finish(request.id);
      }
    },
    [],
  );

  const processPredictiveSuggestionQueue = useCallback(async () => {
    if (processingPredictiveSuggestionRef.current) {
      return;
    }

    processingPredictiveSuggestionRef.current = true;
    try {
      while (predictiveSuggestionQueueRef.current) {
        const request = predictiveSuggestionQueueRef.current;
        predictiveSuggestionQueueRef.current = null;
        setStatus({
          kind: "loading",
          message: `「${request.range.text.trim()}」の候補を生成しています`,
        });
        await processPredictiveSuggestionRequest(request);
      }
    } finally {
      processingPredictiveSuggestionRef.current = false;
    }
  }, [processPredictiveSuggestionRequest]);

  const enqueuePredictiveSuggestion = useCallback(
    (range: ConversionRange) => {
      const view = editorViewRef.current;
      if (!view) {
        return false;
      }

      const visible = view.state.field(ghostSuggestionField).suggestion;
      if (visible && rangesOverlap(visible, range) &&
          (visible.session?.locked || (visible.trigger && !isPredictiveSuggestionTrigger(visible.trigger)))) return false;
      const id = createId("suggestion");
      requestsRef.current.refresh(view.state.doc.toString());
      if (!requestsRef.current.register(id, { ...range, originalText: range.text }, true)) return false;
      if (predictiveSuggestionQueueRef.current) requestsRef.current.finish(predictiveSuggestionQueueRef.current.id);

      const settingsSnapshot: AppSettings = {
        ...settingsRef.current,
        triggers: { ...settingsRef.current.triggers },
        punctuationConversion: { ...settingsRef.current.punctuationConversion },
        userDictionary: [...settingsRef.current.userDictionary],
      };
      const vocabularyProfile = settingsSnapshot.useDocumentVocabulary
        ? buildDocumentVocabularyProfile(view.state.doc.toString())
        : null;
      predictiveSuggestionRevisionRef.current += 1;
      predictiveSuggestionQueueRef.current = {
        id,
        revision: predictiveSuggestionRevisionRef.current,
        epoch: predictiveSuggestionEpochRef.current,
        range,
        settings: settingsSnapshot,
        documentVocabulary: vocabularyProfile?.terms,
        documentVocabularyRevision: vocabularyProfile?.revision,
      };
      void processPredictiveSuggestionQueue();
      return true;
    },
    [processPredictiveSuggestionQueue],
  );

  const handleConvert = useCallback((range: ConversionRange) => {
    const view = editorViewRef.current;
    if (!view) {
      return false;
    }

    if (isPredictiveSuggestionTrigger(range.trigger)) {
      return enqueuePredictiveSuggestion(range);
    }

    if (hasMatchingPendingEditorConversion(conversionQueueRef.current.filter(request => requestsRef.current.valid(request.id)), range)) {
      return false;
    }

    const vocabularyProfile = settingsRef.current.useDocumentVocabulary
      ? buildDocumentVocabularyProfile(view.state.doc.toString())
      : null;
    const request: PendingConversion = {
      id: createId("conversion"),
      range,
      anchor: {
        from: range.from,
        to: range.to,
        originalText: range.text,
        docVersion: docVersionRef.current,
      },
      originalText: range.text,
      createdAt: Date.now(),
      docVersion: docVersionRef.current,
      source: "editor",
      status: "queued",
      inputCompletionLevel: settingsRef.current.inputCompletionLevel,
      documentVocabulary: vocabularyProfile?.terms.length
        ? [...vocabularyProfile.terms]
        : undefined,
      documentVocabularyRevision: vocabularyProfile?.terms.length
        ? vocabularyProfile.revision
        : undefined,
    };

    view.dispatch({
      effects: addLoadingDecoration.of({
        id: request.id,
        from: range.from,
        to: range.to,
      }),
    });

    enqueueConversion(request);
    return true;
  }, [enqueueConversion, enqueuePredictiveSuggestion]);

  const delayedPending = pending.filter((request) => now - request.createdAt >= CANCEL_UI_DELAY_MS);

  useEffect(() => () => {
    requestsRef.current.clear();
    rankingQueueRef.current.clear();
    predictiveSuggestionEpochRef.current += 1;
    predictiveSuggestionQueueRef.current = null;
  }, []);

  return {
    invalidatePredictiveSuggestions,
    clearPendingConversions,
    pending,
    handleConvert,
    handleAcceptGhost,
    handleDismissGhost,
    handleRetryGhost,
    retryRecentConversion,
    history,
    recentRetryItem,
    dismissRecentRetryChip,
    delayedPending,
    cancelConversion,
    handleRerunHistory,
    handleAlternativeHistory,
    previewHistoryGhost,
    clearHistoryGhost,
  };
}
