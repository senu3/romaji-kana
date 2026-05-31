import type { EditorView } from "@codemirror/view";
import { AlertCircle, CheckCircle2, Loader2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import {
  addLoadingDecoration,
  clearGhostSuggestion,
  MarkdownEditor,
  removeLoadingDecoration,
  showGhostSuggestion,
} from "./components/MarkdownEditor";
import { SettingsPanel } from "./components/SettingsPanel";
import { loadDocument, saveDocument } from "./lib/documentStore";
import { basename, openMarkdownFile, saveMarkdownFile } from "./lib/fileSystem";
import { resolveConversionAnchor } from "./lib/historyAnchor";
import { convertRomajiToJapanese } from "./lib/ollama";
import { checkOllamaConnection } from "./lib/ollamaConnection";
import { defaultConversionPrompt } from "./lib/prompts";
import { defaultSettings, loadSettings, saveSettings } from "./lib/settings";
import type {
  AppSettings,
  ConversionAnchor,
  ConversionHistoryItem,
  ConversionRange,
  ConversionStatus,
  GhostConversionSuggestion,
  OllamaConnectionStatus,
  OllamaModel,
  PendingConversion,
} from "./lib/types";

type ActivePanel = "history" | "prompt" | null;
const CANCEL_UI_DELAY_MS = 1_200;

function App() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof localStorage === "undefined") {
      return defaultSettings;
    }
    return loadSettings();
  });
  const [pending, setPending] = useState<PendingConversion[]>([]);
  const [history, setHistory] = useState<ConversionHistoryItem[]>([]);
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [now, setNow] = useState(() => Date.now());
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaConnection, setOllamaConnection] = useState<OllamaConnectionStatus>({
    kind: "idle",
    message: "Ollama has not been checked yet.",
  });
  const [initialDocument] = useState(() => {
    if (typeof localStorage === "undefined") {
      return "";
    }
    return loadDocument();
  });
  const [status, setStatus] = useState<ConversionStatus>({
    kind: "idle",
    message: "Ready. Type romaji and finish with punctuation, or press Ctrl+Enter.",
  });
  const [settingsCollapsed, setSettingsCollapsed] = useState(false);
  const editorViewRef = useRef<EditorView | null>(null);
  const settingsRef = useRef(settings);
  const docVersionRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionCheckIdRef = useRef(0);
  const startupCheckStartedRef = useRef(false);
  const canceledRequestsRef = useRef(new Set<string>());
  const suppressNextDirtyRef = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
    saveSettings(settings);
  }, [settings]);

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

  const registerView = useCallback((view: EditorView | null) => {
    editorViewRef.current = view;
  }, []);

  const handleDocumentChanged = useCallback((documentText: string) => {
    docVersionRef.current += 1;
    if (suppressNextDirtyRef.current) {
      suppressNextDirtyRef.current = false;
    } else {
      setIsDirty(true);
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveDocument(documentText);
      saveTimerRef.current = null;
    }, 250);
  }, []);

  const handleCheckOllama = useCallback(async () => {
    const checkId = connectionCheckIdRef.current + 1;
    connectionCheckIdRef.current = checkId;
    const modelName = settingsRef.current.modelName.trim() || "the selected model";

    setOllamaConnection({
      kind: "checking",
      message: `Checking Ollama and loading ${modelName}...`,
    });
    setStatus({
      kind: "loading",
      message: `Checking Ollama and loading ${modelName}...`,
    });

    try {
      const result = await checkOllamaConnection(settingsRef.current);
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      setOllamaModels(result.models);
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

      const message = formatOllamaConnectionError(error);
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
    if (startupCheckStartedRef.current) {
      return;
    }
    startupCheckStartedRef.current = true;
    void handleCheckOllama();
  }, [handleCheckOllama]);

  const closeActivePanel = useCallback(() => {
    if (activePanel === "history") {
      setHistory([]);
    }
    setActivePanel(null);
  }, [activePanel]);

  const toggleHistoryPanel = useCallback(() => {
    setActivePanel((panel) => {
      if (panel === "history") {
        setHistory([]);
        return null;
      }
      return "history";
    });
  }, []);

  const togglePromptPanel = useCallback(() => {
    setActivePanel((panel) => {
      if (panel === "history") {
        setHistory([]);
      }
      return panel === "prompt" ? null : "prompt";
    });
  }, []);

  const getEditorDocument = useCallback(() => {
    return editorViewRef.current?.state.doc.toString() ?? "";
  }, []);

  const replaceEditorDocument = useCallback((content: string) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

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
  }, []);

  const handleOpenFile = useCallback(async () => {
    try {
      const file = await openMarkdownFile();
      if (!file) {
        return;
      }

      replaceEditorDocument(file.content);
      setCurrentFilePath(file.path);
      setIsDirty(false);
      saveDocument(file.content);
      setStatus({ kind: "success", message: `Opened ${basename(file.path)}.` });
    } catch (error: unknown) {
      setStatus({ kind: "error", message: formatFileError(error) });
    }
  }, [replaceEditorDocument]);

  const handleSaveFile = useCallback(async () => {
    try {
      const savedPath = await saveMarkdownFile(getEditorDocument(), currentFilePath);
      if (!savedPath) {
        return;
      }

      setCurrentFilePath(savedPath);
      setIsDirty(false);
      setStatus({ kind: "success", message: `Saved ${basename(savedPath)}.` });
    } catch (error: unknown) {
      setStatus({ kind: "error", message: formatFileError(error) });
    }
  }, [currentFilePath, getEditorDocument]);

  const handleSaveFileAs = useCallback(async () => {
    try {
      const savedPath = await saveMarkdownFile(getEditorDocument(), null);
      if (!savedPath) {
        return;
      }

      setCurrentFilePath(savedPath);
      setIsDirty(false);
      setStatus({ kind: "success", message: `Saved ${basename(savedPath)}.` });
    } catch (error: unknown) {
      setStatus({ kind: "error", message: formatFileError(error) });
    }
  }, [getEditorDocument]);

  const cancelConversion = useCallback((request: PendingConversion) => {
    canceledRequestsRef.current.add(request.id);
    setPending((items) => items.filter((item) => item.id !== request.id));
    setHistory((items) => [
      {
        id: request.id,
        status: "canceled",
        input: request.originalText,
        error: "Canceled by user.",
        modelName: settingsRef.current.modelName,
        createdAt: Date.now(),
        source: request.source,
        anchor: request.anchor,
      },
      ...items,
    ]);
    setStatus({ kind: "warning", message: "Conversion canceled." });

    const view = editorViewRef.current;
    if (view) {
      view.dispatch({ effects: removeLoadingDecoration.of(request.id) });
    }
  }, []);

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
      saveDocument(view.state.doc.toString());
    }

    setHistory((items) => [
      {
        id: suggestion.id,
        status: "success",
        input: suggestion.inputText,
        output: suggestion.convertedText,
        modelName: settingsRef.current.modelName,
        createdAt: Date.now(),
        source: suggestion.source,
        anchor: nextAnchor,
      },
      ...items,
    ]);
    setStatus({ kind: "success", message: "Ghost suggestion accepted. Undo returns to romaji." });
  }, []);

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
        source: "history",
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
    };

    setPending((items) => [...items, request]);
    setStatus({ kind: "loading", message: `Re-converting "${item.input}"` });

    convertRomajiToJapanese(item.input, settingsRef.current)
      .then((converted) => {
        if (canceledRequestsRef.current.has(request.id)) {
          return;
        }

        const currentView = editorViewRef.current;
        if (!currentView || !item.anchor) {
          setHistory((items) => [
            {
              id: request.id,
              status: "success",
              input: request.originalText,
              output: converted,
              modelName: settingsRef.current.modelName,
              createdAt: Date.now(),
              source: "history",
              anchor: item.anchor,
            },
            ...items,
          ]);
          setStatus({
            kind: "success",
            message: "History conversion re-run. No editor anchor was available to apply.",
          });
          return;
        }

        const resolved = resolveConversionAnchor(currentView.state.doc.toString(), item.anchor);
        if (!resolved) {
          setHistory((items) => [
            {
              id: request.id,
              status: "skipped",
              input: request.originalText,
              error: "Not applied because the original location changed or became ambiguous.",
              modelName: settingsRef.current.modelName,
              createdAt: Date.now(),
              source: "history",
              anchor: item.anchor,
            },
            ...items,
          ]);
          setStatus({
            kind: "warning",
            message: "History conversion was not applied because the anchor could not be resolved.",
          });
          return;
        }

        if (settingsRef.current.conversionMode === "ghost") {
          currentView.dispatch({
            effects: showGhostSuggestion.of({
              id: request.id,
              from: resolved.from,
              to: resolved.to,
              originalText: resolved.matchedText,
              convertedText: converted,
              inputText: item.input,
              source: "history",
            }),
          });
          setStatus({ kind: "success", message: "History suggestion ready. Press Tab to apply." });
          return;
        }

        currentView.dispatch({
          changes: {
            from: resolved.from,
            to: resolved.to,
            insert: converted,
          },
          userEvent: "input.historyApply",
        });
        saveDocument(currentView.state.doc.toString());

        const nextAnchor: ConversionAnchor = {
          from: resolved.from,
          to: resolved.from + converted.length,
          originalText: item.input,
          appliedText: converted,
          docVersion: docVersionRef.current,
        };

        setHistory((items) => [
          {
            id: request.id,
            status: "success",
            input: request.originalText,
            output: converted,
            modelName: settingsRef.current.modelName,
            createdAt: Date.now(),
            source: "history",
            anchor: nextAnchor,
          },
          ...items,
        ]);
        setStatus({
          kind: "success",
          message:
            resolved.matchedBy === "nearby"
              ? "History conversion applied at a nearby matching anchor."
              : "History conversion applied.",
        });
      })
      .catch((error: unknown) => {
        if (canceledRequestsRef.current.has(request.id)) {
          return;
        }

        const message = formatConversionError(error);
        setHistory((items) => [
          {
            id: request.id,
            status: "error",
            input: request.originalText,
            error: message,
            modelName: settingsRef.current.modelName,
            createdAt: Date.now(),
            source: "history",
            anchor: item.anchor,
          },
          ...items,
        ]);
        setStatus({ kind: "error", message });
      })
      .finally(() => {
        canceledRequestsRef.current.delete(request.id);
        setPending((items) => items.filter((pendingItem) => pendingItem.id !== request.id));
      });
  }, []);

  const handleConvert = useCallback((range: ConversionRange) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
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
    };

    setPending((items) => [...items, request]);
    setStatus({ kind: "loading", message: `Converting "${range.text}"` });
    view.dispatch({
      effects: addLoadingDecoration.of({
        id: request.id,
        from: range.from,
        to: range.to,
      }),
    });

    convertRomajiToJapanese(range.text, settingsRef.current)
      .then((converted) => {
        if (canceledRequestsRef.current.has(request.id)) {
          return;
        }

        const currentView = editorViewRef.current;
        if (!currentView) {
          return;
        }

        const currentText = currentView.state.doc.sliceString(range.from, range.to);
        if (currentText !== request.originalText) {
          setHistory((items) => [
            {
              id: request.id,
              status: "skipped",
              input: request.originalText,
              error: "Skipped because the source text changed before Ollama responded.",
              modelName: settingsRef.current.modelName,
              createdAt: Date.now(),
              source: "editor",
              anchor: request.anchor,
            },
            ...items,
          ]);
          setStatus({
            kind: "warning",
            message: "Skipped an older conversion because the text changed.",
          });
          return;
        }

        if (settingsRef.current.conversionMode === "ghost") {
          currentView.dispatch({
            effects: [
              removeLoadingDecoration.of(request.id),
              showGhostSuggestion.of({
                id: request.id,
                from: range.from,
                to: range.to,
                originalText: request.originalText,
                convertedText: converted,
                inputText: request.originalText,
                source: "editor",
              }),
            ],
          });
          setStatus({ kind: "success", message: "Ghost suggestion ready. Press Tab to accept." });
          return;
        }

        currentView.dispatch({
          changes: {
            from: range.from,
            to: range.to,
            insert: converted,
          },
          effects: removeLoadingDecoration.of(request.id),
          userEvent: "input.convert",
        });
        saveDocument(currentView.state.doc.toString());
        const nextAnchor: ConversionAnchor = {
          from: range.from,
          to: range.from + converted.length,
          originalText: request.originalText,
          appliedText: converted,
          docVersion: docVersionRef.current,
        };
        setHistory((items) => [
          {
            id: request.id,
            status: "success",
            input: request.originalText,
            output: converted,
            modelName: settingsRef.current.modelName,
            createdAt: Date.now(),
            source: "editor",
            anchor: nextAnchor,
          },
          ...items,
        ]);
        setStatus({ kind: "success", message: "Converted. Undo returns to romaji." });
      })
      .catch((error: unknown) => {
        if (canceledRequestsRef.current.has(request.id)) {
          return;
        }

        const message = formatConversionError(error);
        setHistory((items) => [
          {
            id: request.id,
            status: "error",
            input: request.originalText,
            error: message,
            modelName: settingsRef.current.modelName,
            createdAt: Date.now(),
            source: "editor",
            anchor: request.anchor,
          },
          ...items,
        ]);
        setStatus({
          kind: "error",
          message,
        });
      })
      .finally(() => {
        canceledRequestsRef.current.delete(request.id);
        const currentView = editorViewRef.current;
        if (currentView) {
          currentView.dispatch({
            effects: removeLoadingDecoration.of(request.id),
          });
        }
        setPending((items) => items.filter((item) => item.id !== request.id));
      });
  }, []);

  const delayedPending = pending.filter((request) => now - request.createdAt >= CANCEL_UI_DELAY_MS);

  return (
    <main className="app-shell">
      <MarkdownEditor
        settings={settings}
        pending={pending}
        historyCount={history.length}
        initialDocument={initialDocument}
        fileName={currentFilePath ? basename(currentFilePath) : "Unsaved draft"}
        isDirty={isDirty}
        onConvert={handleConvert}
        onDocumentChanged={handleDocumentChanged}
        onOpenFile={handleOpenFile}
        onSaveFile={handleSaveFile}
        onSaveFileAs={handleSaveFileAs}
        onOpenHistory={toggleHistoryPanel}
        onOpenPrompt={togglePromptPanel}
        onAcceptGhost={handleAcceptGhost}
        registerView={registerView}
      />
      {activePanel === "history" ? (
        <HistoryPanel
          history={history}
          pending={delayedPending}
          onCancel={cancelConversion}
          onRerun={handleRerunHistory}
          onPreview={previewHistoryGhost}
          onPreviewEnd={clearHistoryGhost}
          onClose={closeActivePanel}
        />
      ) : null}
      {activePanel === "prompt" ? (
        <PromptPanel
          prompt={settings.conversionPrompt}
          onChange={(conversionPrompt) => setSettings((value) => ({ ...value, conversionPrompt }))}
          onReset={() =>
            setSettings((value) => ({ ...value, conversionPrompt: defaultConversionPrompt }))
          }
          onClose={closeActivePanel}
        />
      ) : null}
      <SettingsPanel
        settings={settings}
        ollamaModels={ollamaModels}
        ollamaConnection={ollamaConnection}
        collapsed={settingsCollapsed}
        onToggleCollapsed={() => setSettingsCollapsed((value) => !value)}
        onChange={setSettings}
        onCheckOllama={handleCheckOllama}
      />
      <StatusBar
        status={status}
        pending={delayedPending}
        pendingCount={pending.length}
        onCancel={cancelConversion}
      />
    </main>
  );
}

