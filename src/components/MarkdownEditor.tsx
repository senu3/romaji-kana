import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { Compartment, EditorState, Prec, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  lineNumbers,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  ChevronDown,
  FilePlus2,
  FileText,
  FolderOpen,
  Link2,
  Redo2,
  Save,
  Search,
  Undo2,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  extractConversionRange,
  extractSelectedConversionRange,
  isTriggerEnabled,
  punctuationSuffixForGhostCommit,
  triggerFromCharacter,
} from "../lib/conversion";
import {
  inputPauseDurationMs,
  MAX_TYPING_INTERVAL_MS,
  MIN_TYPING_INTERVAL_MS,
  TYPING_SPEED_SAMPLE_SIZE,
} from "../lib/predictiveSuggestions";
import type {
  AppSettings,
  ConversionRange,
  ConversionTrigger,
  GhostConversionSuggestion,
  OllamaConnectionStatus,
  PendingConversion,
} from "../lib/types";

interface MarkdownEditorProps {
  settings: AppSettings;
  pending: PendingConversion[];
  initialDocument: string;
  fileName: string;
  isDirty: boolean;
  modelStatusLabel: string;
  modelStatusKind: OllamaConnectionStatus["kind"];
  remoteMode?: boolean;
  onSettingsChange: (settings: AppSettings) => void;
  onOpenModelSettings: () => void;
  onConvert: (range: ConversionRange) => boolean;
  onDocumentChanged: (documentText: string) => void;
  onEditorStatusChange: (status: EditorDocumentStatus) => void;
  onNewFile: () => void;
  onOpenFile: () => void;
  onSaveFile: () => void;
  onSaveFileAs: () => void;
  onAcceptGhost: (suggestion: GhostConversionSuggestion) => void;
  onDismissGhost: () => void;
  onRetryGhost: (suggestion: GhostConversionSuggestion) => void;
  onRetryRecent: () => boolean;
  registerView: (view: EditorView | null) => void;
}

