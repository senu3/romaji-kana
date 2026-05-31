import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { Compartment, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { ChevronDown, FileText, FolderOpen, History, MessageSquareText, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  extractConversionRange,
  isTriggerEnabled,
  triggerFromCharacter,
} from "../lib/conversion";
import type { AppSettings, ConversionRange, ConversionTrigger, PendingConversion } from "../lib/types";

interface MarkdownEditorProps {
  settings: AppSettings;
  pending: PendingConversion[];
  historyCount: number;
  initialDocument: string;
  fileName: string;
  isDirty: boolean;
  onConvert: (range: ConversionRange) => void;
  onDocumentChanged: (documentText: string) => void;
  onOpenFile: () => void;
  onSaveFile: () => void;
  onSaveFileAs: () => void;
  onOpenHistory: () => void;
  onOpenPrompt: () => void;
  registerView: (view: EditorView | null) => void;
}

export const addLoadingDecoration = StateEffect.define<{ id: string; from: number; to: number }>();
export const removeLoadingDecoration = StateEffect.define<string>();

const loadingDecorations = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, transaction) {
    let decorations = value.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (effect.is(addLoadingDecoration)) {
        decorations = decorations.update({
          add: [
            Decoration.mark({
              class: "cm-conversion-loading",
              id: effect.value.id,
            }).range(effect.value.from, effect.value.to),
          ],
        });
      }

      if (effect.is(removeLoadingDecoration)) {
        decorations = decorations.update({
          filter: (_from, _to, decoration) => decoration.spec.id !== effect.value,
        });
      }
    }

    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "#134e4a",
    backgroundColor: "#ffffff",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: "15px",
    lineHeight: "1.75",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "28px 32px",
    caretColor: "#0d9488",
  },
  ".cm-line": {
    padding: "0 2px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#99f6e4",
  },
  ".cm-gutters": {
    backgroundColor: "#f8fafc",
    color: "#64748b",
    borderRight: "1px solid #dbe4e8",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#ccfbf1",
  },
  ".cm-activeLine": {
    backgroundColor: "#f0fdfa",
  },
  ".cm-placeholder": {
    color: "#94a3b8",
  },
  ".cm-conversion-loading": {
    backgroundColor: "#ccfbf1",
    borderBottom: "2px solid #0d9488",
    borderRadius: "3px",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "#0f766e", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.link, color: "#0d9488", textDecoration: "underline" },
  { tag: tags.monospace, color: "#9a3412", backgroundColor: "#fff7ed" },
]);

