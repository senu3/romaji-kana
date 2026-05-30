import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { Search, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import {
  extractConversionRange,
  isTriggerEnabled,
  triggerFromCharacter,
} from "../lib/conversion";
import type { AppSettings, ConversionRange, ConversionTrigger, PendingConversion } from "../lib/types";

interface MarkdownEditorProps {
  settings: AppSettings;
  pending: PendingConversion[];
  onConvert: (range: ConversionRange) => void;
  onDocumentChanged: () => void;
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
  onConvert,
  onDocumentChanged,
  registerView,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onConvertRef = useRef(onConvert);
  const onDocumentChangedRef = useRef(onDocumentChanged);
  const settingsRef = useRef(settings);

  const updateListener = useMemo(() => {
    return EditorView.updateListener.of((update) => {
      if (!update.docChanged) {
        return;
      }

      onDocumentChangedRef.current();
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
      doc: "anatahadonnakotogasukidesuka.\n\n## memo\n- kyouhayoi tenkidesu.",
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

  return (
    <section className="editor-shell" aria-label="Markdown editor">
      <div className="editor-toolbar">
        <div>
          <p className="eyebrow">Markdown</p>
          <h1>Romaji Kana</h1>
        </div>
        <div className="editor-actions" aria-label="Editor status">
          <span className="pill">
            <WandSparkles size={15} aria-hidden="true" />
            {pending.length} converting
          </span>
          <span className="pill">
            <Search size={15} aria-hidden="true" />
            Plain text
          </span>
        </div>
      </div>
      <div className="editor-host" ref={hostRef} />
    </section>
  );
}
