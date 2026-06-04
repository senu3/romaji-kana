import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { Compartment, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  ChevronDown,
  FileText,
  FolderOpen,
  History,
  MessageSquareText,
  Redo2,
  Save,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  extractConversionRange,
  isTriggerEnabled,
  triggerFromCharacter,
} from "../lib/conversion";
import type {
  AppSettings,
  ConversionRange,
  ConversionTrigger,
  GhostConversionSuggestion,
  PendingConversion,
} from "../lib/types";

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
  onAcceptGhost: (suggestion: GhostConversionSuggestion) => void;
  registerView: (view: EditorView | null) => void;
}

export const addLoadingDecoration = StateEffect.define<{ id: string; from: number; to: number }>();
export const removeLoadingDecoration = StateEffect.define<string>();
export const showGhostSuggestion = StateEffect.define<GhostConversionSuggestion>();
export const clearGhostSuggestion = StateEffect.define<string | null>();

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

interface GhostState {
  suggestion: GhostConversionSuggestion | null;
  decorations: DecorationSet;
}

class GhostTextWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-ghost-text";
    element.title = "Press Tab to accept, Esc to dismiss";

    const suggestion = document.createElement("span");
    suggestion.className = "cm-ghost-text-suggestion";
    suggestion.textContent = `  ${this.text}`;

    const hint = document.createElement("span");
    hint.className = "cm-ghost-text-hint";
    hint.textContent = "Tab accept / Esc dismiss";

    element.append(suggestion, hint);
    return element;
  }

  ignoreEvent() {
    return true;
  }
}

