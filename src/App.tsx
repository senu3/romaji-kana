import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import {
  AppRail,
  AppTitleBar,
  formatModelStatusLabel,
  InspectorDrawer,
  StatusBar,
} from "./components/AppChrome";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { CompanionPanel } from "./components/CompanionPanel";
import { ConversionPanel } from "./components/ConversionPanel";
import { DictionaryModal } from "./components/DictionaryModal";
import { HistoryPanel, RecentRetryChip } from "./components/HistoryPanel";
import { type EditorDocumentStatus, MarkdownEditor } from "./components/MarkdownEditor";
import { RemotePairingScreen } from "./components/RemotePairingScreen";
import { SettingsContent } from "./components/SettingsPanel";
import { SetupModal } from "./components/SetupModal";
import { useCompanionSync } from "./hooks/useCompanionSync";
import { useConversion } from "./hooks/useConversion";
import { useDocumentFiles } from "./hooks/useDocumentFiles";
import { useDocumentSession } from "./hooks/useDocumentSession";
import { useModelConnection } from "./hooks/useModelConnection";
import { useModelSetup } from "./hooks/useModelSetup";
import type { ActivePanel } from "./lib/appTypes";
import { hasRemoteCompanionToken, isRemoteCompanionClient } from "./lib/companion";
import { buildDocumentVocabularyProfile } from "./lib/documentVocabulary";
import { basename } from "./lib/fileSystem";
import { defaultConversionPrompt } from "./lib/prompts";
import { defaultSettings, loadSettings, saveSettings } from "./lib/settings";
import type { AppSettings, ConversionStatus } from "./lib/types";

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

function EditorApp({ remoteMode }: { remoteMode: boolean }) {
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof localStorage === "undefined") {
      return defaultSettings;
    }
    return loadSettings();
  });

  const [activePanel, setActivePanel] = useState<ActivePanel>(null);

  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);

  const [status, setStatus] = useState<ConversionStatus>({
    kind: "idle",
    message: "準備完了。入力が止まると変換候補を生成します。Tab で確定できます。",
  });

  const [editorReady, setEditorReady] = useState(false);

  const editorViewRef = useRef<EditorView | null>(null);

  const settingsRef = useRef(settings);

  const {
    docVersionRef,
    saveCurrentDocumentSession,
    initialDocument,
    currentFilePathRef,
    setDocumentVocabularyProfile,
    replaceDocumentContent,
    persistDocumentChange,
    persistRemoteDocument,
    getEditorDocument,
    confirmDiscardUnsavedChanges,
    setCurrentFilePath,
    markDocumentClean,
    initialSession,
    currentFilePath,
    isDirty,
    documentVocabularyProfile,
  } = useDocumentSession({ remoteMode, editorViewRef });

  const [editorStatus, setEditorStatus] = useState<EditorDocumentStatus>({
    line: 1,
    column: 1,
    lineCount: 1,
    characterCount: initialDocument.length,
    selectionCount: 0,
  });

  const { setupComplete, setupCompleteRef, completeSetup } = useModelSetup();

  const {
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
  } = useConversion({
    editorViewRef,
    settingsRef,
    setStatus,
    saveCurrentDocumentSession,
    docVersionRef,
    activePanel,
    setupComplete,
  });

  useEffect(() => {
    invalidatePredictiveSuggestions();
    settingsRef.current = settings;
    saveSettings(settings);
  }, [invalidatePredictiveSuggestions, settings]);

  const {
    ollamaConnection,
    setupModelProvider,
    ollamaModels,
    handleCheckOllama,
    handleModelSettingsProviderSelected,
    handleSetupProviderSelected,
  } = useModelConnection({
    setupComplete,
    setupCompleteRef,
    settings,
    settingsRef,
    setStatus,
    setSettings,
    remoteMode,
  });

  const replaceEditorDocument = useCallback((content: string) => {
    if (!editorViewRef.current) return;
    clearPendingConversions();
    replaceDocumentContent(content);
  }, [clearPendingConversions, replaceDocumentContent]);

  const applyRemoteDocument = useCallback((content: string) => {
    replaceEditorDocument(content);
    persistRemoteDocument(content);
  }, [replaceEditorDocument, persistRemoteDocument]);

  const {
    syncDocumentChange,
    notifyDocumentSaved,
    remoteFileName,
    companionStatus,
    companionBusy,
    handleStartCompanion,
    handleStopCompanion,
  } = useCompanionSync({
    remoteMode,
    settings,
    setStatus,
    currentFilePathRef,
    settingsRef,
    setSettings,
    editorViewRef,
    applyRemoteDocument,
    getEditorDocument,
    editorReady,
  });

  const handleDocumentChanged = useCallback((documentText: string) => {
    persistDocumentChange(documentText);
    syncDocumentChange(documentText);
  }, [persistDocumentChange, syncDocumentChange]);

  const { handleNewFile, handleOpenFile, handleSaveFile, handleSaveFileAs } = useDocumentFiles({
    confirmDiscardUnsavedChanges,
    currentFilePathRef,
    replaceEditorDocument,
    setCurrentFilePath,
    markDocumentClean,
    setStatus,
    getEditorDocument,
    notifyDocumentSaved,
    editorReady,
    initialSession,
    remoteMode,
  });

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

  const toggleConversionPanel = useCallback(() => {
    const documentText = editorViewRef.current?.state.doc.toString();
    if (documentText !== undefined) {
      const profile = buildDocumentVocabularyProfile(documentText);
      setDocumentVocabularyProfile(profile);
    }
    setActivePanel((panel) => {
      return panel === "conversion" ? null : "conversion";
    });
  }, []);

  const toggleDictionaryPanel = useCallback(() => {
    setActivePanel((panel) => {
      return panel === "dictionary" ? null : "dictionary";
    });
  }, []);

  const toggleModelDrawer = useCallback(() => {
    setActivePanel((panel) => {
      return panel === "model" ? null : "model";
    });
  }, []);

  const openModelDrawer = useCallback(() => {
    setActivePanel("model");
  }, []);

  const openModelSettings = useCallback(() => {
    setModelSettingsOpen(true);
  }, []);

  const closeModelSettings = useCallback(() => {
    setModelSettingsOpen(false);
  }, []);

  const modelAttention = ollamaConnection.kind === "warning" || ollamaConnection.kind === "error";

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
        onDismissGhost={handleDismissGhost}
        onRetryGhost={handleRetryGhost}
        onRetryRecent={retryRecentConversion}
        registerView={registerView}
      />
      <AppRail
        historyCount={history.length}
        dictionaryCount={enabledDictionaryCount}
        activePanel={activePanel}
        modelAttention={modelAttention}
        remoteMode={remoteMode}
        companionRunning={companionStatus.running}
        onOpenHistory={toggleHistoryPanel}
        onOpenConversion={toggleConversionPanel}
        onOpenDictionary={toggleDictionaryPanel}
        onOpenModel={toggleModelDrawer}
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
          {activePanel === "model" ? (
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
              documentVocabularyProfile={documentVocabularyProfile}
              useDocumentVocabulary={settings.useDocumentVocabulary}
              onUseDocumentVocabularyChange={(useDocumentVocabulary) =>
                setSettings((value) => ({ ...value, useDocumentVocabulary }))
              }
              onChange={(userDictionary) => setSettings((value) => ({ ...value, userDictionary }))}
            />
          ) : null}
          {activePanel === "conversion" ? (
            <ConversionPanel
              settings={settings}
              remoteMode={remoteMode}
              onChange={setSettings}
              onResetPrompt={() =>
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
        onOpenModel={openModelDrawer}
      />
    </main>
  );
}

export default App;