export interface EditorDocumentStatus {
  line: number;
  column: number;
  lineCount: number;
  characterCount: number;
  selectionCount: number;
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
  constructor(
    private readonly text: string,
    private readonly conversionStrategy: GhostConversionSuggestion["conversionStrategy"],
    private readonly inputCompletionLevel: GhostConversionSuggestion["inputCompletionLevel"],
    private readonly inputCompletionAdditions: string[],
  ) {
    super();
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-ghost-text";
    element.title =
      this.conversionStrategy === "speculative"
        ? "推測候補。Tab で確定、Esc で破棄"
        : this.inputCompletionLevel === "word"
        ? "単語サジェスト。Tab または句読点で確定、Ctrl/Cmd+/ で別候補、Esc で破棄"
        : this.inputCompletionLevel === "sentence"
        ? "文章サジェスト。Tab または句読点で確定、Ctrl/Cmd+/ で別候補、Esc で破棄"
        : this.conversionStrategy === "completion"
        ? "補完変換候補。Tab または句読点で確定、Ctrl/Cmd+/ で別候補、Esc で破棄"
        : "Tab または句読点で確定、Ctrl/Cmd+/ で別候補、Esc で破棄";

    const suggestion = document.createElement("span");
    suggestion.className = "cm-ghost-text-suggestion";
    suggestion.textContent = `  ${this.text}`;

    const hint = document.createElement("span");
    hint.className = "cm-ghost-text-hint";
    hint.textContent =
      this.conversionStrategy === "speculative"
        ? "推測候補  Tabで確定  Escで破棄"
        : this.inputCompletionLevel === "word"
        ? "単語サジェスト  Tab/句読点で確定  Ctrl/Cmd+/で別候補"
        : this.inputCompletionLevel === "sentence"
        ? "文章サジェスト  Tab/句読点で確定  Ctrl/Cmd+/で別候補"
        : this.conversionStrategy === "completion"
        ? "補完変換  Tab/句読点で確定  Ctrl/Cmd+/で別候補"
        : "Tab/句読点で確定  Ctrl/Cmd+/で別候補";

    element.append(suggestion);
    if (this.inputCompletionAdditions.length > 0) {
      const diff = document.createElement("span");
      diff.className = "cm-ghost-text-diff";
      const visibleAdditions = this.inputCompletionAdditions.slice(0, 3);
      const additions = visibleAdditions
        .map((addition) => `「${addition}」`)
        .join("・");
      const remainingCount = this.inputCompletionAdditions.length - visibleAdditions.length;
      diff.textContent = `補完 +${additions}${remainingCount > 0 ? ` ほか${remainingCount}件` : ""}`;
      diff.setAttribute(
        "aria-label",
        `入力補完で追加: ${this.inputCompletionAdditions.join("、")}`,
      );
      element.append(diff);
    }
    element.append(hint);
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

  const sourceDecoration = Decoration.mark({
    class: suggestion.previewOnly ? "cm-history-preview" : "cm-ghost-source",
  }).range(suggestion.from, suggestion.to);

  if (suggestion.previewOnly) {
    return Decoration.set([sourceDecoration]);
  }

  return Decoration.set([
    sourceDecoration,
    Decoration.widget({
      widget: new GhostTextWidget(
        suggestion.convertedText,
        suggestion.conversionStrategy,
        suggestion.inputCompletionLevel,
        suggestion.inputCompletionAdditions ?? [],
      ),
      side: 1,
    }).range(suggestion.to),
  ]);
}

const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "#123f3b",
    backgroundColor: "#ffffff",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: "15.5px",
    lineHeight: "1.82",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "44px 54px",
    caretColor: "#0d9488",
  },
  ".cm-line": {
    padding: "0 2px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#b8ece4",
  },
  ".cm-gutters": {
    backgroundColor: "#fbfdfc",
    color: "#718782",
    borderRight: "1px solid #dde9e6",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#e7f8f3",
  },
  ".cm-activeLine": {
    backgroundColor: "#f7fbfa",
  },
  ".cm-placeholder": {
    color: "#617872",
  },
  ".cm-conversion-loading": {
    backgroundColor: "#d8f7ef",
    borderBottom: "2px solid #0d9488",
    borderRadius: "3px",
  },
  ".cm-ghost-source": {
    backgroundColor: "#f3f8f6",
    borderBottom: "1px dashed #0d9488",
    borderRadius: "3px",
  },
  ".cm-ghost-text": {
    color: "#0f766e",
    fontStyle: "italic",
    whiteSpace: "pre-wrap",
  },
  ".cm-ghost-text-suggestion": {
    opacity: "0.58",
    marginRight: "8px",
  },
  ".cm-ghost-text-diff": {
    display: "inline-flex",
    alignItems: "center",
    minHeight: "20px",
    marginRight: "6px",
    border: "1px solid #e2b45e",
    borderRadius: "6px",
    padding: "1px 6px",
    backgroundColor: "#fff8e8",
    color: "#7a4d0b",
    fontFamily: '"MPLUS2", Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: "11px",
    fontStyle: "normal",
    fontWeight: "750",
    verticalAlign: "middle",
    whiteSpace: "nowrap",
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
  ".cm-history-preview": {
    backgroundColor: "#e8f5f2",
    borderBottom: "1px solid #5aa79d",
    borderRadius: "3px",
  },
  ".cm-panels": {
    backgroundColor: "#fbfdfc",
    color: "#123f3b",
    fontFamily: '"MPLUS2", Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: "13px",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "1px solid #dbe8e4",
  },
  ".cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    padding: "8px 12px",
  },
  ".cm-search br": {
    display: "none",
  },
  ".cm-search .cm-textfield": {
    width: "min(180px, 34vw)",
    minHeight: "32px",
    border: "1px solid #b8d5cf",
    borderRadius: "6px",
    padding: "5px 8px",
    backgroundColor: "#ffffff",
    color: "#123f3b",
    outline: "none",
  },
  ".cm-search .cm-textfield:focus": {
    borderColor: "#0f766e",
    boxShadow: "0 0 0 2px #ccfbf1",
  },
  ".cm-search .cm-button": {
    minHeight: "32px",
    border: "1px solid #b8d5cf",
    borderRadius: "6px",
    padding: "5px 9px",
    backgroundImage: "none",
    backgroundColor: "#ffffff",
    color: "#0f766e",
    fontSize: "12px",
    fontWeight: "700",
  },
  ".cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    whiteSpace: "nowrap",
  },
  '.cm-search button[name="close"]': {
    position: "static",
    marginLeft: "auto",
    color: "#617872",
    fontSize: "18px",
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
const editorPhrases = EditorState.phrases.of({
  Find: "検索",
  Replace: "置換",
  next: "次へ",
  previous: "前へ",
  all: "すべて選択",
  "match case": "大文字・小文字を区別",
  regexp: "正規表現",
  "by word": "単語単位",
  replace: "置換",
  "replace all": "すべて置換",
  close: "閉じる",
  "Go to line": "行へ移動",
  go: "移動",
});
const AUTO_TRIGGER_SUPPRESSED_USER_EVENTS = new Set([
  "input.convert",
  "input.historyApply",
  "input.ghostAccept",
  "input.speculativeDismiss",
]);

interface PredictiveRequestMarker {
  from: number;
  text: string;
}

type PredictiveRequestReason = "pause" | "space";

function singleInsertedCharacter(update: ViewUpdate): string | null {
  let changedRangeCount = 0;
  let deletedText = false;
  let insertedText = "";

  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changedRangeCount += 1;
    deletedText ||= fromA !== toA;
    insertedText += inserted.toString();
  });

  return changedRangeCount === 1 && !deletedText && Array.from(insertedText).length === 1
    ? insertedText
    : null;
}