export const ghostSuggestionField = StateField.define<GhostState>({
  create() {
    return { suggestion: null, decorations: Decoration.none };
  },
  update(value, transaction) {
    let suggestion = value.suggestion;

    if (suggestion && transaction.docChanged) {
      const from = transaction.changes.mapPos(suggestion.from, 1);
      const to = transaction.changes.mapPos(suggestion.to, -1);
      const mapped = { ...suggestion, from, to };
      const currentText = transaction.state.doc.sliceString(from, to);
      suggestion = currentText === mapped.originalText ? mapped : null;
    }

    for (const effect of transaction.effects) {
      if (effect.is(showGhostSuggestion)) {
        suggestion = effect.value;
      }

      if (effect.is(clearGhostSuggestion)) {
        if (!effect.value || suggestion?.id === effect.value) {
          suggestion = null;
        }
      }
    }

    return {
      suggestion,
      decorations: buildGhostDecorations(suggestion),
    };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function buildGhostDecorations(suggestion: GhostConversionSuggestion | null): DecorationSet {
  if (!suggestion) {
    return Decoration.none;
  }

  return Decoration.set([
    Decoration.mark({ class: "cm-ghost-source" }).range(suggestion.from, suggestion.to),
    Decoration.widget({
      widget: new GhostTextWidget(suggestion.convertedText),
      side: 1,
    }).range(suggestion.to),
  ]);
}

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
  ".cm-ghost-source": {
    backgroundColor: "#f8fafc",
    borderBottom: "1px dashed #0d9488",
    borderRadius: "3px",
  },
  ".cm-ghost-text": {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    color: "#0f766e",
    fontStyle: "italic",
    whiteSpace: "pre-wrap",
  },
  ".cm-ghost-text-suggestion": {
    opacity: "0.58",
  },
  ".cm-ghost-text-hint": {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "20px",
    border: "1px solid #b5d7d1",
    borderRadius: "999px",
    padding: "1px 7px",
    backgroundColor: "#f8fffd",
    color: "#0f766e",
    fontFamily: '"Plus Jakarta Sans", Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: "11px",
    fontStyle: "normal",
    fontWeight: "750",
    opacity: "0.86",
    verticalAlign: "middle",
    whiteSpace: "nowrap",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "#0f766e", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.link, color: "#0d9488", textDecoration: "underline" },
  { tag: tags.monospace, color: "#9a3412", backgroundColor: "#fff7ed" },
]);

const COMPOSITION_END_GRACE_MS = 120;

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
  onAcceptGhost,
  registerView,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onConvertRef = useRef(onConvert);
  const onDocumentChangedRef = useRef(onDocumentChanged);
  const onAcceptGhostRef = useRef(onAcceptGhost);
  const initialDocumentRef = useRef(initialDocument);
  const settingsRef = useRef(settings);
  const composingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
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
      if (
        userEvent === "input.convert" ||
        userEvent === "input.historyApply" ||
        userEvent === "input.ghostAccept"
      ) {
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
  const enterTriggerHandler = useMemo(() => {
    return EditorView.domEventHandlers({
      compositionstart() {
        composingRef.current = true;
      },
      compositionend() {
        composingRef.current = false;
        lastCompositionEndAtRef.current = Date.now();
      },
      keydown(event, view) {
        if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
          return false;
        }
        if (!settingsRef.current.autoConvert || !settingsRef.current.triggers.enter) {
          return false;
        }
        if (
          event.isComposing ||
          composingRef.current ||
          Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_GRACE_MS
        ) {
          return false;
        }

        const cursor = view.state.selection.main.head;
        const range = extractConversionRange(view.state.doc.toString(), cursor, "enter");
        if (!range) {
          return false;
        }

        onConvertRef.current(range);
        return true;
      },
    });
  }, []);

  useEffect(() => {
    onConvertRef.current = onConvert;
    onDocumentChangedRef.current = onDocumentChanged;
    onAcceptGhostRef.current = onAcceptGhost;
    settingsRef.current = settings;
  }, [onAcceptGhost, onConvert, onDocumentChanged, settings]);

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
        ghostSuggestionField,
        theme,
        syntaxHighlighting(highlightStyle),
        placeholder("Romaji de nihongo wo kaitte kudasai..."),
        updateListener,
        enterTriggerHandler,
        shortcutCompartment.of(
          keymap.of([
            {
              key: "Tab",
              run: acceptGhostSuggestion,
            },
            {
              key: "Escape",
              run: dismissGhostSuggestion,
            },
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
  }, [enterTriggerHandler, registerView, shortcutCompartment, updateListener]);

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
          {
            key: "Tab",
            run: acceptGhostSuggestion,
          },
          {
            key: "Escape",
            run: dismissGhostSuggestion,
          },
        ]),
      ),
    });
  }, [settings.triggers.manualShortcut, shortcutCompartment]);

  function acceptGhostSuggestion(view: EditorView) {
    const state = view.state.field(ghostSuggestionField);
    const suggestion = state.suggestion;
    if (!suggestion) {
      return false;
    }

    const currentText = view.state.doc.sliceString(suggestion.from, suggestion.to);
    if (currentText !== suggestion.originalText) {
      view.dispatch({ effects: clearGhostSuggestion.of(suggestion.id) });
      return true;
    }

    view.dispatch({
      changes: {
        from: suggestion.from,
        to: suggestion.to,
        insert: suggestion.convertedText,
      },
      selection: { anchor: suggestion.from + suggestion.convertedText.length },
      effects: clearGhostSuggestion.of(suggestion.id),
      userEvent: "input.ghostAccept",
    });
    onAcceptGhostRef.current(suggestion);
    return true;
  }

  function dismissGhostSuggestion(view: EditorView) {
    const state = view.state.field(ghostSuggestionField);
    const suggestion = state.suggestion;
    if (!suggestion) {
      return false;
    }

    view.dispatch({ effects: clearGhostSuggestion.of(suggestion.id) });
    return true;
  }

  const runFileAction = (action: () => void) => {
    setFileMenuOpen(false);
    action();
  };

  const runEditorCommand = (command: (view: EditorView) => boolean) => {
    const view = viewRef.current;
    if (view) {
      command(view);
      view.focus();
    }
  };

  return (
    <section className="editor-shell" aria-label="Markdown editor">
      <div className="editor-toolbar">
        <div className="editor-title-block">
          <p className="eyebrow">Markdown</p>
          <h1>Romaji Kana</h1>

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
            Style
          </button>
        </div>
      </div>
      <div className="editor-filebar" aria-label="Editor document bar">
        <div className="editor-filebar-side">
          <button
            className="editor-chrome-button"
            type="button"
            onClick={() => runEditorCommand(undo)}
            aria-label="Undo"
            title="Undo"
          >
            <Undo2 size={16} aria-hidden="true" />
          </button>
          <button
            className="editor-chrome-button"
            type="button"
            onClick={() => runEditorCommand(redo)}
            aria-label="Redo"
            title="Redo"
          >
            <Redo2 size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="editor-filebar-title" title={fileName}>
          <span>{fileName}</span>
          {isDirty ? <span className="dirty-chip">Unsaved</span> : null}
        </div>
        <div className="editor-filebar-side editor-filebar-side-right" aria-hidden="true" />
      </div>
      <div className="editor-host" ref={hostRef} />
    </section>
  );
}