function HistoryPanel({
  history,
  pending,
  onCancel,
  onRerun,
  onPreview,
  onPreviewEnd,
  onClose,
}: {
  history: ConversionHistoryItem[];
  pending: PendingConversion[];
  onCancel: (request: PendingConversion) => void;
  onRerun: (item: ConversionHistoryItem) => void;
  onPreview: (item: ConversionHistoryItem) => void;
  onPreviewEnd: (item: ConversionHistoryItem) => void;
  onClose: () => void;
}) {
  return (
    <section className="floating-panel history-panel" aria-label="history">
      <div className="floating-panel-header">
        <div>
          <p className="eyebrow">Conversion log</p>
          <h2>History</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close history">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {pending.length > 0 ? (
        <div className="pending-list" aria-label="Slow conversions">
          {pending.map((request) => (
            <article className="pending-item" key={request.id}>
              <div>
                <strong>{request.source === "history" ? "Re-applying" : "Converting"}</strong>
                <p>{request.originalText}</p>
              </div>
              <button className="secondary-button" type="button" onClick={() => onCancel(request)}>
                Cancel
              </button>
            </article>
          ))}
        </div>
      ) : null}

      {history.length === 0 ? (
        <p className="empty-state">No conversions in this open history panel yet.</p>
      ) : (
        <div className="history-list">
          {history.map((item) => (
            <button
              className={`history-item ${item.status}`}
              type="button"
              key={item.id}
              onClick={() => {
                onPreviewEnd(item);
                onRerun(item);
                onClose();
              }}
              onBlur={() => onPreviewEnd(item)}
              onFocus={() => onPreview(item)}
              onMouseEnter={() => onPreview(item)}
              onMouseLeave={() => onPreviewEnd(item)}
              title={
                item.anchor
                  ? "Click to re-convert and apply this item"
                  : "Click to re-run this conversion"
              }
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
                  <dt>{item.status === "success" ? "Japanese" : "Result"}</dt>
                  <dd>{item.output ?? item.error ?? "No output."}</dd>
                </div>
              </dl>
              <div className="rerun-meta">
                <span>{item.modelName}</span>
                <span className="rerun-hint">
                  <RotateCcw size={13} aria-hidden="true" />
                  {item.anchor ? "Apply again" : "Re-run"}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function historyStatusLabel(status: ConversionHistoryItem["status"]): string {
  if (status === "success") {
    return "Success";
  }
  if (status === "error") {
    return "Failed";
  }
  if (status === "skipped") {
    return "Skipped";
  }
  return "Canceled";
}

function PromptPanel({
  prompt,
  onChange,
  onReset,
  onClose,
}: {
  prompt: string;
  onChange: (prompt: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <section className="floating-panel prompt-panel" aria-label="Conversion prompt editor">
      <div className="floating-panel-header">
        <div>
          <p className="eyebrow">System prompt</p>
          <h2>Prompt</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close prompt">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <label className="prompt-editor">
        <span>Japanese conversion instructions</span>
        <textarea
          value={prompt}
          onChange={(event) => onChange(event.currentTarget.value)}
          spellCheck={false}
        />
      </label>
      <div className="panel-actions">
        <button className="secondary-button" type="button" onClick={onReset}>
          Reset to default
        </button>
      </div>
      <p className="panel-note">
        This prompt is saved locally. Romaji table and few-shots are auto-appended.
      </p>
    </section>
  );
}

function StatusBar({
  status,
  pending,
  pendingCount,
  onCancel,
}: {
  status: ConversionStatus;
  pending: PendingConversion[];
  pendingCount: number;
  onCancel: (request: PendingConversion) => void;
}) {
  const Icon =
    status.kind === "loading" ? Loader2 : status.kind === "error" ? AlertCircle : CheckCircle2;

  return (
    <div className={`status-bar ${status.kind}`} role="status" aria-live="polite">
      <Icon size={16} className={status.kind === "loading" ? "spin" : ""} aria-hidden="true" />
      <span>{status.message}</span>
      {pending[0] ? (
        <button className="status-cancel" type="button" onClick={() => onCancel(pending[0])}>
          Cancel slow conversion
        </button>
      ) : null}
      {pendingCount > 0 ? <strong>{pendingCount} pending</strong> : null}
    </div>
  );
}

function formatConversionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network|failed|ECONNREFUSED|Load failed/i.test(message)) {
    return "Could not reach Ollama. Confirm it is running at the configured URL.";
  }
  return message || "Conversion failed.";
}

function formatOllamaConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) {
    return "Ollama connection check timed out. Confirm Ollama is running and the selected model can load.";
  }
  if (/fetch|network|failed|ECONNREFUSED|Load failed/i.test(message)) {
    return "Could not reach Ollama. Confirm it is running at the configured URL.";
  }
  return message || "Ollama connection check failed.";
}

function formatFileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "File operation failed.");
}

export default App;
