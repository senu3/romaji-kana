import type { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import {
  AlertCircle,
  BookMarked,
  CheckCircle2,
  History,
  Loader2,
  Link2,
  MessageSquareText,
  Plus,
  RotateCcw,
  Smartphone,
  SlidersHorizontal,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  Component,
  type ErrorInfo,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import "./App.css";
import {
  addLoadingDecoration,
  clearGhostSuggestion,
  type EditorDocumentStatus,
  ghostSuggestionField,
  MarkdownEditor,
  removeLoadingDecoration,
  showGhostSuggestion,
} from "./components/MarkdownEditor";
import { SettingsContent } from "./components/SettingsPanel";
import {
  clearRemoteCompanionToken,
  getCompanionState,
  getCompanionStatus,
  hasRemoteCompanionToken,
  isRemoteCompanionClient,
  pairRemoteCompanion,
  startCompanion,
  stopCompanion,
  updateCompanionDocument,
  updateCompanionSettings,
  type CompanionSnapshot,
  type CompanionStatus,
} from "./lib/companion";
import {
  loadDocumentSession,
  saveFileDocumentSession,
  saveNewDocumentSession,
} from "./lib/documentStore";
import {
  buildDocumentVocabularyProfile,
  type DocumentVocabularyProfile,
} from "./lib/documentVocabulary";
import { basename, openMarkdownFile, reopenMarkdownFile, saveMarkdownFile } from "./lib/fileSystem";
import { resolveConversionAnchor } from "./lib/historyAnchor";
import { createId } from "./lib/id";
import {
  buildProtectedDictionaryEntries,
  convertRomajiToJapaneseDetailed,
  providerLabel,
} from "./lib/ollama";
import { checkOllamaConnection, listLocalModels } from "./lib/ollamaConnection";
import {
  conversionPresetLabels,
  defaultConversionPrompt,
  inputCompletionLabels,
} from "./lib/prompts";
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
  InputCompletionLevel,
  ModelProvider,
  OllamaConnectionStatus,
  OllamaModel,
  PendingConversion,
  UserDictionaryEntry,
} from "./lib/types";

type ActivePanel = "settings" | "history" | "dictionary" | "prompt" | "companion" | null;
const CANCEL_UI_DELAY_MS = 1_200;
const AUTO_CONNECTION_CHECK_DELAY_MS = 550;
const RECENT_RETRY_CHIP_TIMEOUT_MS = 8_000;
const CONVERSION_PRESET_OPTIONS: ConversionPreset[] = ["none", "conversation", "businessEmail"];
const INPUT_COMPLETION_OPTIONS: InputCompletionLevel[] = ["none", "word", "sentence"];
const SETUP_COMPLETE_STORAGE_KEY = "romaji-kana-setup-complete";
const FORCE_SETUP_QUERY_PARAM = "setup";
const ENABLE_FIRST_RUN_SETUP_MODAL = false;
const MAX_USER_DICTIONARY_ENTRIES = 50;
const MAX_CONVERSION_HISTORY_ITEMS = 100;
const COMPANION_SYNC_DELAY_MS = 180;
const COMPANION_POLL_INTERVAL_MS = 650;

const stoppedCompanionStatus: CompanionStatus = {
  running: false,
  port: 18_321,
  urls: [],
  pairCode: null,
  pairedClients: 0,
};

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
  return (
    <AppErrorBoundary>
      <AppRouter />
    </AppErrorBoundary>
  );
}

function AppRouter() {
  const remoteMode = isRemoteCompanionClient();
  const [paired, setPaired] = useState(() => !remoteMode || hasRemoteCompanionToken());

  if (remoteMode && !paired) {
    return <RemotePairingScreen onPaired={() => setPaired(true)} />;
  }

  return <EditorApp remoteMode={remoteMode} />;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Romaji Kana stopped unexpectedly.", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }

    const remoteMode = isRemoteCompanionClient();
    const reconnect = () => {
      clearRemoteCompanionToken();
      window.location.reload();
    };

    return (
      <main className="app-error-page">
        <section className="app-error-sheet" role="alert" aria-labelledby="app-error-title">
          <span className="app-error-mark" aria-hidden="true">
            <AlertCircle size={28} />
          </span>
          <h1 id="app-error-title">画面を読み込めませんでした</h1>
          <p>
            {remoteMode
              ? "スマホ連携を読み込み直してください。直らない場合は、PCに表示された接続コードでもう一度つなぎます。"
              : "アプリを読み込み直してください。編集中の下書きは自動退避されています。"}
          </p>
          <div className="app-error-actions">
            <button className="primary-button" type="button" onClick={() => window.location.reload()}>
              読み込み直す
            </button>
            {remoteMode ? (
              <button className="secondary-button" type="button" onClick={reconnect}>
                もう一度つなぐ
              </button>
            ) : null}
          </div>
        </section>
      </main>
    );
  }
}

