import type { EditorView } from "@codemirror/view";
import { AlertCircle, CheckCircle2, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import {
  addLoadingDecoration,
  MarkdownEditor,
  removeLoadingDecoration,
} from "./components/MarkdownEditor";
import { SettingsPanel } from "./components/SettingsPanel";
import { convertRomajiToJapanese } from "./lib/ollama";
import { defaultSettings, loadSettings, saveSettings } from "./lib/settings";
import type {
  AppSettings,
  ConversionHistoryItem,
  ConversionRange,
  ConversionStatus,
  PendingConversion,
} from "./lib/types";

type ActivePanel = "history" | "prompt" | null;

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
  const [status, setStatus] = useState<ConversionStatus>({
    kind: "idle",
    message: "Ready. Type romaji and finish with punctuation, or press Ctrl+Enter.",
  });
  const [settingsCollapsed, setSettingsCollapsed] = useState(false);
  const editorViewRef = useRef<EditorView | null>(null);
  const settingsRef = useRef(settings);
  const docVersionRef = useRef(0);

  useEffect(() => {
    settingsRef.current = settings;
    saveSettings(settings);
  }, [settings]);

  const registerView = useCallback((view: EditorView | null) => {
    editorViewRef.current = view;
  }, []);

  const handleDocumentChanged = useCallback(() => {
    docVersionRef.current += 1;
  }, []);

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

  const handleConvert = useCallback((range: ConversionRange) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    const request: PendingConversion = {
      id: crypto.randomUUID(),
      range,
      originalText: range.text,
      createdAt: Date.now(),
      docVersion: docVersionRef.current,
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
        const currentView = editorViewRef.current;
        if (!currentView) {
          return;
        }

        const currentText = currentView.state.doc.sliceString(range.from, range.to);
        if (currentText !== request.originalText) {
          setStatus({
            kind: "warning",
            message: "Skipped an older conversion because the text changed.",
          });
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
        setHistory((items) => [
          {
            id: request.id,
            input: request.originalText,
            output: converted,
            modelName: settingsRef.current.modelName,
            createdAt: Date.now(),
          },
          ...items,
        ]);
        setStatus({ kind: "success", message: "Converted. Undo returns to romaji." });
      })
      .catch((error: unknown) => {
        setStatus({
          kind: "error",
          message: formatConversionError(error),
        });
      })
      .finally(() => {
        const currentView = editorViewRef.current;
        if (currentView) {
          currentView.dispatch({
            effects: removeLoadingDecoration.of(request.id),
          });
        }
        setPending((items) => items.filter((item) => item.id !== request.id));
      });
  }, []);

  return (
    <main className="app-shell">
      <MarkdownEditor
        settings={settings}
        pending={pending}
        historyCount={history.length}
        onConvert={handleConvert}
        onDocumentChanged={handleDocumentChanged}
        onOpenHistory={toggleHistoryPanel}
        onOpenPrompt={togglePromptPanel}
        registerView={registerView}
      />
      {activePanel === "history" ? (
        <HistoryPanel history={history} onClose={closeActivePanel} />
      ) : null}
      {activePanel === "prompt" ? (
        <PromptPanel
          prompt={settings.conversionPrompt}
          onChange={(conversionPrompt) => setSettings((value) => ({ ...value, conversionPrompt }))}
          onClose={closeActivePanel}
        />
      ) : null}
      <SettingsPanel
        settings={settings}
        collapsed={settingsCollapsed}
        onToggleCollapsed={() => setSettingsCollapsed((value) => !value)}
        onChange={setSettings}
      />
      <StatusBar status={status} pendingCount={pending.length} />
    </main>
  );
}

function HistoryPanel({
  history,
  onClose,
}: {
  history: ConversionHistoryItem[];
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

      {history.length === 0 ? (
        <p className="empty-state">No conversions in this open history panel yet.</p>
      ) : (
        <div className="history-list">
          {history.map((item) => (
            <article className="history-item" key={item.id}>
              <div className="history-meta">
                <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
                <span>{item.modelName}</span>
              </div>
              <dl>
                <div>
                  <dt>Romaji</dt>
                  <dd>{item.input}</dd>
                </div>
                <div>
                  <dt>Japanese</dt>
                  <dd>{item.output}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function PromptPanel({
  prompt,
  onChange,
  onClose,
}: {
  prompt: string;
  onChange: (prompt: string) => void;
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
      <p className="panel-note">
        This prompt is saved locally and used for the next Ollama conversion.
      </p>
    </section>
  );
}

function StatusBar({
  status,
  pendingCount,
}: {
  status: ConversionStatus;
  pendingCount: number;
}) {
  const Icon =
    status.kind === "loading" ? Loader2 : status.kind === "error" ? AlertCircle : CheckCircle2;

  return (
    <div className={`status-bar ${status.kind}`} role="status" aria-live="polite">
      <Icon size={16} className={status.kind === "loading" ? "spin" : ""} aria-hidden="true" />
      <span>{status.message}</span>
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

export default App;
