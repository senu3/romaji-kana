import type { EditorView } from "@codemirror/view";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
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
import type { AppSettings, ConversionRange, ConversionStatus, PendingConversion } from "./lib/types";

function App() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof localStorage === "undefined") {
      return defaultSettings;
    }
    return loadSettings();
  });
  const [pending, setPending] = useState<PendingConversion[]>([]);
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
        onConvert={handleConvert}
        onDocumentChanged={handleDocumentChanged}
        registerView={registerView}
      />
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