export function MarkdownEditor({
  settings,
  pending,
  initialDocument,
  fileName,
  isDirty,
  modelStatusLabel,
  modelStatusKind,
  remoteMode = false,
  onSettingsChange,
  onOpenModelSettings,
  onConvert,
  onDocumentChanged,
  onEditorStatusChange,
  onNewFile,
  onOpenFile,
  onSaveFile,
  onSaveFileAs,
  onAcceptGhost,
  onDismissGhost,
  onRetryGhost,
  onRetryRecent,
  registerView,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onConvertRef = useRef(onConvert);
  const onDocumentChangedRef = useRef(onDocumentChanged);
  const onEditorStatusChangeRef = useRef(onEditorStatusChange);
  const onAcceptGhostRef = useRef(onAcceptGhost);
  const onDismissGhostRef = useRef(onDismissGhost);
  const onRetryGhostRef = useRef(onRetryGhost);
  const onRetryRecentRef = useRef(onRetryRecent);
  const initialDocumentRef = useRef(initialDocument);
  const settingsRef = useRef(settings);
  const composingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const suggestionPauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingIntervalsRef = useRef<number[]>([]);
  const lastTypingAtRef = useRef<number | null>(null);
  const lastPredictiveRequestRef = useRef<PredictiveRequestMarker | null>(null);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  settingsRef.current = settings;

  function clearPredictiveSuggestionTimer() {
    if (suggestionPauseTimerRef.current) {
      window.clearTimeout(suggestionPauseTimerRef.current);
      suggestionPauseTimerRef.current = null;
    }
  }

  function resetPredictiveSuggestionCadence() {
    clearPredictiveSuggestionTimer();
    lastTypingAtRef.current = null;
    lastPredictiveRequestRef.current = null;
  }

  function recordTypingSpeed(update: ViewUpdate, userEvent: string | undefined) {
    const character = singleInsertedCharacter(update);
    if (!userEvent?.startsWith("input.type") || !character || !/[A-Za-z]/.test(character)) {
      lastTypingAtRef.current = null;
      return;
    }

    const now = performance.now();
    const previous = lastTypingAtRef.current;
    lastTypingAtRef.current = now;
    if (previous === null) {
      return;
    }

    const interval = now - previous;
    if (interval < MIN_TYPING_INTERVAL_MS || interval > MAX_TYPING_INTERVAL_MS) {
      return;
    }

    typingIntervalsRef.current = [
      ...typingIntervalsRef.current.slice(-(TYPING_SPEED_SAMPLE_SIZE - 1)),
      interval,
    ];
  }

  function requestPredictiveSuggestion(
    view: EditorView,
    reason: PredictiveRequestReason,
  ) {
    clearPredictiveSuggestionTimer();
    if (
      composingRef.current ||
      !settingsRef.current.autoConvert ||
      !settingsRef.current.triggers.space ||
      !view.state.selection.main.empty
    ) {
      return;
    }

    const cursor = view.state.selection.main.head;
    const trigger: Extract<ConversionTrigger, "typing" | "space"> =
      reason === "space" ? "space" : "typing";
    const range = extractConversionRange(view.state.doc.toString(), cursor, trigger);
    if (!range) {
      return false;
    }

    const previous = lastPredictiveRequestRef.current;
    if (previous?.from === range.from && previous.text === range.text) {
      return false;
    }

    if (!onConvertRef.current(range)) {
      return false;
    }

    lastPredictiveRequestRef.current = {
      from: range.from,
      text: range.text,
    };
    return true;
  }

  function schedulePredictiveSuggestion(view: EditorView) {
    if (
      composingRef.current ||
      !settingsRef.current.autoConvert ||
      !settingsRef.current.triggers.space
    ) {
      resetPredictiveSuggestionCadence();
      return;
    }

    clearPredictiveSuggestionTimer();
    if (!view.state.selection.main.empty) {
      return;
    }

    const cursor = view.state.selection.main.head;
    const range = extractConversionRange(view.state.doc.toString(), cursor, "typing");
    if (!range) {
      lastPredictiveRequestRef.current = null;
      return;
    }

    suggestionPauseTimerRef.current = window.setTimeout(
      () => requestPredictiveSuggestion(view, "pause"),
      inputPauseDurationMs(
        typingIntervalsRef.current,
        settingsRef.current.inputPauseTiming,
      ),
    );
  }

  const updateListener = useMemo(() => {
    return EditorView.updateListener.of((update) => {
      if (update.docChanged || update.selectionSet) {
        onEditorStatusChangeRef.current(editorDocumentStatus(update.state));
        setCanUndo(undoDepth(update.state) > 0);
        setCanRedo(redoDepth(update.state) > 0);
      }

      if (!update.docChanged) {
        return;
      }

      onDocumentChangedRef.current(update.state.doc.toString());
      const userEvent = update.transactions
        .map((transaction) => transaction.annotation(Transaction.userEvent))
        .find(Boolean);
      if (userEvent?.startsWith("document.")) {
        resetPredictiveSuggestionCadence();
        return;
      }
      if (shouldSuppressAutoTriggerForUserEvent(userEvent)) {
        resetPredictiveSuggestionCadence();
        return;
      }

      if (!settingsRef.current.autoConvert) {
        resetPredictiveSuggestionCadence();
        return;
      }

      recordTypingSpeed(update, userEvent);
      if (userEvent?.startsWith("input.delete")) {
        lastPredictiveRequestRef.current = null;
      }

      const cursor = update.state.selection.main.head;
      const previousChar = update.state.doc.sliceString(cursor - 1, cursor);
      const trigger = triggerFromCharacter(previousChar);
      if (trigger && isTriggerEnabled(trigger, settingsRef.current)) {
        if (trigger === "space") {
          requestPredictiveSuggestion(update.view, "space");
          return;
        }
        resetPredictiveSuggestionCadence();
        const range = extractConversionRange(update.state.doc.toString(), cursor, trigger);
        if (range) {
          onConvertRef.current(range);
        }
        return;
      }

      schedulePredictiveSuggestion(update.view);
    });
  }, []);

  const shortcutCompartment = useMemo(() => new Compartment(), []);
  const compositionHandler = useMemo(() => {
    return EditorView.domEventHandlers({
      compositionstart() {
        composingRef.current = true;
      },
      compositionend() {
        composingRef.current = false;
        lastCompositionEndAtRef.current = Date.now();
      },
    });
  }, []);

  useEffect(() => {
    onConvertRef.current = onConvert;
    onDocumentChangedRef.current = onDocumentChanged;
    onEditorStatusChangeRef.current = onEditorStatusChange;
    onAcceptGhostRef.current = onAcceptGhost;
    onDismissGhostRef.current = onDismissGhost;
    onRetryGhostRef.current = onRetryGhost;
    onRetryRecentRef.current = onRetryRecent;
    settingsRef.current = settings;
  }, [
    onAcceptGhost,
    onDismissGhost,
    onConvert,
    onDocumentChanged,
    onEditorStatusChange,
    onRetryGhost,
    onRetryRecent,
    settings,
  ]);

  useEffect(() => {
    if (!settings.autoConvert || !settings.triggers.space) {
      resetPredictiveSuggestionCadence();
    }
  }, [
    settings.autoConvert,
    settings.inputPauseTiming,
    settings.triggers.space,
  ]);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    const state = EditorState.create({
      doc: initialDocumentRef.current,
      extensions: [
        history(),
        markdown(),
        editorPhrases,
        search({ top: true }),
        lineNumbers(),
        loadingDecorations,
        ghostSuggestionField,
        theme,
        syntaxHighlighting(highlightStyle),
        highlightSelectionMatches(),
        placeholder("romaji で日本語を書いてください..."),
        updateListener,
        compositionHandler,
        shortcutCompartment.of(
          Prec.highest(keymap.of([
            {
              any: acceptGhostSuggestionWithPunctuation,
            },
            {
              any: runPlainEnterConversion,
            },
            {
              key: settingsRef.current.triggers.manualShortcut,
              run: runManualConversion,
            },
            {
              key: "Tab",
              run: acceptGhostSuggestion,
            },
            {
              key: "Mod-/",
              run: retryGhostSuggestion,
            },
            {
              key: "Ctrl-/",
              run: retryGhostSuggestion,
            },
            {
              key: "Cmd-/",
              run: retryGhostSuggestion,
            },
            {
              key: "Escape",
              run: dismissGhostSuggestion,
            },
          ])),
        ),
        keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state,
      parent: hostRef.current,
    });

    viewRef.current = view;
    registerView(view);
    onEditorStatusChangeRef.current(editorDocumentStatus(view.state));
    setCanUndo(undoDepth(view.state) > 0);
    setCanRedo(redoDepth(view.state) > 0);

    return () => {
      resetPredictiveSuggestionCadence();
      registerView(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [compositionHandler, registerView, shortcutCompartment, updateListener]);

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
        Prec.highest(keymap.of([
          {
            any: acceptGhostSuggestionWithPunctuation,
          },
          {
            any: runPlainEnterConversion,
          },
          {
            key: settings.triggers.manualShortcut,
            run: runManualConversion,
          },
          {
            key: "Tab",
            run: acceptGhostSuggestion,
          },
          {
            key: "Mod-/",
            run: retryGhostSuggestion,
          },
          {
            key: "Ctrl-/",
            run: retryGhostSuggestion,
          },
          {
            key: "Cmd-/",
            run: retryGhostSuggestion,
          },
          {
            key: "Escape",
            run: dismissGhostSuggestion,
          },
        ])),
      ),
    });
  }, [settings.triggers.manualShortcut, shortcutCompartment]);

  function runEnterConversion(view: EditorView) {
    if (!settingsRef.current.autoConvert || !settingsRef.current.triggers.enter) {
      return false;
    }
    if (
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
    return false;
  }

  function runPlainEnterConversion(view: EditorView, event: KeyboardEvent) {
    if (
      event.key === "Enter" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      runEnterConversion(view);
    }
    return false;
  }

  function runManualConversion(view: EditorView) {
    const range = extractManualConversionRange(view, "shortcut");
    if (range) {
      onConvertRef.current(range);
    }
    return true;
  }

  function extractManualConversionRange(
    view: EditorView,
    trigger: ConversionTrigger,
  ): ConversionRange | null {
    const doc = view.state.doc.toString();
    const selection = view.state.selection.main;
    if (!selection.empty) {
      return extractSelectedConversionRange(doc, selection.from, selection.to, trigger);
    }

    return extractConversionRange(doc, selection.head, trigger);
  }

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
      effects: clearGhostSuggestion.of(suggestion.id),
      userEvent: "input.ghostAccept",
    });
    onAcceptGhostRef.current(suggestion);
    return true;
  }

  function acceptGhostSuggestionWithPunctuation(
    view: EditorView,
    event: KeyboardEvent,
  ) {
    if (
      composingRef.current ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      (event.key !== "." && event.key !== ",")
    ) {
      return false;
    }

    const character = event.key;
    const trigger = character === "." ? "period" : "comma";
    const suggestion = view.state.field(ghostSuggestionField).suggestion;
    const selection = view.state.selection.main;
    if (
      !suggestion ||
      suggestion.source !== "editor" ||
      suggestion.previewOnly ||
      !selection.empty ||
      selection.head !== suggestion.to
    ) {
      return false;
    }

    const currentText = view.state.doc.sliceString(suggestion.from, suggestion.to);
    if (currentText !== suggestion.originalText) {
      view.dispatch({ effects: clearGhostSuggestion.of(suggestion.id) });
      return false;
    }

    if (suggestion.conversionStrategy === "speculative") {
      const cursor = selection.head;
      view.dispatch({
        changes: { from: cursor, to: cursor, insert: character },
        selection: { anchor: cursor + character.length },
        effects: clearGhostSuggestion.of(suggestion.id),
        userEvent: "input.speculativeDismiss",
      });
      onDismissGhostRef.current();
      return true;
    }

    if (
      !settingsRef.current.autoConvert ||
      !isTriggerEnabled(trigger, settingsRef.current)
    ) {
      return false;
    }

    const suffix = punctuationSuffixForGhostCommit(
      character,
      suggestion.convertedText,
      settingsRef.current,
    );
    const replacement = `${suggestion.convertedText}${suffix}`;
    view.dispatch({
      changes: {
        from: suggestion.from,
        to: suggestion.to,
        insert: replacement,
      },
      selection: { anchor: suggestion.from + replacement.length },
      effects: clearGhostSuggestion.of(suggestion.id),
      annotations: isolateHistory.of("full"),
      userEvent: "input.ghostAccept",
    });
    onAcceptGhostRef.current({
      ...suggestion,
      convertedText: replacement,
      trigger,
    });
    return true;
  }

  function retryGhostSuggestion(view: EditorView) {
    const state = view.state.field(ghostSuggestionField);
    const suggestion = state.suggestion;
    if (!suggestion) {
      onRetryRecentRef.current();
      return true;
    }

    const currentText = view.state.doc.sliceString(suggestion.from, suggestion.to);
    if (currentText !== suggestion.originalText) {
      view.dispatch({ effects: clearGhostSuggestion.of(suggestion.id) });
      return true;
    }

    onRetryGhostRef.current(suggestion);
    return true;
  }

  function dismissGhostSuggestion(view: EditorView) {
    clearPredictiveSuggestionTimer();
    const state = view.state.field(ghostSuggestionField);
    const suggestion = state.suggestion;
    if (!suggestion) {
      onDismissGhostRef.current();
      return false;
    }

    view.dispatch({ effects: clearGhostSuggestion.of(suggestion.id) });
    onDismissGhostRef.current();
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
    <section className="editor-shell" aria-label="Markdownエディター">
      <div className="editor-commandbar">
        <div className="commandbar-left">
          {!remoteMode ? (
            <>
              <button className="toolbar-command" type="button" onClick={onNewFile}>
                <FilePlus2 size={20} aria-hidden="true" />
                <span>新規</span>
              </button>
              <button className="toolbar-command" type="button" onClick={onOpenFile}>
                <FolderOpen size={21} aria-hidden="true" />
                <span>開く</span>
              </button>
              <button className="toolbar-command" type="button" onClick={onSaveFile}>
                <Save size={21} aria-hidden="true" />
                <span>保存</span>
              </button>
              <span className="toolbar-separator" aria-hidden="true" />
            </>
          ) : null}
          <div className="toolbar-menu" ref={fileMenuRef}>
            {remoteMode ? (
              <div className="document-picker remote-document" title={fileName}>
                <Link2 size={18} aria-hidden="true" />
                <span>{fileName}</span>
                <span className="sync-dot" aria-label="PCと同期中" />
              </div>
            ) : (
              <button
                aria-expanded={fileMenuOpen}
                aria-haspopup="menu"
                className="document-picker"
                type="button"
                onClick={() => setFileMenuOpen((open) => !open)}
                title={fileName}
              >
                <FileText size={20} aria-hidden="true" />
                <span>{fileName}</span>
                {isDirty ? <span className="dirty-dot" aria-label="未保存" /> : null}
                <ChevronDown size={16} aria-hidden="true" />
              </button>
            )}
            {!remoteMode && fileMenuOpen ? (
              <div className="toolbar-menu-items" role="menu" aria-label="File actions">
                <button type="button" role="menuitem" onClick={() => runFileAction(onNewFile)}>
                  <FilePlus2 size={15} aria-hidden="true" />
                  <span>新規ファイル</span>
                  <kbd>Ctrl/Cmd + N</kbd>
                </button>
                <button type="button" role="menuitem" onClick={() => runFileAction(onOpenFile)}>
                  <FolderOpen size={15} aria-hidden="true" />
                  <span>Markdownを開く...</span>
                  <kbd>Ctrl/Cmd + O</kbd>
                </button>
                <button type="button" role="menuitem" onClick={() => runFileAction(onSaveFile)}>
                  <Save size={15} aria-hidden="true" />
                  <span>保存</span>
                  <kbd>Ctrl/Cmd + S</kbd>
                </button>
                <button type="button" role="menuitem" onClick={() => runFileAction(onSaveFileAs)}>
                  <Save size={15} aria-hidden="true" />
                  <span>別名で保存...</span>
                  <kbd>Ctrl/Cmd + Shift + S</kbd>
                </button>
              </div>
            ) : null}
          </div>
          <button
            className="editor-chrome-button"
            type="button"
            onClick={() => runEditorCommand(undo)}
            aria-label="元に戻す"
            title="元に戻す"
            disabled={!canUndo}
          >
            <Undo2 size={16} aria-hidden="true" />
          </button>
          <button
            className="editor-chrome-button"
            type="button"
            onClick={() => runEditorCommand(redo)}
            aria-label="やり直し"
            title="やり直し"
            disabled={!canRedo}
          >
            <Redo2 size={16} aria-hidden="true" />
          </button>
          <button
            className="editor-chrome-button"
            type="button"
            onClick={() => runEditorCommand(openSearchPanel)}
            aria-label="検索と置換"
            title="検索と置換 (Ctrl/Cmd + F)"
          >
            <Search size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="commandbar-spacer" aria-hidden="true" />
        <div className="commandbar-right">
          {pending.length > 0 ? (
            <span className="queue-chip">{pending.length} 件変換中</span>
          ) : null}
          <button
            className={`model-chip ${modelStatusKind}`}
            type="button"
            onClick={onOpenModelSettings}
            disabled={remoteMode}
            aria-label="モデル設定を開く"
            title={remoteMode ? "モデル設定はPC版で変更できます" : "モデル設定"}
          >
            {modelStatusLabel}
          </button>
          <button
            className={`auto-convert-toggle ${settings.autoConvert ? "enabled" : ""}`}
            type="button"
            aria-pressed={settings.autoConvert}
            aria-label={settings.autoConvert ? "自動変換をオフにする" : "自動変換をオンにする"}
            title={
              settings.autoConvert
                ? "句読点・Enterによる自動変換を停止します。手動変換は引き続き利用できます"
                : "句読点・Enterによる自動変換を有効にします"
            }
            onClick={() => onSettingsChange({ ...settings, autoConvert: !settings.autoConvert })}
          >
            <Zap size={15} aria-hidden="true" />
            <span>自動変換</span>
            <span className="auto-convert-state" aria-hidden="true">
              {settings.autoConvert ? "ON" : "OFF"}
            </span>
          </button>
        </div>
      </div>
      <div className="editor-host" ref={hostRef} />
    </section>
  );
}

function editorDocumentStatus(state: EditorState): EditorDocumentStatus {
  const selection = state.selection.main;
  const line = state.doc.lineAt(selection.head);
  return {
    line: line.number,
    column: selection.head - line.from + 1,
    lineCount: state.doc.lines,
    characterCount: state.doc.length,
    selectionCount: Math.abs(selection.to - selection.from),
  };
}

function shouldSuppressAutoTriggerForUserEvent(userEvent: string | undefined): boolean {
  if (!userEvent) {
    return false;
  }
  if (AUTO_TRIGGER_SUPPRESSED_USER_EVENTS.has(userEvent)) {
    return true;
  }
  return (
    userEvent === "undo" ||
    userEvent === "redo" ||
    userEvent.startsWith("undo.") ||
    userEvent.startsWith("redo.") ||
    userEvent.startsWith("history.")
  );
}
