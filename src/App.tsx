import type { EditorView } from "@codemirror/view";
import {
  AlertCircle,
  BookMarked,
  CheckCircle2,
  History,
  Loader2,
  MessageSquareText,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import {
  addLoadingDecoration,
  clearGhostSuggestion,
  MarkdownEditor,
  removeLoadingDecoration,
  showGhostSuggestion,
} from "./components/MarkdownEditor";
import { SettingsContent } from "./components/SettingsPanel";
import {
  loadDocumentSession,
  saveFileDocumentSession,
  saveNewDocumentSession,
} from "./lib/documentStore";
import { basename, openMarkdownFile, reopenMarkdownFile, saveMarkdownFile } from "./lib/fileSystem";
import { resolveConversionAnchor } from "./lib/historyAnchor";
import {
  buildProtectedDictionaryEntries,
  convertRomajiToJapaneseDetailed,
  providerLabel,
} from "./lib/ollama";
import { checkOllamaConnection, listLocalModels } from "./lib/ollamaConnection";
import { conversionPresetLabels, defaultConversionPrompt } from "./lib/prompts";
import { defaultSettings, loadSettings, saveSettings } from "./lib/settings";
import { appShortcutFromKeyboardEvent } from "./lib/shortcuts";
import type {
  AppSettings,
  ConversionAnchor,
  ConversionHistoryItem,
  ConversionPreset,
  ConversionRange,
  ConversionStatus,
  GhostConversionSuggestion,
  ModelProvider,
  OllamaConnectionStatus,
  OllamaModel,
  PendingConversion,
  UserDictionaryEntry,
} from "./lib/types";

type ActivePanel = "settings" | "history" | "dictionary" | "prompt" | null;
const CANCEL_UI_DELAY_MS = 1_200;
const AUTO_CONNECTION_CHECK_DELAY_MS = 550;
const RECENT_RETRY_CHIP_TIMEOUT_MS = 8_000;
const CONVERSION_PRESET_OPTIONS: ConversionPreset[] = ["none", "conversation", "businessEmail"];
const SETUP_COMPLETE_STORAGE_KEY = "romaji-kana-setup-complete";
const FORCE_SETUP_QUERY_PARAM = "setup";
const ENABLE_FIRST_RUN_SETUP_MODAL = true;
const MAX_USER_DICTIONARY_ENTRIES = 50;

function shouldForceSetupModalFromQuery(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const value = new URLSearchParams(window.location.search).get(FORCE_SETUP_QUERY_PARAM);
  return value === "1" || value === "true";
}

function shouldShowSetupModalOnStartup(): boolean {
  if (shouldForceSetupModalFromQuery()) {
    return true;
  }

  if (!ENABLE_FIRST_RUN_SETUP_MODAL) {
    return false;
  }

  return localStorage.getItem(SETUP_COMPLETE_STORAGE_KEY) !== "true";
}

function App() {
  const [initialSession] = useState(() => {
    if (typeof localStorage === "undefined") {
      return { kind: "new" as const, content: "" };
    }
    return loadDocumentSession();
  });
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof localStorage === "undefined") {
      return defaultSettings;
    }
    return loadSettings();
  });
  const [pending, setPending] = useState<PendingConversion[]>([]);
  const [history, setHistory] = useState<ConversionHistoryItem[]>([]);
  const [recentRetryItem, setRecentRetryItem] = useState<ConversionHistoryItem | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [now, setNow] = useState(() => Date.now());
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(
    initialSession.kind === "file" ? initialSession.path : null,
  );
  const [isDirty, setIsDirty] = useState(
    initialSession.kind === "new" && initialSession.content.length > 0,
  );
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaConnection, setOllamaConnection] = useState<OllamaConnectionStatus>({
    kind: "idle",
    message: "ローカルモデル Provider はまだ確認されていません。",
  });
  const [initialDocument] = useState(() =>
    initialSession.kind === "new" ? initialSession.content : "",
  );
  const [status, setStatus] = useState<ConversionStatus>({
    kind: "idle",
    message: "準備完了。romaji を入力して句読点で確定するか、Ctrl+Enter を押してください。",
  });
  const [editorReady, setEditorReady] = useState(false);
  const [setupComplete, setSetupComplete] = useState(() => {
    if (typeof localStorage === "undefined") {
      return true;
    }
    return !shouldShowSetupModalOnStartup();
  });
  const [setupModelProvider, setSetupModelProvider] = useState<ModelProvider | null>(() => null);
  const editorViewRef = useRef<EditorView | null>(null);
  const settingsRef = useRef(settings);
  const setupCompleteRef = useRef(setupComplete);
  const currentFilePathRef = useRef<string | null>(
    initialSession.kind === "file" ? initialSession.path : null,
  );
  const isDirtyRef = useRef(initialSession.kind === "new" && initialSession.content.length > 0);
  const initialFileRestoreStartedRef = useRef(false);
  const docVersionRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionCheckIdRef = useRef(0);
  const startupCheckStartedRef = useRef(false);
  const previousModelProviderRef = useRef(settings.modelProvider);
  const canceledRequestsRef = useRef(new Set<string>());
  const conversionQueueRef = useRef<PendingConversion[]>([]);
  const processingQueueRef = useRef(false);
  const runningRequestIdRef = useRef<string | null>(null);
  const suppressNextDirtyRef = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    setupCompleteRef.current = setupComplete;
  }, [setupComplete]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (pending.length === 0) {
      return;
    }

    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [pending.length]);

  useEffect(() => {
    if (!activePanel) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActivePanel(null);
      }
    };

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [activePanel]);

  const registerView = useCallback((view: EditorView | null) => {
    editorViewRef.current = view;
    setEditorReady(Boolean(view));
  }, []);

  const completeSetup = useCallback(() => {
    setSetupComplete(true);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SETUP_COMPLETE_STORAGE_KEY, "true");
    }
  }, []);

  const handleDocumentChanged = useCallback((documentText: string) => {
    docVersionRef.current += 1;
    if (suppressNextDirtyRef.current) {
      suppressNextDirtyRef.current = false;
    } else {
      isDirtyRef.current = true;
      setIsDirty(true);
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      const filePath = currentFilePathRef.current;
      if (filePath) {
        saveFileDocumentSession(filePath);
      } else {
        saveNewDocumentSession(documentText);
      }
      saveTimerRef.current = null;
    }, 250);
  }, []);

  const handleCheckOllama = useCallback(async () => {
    const checkId = connectionCheckIdRef.current + 1;
    connectionCheckIdRef.current = checkId;
    const modelName = settingsRef.current.modelName.trim() || "選択中のモデル";
    const label = providerLabel(settingsRef.current);

    setOllamaConnection({
      kind: "checking",
      message: `${label} を確認し、${modelName} を読み込んでいます...`,
    });
    setStatus({
      kind: "loading",
      message: `${label} を確認し、${modelName} を読み込んでいます...`,
    });

    try {
      const result = await checkOllamaConnection(settingsRef.current);
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      setOllamaModels(result.models);
      const currentModelName = settingsRef.current.modelName.trim();
      const shouldAutoSelectModel =
        setupCompleteRef.current &&
        Boolean(result.suggestedModelName) &&
        result.kind === "warning" &&
        (!currentModelName || currentModelName === defaultSettings.modelName);

      if (shouldAutoSelectModel) {
        setSettings((value) => ({
          ...value,
          modelName: result.suggestedModelName ?? value.modelName,
        }));
        setOllamaConnection({
          kind: "checking",
          message: `"${result.suggestedModelName}" を選択しました。モデルを確認しています...`,
        });
        setStatus({
          kind: "loading",
          message: `"${result.suggestedModelName}" を選択しました。モデルを確認しています...`,
        });
        return;
      }

      setOllamaConnection({
        kind: result.kind,
        message: result.message,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: result.kind === "connected" ? "success" : "warning",
        message: result.message,
      });
    } catch (error: unknown) {
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      const message = formatOllamaConnectionError(error, providerLabel(settingsRef.current));
      setOllamaModels([]);
      setOllamaConnection({
        kind: "error",
        message,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: "error",
        message,
      });
    }
  }, []);

  const handleSetupProviderSelected = useCallback(async (modelProvider: ModelProvider) => {
    if (setupCompleteRef.current) {
      return;
    }

    setSetupModelProvider(modelProvider);
    const checkId = connectionCheckIdRef.current + 1;
    connectionCheckIdRef.current = checkId;
    const nextSettings = { ...settingsRef.current, modelProvider };
    const label = providerLabel(nextSettings);

    setOllamaModels([]);
    setOllamaConnection({
      kind: "checking",
      message: `${label} のモデルを読み込んでいます...`,
    });
    setStatus({
      kind: "loading",
      message: `${label} のモデルを読み込んでいます...`,
    });

    try {
      const models = await listLocalModels(nextSettings);
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      setOllamaModels(models);
      setOllamaConnection({
        kind: models.length > 0 ? "warning" : "idle",
        message:
          models.length > 0
            ? `${label} のモデルを ${models.length} 件読み込みました。モデルを選んで Check してください。`
            : `${label} に接続しましたが、ローカルモデルが見つかりませんでした。`,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: models.length > 0 ? "warning" : "idle",
        message:
          models.length > 0
            ? "モデルを選択し、Check を実行するとセットアップが完了します。"
            : `${label} のモデルが見つかりませんでした。`,
      });
    } catch (error: unknown) {
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      const message = formatOllamaConnectionError(error, label);
      setOllamaModels([]);
      setOllamaConnection({
        kind: "error",
        message,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: "error",
        message,
      });
    }
  }, []);

  useEffect(() => {
    const providerChanged = previousModelProviderRef.current !== settings.modelProvider;
    previousModelProviderRef.current = settings.modelProvider;

    if (providerChanged) {
      setOllamaModels([]);
    }

    if (!setupComplete) {
      startupCheckStartedRef.current = false;
      if (setupModelProvider) {
        return;
      }

      setOllamaConnection({
        kind: "idle",
        message: "Provider を選択するとローカルモデル一覧を読み込みます。",
      });
      setStatus({
        kind: "idle",
        message: "Provider を選ぶとモデル一覧を読み込みます。入力は今すぐ可能です。",
      });
      return;
    }

    if (!startupCheckStartedRef.current && ollamaConnection.kind === "connected") {
      startupCheckStartedRef.current = true;
      return;
    }

    if (startupCheckStartedRef.current) {
      const timeout = window.setTimeout(
        () => void handleCheckOllama(),
        providerChanged ? 0 : AUTO_CONNECTION_CHECK_DELAY_MS,
      );
      return () => window.clearTimeout(timeout);
    }

    startupCheckStartedRef.current = true;
    void handleCheckOllama();
  }, [
    settings.modelProvider,
    settings.modelName,
    settings.ollamaApiUrl,
    settings.lmStudioApiUrl,
    setupComplete,
    setupModelProvider,
    handleCheckOllama,
  ]);

  const closeActivePanel = useCallback(() => {
    setActivePanel(null);
  }, []);

  const toggleHistoryPanel = useCallback(() => {
    setActivePanel((panel) => {
      if (panel === "history") {
        return null;
      }
      return "history";
    });
  }, []);

  const togglePromptPanel = useCallback(() => {
    setActivePanel((panel) => {
      return panel === "prompt" ? null : "prompt";
    });
  }, []);

  const toggleDictionaryPanel = useCallback(() => {
    setActivePanel((panel) => {
      return panel === "dictionary" ? null : "dictionary";
    });
  }, []);

  const toggleSettingsDrawer = useCallback(() => {
    setActivePanel((panel) => {
      return panel === "settings" ? null : "settings";
    });
  }, []);

  const openSettingsDrawer = useCallback(() => {
    setActivePanel("settings");
  }, []);

  const getEditorDocument = useCallback(() => {
    return editorViewRef.current?.state.doc.toString() ?? "";
  }, []);

  const clearPendingConversions = useCallback(() => {
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
  }, []);

  const replaceEditorDocument = useCallback((content: string) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    clearPendingConversions();
    suppressNextDirtyRef.current = true;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
      selection: { anchor: 0 },
      userEvent: "document.open",
    });
  }, [clearPendingConversions]);

  const markDocumentClean = useCallback(() => {
    isDirtyRef.current = false;
    setIsDirty(false);
  }, []);

  const confirmDiscardUnsavedChanges = useCallback(() => {
    if (!isDirtyRef.current) {
      return true;
    }

    return window.confirm("未保存の変更があります。破棄しますか？");
  }, []);

  const saveCurrentDocumentSession = useCallback((documentText: string) => {
    const filePath = currentFilePathRef.current;
    if (filePath) {
      saveFileDocumentSession(filePath);
      return;
    }

    saveNewDocumentSession(documentText);
  }, []);

  const handleNewFile = useCallback(() => {
    if (!confirmDiscardUnsavedChanges()) {
      return;
    }

    currentFilePathRef.current = null;
    replaceEditorDocument("");
    setCurrentFilePath(null);
    markDocumentClean();
    saveNewDocumentSession("");
    setStatus({ kind: "success", message: "新しいファイルを作成しました。" });
  }, [confirmDiscardUnsavedChanges, markDocumentClean, replaceEditorDocument]);

  const handleOpenFile = useCallback(async () => {
    if (!confirmDiscardUnsavedChanges()) {
      return;
    }

    try {
      const file = await openMarkdownFile();
      if (!file) {
        return;
      }

      currentFilePathRef.current = file.path;
      replaceEditorDocument(file.content);
      setCurrentFilePath(file.path);
      markDocumentClean();
      saveFileDocumentSession(file.path);
      setStatus({ kind: "success", message: `${basename(file.path)} を開きました。` });
    } catch (error: unknown) {
      setStatus({ kind: "error", message: formatFileError(error) });
    }
  }, [confirmDiscardUnsavedChanges, markDocumentClean, replaceEditorDocument]);

  const handleSaveFile = useCallback(async () => {
    try {
      const savedPath = await saveMarkdownFile(getEditorDocument(), currentFilePathRef.current);
      if (!savedPath) {
        return;
      }

      currentFilePathRef.current = savedPath;
      setCurrentFilePath(savedPath);
      markDocumentClean();
      saveFileDocumentSession(savedPath);
      setStatus({ kind: "success", message: `${basename(savedPath)} を保存しました。` });
    } catch (error: unknown) {
      setStatus({ kind: "error", message: formatFileError(error) });
    }
  }, [getEditorDocument, markDocumentClean]);

  const handleSaveFileAs = useCallback(async () => {
    try {
      const savedPath = await saveMarkdownFile(getEditorDocument(), null);
      if (!savedPath) {
        return;
      }

      currentFilePathRef.current = savedPath;
      setCurrentFilePath(savedPath);
      markDocumentClean();
      saveFileDocumentSession(savedPath);
      setStatus({ kind: "success", message: `${basename(savedPath)} を保存しました。` });
    } catch (error: unknown) {
      setStatus({ kind: "error", message: formatFileError(error) });
    }
  }, [getEditorDocument, markDocumentClean]);

  useEffect(() => {
    if (!editorReady || initialSession.kind !== "file" || initialFileRestoreStartedRef.current) {
      return;
    }

    initialFileRestoreStartedRef.current = true;
    setStatus({ kind: "loading", message: `${basename(initialSession.path)} を再度開いています...` });

    reopenMarkdownFile(initialSession.path)
      .then((file) => {
        currentFilePathRef.current = file.path;
        replaceEditorDocument(file.content);
        setCurrentFilePath(file.path);
        markDocumentClean();
        saveFileDocumentSession(file.path);
        setStatus({ kind: "success", message: `${basename(file.path)} を再度開きました。` });
      })
      .catch((error: unknown) => {
        currentFilePathRef.current = null;
        replaceEditorDocument("");
        setCurrentFilePath(null);
        markDocumentClean();
        saveNewDocumentSession("");
        setStatus({ kind: "error", message: formatFileError(error) });
      });
  }, [editorReady, initialSession, markDocumentClean, replaceEditorDocument]);

  useEffect(() => {
    const handleAppShortcut = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-ignore-app-shortcuts='true']")
      ) {
        return;
      }

      const action = appShortcutFromKeyboardEvent(event);
      if (!action) {
        return;
      }

      event.preventDefault();
      if (action === "new") {
        handleNewFile();
        return;
      }
      if (action === "open") {
        void handleOpenFile();
        return;
      }
      if (action === "saveAs") {
        void handleSaveFileAs();
        return;
      }
      void handleSaveFile();
    };

    document.addEventListener("keydown", handleAppShortcut);
    return () => document.removeEventListener("keydown", handleAppShortcut);
  }, [handleNewFile, handleOpenFile, handleSaveFile, handleSaveFileAs]);

  const recordCanceledConversion = useCallback((request: PendingConversion) => {
    setHistory((items) => [
      {
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
      },
      ...items,
    ]);
    setStatus({ kind: "warning", message: "変換をキャンセルしました。" });
  }, []);

  const skipQueuedConversion = useCallback((request: PendingConversion, message: string) => {
    setHistory((items) => [
      {
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
      },
      ...items,
    ]);
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

      const conversion = await convertRomajiToJapaneseDetailed(
        resolved.matchedText,
        settingsRef.current,
        undefined,
        {
          avoidOutputs: request.avoidOutputs,
        },
      );
      if (canceledRequestsRef.current.has(request.id)) {
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
      if (settingsRef.current.conversionMode === "ghost") {
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
              source: "editor",
              retryOf: request.retryOf,
              avoidOutputs: request.avoidOutputs,
            }),
          ],
        });
        setStatus({
          kind: "success",
          message:
            conversion.conversionStrategy === "completion"
              ? "補完変換で Ghost suggestion を生成しました。Tab で確定、Ctrl+/ で別候補を試せます。"
              : "Ghost suggestion の準備ができました。Tab で確定、Ctrl+/ で別候補を試せます。",
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
        modelName: settingsRef.current.modelName,
        createdAt: Date.now(),
        source: "editor",
        anchor: nextAnchor,
        conversionStrategy: conversion.conversionStrategy,
        retryOf: request.retryOf,
        avoidOutputs: request.avoidOutputs,
      };
      setHistory((items) => [historyItem, ...items]);
      setRecentRetryItem(historyItem);
      setStatus({
        kind: "success",
        message:
          conversion.conversionStrategy === "completion"
            ? "補完変換で変換しました。Ctrl+/ で別候補を試せます。Undo で romaji に戻せます。"
            : "変換しました。Ctrl+/ で別候補を試せます。Undo で romaji に戻せます。",
      });
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
          "適用位置を解決できなかったため、History からの変換を適用しませんでした。",
        );
        return;
      }

      const conversion = await convertRomajiToJapaneseDetailed(
        request.originalText,
        settingsRef.current,
        undefined,
        {
          avoidOutputs: request.avoidOutputs,
          protectedDictionaryEntries: resolved
            ? buildProtectedDictionaryEntries(
                request.originalText,
                resolved.matchedText,
                settingsRef.current.userDictionary,
              )
            : [],
        },
      );
      if (canceledRequestsRef.current.has(request.id)) {
        return;
      }

      const converted = conversion.text;
      const latestView = editorViewRef.current;
      if (!latestView || !request.anchor || !resolved) {
        setHistory((items) => [
          {
            id: request.id,
            status: "success",
            input: request.originalText,
            output: converted,
            modelName: settingsRef.current.modelName,
            createdAt: Date.now(),
            source: "history",
            anchor: request.anchor,
            conversionStrategy: conversion.conversionStrategy,
            retryOf: request.retryOf,
            avoidOutputs: request.avoidOutputs,
          },
          ...items,
        ]);
        setStatus({
          kind: "success",
          message:
            conversion.conversionStrategy === "completion"
              ? "補完変換で History から再変換しました。適用先がないため結果のみ保存しました。"
              : "History から再変換しました。適用先がないため結果のみ保存しました。",
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
          "適用前に位置が変わったため、History からの変換を適用しませんでした。",
        );
        return;
      }

      if (settingsRef.current.conversionMode === "ghost") {
        const nextAnchor: ConversionAnchor = {
          from: latestResolved.from,
          to: latestResolved.to,
          originalText: latestResolved.matchedText,
          appliedText: converted,
          docVersion: docVersionRef.current,
        };

        setHistory((items) =>
          upsertConversionHistory(items, {
            id: request.id,
            status: "success",
            input: request.originalText,
            output: converted,
            modelName: settingsRef.current.modelName,
            createdAt: Date.now(),
            source: "history",
            anchor: nextAnchor,
            conversionStrategy: conversion.conversionStrategy,
            retryOf: request.retryOf,
            avoidOutputs: request.avoidOutputs,
          }),
        );
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
            source: "history",
            retryOf: request.retryOf,
            avoidOutputs: request.avoidOutputs,
          }),
        });
        setStatus({
          kind: "success",
          message:
            conversion.conversionStrategy === "completion"
              ? "補完変換で History suggestion を生成しました。Tab で適用、Ctrl+/ で別候補を試せます。"
              : "History suggestion の準備ができました。Tab で適用、Ctrl+/ で別候補を試せます。",
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
        modelName: settingsRef.current.modelName,
        createdAt: Date.now(),
        source: "history",
        anchor: nextAnchor,
        conversionStrategy: conversion.conversionStrategy,
        retryOf: request.retryOf,
        avoidOutputs: request.avoidOutputs,
      };

      setHistory((items) => [historyItem, ...items]);
      setRecentRetryItem(historyItem);
      setStatus({
        kind: "success",
        message:
          conversion.conversionStrategy === "completion"
            ? "補完変換で History の変換を適用しました。Ctrl+/ で別候補を試せます。"
            : latestResolved.matchedBy === "nearby"
            ? "近くの一致位置に History の変換を適用しました。Ctrl+/ で別候補を試せます。"
            : "History の変換を適用しました。Ctrl+/ で別候補を試せます。",
      });
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
        if (canceledRequestsRef.current.has(request.id)) {
          canceledRequestsRef.current.delete(request.id);
          conversionQueueRef.current = conversionQueueRef.current.slice(1);
          setPending([...conversionQueueRef.current]);
          continue;
        }

        request.status = "running";
        runningRequestIdRef.current = request.id;
        setPending([...conversionQueueRef.current]);
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
          if (!canceledRequestsRef.current.has(request.id)) {
            const message = formatConversionError(error);
            setHistory((items) => [
              {
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
              },
              ...items,
            ]);
            setStatus({ kind: "error", message });
          }
        } finally {
          canceledRequestsRef.current.delete(request.id);
          runningRequestIdRef.current = null;
          const currentView = editorViewRef.current;
          if (currentView) {
            currentView.dispatch({ effects: removeLoadingDecoration.of(request.id) });
          }
          conversionQueueRef.current = conversionQueueRef.current.filter(
            (item) => item.id !== request.id,
          );
          setPending([...conversionQueueRef.current]);
        }
      }
    } finally {
      processingQueueRef.current = false;
      runningRequestIdRef.current = null;
    }
  }, [processEditorConversion, processHistoryConversion]);

  const enqueueConversion = useCallback(
    (request: PendingConversion) => {
      setRecentRetryItem(null);
      conversionQueueRef.current = [...conversionQueueRef.current, request];
      setPending([...conversionQueueRef.current]);
      if (processingQueueRef.current) {
        setStatus({ kind: "loading", message: `"${request.originalText}" をキューに追加しました` });
      }
      void processConversionQueue();
    },
    [processConversionQueue],
  );

  const cancelConversion = useCallback(
    (request: PendingConversion) => {
      canceledRequestsRef.current.add(request.id);
      const isRunning = runningRequestIdRef.current === request.id;
      if (!isRunning) {
        conversionQueueRef.current = conversionQueueRef.current.filter(
          (item) => item.id !== request.id,
        );
        canceledRequestsRef.current.delete(request.id);
      }
      setPending((items) => items.filter((item) => item.id !== request.id));
      recordCanceledConversion(request);

      const view = editorViewRef.current;
      if (view) {
        view.dispatch({ effects: removeLoadingDecoration.of(request.id) });
      }
    },
    [recordCanceledConversion],
  );

  const handleAcceptGhost = useCallback((suggestion: GhostConversionSuggestion) => {
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
      modelName: settingsRef.current.modelName,
      createdAt: Date.now(),
      source: suggestion.source,
      anchor: nextAnchor,
      conversionStrategy: suggestion.conversionStrategy,
      retryOf: suggestion.retryOf,
      avoidOutputs: suggestion.avoidOutputs,
    };

    setHistory((items) =>
      upsertConversionHistory(items, historyItem),
    );
    setRecentRetryItem(historyItem);
    setStatus({
      kind: "success",
      message:
        suggestion.conversionStrategy === "completion"
          ? "補完変換の Ghost suggestion を確定しました。Ctrl+/ で別候補を試せます。"
          : "Ghost suggestion を確定しました。Ctrl+/ で別候補を試せます。",
    });
  }, [saveCurrentDocumentSession]);

  const handleRetryGhost = useCallback(
    (suggestion: GhostConversionSuggestion) => {
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

      const request: PendingConversion = {
        id: crypto.randomUUID(),
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
    [enqueueConversion],
  );

  const previewHistoryGhost = useCallback((item: ConversionHistoryItem) => {
    if (!item.output || !item.anchor) {
      return;
    }

    const view = editorViewRef.current;
    if (!view) {
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
        conversionStrategy: item.conversionStrategy,
        source: "history",
        retryOf: item.retryOf,
        avoidOutputs: item.avoidOutputs,
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
      id: crypto.randomUUID(),
      anchor: item.anchor,
      originalText: item.input,
      createdAt: Date.now(),
      source: "history",
      status: "queued",
    };

    enqueueConversion(request);
  }, [enqueueConversion]);

  const handleAlternativeHistory = useCallback((item: ConversionHistoryItem) => {
    const request: PendingConversion = {
      id: crypto.randomUUID(),
      anchor: item.anchor,
      originalText: item.input,
      createdAt: Date.now(),
      source: "history",
      status: "queued",
      retryOf: item.id,
      avoidOutputs: collectAvoidOutputs(item.avoidOutputs, item.output),
    };

    enqueueConversion(request);
  }, [enqueueConversion]);

  const dismissRecentRetryChip = useCallback(() => {
    setRecentRetryItem(null);
  }, []);

  const retryRecentConversion = useCallback(() => {
    if (!recentRetryItem) {
      return false;
    }

    handleAlternativeHistory(recentRetryItem);
    return true;
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

  const handleConvert = useCallback((range: ConversionRange) => {
    const view = editorViewRef.current;
    if (!view) {
      return false;
    }

    if (hasMatchingPendingEditorConversion(conversionQueueRef.current, range)) {
      return false;
    }

    const request: PendingConversion = {
      id: crypto.randomUUID(),
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
  }, [enqueueConversion]);

  const delayedPending = pending.filter((request) => now - request.createdAt >= CANCEL_UI_DELAY_MS);
  const settingsAttention = ollamaConnection.kind === "warning" || ollamaConnection.kind === "error";
  const enabledDictionaryCount = settings.userDictionary.filter(
    (entry) => entry.enabled && entry.reading.trim() && entry.output.trim(),
  ).length;

  return (
    <main className="app-shell">
      <MarkdownEditor
        settings={settings}
        pending={pending}
        initialDocument={initialDocument}
        fileName={currentFilePath ? basename(currentFilePath) : "未保存の下書き"}
        isDirty={isDirty}
        modelStatusLabel={
          !setupComplete && !setupModelProvider
            ? "Provider未設定 · Model未選択"
            : formatModelStatusLabel(settings, ollamaConnection)
        }
        modelStatusKind={ollamaConnection.kind}
        onConvert={handleConvert}
        onDocumentChanged={handleDocumentChanged}
        onNewFile={handleNewFile}
        onOpenFile={handleOpenFile}
        onSaveFile={handleSaveFile}
        onSaveFileAs={handleSaveFileAs}
        onAcceptGhost={handleAcceptGhost}
        onRetryGhost={handleRetryGhost}
        onRetryRecent={retryRecentConversion}
        registerView={registerView}
      />
      <AppRail
        historyCount={history.length}
        dictionaryCount={enabledDictionaryCount}
        activePanel={activePanel}
        settingsAttention={settingsAttention}
        onOpenHistory={toggleHistoryPanel}
        onOpenPrompt={togglePromptPanel}
        onOpenDictionary={toggleDictionaryPanel}
        onOpenSettings={toggleSettingsDrawer}
      />
      {recentRetryItem ? (
        <RecentRetryChip
          item={recentRetryItem}
          onRetry={retryRecentConversion}
          onDismiss={dismissRecentRetryChip}
        />
      ) : null}
      {activePanel ? (
        <InspectorDrawer
          panel={activePanel}
          onClose={closeActivePanel}
        >
          {activePanel === "settings" ? (
            <SettingsDrawerContent
              settings={settings}
              ollamaModels={ollamaModels}
              ollamaConnection={ollamaConnection}
              onChange={setSettings}
              onCheckOllama={handleCheckOllama}
            />
          ) : null}
          {activePanel === "history" ? (
            <HistoryPanel
              history={history}
              pending={delayedPending}
              onCancel={cancelConversion}
              onRerun={handleRerunHistory}
              onAlternative={handleAlternativeHistory}
              onPreview={previewHistoryGhost}
              onPreviewEnd={clearHistoryGhost}
              onClose={closeActivePanel}
            />
          ) : null}
          {activePanel === "dictionary" ? (
            <DictionaryModal
              entries={settings.userDictionary}
              onChange={(userDictionary) => setSettings((value) => ({ ...value, userDictionary }))}
            />
          ) : null}
          {activePanel === "prompt" ? (
            <PromptPanel
              prompt={settings.conversionPrompt}
              preset={settings.conversionPreset}
              onPresetChange={(conversionPreset) =>
                setSettings((value) => ({ ...value, conversionPreset }))
              }
              onChange={(conversionPrompt) =>
                setSettings((value) => ({ ...value, conversionPrompt }))
              }
              onReset={() =>
                setSettings((value) => ({ ...value, conversionPrompt: defaultConversionPrompt }))
              }
              onClose={closeActivePanel}
            />
          ) : null}
        </InspectorDrawer>
      ) : null}
      {!setupComplete ? (
        <SetupModal
          settings={settings}
          ollamaModels={ollamaModels}
          ollamaConnection={ollamaConnection}
          setupModelProvider={setupModelProvider}
          onChange={setSettings}
          onCheckOllama={handleCheckOllama}
          onProviderSelected={handleSetupProviderSelected}
          onComplete={completeSetup}
          onSkip={completeSetup}
        />
      ) : null}
      <StatusBar
        status={status}
        pending={delayedPending}
        pendingCount={pending.length}
        onCancel={cancelConversion}
        onOpenSettings={openSettingsDrawer}
      />
    </main>
  );
}

function RecentRetryChip({
  item,
  onRetry,
  onDismiss,
}: {
  item: ConversionHistoryItem;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside
      className={`recent-retry-chip ${item.conversionStrategy === "completion" ? "completion" : ""}`}
      aria-label="別候補への再変換"
    >
      <button
        className="recent-retry-chip-main"
        type="button"
        onClick={onRetry}
        title="別候補を再生成"
      >
        <RotateCcw size={15} aria-hidden="true" />
        <span className="recent-retry-chip-text">
          {item.conversionStrategy === "completion"
            ? item.output
              ? `補完変換: ${item.output}`
              : "補完変換で生成しました"
            : item.output
              ? `${item.output} の別候補を試す`
              : "別候補を試す"}
        </span>
        <kbd>Ctrl+/</kbd>
      </button>
      <button
        className="recent-retry-chip-dismiss"
        type="button"
        onClick={onDismiss}
        aria-label="別候補チップを閉じる"
        title="閉じる"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </aside>
  );
}

function AppRail({
  historyCount,
  dictionaryCount,
  activePanel,
  settingsAttention,
  onOpenHistory,
  onOpenPrompt,
  onOpenDictionary,
  onOpenSettings,
}: {
  historyCount: number;
  dictionaryCount: number;
  activePanel: ActivePanel;
  settingsAttention: boolean;
  onOpenHistory: () => void;
  onOpenPrompt: () => void;
  onOpenDictionary: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <nav className="app-rail" aria-label="App tools">
      <button
        className={`rail-button ${activePanel === "settings" ? "active" : ""} ${settingsAttention ? "attention" : ""}`}
        type="button"
        onClick={onOpenSettings}
        aria-pressed={activePanel === "settings"}
        aria-label="Settings を開く"
        title="Settings"
      >
        <SlidersHorizontal size={18} aria-hidden="true" />
        <span>Settings</span>
      </button>
      <button
        className={`rail-button ${activePanel === "history" ? "active" : ""}`}
        type="button"
        onClick={onOpenHistory}
        aria-pressed={activePanel === "history"}
        aria-label={`History を開く、${historyCount} 件`}
        title="History"
      >
        <History size={18} aria-hidden="true" />
        {historyCount > 0 ? <span className="rail-count">{historyCount}</span> : null}
        <span>History</span>
      </button>
      <button
        className={`rail-button ${activePanel === "dictionary" ? "active" : ""}`}
        type="button"
        onClick={onOpenDictionary}
        aria-pressed={activePanel === "dictionary"}
        aria-label={
          dictionaryCount > 0
            ? `Dictionary を開く、${dictionaryCount} 件有効`
            : "Dictionary を開く"
        }
        title="Dictionary"
      >
        <BookMarked size={18} aria-hidden="true" />
        {dictionaryCount > 0 ? <span className="rail-count">{dictionaryCount}</span> : null}
        <span>Dictionary</span>
      </button>
      <button
        className={`rail-button ${activePanel === "prompt" ? "active" : ""}`}
        type="button"
        onClick={onOpenPrompt}
        aria-pressed={activePanel === "prompt"}
        aria-label="Style を開く"
        title="Style"
      >
        <MessageSquareText size={18} aria-hidden="true" />
        <span>Style</span>
      </button>
    </nav>
  );
}

function formatModelStatusLabel(
  settings: AppSettings,
  ollamaConnection: OllamaConnectionStatus,
): string {
  const label = providerLabel(settings);
  const modelName = settings.modelName.trim() || "Model未選択";

  if (ollamaConnection.kind === "connected") {
    return `${label} · ${modelName} · Ready`;
  }
  if (ollamaConnection.kind === "checking") {
    return `${label} · ${modelName} · 確認中`;
  }
  if (ollamaConnection.kind === "error") {
    return `${label} · ${modelName} · 未接続`;
  }
  if (ollamaConnection.kind === "warning") {
    return `${label} · ${modelName} · 要確認`;
  }
  return `${label} · ${modelName} · 未確認`;
}

function InspectorDrawer({
  panel,
  children,
  onClose,
}: {
  panel: NonNullable<ActivePanel>;
  children: ReactNode;
  onClose: () => void;
}) {
  const title = panelTitle(panel);
  const eyebrow = panelEyebrow(panel);

  return (
    <div className="inspector-overlay" onMouseDown={onClose}>
      <aside
        className="inspector-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspector-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="inspector-header">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2 id="inspector-title">{title}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={`${title} を閉じる`}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="inspector-body">{children}</div>
      </aside>
    </div>
  );
}

function panelTitle(panel: NonNullable<ActivePanel>): string {
  if (panel === "settings") {
    return "Settings";
  }
  if (panel === "history") {
    return "History";
  }
  if (panel === "dictionary") {
    return "Dictionary";
  }
  return "Style";
}

function panelEyebrow(panel: NonNullable<ActivePanel>): string {
  if (panel === "settings") {
    return "Model setup";
  }
  if (panel === "history") {
    return "Conversion log";
  }
  if (panel === "dictionary") {
    return "User terms";
  }
  return "Conversion style";
}

function SettingsDrawerContent({
  settings,
  ollamaModels,
  ollamaConnection,
  onChange,
  onCheckOllama,
}: {
  settings: AppSettings;
  ollamaModels: OllamaModel[];
  ollamaConnection: OllamaConnectionStatus;
  onChange: (settings: AppSettings) => void;
  onCheckOllama: () => void;
}) {
  return (
    <SettingsContent
      settings={settings}
      ollamaModels={ollamaModels}
      ollamaConnection={ollamaConnection}
      onChange={onChange}
      onCheckOllama={onCheckOllama}
    />
  );
}

function SetupModal({
  settings,
  ollamaModels,
  ollamaConnection,
  setupModelProvider,
  onChange,
  onCheckOllama,
  onProviderSelected,
  onComplete,
  onSkip,
}: {
  settings: AppSettings;
  ollamaModels: OllamaModel[];
  ollamaConnection: OllamaConnectionStatus;
  setupModelProvider: ModelProvider | null;
  onChange: (settings: AppSettings) => void;
  onCheckOllama: () => void;
  onProviderSelected: (modelProvider: ModelProvider) => void;
  onComplete: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="settings-overlay setup-overlay">
      <section
        className="setup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-modal-title"
      >
        <div className="setup-intro">
          <p className="eyebrow">First run</p>
          <h2 id="setup-modal-title">最初のモデル設定</h2>
          <p>
            Provider と Model を選ぶとすぐ変換できます。設定はあとからでも変更できます。
          </p>
        </div>
        <SettingsContent
          settings={settings}
          ollamaModels={ollamaModels}
          ollamaConnection={ollamaConnection}
          onChange={onChange}
          onCheckOllama={onCheckOllama}
          onProviderSelected={onProviderSelected}
          setupModelProvider={setupModelProvider}
          mode="setup"
        />
        <div className="setup-actions">
          <button className="secondary-button" type="button" onClick={onSkip}>
            あとで設定
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={onComplete}
          >
            書き始める
          </button>
        </div>
      </section>
    </div>
  );
}

function HistoryPanel({
  history,
  pending,
  onCancel,
  onRerun,
  onAlternative,
  onPreview,
  onPreviewEnd,
  onClose,
}: {
  history: ConversionHistoryItem[];
  pending: PendingConversion[];
  onCancel: (request: PendingConversion) => void;
  onRerun: (item: ConversionHistoryItem) => void;
  onAlternative: (item: ConversionHistoryItem) => void;
  onPreview: (item: ConversionHistoryItem) => void;
  onPreviewEnd: (item: ConversionHistoryItem) => void;
  onClose: () => void;
}) {
  return (
    <section className="floating-panel history-panel" aria-label="History">
      <div className="floating-panel-header">
        <div>
          <p className="eyebrow">Conversion log</p>
          <h2>History</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="History を閉じる">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {pending.length > 0 ? (
        <div className="pending-list" aria-label="処理中の変換">
          {pending.map((request) => (
            <article className="pending-item" key={request.id}>
              <div>
                <strong>
                  {request.retryOf
                    ? request.status === "queued"
                      ? "再試行待ち"
                      : "別候補を生成中"
                    : request.status === "queued"
                    ? "待機中"
                    : request.source === "history"
                      ? "再適用中"
                      : "変換中"}
                </strong>
                <p>{request.originalText}</p>
              </div>
              <button className="secondary-button" type="button" onClick={() => onCancel(request)}>
                キャンセル
              </button>
            </article>
          ))}
        </div>
      ) : null}

      {history.length === 0 ? (
        <p className="empty-state">変換はまだありません。</p>
      ) : (
        <div className="history-list">
          {history.map((item) => (
            <article
              className={`history-item ${item.status}`}
              key={item.id}
              onBlur={() => onPreviewEnd(item)}
              onMouseEnter={() => onPreview(item)}
              onMouseLeave={() => onPreviewEnd(item)}
            >
              <div className="history-meta">
                <span className={`status-chip ${item.status}`}>{historyStatusLabel(item.status)}</span>
                <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
              </div>
              <dl>
                <div>
                  <dt>Romaji</dt>
                  <dd>{item.input}</dd>
                </div>
                <div>
                  <dt>{item.status === "success" ? "日本語" : "結果"}</dt>
                  <dd>{item.output ?? item.error ?? "出力はありません。"}</dd>
                </div>
              </dl>
              <div className="rerun-meta">
                <span>{item.modelName}</span>
                <button
                  className="rerun-hint"
                  type="button"
                  onFocus={() => onPreview(item)}
                  onClick={() => {
                    onPreviewEnd(item);
                    onRerun(item);
                    onClose();
                  }}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  再試行
                </button>
                <button
                  className="rerun-hint"
                  type="button"
                  disabled={!item.output}
                  title={item.output ? "前回結果を避けて別候補を生成します" : "出力がないため別候補は生成できません"}
                  onFocus={() => onPreview(item)}
                  onClick={() => {
                    onPreviewEnd(item);
                    onAlternative(item);
                    onClose();
                  }}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  別候補
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function historyStatusLabel(status: ConversionHistoryItem["status"]): string {
  if (status === "success") {
    return "成功";
  }
  if (status === "error") {
    return "失敗";
  }
  if (status === "skipped") {
    return "スキップ";
  }
  return "キャンセル";
}

function PromptPanel({
  prompt,
  preset,
  onPresetChange,
  onChange,
  onReset,
  onClose,
}: {
  prompt: string;
  preset: ConversionPreset;
  onPresetChange: (preset: ConversionPreset) => void;
  onChange: (prompt: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <section className="floating-panel prompt-panel" aria-label="変換スタイル">
      <div className="floating-panel-header">
        <div>
          <p className="eyebrow">Conversion style</p>
          <h2>Preset</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Preset を閉じる">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="preset-panel-content">
        <fieldset className="preset-options">
          <legend className="sr-only">変換 Preset</legend>
          {CONVERSION_PRESET_OPTIONS.map((option) => (
            <label
              className={preset === option ? "selected" : ""}
              key={option}
            >
              <input
                type="radio"
                name="conversion-preset"
                value={option}
                checked={preset === option}
                onChange={() => onPresetChange(option)}
              />
              <span>
                <strong>{conversionPresetLabels[option]}</strong>
                <small>{presetDescription(option)}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <details className="advanced-prompt">
          <summary>Advanced prompt</summary>
          <label className="prompt-editor">
            <span>日本語変換の指示</span>
            <textarea
              value={prompt}
              onChange={(event) => onChange(event.currentTarget.value)}
              spellCheck={false}
            />
          </label>
          <div className="panel-actions">
            <button className="secondary-button" type="button" onClick={onReset}>
              デフォルトに戻す
            </button>
          </div>
          <p className="panel-note">
            このプロンプトはローカルに保存されます。かな漢字変換の安全ルールと few-shot は自動で追加されます。
          </p>
        </details>
      </div>
    </section>
  );
}

function presetDescription(preset: ConversionPreset): string {
  if (preset === "conversation") {
    return "チャットや口語メモ向け。ビジネス表現に寄せすぎず、自然な言い回しを優先します。";
  }
  if (preset === "businessEmail") {
    return "仕事の連絡やメール下書き向け。標準的なビジネス漢字と丁寧な表記を優先します。";
  }
  return "汎用の変換。読みと一般的な日本語表記を優先します。";
}

function DictionaryModal({
  entries,
  onChange,
}: {
  entries: UserDictionaryEntry[];
  onChange: (entries: UserDictionaryEntry[]) => void;
}) {
  const [draft, setDraft] = useState({ reading: "", output: "", note: "" });
  const canAdd =
    draft.reading.trim().length > 0 &&
    draft.output.trim().length > 0 &&
    entries.length < MAX_USER_DICTIONARY_ENTRIES;

  const addEntry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canAdd) {
      return;
    }

    onChange([
      ...entries,
      {
        id: createDictionaryEntryId(),
        reading: draft.reading.trim(),
        output: draft.output.trim(),
        note: draft.note.trim(),
        enabled: true,
      },
    ]);
    setDraft({ reading: "", output: "", note: "" });
  };

  const updateEntry = (id: string, patch: Partial<UserDictionaryEntry>) => {
    onChange(
      entries.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              ...patch,
            }
          : entry,
      ),
    );
  };

  const deleteEntry = (id: string) => {
    onChange(entries.filter((entry) => entry.id !== id));
  };

  return (
      <section className="dictionary-modal inspector-panel" aria-label="Dictionary entries">
        <form className="dictionary-add-form" onSubmit={addEntry}>
          <label className="field">
            <span>Romaji reading</span>
            <input
              aria-label="Romaji reading"
              value={draft.reading}
              maxLength={80}
              placeholder="openai"
              onChange={(event) => {
                const reading = event.currentTarget.value;
                setDraft((value) => ({ ...value, reading }));
              }}
            />
          </label>
          <label className="field">
            <span>出力</span>
            <input
              aria-label="出力"
              value={draft.output}
              maxLength={80}
              placeholder="OpenAI"
              onChange={(event) => {
                const output = event.currentTarget.value;
                setDraft((value) => ({ ...value, output }));
              }}
            />
          </label>
          <label className="field dictionary-note-field">
            <span>メモ</span>
            <input
              aria-label="メモ"
              value={draft.note}
              maxLength={120}
              placeholder="会社名など"
              onChange={(event) => {
                const note = event.currentTarget.value;
                setDraft((value) => ({ ...value, note }));
              }}
            />
          </label>
          <button
            className="primary-button dictionary-add-button"
            type="submit"
            disabled={!canAdd}
          >
            <Plus size={16} aria-hidden="true" />
            追加
          </button>
        </form>

        <div className="dictionary-list-header">
          <strong>{entries.length} / {MAX_USER_DICTIONARY_ENTRIES}</strong>
        </div>
        {entries.length === 0 ? (
          <p className="empty-state">Dictionary の登録はまだありません。</p>
        ) : (
          <div className="dictionary-list">
            {entries.map((entry, index) => (
              <article className={`dictionary-entry ${entry.enabled ? "" : "disabled"}`} key={entry.id}>
                <label className="dictionary-enable">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={(event) =>
                      updateEntry(entry.id, { enabled: event.currentTarget.checked })
                    }
                  />
                  有効
                </label>
                <div className="dictionary-entry-fields">
                  <input
                    aria-label={`Dictionary reading ${index + 1}`}
                    value={entry.reading}
                    maxLength={80}
                    onChange={(event) =>
                      updateEntry(entry.id, { reading: event.currentTarget.value })
                    }
                  />
                  <input
                    aria-label={`Dictionary output ${index + 1}`}
                    value={entry.output}
                    maxLength={80}
                    onChange={(event) =>
                      updateEntry(entry.id, { output: event.currentTarget.value })
                    }
                  />
                  <input
                    aria-label={`Dictionary note ${index + 1}`}
                    value={entry.note}
                    maxLength={120}
                    placeholder="メモ"
                    onChange={(event) =>
                      updateEntry(entry.id, { note: event.currentTarget.value })
                    }
                  />
                </div>
                <button
                  className="icon-button dictionary-delete"
                  type="button"
                  onClick={() => deleteEntry(entry.id)}
                  aria-label={`${entry.output || entry.reading} を削除`}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
  );
}

function createDictionaryEntryId(prefix = "dictionary"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

function upsertConversionHistory(
  items: ConversionHistoryItem[],
  nextItem: ConversionHistoryItem,
): ConversionHistoryItem[] {
  return [nextItem, ...items.filter((item) => item.id !== nextItem.id)];
}

function StatusBar({
  status,
  pending,
  pendingCount,
  onCancel,
  onOpenSettings,
}: {
  status: ConversionStatus;
  pending: PendingConversion[];
  pendingCount: number;
  onCancel: (request: PendingConversion) => void;
  onOpenSettings: () => void;
}) {
  const Icon =
    status.kind === "loading" ? Loader2 : status.kind === "error" ? AlertCircle : CheckCircle2;
  const canOpenSettings = status.kind === "warning" || status.kind === "error";
  const hasStatusActions = canOpenSettings || Boolean(pending[0]) || pendingCount > 0;

  return (
    <div
      className={`status-bar ${status.kind} ${hasStatusActions ? "has-actions" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="status-main">
        <Icon size={16} className={status.kind === "loading" ? "spin" : ""} aria-hidden="true" />
        <span className="status-message">{status.message}</span>
      </div>
      {hasStatusActions ? (
        <div className="status-actions">
          {canOpenSettings ? (
            <button className="status-settings" type="button" onClick={onOpenSettings}>
              Settings を開く
            </button>
          ) : null}
          {pending[0] ? (
            <button className="status-cancel" type="button" onClick={() => onCancel(pending[0])}>
              遅い変換をキャンセル
            </button>
          ) : null}
          {pendingCount > 0 ? <strong>{pendingCount} 件待機中</strong> : null}
        </div>
      ) : null}
    </div>
  );
}

function formatConversionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network|failed|ECONNREFUSED|Load failed/i.test(message)) {
    return "選択中のローカルモデル Provider に接続できません。設定した URL で起動しているか確認してください。";
  }
  return message || "変換に失敗しました。";
}

function formatOllamaConnectionError(error: unknown, label: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) {
    return `${label} の接続確認がタイムアウトしました。${label} が起動していて、選択中のモデルを読み込めるか確認してください。`;
  }
  if (/fetch|network|failed|ECONNREFUSED|Load failed/i.test(message)) {
    return `${label} に接続できません。設定した URL で起動しているか確認してください。`;
  }
  return message || `${label} の接続確認に失敗しました。`;
}

function formatFileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "ファイル操作に失敗しました。");
}

export default App;
