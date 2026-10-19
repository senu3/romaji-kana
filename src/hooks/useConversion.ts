import { candidateDetails, isOpenConversionResult } from "../lib/conversionCandidate";
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
import { recordConversionChoice } from "../lib/conversionLearning";
import { ConversionRequests, rangesOverlap } from "../lib/conversionRequests";
import { createConversionSession, type ConversionSession } from "../lib/conversionSession";
import { buildDocumentVocabularyProfile } from "../lib/documentVocabulary";
import { resolveConversionAnchor } from "../lib/historyAnchor";
import { createId } from "../lib/id";
import type { JapaneseConversionResult } from "../lib/japaneseConversionTypes";
import { defaultKanaEngine } from "../lib/kanaEngine";
import { buildProtectedDictionaryEntries, convertRomajiToJapaneseDetailed } from "../lib/ollama";
import { RankingQueue } from "../lib/rankingQueue";
import { requiresExplicitAcceptance } from "../lib/readingAssessment";
import { normalizeReading } from "../lib/readingComparison";
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

interface CandidateListTarget {
  item: ConversionHistoryItem;
  ghost?: GhostConversionSuggestion;
  session: ConversionSession;
  anchor: ConversionAnchor;
  documentText: string;
  docVersion: number;
}

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
    request.userRequestedSpeculation === next.userRequestedSpeculation &&
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
  const [candidateList, setCandidateList] = useState<CandidateListTarget | null>(null);
  const closeCandidateList = useCallback(() => setCandidateList(null), []);

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
    setCandidateList(null);
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
        conversionStrategy: request.userRequestedSpeculation ? "speculative" : undefined,
        input: request.originalText,
        error: "ユーザーがキャンセルしました。",
        modelName: settingsRef.current.modelName,
        createdAt: Date.now(),
        source: request.source,
        anchor: request.anchor,
        retryOf: request.retryOf,
        avoidOutputs: request.avoidOutputs,

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
        conversionStrategy: request.userRequestedSpeculation ? "speculative" : undefined,
        input: request.originalText,
        error: message,
        modelName: settingsRef.current.modelName,
        createdAt: Date.now(),
        source: request.source,
        anchor: request.anchor,
        retryOf: request.retryOf,
        avoidOutputs: request.avoidOutputs,

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

      const applyConversion = (conversion: JapaneseConversionResult) => {
        if (!requestsRef.current.valid(request.id)) {
          return;
        }
        if (!isOpenConversionResult(conversion)) return;

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
          conversion.conversionStrategy === "speculative" ||
          isPredictiveSuggestionTrigger(request.range?.trigger)
        ) {
          if (!requestsRef.current.display(request.id)) return;
          currentView.dispatch({
            effects: [
              removeLoadingDecoration.of(request.id),
              showGhostSuggestion.of({
                ...candidateDetails(conversion),
                id: request.id,
                from: latestResolved.from,
                to: latestResolved.to,
                originalText: latestResolved.matchedText,
                inputText: request.originalText,
                trigger: request.range?.trigger,
                documentVocabulary: request.documentVocabulary,
                documentVocabularyRevision: request.documentVocabularyRevision,
                source: "editor",
                retryOf: request.retryOf,
                avoidOutputs: request.avoidOutputs
              }),
            ],
          });
          setStatus({
            kind: "success",
            message: conversion.conversionStrategy === "speculative"
              ? "推測候補を表示しました。"
              : conversion.conversionStrategy === "correction"
                ? "誤字修正候補を表示しました。"
                : "変換候補を表示しました。",
          });
          return;
        }

        currentView.dispatch({
          changes: {
            from: latestResolved.from,
            to: latestResolved.to,
            insert: converted,
          },
          effects: [removeLoadingDecoration.of(request.id), clearGhostSuggestion.of(request.id)],
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

          documentVocabulary: request.documentVocabulary,
          documentVocabularyRevision: request.documentVocabularyRevision,
          retryOf: request.retryOf,
          avoidOutputs: request.avoidOutputs,
        };
        setHistory((items) => prependConversionHistory(items, historyItem));
        setRecentRetryItem(historyItem);
        setStatus({
          kind: "success",
          message: conversion.conversionStrategy === "correction"
            ? "誤字修正で変換しました。Ctrl/Cmd+/ で候補一覧を開けます。元に戻すとローマ字に戻ります。"
            : "変換しました。Ctrl/Cmd+/ で候補一覧を開けます。元に戻すとローマ字に戻ります。",
        });
      };
      const conversion = await convertRomajiToJapaneseDetailed(
        resolved.matchedText,
        { ...settingsRef.current, },
        undefined,
        {
          kanaEngine: defaultKanaEngine,
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
            current.dispatch({
              effects: showGhostSuggestion.of({
                ...candidateDetails(result),
                id: request.id,
                from: position.from,
                to: position.to,
                originalText: position.matchedText,
                inputText: request.originalText,
                trigger: request.range?.trigger,
                source: request.source,
                documentVocabulary: request.documentVocabulary
              })
            });
          },
          avoidOutputs: request.avoidOutputs,

          userRequestedSpeculation: request.userRequestedSpeculation,

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

      const applyConversion = (conversion: JapaneseConversionResult) => {
        if (!requestsRef.current.valid(request.id)) {
          return;
        }

        if (!isOpenConversionResult(conversion)) return;

        if (conversion.suggestionRejected) {
          currentView?.dispatch({ effects: clearGhostSuggestion.of(request.id) });
          skipQueuedConversion(
            request,
            request.userRequestedSpeculation
              ? "意図に合う推測候補を作れませんでした。本文は変更していません。"
              : conversion.suggestionRejectedReason === "speculative"
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

              documentVocabulary: request.documentVocabulary,
              documentVocabularyRevision: request.documentVocabularyRevision,
              retryOf: request.retryOf,
              avoidOutputs: request.avoidOutputs,
            }),
          );
          setStatus({
            kind: "success",
            message: conversion.conversionStrategy === "correction"
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
          conversion.conversionStrategy === "speculative" ||
          isPredictiveSuggestionTrigger(request.range?.trigger)
        ) {
          if (!requestsRef.current.display(request.id)) return;
          latestView.dispatch({
            effects: showGhostSuggestion.of({
              ...candidateDetails(conversion),
              id: request.id,
              from: latestResolved.from,
              to: latestResolved.to,
              originalText: latestResolved.matchedText,
              inputText: request.originalText,
              trigger: request.range?.trigger,
              documentVocabulary: request.documentVocabulary,
              documentVocabularyRevision: request.documentVocabularyRevision,
              source: "history",
              retryOf: request.retryOf,
              avoidOutputs: request.avoidOutputs
            }),
          });
          latestView.focus();
          setStatus({
            kind: "success",
            message: conversion.conversionStrategy === "speculative"
              ? "履歴から推測候補を表示しました。"
              : conversion.conversionStrategy === "correction"
                ? "履歴から誤字修正候補を表示しました。"
                : "履歴から変換候補を表示しました。",
          });
          return;
        }

        latestView.dispatch({
          changes: {
            from: latestResolved.from,
            to: latestResolved.to,
            insert: converted,
          },
          effects: clearGhostSuggestion.of(request.id),
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

          documentVocabulary: request.documentVocabulary,
          documentVocabularyRevision: request.documentVocabularyRevision,
          retryOf: request.retryOf,
          avoidOutputs: request.avoidOutputs,
        };

        setHistory((items) => prependConversionHistory(items, historyItem));
        setRecentRetryItem(historyItem);
        setStatus({
          kind: "success",
          message: conversion.conversionStrategy === "correction"
            ? "誤字修正で履歴の変換を適用しました。Ctrl/Cmd+/ で候補一覧を開けます。"
            : latestResolved.matchedBy === "nearby"
              ? "近くの一致位置に履歴の変換を適用しました。Ctrl/Cmd+/ で候補一覧を開けます。"
              : "履歴の変換を適用しました。Ctrl/Cmd+/ で候補一覧を開けます。",
        });
      };
      const conversion = await convertRomajiToJapaneseDetailed(
        request.originalText,
        { ...settingsRef.current, },
        undefined,
        {
          kanaEngine: defaultKanaEngine,
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

          userRequestedSpeculation: request.userRequestedSpeculation,

          documentVocabulary: request.documentVocabulary,
          // Unconverted romaji is the target, not a protected ASCII spelling.
          protectedDictionaryEntries: resolved && resolved.matchedText !== request.originalText
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
            request.userRequestedSpeculation
              ? `"${request.originalText}" の意図を推測し直しています`
              : request.retryOf
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
                conversionStrategy: request.userRequestedSpeculation ? "speculative" : undefined,
                input: request.originalText,
                error: message,
                modelName: settingsRef.current.modelName,
                createdAt: Date.now(),
                source: request.source,
                anchor: request.anchor,
                retryOf: request.retryOf,
                avoidOutputs: request.avoidOutputs,

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
      setCandidateList(null);
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
        ? "推測候補を確定しました。"
        : suggestion.conversionStrategy === "correction"
          ? "誤字修正候補を確定しました。"
          : "変換候補を確定しました。",
    });
  }, [invalidatePredictiveSuggestions, saveCurrentDocumentSession]);

  const handleDismissGhost = useCallback((suggestion?: GhostConversionSuggestion) => {
    suggestion ??= editorViewRef.current?.state.field(ghostSuggestionField).suggestion ?? undefined;
    if (suggestion) requestsRef.current.cancel(suggestion.id);
    syncPending();
    const session = suggestion?.session ?? editorViewRef.current?.state.field(ghostSuggestionField).suggestion?.session;
    if (session) session.state = "dismissed";
    if (suggestion) editorViewRef.current?.dispatch({ effects: clearGhostSuggestion.of(suggestion.id) });
    invalidatePredictiveSuggestions(false);
    setStatus({
      kind: "idle",
      message: "候補を閉じました。",
    });
  }, [invalidatePredictiveSuggestions]);

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

      documentVocabulary: item.documentVocabulary,
      documentVocabularyRevision: item.documentVocabularyRevision,
    };

    return enqueueConversion(request);
  }, [enqueueConversion]);

  const dismissRecentRetryChip = useCallback(() => {
    setRecentRetryItem(null);
  }, []);

  const openCandidateList = useCallback((item: ConversionHistoryItem, ghost?: GhostConversionSuggestion) => {
    const view = editorViewRef.current;
    const resolved = view && item.anchor && resolveConversionAnchor(view.state.doc.toString(), item.anchor);
    if (!view || !resolved || !item.output || ghost?.previewOnly) return false;
    if (ghost && view.state.field(ghostSuggestionField).suggestion?.id !== ghost.id) return false;
    invalidatePredictiveSuggestions(false);
    const reading = item.changes?.resultReading ?? item.reviewKana;
    const stored = item.session;
    // A visible list keeps its order even if an older ranking request finishes.
    if (stored) stored.locked = true;
    const seen = new Set<string>();
    const candidates = reading ? (stored?.candidates ?? []).filter(candidate => {
      const result = candidate.result;
      if (result.suggestionRejected || !result.text.trim() ||
        normalizeReading(result.changes?.resultReading ?? result.reviewKana) !== normalizeReading(reading) || seen.has(result.text)) return false;
      seen.add(result.text);
      return true;
    }) : [];
    if (!candidates.some(candidate => candidate.result.text === item.output)) candidates.unshift({
      id: "current",
      kind: "conversion", result: {
        text: item.output, reviewKana: reading ?? "", changes: item.changes,
        conversionStrategy: item.conversionStrategy
      }
    });
    const session = createConversionSession(item.input, candidates);
    session.selectedId = candidates.find(candidate => candidate.result.text === item.output)!.id;
    session.locked = true;
    setCandidateList({
      item, ghost, session, documentText: view.state.doc.toString(), docVersion: docVersionRef.current,
      anchor: { from: resolved.from, to: resolved.to, originalText: resolved.matchedText, docVersion: docVersionRef.current }
    });
    return true;
  }, [invalidatePredictiveSuggestions]);

  const openGhostCandidates = useCallback((ghost: GhostConversionSuggestion) => openCandidateList({
    id: ghost.id, input: ghost.inputText, output: ghost.convertedText, reviewKana: ghost.reviewKana, changes: ghost.changes,
    session: ghost.session, status: "success", source: ghost.source, createdAt: Date.now(), modelName: settingsRef.current.modelName,
    conversionStrategy: ghost.conversionStrategy,
    avoidOutputs: ghost.avoidOutputs, documentVocabulary: ghost.documentVocabulary,
    documentVocabularyRevision: ghost.documentVocabularyRevision,
    anchor: { from: ghost.from, to: ghost.to, originalText: ghost.originalText, docVersion: docVersionRef.current },
  }, ghost), [openCandidateList]);

  const retryRecentConversion = useCallback(() => {
    if (!recentRetryItem) {
      return false;
    }

    return openCandidateList(recentRetryItem);
  }, [openCandidateList, recentRetryItem]);

  const handleSpeculateHistory = useCallback((item: ConversionHistoryItem) => {
    const view = editorViewRef.current;
    const resolved = item.anchor && view ? resolveConversionAnchor(view.state.doc.toString(), item.anchor) : null;
    if (!view || !resolved || !item.output) {
      setStatus({ kind: "warning", message: "元の箇所を確認できないため、推測し直せません。" });
      return false;
    }
    const visible = view.state.field(ghostSuggestionField).suggestion;
    if (visible && rangesOverlap(visible, resolved)) requestsRef.current.cancel(visible.id);
    invalidatePredictiveSuggestions();
    return enqueueConversion({
      id: createId("conversion"), source: "history", status: "queued",
      originalText: item.input, createdAt: Date.now(), docVersion: docVersionRef.current,
      anchor: { ...item.anchor!, from: resolved.from, to: resolved.to, originalText: resolved.matchedText },
      retryOf: item.id, userRequestedSpeculation: true,
      avoidOutputs: collectAvoidOutputs(item.avoidOutputs, item.output),
      documentVocabulary: item.documentVocabulary, documentVocabularyRevision: item.documentVocabularyRevision
    });
  }, [enqueueConversion, invalidatePredictiveSuggestions]);

  const candidateListIsCurrent = useCallback(() => {
    const view = editorViewRef.current;
    if (!candidateList || !view || view.state.doc.toString() !== candidateList.documentText || docVersionRef.current !== candidateList.docVersion ||
      (candidateList.ghost && view.state.field(ghostSuggestionField).suggestion?.id !== candidateList.ghost.id)) {
      setCandidateList(null);
      setStatus({ kind: "warning", message: "本文や候補が変わったため、候補一覧を閉じました。" });
      return false;
    }
    return true;
  }, [candidateList]);

  const selectListedCandidate = useCallback((id: string) => {
    if (!candidateListIsCurrent() || !candidateList) return;
    const candidate = candidateList.session.candidates.find(candidate => candidate.id === id);
    if (!candidate) return;
    const { item, anchor, session, ghost } = candidateList;
    session.selectedId = id;
    const next = candidate.result;
    setCandidateList(null);
    editorViewRef.current!.dispatch({
      effects: showGhostSuggestion.of({
        ...candidateDetails(next), session,
        id: ghost?.id ?? createId("conversion"),
        from: anchor.from,
        to: anchor.to,
        originalText: anchor.originalText,
        inputText: item.input,
        source: ghost?.source ?? "history",
        retryOf: item.id,
        avoidOutputs: item.avoidOutputs,
        documentVocabulary: item.documentVocabulary,
        documentVocabularyRevision: item.documentVocabularyRevision
      })
    });
    editorViewRef.current!.focus();
    setStatus({ kind: "success", message: "選んだ候補を表示しました。" });
  }, [candidateList, candidateListIsCurrent]);

  const speculateFromCandidateList = useCallback(() => {
    if (!candidateListIsCurrent() || !candidateList) return;
    setCandidateList(null);
    handleSpeculateHistory(candidateList.item);
  }, [candidateList, candidateListIsCurrent, handleSpeculateHistory]);

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
      candidateList ||
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
    candidateList,
    recentRetryItem,
    retryRecentConversion,
    setupComplete,
  ]);

  const processPredictiveSuggestionRequest = useCallback(
    async (request: PredictiveSuggestionRequest) => {
      try {
        const applyConversion = (conversion: JapaneseConversionResult) => {
          if (!isOpenConversionResult(conversion)) return;
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
              ...candidateDetails(conversion),
              id: request.id,
              from: request.range.from,
              to: request.range.to,
              originalText: request.range.text,
              inputText: request.range.text,
              trigger: request.range.trigger,
              documentVocabulary: request.documentVocabulary,
              documentVocabularyRevision: request.documentVocabularyRevision,
              source: "editor"
            }),
          });
          setStatus({
            kind: predictiveSuggestionQueueRef.current ? "loading" : "success",
            message: conversion.conversionStrategy === "speculative"
              ? "推測候補を表示しました。"
              : conversion.changes?.additions?.length
                ? "読みを変更した候補を表示しました。"
                : predictiveSuggestionQueueRef.current
                  ? "候補を表示しました。より新しい入力の候補を更新しています。"
                  : "変換候補を表示しました。",
          });
        };
        const conversion = await convertRomajiToJapaneseDetailed(
          request.range.text,
          request.settings,
          undefined,
          {
            documentVocabulary: request.documentVocabulary, kanaEngine: defaultKanaEngine,
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
    candidateList,
    closeCandidateList,
    openCandidateList,
    openGhostCandidates,
    selectListedCandidate,
    speculateFromCandidateList,
    handleSpeculateHistory,
    retryRecentConversion,
    history,
    recentRetryItem,
    dismissRecentRetryChip,
    delayedPending,
    cancelConversion,
    handleRerunHistory,
    previewHistoryGhost,
    clearHistoryGhost,
  };
}