export function MarkdownEditor({
  settings,
  pending,
  historyCount,
  initialDocument,
  fileName,
  isDirty,
  onConvert,
  onDocumentChanged,
  onOpenFile,
  onSaveFile,
  onSaveFileAs,
  onOpenHistory,
  onOpenPrompt,
  registerView,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onConvertRef = useRef(onConvert);
  const onDocumentChangedRef = useRef(onDocumentChanged);
  const initialDocumentRef = useRef(initialDocument);
  const settingsRef = useRef(settings);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);

  const updateListener = useMemo(() => {
    return EditorView.updateListener.of((update) => {
      if (!update.docChanged) {
        return;
      }

      onDocumentChangedRef.current(update.state.doc.toString());
      const userEvent = update.transactions
        .map((transaction) => transaction.annotation(Transaction.userEvent))
        .find(Boolean);
      if (userEvent?.startsWith("document.")) {
        return;
      }

      if (!settingsRef.current.autoConvert) {
        return;
      }

      const cursor = update.state.selection.main.head;
      const previousChar = update.state.doc.sliceString(cursor - 1, cursor);
      const trigger = triggerFromCharacter(previousChar);
      if (!trigger || !isTriggerEnabled(trigger, settingsRef.current)) {
        return;
      }

      const range = extractConversionRange(update.state.doc.toString(), cursor, trigger);
      if (range) {
        onConvertRef.current(range);
      }
    });
  }, []);

  const shortcutCompartment = useMemo(() => new Compartment(), []);

  useEffect(() => {
    onConvertRef.current = onConvert;
    onDocumentChangedRef.current = onDocumentChanged;
    settingsRef.current = settings;
  }, [onConvert, onDocumentChanged, settings]);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const manualConvert = (view: EditorView, trigger: ConversionTrigger) => {
      const cursor = view.state.selection.main.head;
      const range = extractConversionRange(view.state.doc.toString(), cursor, trigger);
      if (range) {
        onConvertRef.current(range);
      }
      return true;
    };

    const state = EditorState.create({
      doc: initialDocumentRef.current,
      extensions: [
        history(),
        markdown(),
        loadingDecorations,
        theme,
        syntaxHighlighting(highlightStyle),
        placeholder("Romaji de nihongo wo kaitte kudasai..."),
        updateListener,
        shortcutCompartment.of(
          keymap.of([
            {
              key: settingsRef.current.triggers.manualShortcut,
              run: (view) => manualConvert(view, "shortcut"),
            },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state,
      parent: hostRef.current,
    });

    viewRef.current = view;
    registerView(view);

    return () => {
      registerView(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [registerView, shortcutCompartment, updateListener]);

  useEffect(() => {
    if (!fileMenuOpen) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!fileMenuRef.current?.contains(event.target as Node)) {
        setFileMenuOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFileMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [fileMenuOpen]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    view.dispatch({
      effects: shortcutCompartment.reconfigure(
        keymap.of([
          {
            key: settings.triggers.manualShortcut,
            run: (editorView) => {
              const range = extractConversionRange(
                editorView.state.doc.toString(),
                editorView.state.selection.main.head,
                "shortcut",
              );
              if (range) {
                onConvertRef.current(range);
              }
              return true;
            },
          },
        ]),
      ),
    });
  }, [settings.triggers.manualShortcut, shortcutCompartment]);

  const runFileAction = (action: () => void) => {
    setFileMenuOpen(false);
    action();
  };

  return (
    <section className="editor-shell" aria-label="Markdown editor">
      <div className="editor-toolbar">
        <div className="editor-title-block">
          <p className="eyebrow">Markdown</p>
          <h1>Romaji Kana</h1>
          <div className="file-row">
            <p className="file-label" title={fileName}>
              {fileName}
            </p>
            {isDirty ? <span className="dirty-chip">Unsaved</span> : null}
          </div>
        </div>
        <div className="editor-actions" aria-label="Editor actions">
          <div className="toolbar-menu" ref={fileMenuRef}>
            <button
              aria-expanded={fileMenuOpen}
              aria-haspopup="menu"
              className="pill pill-action"
              type="button"
              onClick={() => setFileMenuOpen((open) => !open)}
            >
              <FileText size={15} aria-hidden="true" />
              File
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {fileMenuOpen ? (
              <div className="toolbar-menu-items" role="menu" aria-label="File actions">
                <button type="button" role="menuitem" onClick={() => runFileAction(onOpenFile)}>
                  <FolderOpen size={15} aria-hidden="true" />
                  Open Markdown...
                </button>
                <button type="button" role="menuitem" onClick={() => runFileAction(onSaveFile)}>
                  <Save size={15} aria-hidden="true" />
                  Save
                </button>
                <button type="button" role="menuitem" onClick={() => runFileAction(onSaveFileAs)}>
                  <Save size={15} aria-hidden="true" />
                  Save As...
                </button>
              </div>
            ) : null}
          </div>
          <button className="pill pill-action" type="button" onClick={onOpenHistory}>
            <History size={15} aria-hidden="true" />
            {pending.length > 0 ? `${pending.length} converting` : `${historyCount} History`}
          </button>
          <button className="pill pill-action" type="button" onClick={onOpenPrompt}>
            <MessageSquareText size={15} aria-hidden="true" />
            Prompt
          </button>
        </div>
      </div>
      <div className="editor-host" ref={hostRef} />
    </section>
  );
}