function EditorApp({ remoteMode }: { remoteMode: boolean }) {
  const [initialSession] = useState(() => {
    if (remoteMode) {
      return { kind: "new" as const, content: "" };
    }
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
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [companionStatus, setCompanionStatus] = useState<CompanionStatus>(stoppedCompanionStatus);
  const [companionBusy, setCompanionBusy] = useState(false);
  const [remoteFileName, setRemoteFileName] = useState("PCの文書");
  const [now, setNow] = useState(() => Date.now());
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(
    initialSession.kind === "file" ? initialSession.path : null,
  );
  const [isDirty, setIsDirty] = useState(
    initialSession.kind === "new"
      ? initialSession.content.length > 0
      : initialSession.dirty,
  );
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaConnection, setOllamaConnection] = useState<OllamaConnectionStatus>({
    kind: "idle",
    message: "ローカルモデルプロバイダーはまだ確認されていません。",
  });
  const [initialDocument] = useState(() => initialSession.content);
  const [documentVocabularyProfile, setDocumentVocabularyProfile] =
    useState<DocumentVocabularyProfile>(() =>
      buildDocumentVocabularyProfile(initialSession.content),
    );
  const [status, setStatus] = useState<ConversionStatus>({
    kind: "idle",
    message: "準備完了。romaji を入力して句読点で確定するか、Ctrl+Enter を押してください。",
  });
  const [editorReady, setEditorReady] = useState(false);
  const [editorStatus, setEditorStatus] = useState<EditorDocumentStatus>({
    line: 1,
    column: 1,
    lineCount: 1,
    characterCount: initialDocument.length,
    selectionCount: 0,
  });
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
  const isDirtyRef = useRef(
    initialSession.kind === "new" ? initialSession.content.length > 0 : initialSession.dirty,
  );
  const initialFileRestoreStartedRef = useRef(false);
  const docVersionRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vocabularyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionCheckIdRef = useRef(0);
  const startupCheckStartedRef = useRef(false);
  const previousModelProviderRef = useRef(settings.modelProvider);
  const canceledRequestsRef = useRef(new Set<string>());
  const conversionQueueRef = useRef<PendingConversion[]>([]);
  const processingQueueRef = useRef(false);
  const runningRequestIdRef = useRef<string | null>(null);
  const suppressNextDirtyRef = useRef(false);
  const companionStatusRef = useRef(companionStatus);
  const companionRevisionRef = useRef(0);
  const companionPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const companionPushPendingRef = useRef(false);
  const suppressNextCompanionPushRef = useRef(false);
  const companionClientIdRef = useRef(remoteMode ? createId("mobile") : "desktop");

  useEffect(() => {
    settingsRef.current = settings;
    saveSettings(settings);
    if (!remoteMode && companionStatusRef.current.running) {
      void updateCompanionSettings(settings);
    }
  }, [remoteMode, settings]);

  useEffect(() => {
    companionStatusRef.current = companionStatus;
  }, [companionStatus]);

  useEffect(() => {
    setupCompleteRef.current = setupComplete;
  }, [setupComplete]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      if (vocabularyTimerRef.current) {
        clearTimeout(vocabularyTimerRef.current);
      }
      if (companionPushTimerRef.current) {
        clearTimeout(companionPushTimerRef.current);
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
        saveFileDocumentSession(filePath, documentText, true);
      } else {
        saveNewDocumentSession(documentText);
      }
      saveTimerRef.current = null;
    }, 250);

    if (vocabularyTimerRef.current) {
      clearTimeout(vocabularyTimerRef.current);
    }
    vocabularyTimerRef.current = setTimeout(() => {
      const profile = buildDocumentVocabularyProfile(documentText);
      setDocumentVocabularyProfile(profile);
      vocabularyTimerRef.current = null;
    }, 350);

    const syncEnabled = remoteMode || companionStatusRef.current.running;
    if (!syncEnabled) {
      return;
    }
    if (suppressNextCompanionPushRef.current) {
      suppressNextCompanionPushRef.current = false;
      return;
    }
    if (companionPushTimerRef.current) {
      clearTimeout(companionPushTimerRef.current);
    }
    companionPushTimerRef.current = setTimeout(async () => {
      companionPushPendingRef.current = true;
      try {
        const snapshot = await updateCompanionDocument(
          documentText,
          remoteMode
            ? remoteFileName
            : currentFilePathRef.current
              ? basename(currentFilePathRef.current)
              : "Untitled.md",
          companionClientIdRef.current,
        );
        companionRevisionRef.current = Math.max(
          companionRevisionRef.current,
          snapshot.document.revision,
        );
      } catch (error: unknown) {
        setStatus({
          kind: "error",
          message: `スマホ連携の同期に失敗しました。${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        companionPushPendingRef.current = false;
        companionPushTimerRef.current = null;
      }
    }, COMPANION_SYNC_DELAY_MS);
  }, [remoteFileName, remoteMode]);

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
            ? `${label} のモデルを ${models.length} 件読み込みました。モデルを選んで接続チェックしてください。`
            : `${label} に接続しましたが、ローカルモデルが見つかりませんでした。`,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: models.length > 0 ? "warning" : "idle",
        message:
          models.length > 0
            ? "モデルを選択し、接続チェックを実行するとセットアップが完了します。"
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

  const handleModelSettingsProviderSelected = useCallback(async (modelProvider: ModelProvider) => {
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
            ? `${label} のモデルを ${models.length} 件読み込みました。モデルを選んで接続チェックしてください。`
            : `${label} に接続しましたが、ローカルモデルが見つかりませんでした。`,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: models.length > 0 ? "warning" : "idle",
        message:
          models.length > 0
            ? "モデルを選択し、接続チェックを実行すると設定を確認できます。"
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
    if (remoteMode) {
      startupCheckStartedRef.current = true;
      setOllamaConnection({
        kind: "connected",
        message: "PC経由でローカルモデルに接続しています。",
        checkedAt: Date.now(),
      });
      return;
    }

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
        message: "プロバイダーを選択するとローカルモデル一覧を読み込みます。",
      });
      setStatus({
        kind: "idle",
        message: "プロバイダーを選ぶとモデル一覧を読み込みます。入力は今すぐ可能です。",
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
    remoteMode,
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
    const documentText = editorViewRef.current?.state.doc.toString();
    if (documentText !== undefined) {
      const profile = buildDocumentVocabularyProfile(documentText);
      setDocumentVocabularyProfile(profile);
    }
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

  const openModelSettings = useCallback(() => {
    setModelSettingsOpen(true);
  }, []);

  const closeModelSettings = useCallback(() => {
    setModelSettingsOpen(false);
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
      annotations: Transaction.addToHistory.of(false),
    });
  }, [clearPendingConversions]);

  const applyCompanionSnapshot = useCallback((snapshot: CompanionSnapshot) => {
    if (remoteMode && JSON.stringify(snapshot.settings) !== JSON.stringify(settingsRef.current)) {
      setSettings(snapshot.settings);
    }
    if (remoteMode) {
      setRemoteFileName(snapshot.document.fileName || "PCの文書");
    }
    if (snapshot.document.revision <= companionRevisionRef.current) {
      return;
    }

    companionRevisionRef.current = snapshot.document.revision;
    const currentContent = editorViewRef.current?.state.doc.toString() ?? "";
    if (snapshot.document.content === currentContent) {
      return;
    }
    suppressNextCompanionPushRef.current = true;
    replaceEditorDocument(snapshot.document.content);
    isDirtyRef.current = true;
    setIsDirty(true);
    const filePath = currentFilePathRef.current;
    if (filePath) {
      saveFileDocumentSession(filePath, snapshot.document.content, true);
    } else {
      saveNewDocumentSession(snapshot.document.content);
    }
    setStatus({
      kind: "success",
      message: remoteMode
        ? "PCの文書を同期しました。"
        : "スマホからの変更を反映しました。保存するとファイルへ書き込まれます。",
    });
  }, [remoteMode, replaceEditorDocument]);

  const handleStartCompanion = useCallback(async () => {
    setCompanionBusy(true);
    try {
      const nextStatus = await startCompanion(
        getEditorDocument(),
        currentFilePathRef.current ? basename(currentFilePathRef.current) : "Untitled.md",
        settingsRef.current,
      );
      companionRevisionRef.current = 0;
      setCompanionStatus(nextStatus);
      setStatus({
        kind: "success",
        message: "スマホ連携を開始しました。同じWi-Fiのスマホで接続URLを開いてください。",
      });
    } catch (error: unknown) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCompanionBusy(false);
    }
  }, [getEditorDocument]);

  const handleStopCompanion = useCallback(async () => {
    setCompanionBusy(true);
    try {
      setCompanionStatus(await stopCompanion());
      setStatus({ kind: "success", message: "スマホ連携を停止しました。" });
    } catch (error: unknown) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCompanionBusy(false);
    }
  }, []);

  useEffect(() => {
    if (remoteMode) {
      return;
    }
    const refreshStatus = () => {
      void getCompanionStatus().then(setCompanionStatus).catch(() => undefined);
    };
    refreshStatus();
    if (!companionStatus.running) {
      return;
    }
    const interval = window.setInterval(refreshStatus, 2_000);
    return () => window.clearInterval(interval);
  }, [companionStatus.running, remoteMode]);

  useEffect(() => {
    if (!editorReady || (!remoteMode && !companionStatus.running)) {
      return;
    }

    let disposed = false;
    const poll = async () => {
      if (companionPushPendingRef.current || companionPushTimerRef.current) {
        return;
      }
      try {
        const snapshot = await getCompanionState();
        if (!disposed) {
          applyCompanionSnapshot(snapshot);
        }
      } catch (error: unknown) {
        if (disposed) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ kind: "error", message: `PCとの同期が止まりました。${message}` });
        if (remoteMode && !hasRemoteCompanionToken()) {
          window.location.reload();
        }
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), COMPANION_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [applyCompanionSnapshot, companionStatus.running, editorReady, remoteMode]);

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
      saveFileDocumentSession(filePath, documentText, isDirtyRef.current);
      return;
    }

    saveNewDocumentSession(documentText);
  }, []);

  useEffect(() => {
    const persistCurrentDraft = () => {
      saveCurrentDocumentSession(getEditorDocument());
    };
    const persistWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        persistCurrentDraft();
      }
    };

    window.addEventListener("beforeunload", persistCurrentDraft);
    document.addEventListener("visibilitychange", persistWhenHidden);
    return () => {
      window.removeEventListener("beforeunload", persistCurrentDraft);
      document.removeEventListener("visibilitychange", persistWhenHidden);
    };
  }, [getEditorDocument, saveCurrentDocumentSession]);

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
      saveFileDocumentSession(file.path, file.content, false);
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
      saveFileDocumentSession(savedPath, getEditorDocument(), false);
      if (companionStatusRef.current.running) {
        void updateCompanionDocument(
          getEditorDocument(),
          basename(savedPath),
          companionClientIdRef.current,
        ).then((snapshot) => {
          companionRevisionRef.current = Math.max(
            companionRevisionRef.current,
            snapshot.document.revision,
          );
        }).catch(() => undefined);
      }
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
      saveFileDocumentSession(savedPath, getEditorDocument(), false);
      if (companionStatusRef.current.running) {
        void updateCompanionDocument(
          getEditorDocument(),
          basename(savedPath),
          companionClientIdRef.current,
        ).then((snapshot) => {
          companionRevisionRef.current = Math.max(
            companionRevisionRef.current,
            snapshot.document.revision,
          );
        }).catch(() => undefined);
      }
      setStatus({ kind: "success", message: `${basename(savedPath)} を保存しました。` });
    } catch (error: unknown) {
      setStatus({ kind: "error", message: formatFileError(error) });
    }
  }, [getEditorDocument, markDocumentClean]);

  useEffect(() => {
    if (!editorReady || initialSession.kind !== "file" || initialFileRestoreStartedRef.current) {
      return;
    }

    if (initialSession.dirty) {
      initialFileRestoreStartedRef.current = true;
      setStatus({ kind: "warning", message: `${basename(initialSession.path)} の未保存の編集内容を復元しました。` });
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
        saveFileDocumentSession(file.path, file.content, false);
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
    if (remoteMode) {
      return;
    }
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
  }, [handleNewFile, handleOpenFile, handleSaveFile, handleSaveFileAs, remoteMode]);

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
      const conversion = await convertRomajiToJapaneseDetailed(
        resolved.matchedText,
        { ...settingsRef.current, inputCompletionLevel },
        undefined,
        {
          avoidOutputs: request.avoidOutputs,
          documentVocabulary: request.documentVocabulary,
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
      if (settingsRef.current.conversionMode === "ghost" || conversion.inputCompletionApplied) {
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
              inputCompletionLevel,
              inputCompletionApplied: conversion.inputCompletionApplied,
              inputCompletionSourceKana: conversion.inputCompletionSourceKana,
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
          message: conversion.inputCompletionApplied
            ? "入力補完候補を生成しました。Tab で確定、Esc で破棄できます。"
            : conversion.conversionStrategy === "completion"
              ? "補完変換候補を生成しました。Tab で確定、Ctrl/Cmd+/ で別候補を試せます。"
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
            ? "補完変換で変換しました。Ctrl/Cmd+/ で別候補を試せます。元に戻すとローマ字に戻ります。"
            : "変換しました。Ctrl/Cmd+/ で別候補を試せます。元に戻すとローマ字に戻ります。",
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
          "適用位置を解決できなかったため、履歴からの変換を適用しませんでした。",
        );
        return;
      }

      const inputCompletionLevel =
        request.inputCompletionLevel ?? settingsRef.current.inputCompletionLevel;
      const conversion = await convertRomajiToJapaneseDetailed(
        request.originalText,
        { ...settingsRef.current, inputCompletionLevel },
        undefined,
        {
          avoidOutputs: request.avoidOutputs,
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
      if (canceledRequestsRef.current.has(request.id)) {
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
            modelName: settingsRef.current.modelName,
            createdAt: Date.now(),
            source: "history",
            anchor: request.anchor,
            conversionStrategy: conversion.conversionStrategy,
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
              ? "補完変換で履歴から再変換しました。適用先がないため結果のみ保存しました。"
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

      if (settingsRef.current.conversionMode === "ghost" || conversion.inputCompletionApplied) {
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
            inputCompletionLevel,
            inputCompletionApplied: conversion.inputCompletionApplied,
            inputCompletionSourceKana: conversion.inputCompletionSourceKana,
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
          message: conversion.inputCompletionApplied
            ? "履歴から入力補完候補を生成しました。Tab で適用、Esc で破棄できます。"
            : conversion.conversionStrategy === "completion"
              ? "履歴から補完変換候補を生成しました。Tab で適用、Ctrl/Cmd+/ で別候補を試せます。"
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
            ? "補完変換で履歴の変換を適用しました。Ctrl/Cmd+/ で別候補を試せます。"
            : latestResolved.matchedBy === "nearby"
            ? "近くの一致位置に履歴の変換を適用しました。Ctrl/Cmd+/ で別候補を試せます。"
            : "履歴の変換を適用しました。Ctrl/Cmd+/ で別候補を試せます。",
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
      if (
        request.source === "history" &&
        hasDuplicatePendingHistoryConversion(conversionQueueRef.current, request)
      ) {
        setStatus({ kind: "warning", message: "同じ再変換はすでに処理待ちです。" });
        return false;
      }

      setRecentRetryItem(null);
      conversionQueueRef.current = [...conversionQueueRef.current, request];
      setPending([...conversionQueueRef.current]);
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
      message: suggestion.inputCompletionApplied
        ? "入力補完候補を確定しました。"
        : suggestion.conversionStrategy === "completion"
          ? "補完変換候補を確定しました。Ctrl/Cmd+/ で別候補を試せます。"
          : "変換候補を確定しました。Ctrl/Cmd+/ で別候補を試せます。",
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
        id: createId("conversion"),
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
        conversionStrategy: item.conversionStrategy,
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
    const request: PendingConversion = {
      id: createId("conversion"),
      anchor: item.anchor,
      originalText: item.input,
      createdAt: Date.now(),
      source: "history",
      status: "queued",
      retryOf: item.id,
      avoidOutputs: collectAvoidOutputs(item.avoidOutputs, item.output),
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

  const handleConvert = useCallback((range: ConversionRange) => {
    const view = editorViewRef.current;
    if (!view) {
      return false;
    }

    if (hasMatchingPendingEditorConversion(conversionQueueRef.current, range)) {
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
  }, [enqueueConversion]);

  const delayedPending = pending.filter((request) => now - request.createdAt >= CANCEL_UI_DELAY_MS);
  const settingsAttention = ollamaConnection.kind === "warning" || ollamaConnection.kind === "error";
  const enabledDictionaryCount = settings.userDictionary.filter(
    (entry) => entry.enabled && entry.reading.trim() && entry.output.trim(),
  ).length;

  return (
    <main className="app-shell">
      <AppTitleBar />
      <MarkdownEditor
        settings={settings}
        pending={pending}
        initialDocument={initialDocument}
        fileName={remoteMode ? remoteFileName : currentFilePath ? basename(currentFilePath) : "Untitled.md"}
        isDirty={isDirty}
        remoteMode={remoteMode}
        modelStatusLabel={
          remoteMode
            ? `PC · ${settings.modelName.trim() || "モデル"} · 同期中`
            : !setupComplete && !setupModelProvider
            ? "未設定"
            : formatModelStatusLabel(settings, ollamaConnection)
        }
        modelStatusKind={ollamaConnection.kind}
        onSettingsChange={setSettings}
        onOpenModelSettings={openModelSettings}
        onConvert={handleConvert}
        onDocumentChanged={handleDocumentChanged}
        onEditorStatusChange={setEditorStatus}
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
        remoteMode={remoteMode}
        companionRunning={companionStatus.running}
        onOpenHistory={toggleHistoryPanel}
        onOpenPrompt={togglePromptPanel}
        onOpenDictionary={toggleDictionaryPanel}
        onOpenSettings={toggleSettingsDrawer}
        onOpenCompanion={() => setActivePanel((panel) => panel === "companion" ? null : "companion")}
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
            <SettingsContent
              settings={settings}
              ollamaModels={ollamaModels}
              ollamaConnection={ollamaConnection}
              onChange={setSettings}
              onCheckOllama={handleCheckOllama}
              onProviderSelected={handleModelSettingsProviderSelected}
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
              inputCompletionLevel={settings.inputCompletionLevel}
              useDocumentVocabulary={settings.useDocumentVocabulary}
              documentVocabularyProfile={documentVocabularyProfile}
              onInputCompletionLevelChange={(inputCompletionLevel) =>
                setSettings((value) => ({ ...value, inputCompletionLevel }))
              }
              onUseDocumentVocabularyChange={(useDocumentVocabulary) =>
                setSettings((value) => ({ ...value, useDocumentVocabulary }))
              }
              onPresetChange={(conversionPreset) =>
                setSettings((value) => ({ ...value, conversionPreset }))
              }
              onChange={(conversionPrompt) =>
                setSettings((value) => ({ ...value, conversionPrompt }))
              }
              onReset={() =>
                setSettings((value) => ({ ...value, conversionPrompt: defaultConversionPrompt }))
              }
            />
          ) : null}
          {activePanel === "companion" && !remoteMode ? (
            <CompanionPanel
              status={companionStatus}
              busy={companionBusy}
              onStart={handleStartCompanion}
              onStop={handleStopCompanion}
            />
          ) : null}
        </InspectorDrawer>
      ) : null}
      {!setupComplete ? (
        <SetupModal
          mode="setup"
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
      {setupComplete && modelSettingsOpen && !remoteMode ? (
        <SetupModal
          mode="settings"
          settings={settings}
          ollamaModels={ollamaModels}
          ollamaConnection={ollamaConnection}
          setupModelProvider={null}
          onChange={setSettings}
          onCheckOllama={handleCheckOllama}
          onProviderSelected={handleModelSettingsProviderSelected}
          onComplete={closeModelSettings}
          onSkip={closeModelSettings}
        />
      ) : null}
      <StatusBar
        status={status}
        pending={delayedPending}
        pendingCount={pending.length}
        editorStatus={editorStatus}
        onCancel={cancelConversion}
        onOpenSettings={openSettingsDrawer}
      />
    </main>
  );
}

function RemotePairingScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("PCに表示されている6桁の接続コードを入力してください。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await pairRemoteCompanion(code);
      onPaired();
    } catch (pairingError: unknown) {
      clearRemoteCompanionToken();
      setError(pairingError instanceof Error ? pairingError.message : String(pairingError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pairing-page">
      <section className="pairing-sheet" aria-labelledby="pairing-title">
        <div className="pairing-brand" aria-hidden="true">
          <span className="app-logo">か</span>
          <span>Romaji Kana</span>
        </div>
        <div className="pairing-device-mark" aria-hidden="true">
          <Smartphone size={34} />
          <Link2 size={22} />
        </div>
        <h1 id="pairing-title">PCとつなぐ</h1>
        <p>PC版の「スマホ連携」に表示されている接続コードを入力してください。</p>
        <form onSubmit={submit} className="pairing-form">
          <label htmlFor="pairing-code">6桁の接続コード</label>
          <input
            id="pairing-code"
            value={code}
            onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            maxLength={6}
            autoFocus
          />
          {error ? <p className="pairing-error" role="alert">{error}</p> : null}
          <button className="primary-button pairing-submit" type="submit" disabled={busy || code.length !== 6}>
            {busy ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Link2 size={18} aria-hidden="true" />}
            {busy ? "接続しています..." : "PCに接続"}
          </button>
        </form>
        <small>文章と変換要求は同じWi-Fi内のPCとの間だけで送受信されます。</small>
      </section>
    </main>
  );
}

function CompanionPanel({
  status,
  busy,
  onStart,
  onStop,
}: {
  status: CompanionStatus;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      window.setTimeout(() => setCopiedUrl((current) => current === url ? null : current), 1_800);
    } catch {
      setCopiedUrl(null);
    }
  };

  return (
    <div className="companion-panel">
      <div className={`companion-state ${status.running ? "running" : "stopped"}`}>
        <span className="companion-state-icon" aria-hidden="true">
          {status.running ? <Wifi size={22} /> : <WifiOff size={22} />}
        </span>
        <div>
          <strong>{status.running ? "スマホから接続できます" : "スマホ連携は停止中です"}</strong>
          <p>
            {status.running
              ? `ペアリング済み ${status.pairedClients} 回。PCが文書と変換処理を担当します。`
              : "必要なときだけ開始できます。モデルAPIを直接ネットワークへ公開しません。"}
          </p>
        </div>
      </div>

      {status.running ? (
        <>
          <section className="companion-section" aria-labelledby="companion-url-title">
            <h3 id="companion-url-title">スマホで開くURL</h3>
            {status.urls.length > 0 ? (
              <div className="companion-url-list">
                {status.urls.map((url) => (
                  <div className="companion-url" key={url}>
                    <input value={url} readOnly aria-label="スマホ接続URL" />
                    <button className="secondary-button" type="button" onClick={() => void copyUrl(url)}>
                      {copiedUrl === url ? <CheckCircle2 size={16} aria-hidden="true" /> : null}
                      {copiedUrl === url ? "コピー済み" : "コピー"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="companion-note">LAN内のIPアドレスを取得できませんでした。Wi-Fi接続を確認してください。</p>
            )}
          </section>

          <section className="companion-code" aria-labelledby="companion-code-title">
            <div>
              <h3 id="companion-code-title">接続コード</h3>
              <p>スマホの接続画面に入力します。</p>
            </div>
            <output aria-label="6桁の接続コード">{status.pairCode ?? "------"}</output>
          </section>

          <ol className="companion-steps">
            <li>PCとスマホを同じWi-Fiへ接続</li>
            <li>スマホで上のURLを開く</li>
            <li>6桁の接続コードを入力</li>
          </ol>
        </>
      ) : null}

      <button
        className={status.running ? "secondary-button companion-toggle" : "primary-button companion-toggle"}
        type="button"
        disabled={busy}
        onClick={status.running ? onStop : onStart}
      >
        {busy ? <Loader2 className="spin" size={18} aria-hidden="true" /> : status.running ? <WifiOff size={18} aria-hidden="true" /> : <Wifi size={18} aria-hidden="true" />}
        {busy ? "処理しています..." : status.running ? "スマホ連携を停止" : "スマホ連携を開始"}
      </button>
      <p className="companion-security-note">公共Wi-Fiでは使用せず、利用後は連携を停止してください。</p>
    </div>
  );
}

function AppTitleBar() {
  return (
    <header className="app-titlebar" aria-label="アプリケーションヘッダー">
      <div className="app-brand">
        <span className="app-logo" aria-hidden="true">か</span>
        <span>Romaji Kana</span>
      </div>
    </header>
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
      className={`recent-retry-chip ${
        item.conversionStrategy === "completion" || item.inputCompletionApplied
          ? "completion"
          : ""
      }`}
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
          {item.inputCompletionApplied
            ? item.output
              ? `入力補完: ${item.output}`
              : "入力補完で生成しました"
            : item.conversionStrategy === "completion"
            ? item.output
              ? `補完変換: ${item.output}`
              : "補完変換で生成しました"
            : item.output
              ? `${item.output} の別候補を試す`
              : "別候補を試す"}
        </span>
        <kbd>Ctrl/Cmd+/</kbd>
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
  remoteMode,
  companionRunning,
  onOpenHistory,
  onOpenPrompt,
  onOpenDictionary,
  onOpenSettings,
  onOpenCompanion,
}: {
  historyCount: number;
  dictionaryCount: number;
  activePanel: ActivePanel;
  settingsAttention: boolean;
  remoteMode: boolean;
  companionRunning: boolean;
  onOpenHistory: () => void;
  onOpenPrompt: () => void;
  onOpenDictionary: () => void;
  onOpenSettings: () => void;
  onOpenCompanion: () => void;
}) {
  return (
    <nav className="app-rail" aria-label="アプリのツール">
      <button
        className={`rail-button ${activePanel === "settings" ? "active" : ""} ${settingsAttention ? "attention" : ""}`}
        type="button"
        onClick={onOpenSettings}
        aria-pressed={activePanel === "settings"}
        aria-label="設定を開く"
        title="設定"
      >
        <SlidersHorizontal size={18} aria-hidden="true" />
        <span>設定</span>
      </button>
      <button
        className={`rail-button ${activePanel === "history" ? "active" : ""}`}
        type="button"
        onClick={onOpenHistory}
        aria-pressed={activePanel === "history"}
        aria-label={`履歴を開く、${historyCount} 件`}
        title="履歴"
      >
        <History size={18} aria-hidden="true" />
        {historyCount > 0 ? <span className="rail-count">{historyCount}</span> : null}
        <span>履歴</span>
      </button>
      <button
        className={`rail-button ${activePanel === "dictionary" ? "active" : ""}`}
        type="button"
        onClick={onOpenDictionary}
        aria-pressed={activePanel === "dictionary"}
        aria-label={
          dictionaryCount > 0
            ? `辞書を開く、${dictionaryCount} 件有効`
            : "辞書を開く"
        }
        title="辞書"
      >
        <BookMarked size={18} aria-hidden="true" />
        {dictionaryCount > 0 ? <span className="rail-count">{dictionaryCount}</span> : null}
        <span>辞書</span>
      </button>
      <button
        className={`rail-button ${activePanel === "prompt" ? "active" : ""}`}
        type="button"
        onClick={onOpenPrompt}
        aria-pressed={activePanel === "prompt"}
        aria-label="変換スタイルを開く"
        title="変換スタイル"
      >
        <MessageSquareText size={18} aria-hidden="true" />
        <span>スタイル</span>
      </button>
      {!remoteMode ? (
        <button
          className={`rail-button ${activePanel === "companion" ? "active" : ""} ${companionRunning ? "connected" : ""}`}
          type="button"
          onClick={onOpenCompanion}
          aria-pressed={activePanel === "companion"}
          aria-label={companionRunning ? "スマホ連携を開く、連携中" : "スマホ連携を開く"}
          title="スマホ連携"
        >
          <Smartphone size={18} aria-hidden="true" />
          {companionRunning ? <span className="connection-dot" aria-hidden="true" /> : null}
          <span>スマホ</span>
        </button>
      ) : null}
    </nav>
  );
}

function formatModelStatusLabel(
  settings: AppSettings,
  ollamaConnection: OllamaConnectionStatus,
): string {
  const label = providerLabel(settings);
  const modelName = settings.modelName.trim() || "モデル未選択";

  if (ollamaConnection.kind === "connected") {
    return `${label} · ${modelName} · 接続済み`;
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
    return "設定";
  }
  if (panel === "history") {
    return "履歴";
  }
  if (panel === "dictionary") {
    return "辞書";
  }
  if (panel === "companion") {
    return "スマホ連携";
  }
  return "スタイル";
}

function panelEyebrow(panel: NonNullable<ActivePanel>): string {
  if (panel === "settings") {
    return "アプリ設定";
  }
  if (panel === "history") {
    return "変換履歴";
  }
  if (panel === "dictionary") {
    return "ユーザー辞書";
  }
  if (panel === "companion") {
    return "同じWi-Fiで接続";
  }
  return "変換スタイル";
}

function SetupModal({
  mode = "setup",
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
  mode?: "setup" | "settings";
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
  const isSetupMode = mode === "setup";
  const activeModelProvider = isSetupMode ? setupModelProvider : settings.modelProvider;
  const hasProvider = Boolean(activeModelProvider);
  const currentApiUrl =
    activeModelProvider === "lmstudio"
      ? settings.lmStudioApiUrl
      : activeModelProvider === "ollama"
        ? settings.ollamaApiUrl
        : "";
  const sortedModelNames = ollamaModels
    .map((model) => model.name)
    .sort((a, b) => a.localeCompare(b));

  const updateProvider = (modelProvider: ModelProvider) => {
    onChange({ ...settings, modelProvider });
    onProviderSelected(modelProvider);
  };

  const updateApiUrl = (apiUrl: string) => {
    if (activeModelProvider === "lmstudio") {
      onChange({ ...settings, lmStudioApiUrl: apiUrl });
      return;
    }
    if (activeModelProvider === "ollama") {
      onChange({ ...settings, ollamaApiUrl: apiUrl });
    }
  };

  return (
    <div className="settings-overlay setup-overlay">
      <section
        className="setup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-modal-title"
      >
        <header className="setup-modal-header">
          <div>
            <h2 id="setup-modal-title">
              {isSetupMode ? "最初のモデル設定" : "モデル設定"}
            </h2>
            <p>ローカル LLM の接続先とモデルを設定します。</p>
          </div>
          <button className="icon-button" type="button" onClick={onSkip} aria-label="モデル設定を閉じる">
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="setup-form">
          <fieldset className="field provider-field">
            <legend>プロバイダー</legend>
            <div className="segmented-control provider-control" role="radiogroup" aria-label="モデルプロバイダー">
              <label className={activeModelProvider === "ollama" ? "selected" : ""}>
                <input
                  type="radio"
                  name={`${mode}-provider`}
                  value="ollama"
                  checked={activeModelProvider === "ollama"}
                  onChange={() => updateProvider("ollama")}
                />
                <span>Ollama</span>
              </label>
              <label className={activeModelProvider === "lmstudio" ? "selected" : ""}>
                <input
                  type="radio"
                  name={`${mode}-provider`}
                  value="lmstudio"
                  checked={activeModelProvider === "lmstudio"}
                  onChange={() => updateProvider("lmstudio")}
                />
                <span>LM Studio</span>
              </label>
            </div>
          </fieldset>

          <label className="field">
            <span>API URL</span>
            <div className="setup-inline-control">
              <input
                value={currentApiUrl}
                disabled={!hasProvider}
                onChange={(event) => updateApiUrl(event.currentTarget.value)}
                placeholder={
                  activeModelProvider === "lmstudio"
                    ? "http://localhost:1234"
                    : activeModelProvider === "ollama"
                      ? "http://localhost:11434"
                      : "プロバイダーを選択してください"
                }
              />
              <button
                className="secondary-button"
                type="button"
                onClick={onCheckOllama}
                disabled={!hasProvider || ollamaConnection.kind === "checking"}
              >
                接続チェック
              </button>
            </div>
            <small>通常は localhost の既定URLのままで問題ありません。</small>
          </label>

          <label className="field">
            <span>モデル</span>
            <div className="setup-inline-control setup-model-row">
              <select
                value={hasProvider ? settings.modelName : ""}
                disabled={!hasProvider}
                onChange={(event) => onChange({ ...settings, modelName: event.currentTarget.value })}
              >
                <option value="">モデルを選択...</option>
                {sortedModelNames.map((modelName) => (
                  <option value={modelName} key={modelName}>{modelName}</option>
                ))}
              </select>
              <button
                className="icon-button setup-refresh"
                type="button"
                onClick={onCheckOllama}
                disabled={!hasProvider || ollamaConnection.kind === "checking"}
                aria-label="モデル一覧を更新"
              >
                <RotateCcw size={18} aria-hidden="true" />
              </button>
            </div>
          </label>

          <p className={`setup-connection-line ${ollamaConnection.kind}`}>
            <span aria-hidden="true" />
            {hasProvider ? ollamaConnection.message : "未接続"}
          </p>
        </div>
        <div className="setup-actions">
          <button className="secondary-button" type="button" onClick={onSkip}>
            {isSetupMode ? "あとで設定" : "キャンセル"}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={onComplete}
          >
            {isSetupMode ? "書き始める" : "完了"}
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
    <section className="floating-panel history-panel" aria-label="変換履歴">
      {pending.length > 0 ? (
        <div className="pending-list" aria-label="処理中の変換">
          {pending.map((request) => (
            <article className="pending-item" key={request.id}>
              <div className="pending-copy">
                <span className="pending-state">
                  <Loader2 size={13} className="spin" aria-hidden="true" />
                  {request.retryOf
                    ? request.status === "queued"
                      ? "再試行待ち"
                      : "別候補を生成中"
                    : request.status === "queued"
                    ? "待機中"
                    : request.source === "history"
                      ? "再適用中"
                      : "変換中"}
                </span>
                <p>{request.originalText}</p>
              </div>
              <button className="history-action-button" type="button" onClick={() => onCancel(request)}>
                キャンセル
              </button>
            </article>
          ))}
        </div>
      ) : null}

      {history.length === 0 ? (
        <p className="empty-state">
          この起動中に確定・適用した変換が最大100件残ります。選択範囲またはカーソルのある行は Ctrl/Cmd + Enter で変換できます。
        </p>
      ) : (
        <div className="history-list" role="list">
          {history.map((item) => (
            <article
              className={`history-item ${item.status}`}
              key={item.id}
              role="listitem"
              onBlur={() => onPreviewEnd(item)}
              onFocus={() => onPreview(item)}
              onMouseEnter={() => onPreview(item)}
              onMouseLeave={() => onPreviewEnd(item)}
            >
              <div className="history-meta">
                <span className="history-status">
                  <span className={`history-status-dot ${item.status}`} aria-hidden="true" />
                  {historyStatusLabel(item.status)}
                </span>
                {item.documentVocabulary?.length ? (
                  <span
                    className="history-vocabulary-badge"
                    title="この変換で参照した文書語彙"
                  >
                    文書語彙 {item.documentVocabulary.length}
                  </span>
                ) : null}
                <time dateTime={new Date(item.createdAt).toISOString()}>
                  {new Date(item.createdAt).toLocaleTimeString()}
                </time>
              </div>
              <dl className="history-lines">
                <div className="history-line">
                  <dt>入力</dt>
                  <dd>{item.input}</dd>
                </div>
                <div className="history-line">
                  <dt>{item.status === "success" ? "出力" : "結果"}</dt>
                  <dd>{item.output ?? item.error ?? "出力はありません。"}</dd>
                </div>
              </dl>
              <div className="rerun-meta">
                <span className="history-model">{item.modelName}</span>
                <span
                  className={`history-completion-level ${
                    item.inputCompletionApplied ? "applied" : ""
                  }`}
                  title={
                    item.inputCompletionApplied && item.inputCompletionSourceKana
                      ? `補完前: ${item.inputCompletionSourceKana}`
                      : "この変換で使用した入力補完レベル"
                  }
                >
                  {historyInputCompletionLabel(
                    item.inputCompletionLevel,
                    item.inputCompletionApplied,
                  )}
                </span>
                <button
                  className="history-action-button"
                  type="button"
                  title="同じ入力をもう一度変換します"
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
                  className="history-action-button"
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

function historyInputCompletionLabel(
  level: InputCompletionLevel | undefined,
  applied: boolean | undefined,
): string {
  if (level === "word") {
    return applied ? "単語補完・適用" : "単語補完・変更なし";
  }
  if (level === "sentence") {
    return applied ? "文章補完・適用" : "文章補完・変更なし";
  }
  return "入力どおり";
}

function PromptPanel({
  prompt,
  preset,
  inputCompletionLevel,
  useDocumentVocabulary,
  documentVocabularyProfile,
  onInputCompletionLevelChange,
  onUseDocumentVocabularyChange,
  onPresetChange,
  onChange,
  onReset,
}: {
  prompt: string;
  preset: ConversionPreset;
  inputCompletionLevel: InputCompletionLevel;
  useDocumentVocabulary: boolean;
  documentVocabularyProfile: DocumentVocabularyProfile;
  onInputCompletionLevelChange: (level: InputCompletionLevel) => void;
  onUseDocumentVocabularyChange: (enabled: boolean) => void;
  onPresetChange: (preset: ConversionPreset) => void;
  onChange: (prompt: string) => void;
  onReset: () => void;
}) {
  return (
    <section className="floating-panel prompt-panel" aria-label="変換スタイル">
      <div className="preset-panel-content">
        <fieldset className="input-completion-options">
          <legend>入力補完</legend>
          <p className="input-completion-intro">
            入力にない文字を、どこまでAIに補わせるかを選びます。
          </p>
          <div className="input-completion-levels">
            {INPUT_COMPLETION_OPTIONS.map((option) => (
              <label
                className={inputCompletionLevel === option ? "selected" : ""}
                key={option}
              >
                <input
                  type="radio"
                  name="input-completion-level"
                  value={option}
                  checked={inputCompletionLevel === option}
                  onChange={() => onInputCompletionLevelChange(option)}
                />
                <span>{inputCompletionLabels[option]}</span>
              </label>
            ))}
          </div>
          <div className="input-completion-preview" aria-live="polite">
            <span>{inputCompletionDescription(inputCompletionLevel)}</span>
            <code>{inputCompletionExample(inputCompletionLevel)}</code>
          </div>
          {inputCompletionLevel !== "none" ? (
            <p className="input-completion-safety">
              補完が発生した場合は、直接置換の設定でも候補として表示します。
            </p>
          ) : null}
        </fieldset>

        <fieldset className="document-vocabulary-options">
          <legend>文書語彙</legend>
          <label
            className={`document-vocabulary-toggle ${
              useDocumentVocabulary ? "selected" : ""
            }`}
          >
            <input
              type="checkbox"
              checked={useDocumentVocabulary}
              onChange={(event) =>
                onUseDocumentVocabularyChange(event.currentTarget.checked)
              }
            />
            <span>
              <strong>文書の語彙に合わせる</strong>
              <small>
                文書内の用語を、同じ読みの表記候補を選ぶときだけ参照します。
              </small>
            </span>
          </label>
          <div className="document-vocabulary-summary" aria-live="polite">
            {documentVocabularyProfile.terms.length > 0 ? (
              <>
                <p>
                  文書から {documentVocabularyProfile.terms.length} 語を自動抽出しました。
                </p>
                <div className="document-vocabulary-terms" aria-label="抽出した文書語彙">
                  {documentVocabularyProfile.terms.slice(0, 8).map((term) => (
                    <span key={term}>{term}</span>
                  ))}
                  {documentVocabularyProfile.terms.length > 8 ? (
                    <span>ほか {documentVocabularyProfile.terms.length - 8} 語</span>
                  ) : null}
                </div>
              </>
            ) : (
              <p>
                漢字・カタカナ・製品名などが文書に増えると、ここに候補が表示されます。
              </p>
            )}
          </div>
          {useDocumentVocabulary ? (
            <p className="document-vocabulary-safety">
              入力にない語の追加や、読みの変更には使いません。
            </p>
          ) : null}
        </fieldset>

        <fieldset className="preset-options">
          <legend className="sr-only">変換プリセット</legend>
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
            プロンプトはローカルストレージに自動保存されます。
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

function inputCompletionDescription(level: InputCompletionLevel): string {
  if (level === "word") {
    return "途中で切れた最後の単語だけを補います。";
  }
  if (level === "sentence") {
    return "助詞や文末を最小限補い、文章として整えます。";
  }
  return "入力の読みを変えず、そのまま変換します。";
}

function inputCompletionExample(level: InputCompletionLevel): string {
  if (level === "word") {
    return "ariga → ありがとう";
  }
  if (level === "sentence") {
    return "asita kaigi 10ji → 明日の会議は10時です";
  }
  return "ariga → ありが";
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
      <section className="dictionary-modal inspector-panel" aria-label="辞書項目">
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
          <p className="empty-state">辞書の登録はまだありません。</p>
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
                    aria-label={`辞書の読み ${index + 1}`}
                    value={entry.reading}
                    maxLength={80}
                    onChange={(event) =>
                      updateEntry(entry.id, { reading: event.currentTarget.value })
                    }
                  />
                  <input
                    aria-label={`辞書の出力 ${index + 1}`}
                    value={entry.output}
                    maxLength={80}
                    onChange={(event) =>
                      updateEntry(entry.id, { output: event.currentTarget.value })
                    }
                  />
                  <input
                    aria-label={`辞書のメモ ${index + 1}`}
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
  return createId(prefix);
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

function StatusBar({
  status,
  pending,
  pendingCount,
  editorStatus,
  onCancel,
  onOpenSettings,
}: {
  status: ConversionStatus;
  pending: PendingConversion[];
  pendingCount: number;
  editorStatus: EditorDocumentStatus;
  onCancel: (request: PendingConversion) => void;
  onOpenSettings: () => void;
}) {
  const Icon =
    status.kind === "loading" ? Loader2 : status.kind === "error" ? AlertCircle : CheckCircle2;
  const canOpenSettings = status.kind === "warning" || status.kind === "error";
  const hasStatusActions = canOpenSettings || Boolean(pending[0]) || pendingCount > 0;

  return (
    <div className={`status-bar ${status.kind} ${hasStatusActions ? "has-actions" : ""}`}>
      <div className="status-main" role="status" aria-live="polite">
        <Icon size={16} className={status.kind === "loading" ? "spin" : ""} aria-hidden="true" />
        <span className="status-message">{status.message}</span>
      </div>
      <div className="status-side">
        {hasStatusActions ? (
        <div className="status-actions">
          {canOpenSettings ? (
            <button className="status-settings" type="button" onClick={onOpenSettings}>
              設定を開く
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
        <div className="status-meta" aria-label="文書情報">
          <span>行 {editorStatus.line}, 列 {editorStatus.column}</span>
          <span>
            {editorStatus.selectionCount > 0
              ? `${editorStatus.selectionCount} 文字選択`
              : `${editorStatus.characterCount} 文字`}
          </span>
          <span>UTF-8</span>
          <span>Markdown</span>
        </div>
      </div>
    </div>
  );
}

function formatConversionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network|failed|ECONNREFUSED|Load failed/i.test(message)) {
    return "選択中のローカルモデルプロバイダーに接続できません。設定した URL で起動しているか確認してください。";
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
