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
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { Compartment, EditorState, Facet, Prec, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  placeholder,
  WidgetType,
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
import { ConversionPopover, type CandidateListTarget } from "./ConversionPopover";
import {
  extractSelectedConversionRange,
  isTriggerEnabled,
  punctuationSuffixForGhostCommit,
  shouldTriggerAutoConversion,
  triggerFromCharacter,
} from "../lib/conversion";
import { isPendingNumericSeparator } from "../lib/conversionBoundaries";
import {
  inputPauseDurationMs,
  MAX_TYPING_INTERVAL_MS,
  MIN_TYPING_INTERVAL_MS,
  TYPING_SPEED_SAMPLE_SIZE,
} from "../lib/predictiveSuggestions";
import { candidatePresentation } from "../lib/candidatePresentation";
import { requiresExplicitAcceptance } from "../lib/readingAssessment";
import type {
  AppSettings,
  ConversionRange,
  ConversionTrigger,
  GhostConversionSuggestion,
  OllamaConnectionStatus,
  PendingConversion,
} from "../lib/types";
import { rememberUnconvertedRange, retainedConversionRange, unconvertedRanges } from "../lib/unconvertedRanges";

interface MarkdownEditorProps {
  candidateList?: CandidateListTarget | null;
  onSelectCandidate?: (id: string) => void;
  onSpeculate?: () => void;
  onCloseCandidateList?: () => void;
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
  onDismissGhost: (suggestion?: GhostConversionSuggestion) => void;
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

const inlineGhostActions = Facet.define<{
  accept: (view: EditorView) => boolean;
  open: (suggestion: GhostConversionSuggestion) => void;
  details: (suggestion: GhostConversionSuggestion) => void;
}>();

class InlineGhostWidget extends WidgetType {
  constructor(private readonly suggestion: GhostConversionSuggestion) { super(); }

  eq(other: InlineGhostWidget) { return this.suggestion === other.suggestion; }

  toDOM(view: EditorView) {
    const element = document.createElement("span");
    element.className = "cm-ghost-text cm-inline-candidate";
    element.contentEditable = "false";
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", "変換候補");
    // Keep pointer interaction out of CodeMirror's selection handling.
    element.onmousedown = event => event.preventDefault();
    const arrow = document.createElement("span");
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");
    element.append(arrow);
    const button = (label: string, name: string, action: () => void) => {
      const control = document.createElement("button");
      control.type = "button";
      control.textContent = label;
      control.setAttribute("aria-label", name);
      control.title = name;
      control.onclick = action;
      element.append(control);
      return control;
    };
    const text = button(this.suggestion.convertedText, "変更の詳細", () => view.state.facet(inlineGhostActions)[0]?.details(this.suggestion));
    text.className = "cm-ghost-text-suggestion";
    if (requiresExplicitAcceptance(this.suggestion)) {
      const kind = document.createElement("span");
      kind.className = "conversion-kind";
      kind.textContent = this.suggestion.conversionStrategy ? candidatePresentation(this.suggestion).label : "読み未確認";
      kind.title = "内容を確認してTabで確定してください。";
      element.append(kind);
    }
    button("Tab", "確定 Tab", () => view.state.facet(inlineGhostActions)[0]?.accept(view));
    button("▾", "ほかの候補", () => view.state.facet(inlineGhostActions)[0]?.open(this.suggestion));
    return element;
  }

  ignoreEvent() { return true; }
}

export const ghostSuggestionField = StateField.define<GhostState>({
  create() {
    return { suggestion: null, decorations: Decoration.none };
  },
  update(value, transaction) {
    let suggestion = value.suggestion;
    const dismiss = () => {
      if (suggestion?.session?.state === "open") suggestion.session.state = "dismissed";
      suggestion = null;
    };

    if (transaction.annotation(Transaction.userEvent)?.startsWith("document.")) {
      dismiss();
    } else if (suggestion && transaction.docChanged) {
      const from = transaction.changes.mapPos(suggestion.from, 1);
      const to = transaction.changes.mapPos(suggestion.to, -1);
      if (from >= to || transaction.state.doc.sliceString(from, to) !== suggestion.originalText) {
        dismiss();
      } else {
        suggestion = { ...suggestion, from, to };
      }
    } else if (suggestion && transaction.selection) {
      const selection = transaction.state.selection.main;
      if (!selection.empty || selection.head < suggestion.from || selection.head > suggestion.to) dismiss();
    }

    for (const effect of transaction.effects) {
      if (effect.is(showGhostSuggestion)) {
        const next = effect.value;
        // Late responses cannot reopen a closed session or target stale text.
        if (next.session && next.session.state !== "open") continue;
        if (next.from < 0 || next.from >= next.to || next.to > transaction.state.doc.length ||
          transaction.state.doc.sliceString(next.from, next.to) !== next.originalText) continue;
        if (suggestion?.session !== next.session) dismiss();
        suggestion = next;
      }

      if (effect.is(clearGhostSuggestion)) {
        if (!effect.value || suggestion?.id === effect.value) {
          dismiss();
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

  return suggestion.previewOnly ? Decoration.set([sourceDecoration]) : Decoration.set([
    sourceDecoration,
    Decoration.widget({ widget: new InlineGhostWidget(suggestion), side: 1 }).range(suggestion.to),
  ]);
}

const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--theme-text, #123f3b)",
    backgroundColor: "var(--theme-surface, #ffffff)",
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
    caretColor: "var(--theme-accent, #0d9488)",
  },
  ".cm-line": {
    padding: "0 2px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--theme-selection, #b8ece4)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--theme-raised, #fbfdfc)",
    color: "var(--theme-muted, #718782)",
    borderRight: "1px solid var(--theme-border, #dde9e6)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--theme-accent-soft, #e7f8f3)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--theme-raised, #f7fbfa)",
  },
  ".cm-placeholder": {
    color: "var(--theme-muted, #617872)",
  },
  ".cm-conversion-loading": {
    backgroundColor: "var(--theme-selection, #d8f7ef)",
    borderBottom: "2px solid var(--theme-accent, #0d9488)",
    borderRadius: "3px",
  },
  ".cm-ghost-source": {
    backgroundColor: "var(--theme-chrome, #f3f8f6)",
    borderBottom: "1px dashed var(--theme-accent, #0d9488)",
    borderRadius: "3px",
  },

  ".cm-history-preview": {
    backgroundColor: "var(--theme-accent-soft, #e8f5f2)",
    borderBottom: "1px solid var(--theme-accent, #5aa79d)",
    borderRadius: "3px",
  },
  ".cm-panels": {
    backgroundColor: "var(--theme-raised, #fbfdfc)",
    color: "var(--theme-text, #123f3b)",
    fontFamily: '"MPLUS2", Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: "13px",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "1px solid var(--theme-border, #dbe8e4)",
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
    border: "1px solid var(--theme-border, #b8d5cf)",
    borderRadius: "6px",
    padding: "5px 8px",
    backgroundColor: "var(--theme-surface, #ffffff)",
    color: "var(--theme-text, #123f3b)",
    outline: "none",
  },
  ".cm-search .cm-textfield:focus": {
    borderColor: "var(--theme-accent, #0f766e)",
    boxShadow: "0 0 0 2px var(--theme-selection, #ccfbf1)",
  },
  ".cm-search .cm-button": {
    minHeight: "32px",
    border: "1px solid var(--theme-border, #b8d5cf)",
    borderRadius: "6px",
    padding: "5px 9px",
    backgroundImage: "none",
    backgroundColor: "var(--theme-surface, #ffffff)",
    color: "var(--theme-accent, #0f766e)",
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
    color: "var(--theme-muted, #617872)",
    fontSize: "18px",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--theme-accent, #0f766e)", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.link, color: "var(--theme-accent, #0d9488)", textDecoration: "underline" },
  { tag: tags.monospace, color: "var(--theme-warning, #9a3412)", backgroundColor: "var(--theme-warning-soft, #fff7ed)" },
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
  candidateList,
  onSelectCandidate,
  onSpeculate,
  onCloseCandidateList,
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
  const onCloseCandidateListRef = useRef(onCloseCandidateList);
  onCloseCandidateListRef.current = onCloseCandidateList;
  const initialDocumentRef = useRef(initialDocument);
  const settingsRef = useRef(settings);
  const composingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const suggestionPauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingIntervalsRef = useRef<number[]>([]);
  const lastTypingAtRef = useRef<number | null>(null);
  const lastPredictiveRequestRef = useRef<PredictiveRequestMarker | null>(null);
  const [inlineDetailsId, setInlineDetailsId] = useState<string | null>(null);
  const [visibleSuggestion, setVisibleSuggestion] = useState<GhostConversionSuggestion | null>(null);
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
    const trigger: Extract<ConversionTrigger, "typing" | "space"> =
      reason === "space" ? "space" : "typing";
    if (
      composingRef.current ||
      !settingsRef.current.autoConvert ||
      !isTriggerEnabled(trigger, settingsRef.current) ||
      !view.state.selection.main.empty
    ) {
      return;
    }

    const cursor = view.state.selection.main.head;
    const range = retainedConversionRange(view.state, cursor, trigger);
    if (!range) {
      return false;
    }

    const previous = lastPredictiveRequestRef.current;
    if (previous?.from === range.from && previous.text === range.text) {
      return false;
    }

    view.dispatch({ effects: rememberUnconvertedRange.of(range) });
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
      !isTriggerEnabled("typing", settingsRef.current)
    ) {
      resetPredictiveSuggestionCadence();
      return;
    }

    clearPredictiveSuggestionTimer();
    if (!view.state.selection.main.empty) {
      return;
    }

    const cursor = view.state.selection.main.head;
    const range = retainedConversionRange(view.state, cursor, "typing");
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
      setVisibleSuggestion(update.state.field(ghostSuggestionField).suggestion);
      if (update.selectionSet) onCloseCandidateListRef.current?.();
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
      if (composingRef.current || Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_GRACE_MS ||
        shouldSuppressAutoTriggerForUserEvent(userEvent) || !shouldTriggerAutoConversion(userEvent)) {
        resetPredictiveSuggestionCadence();
        return;
      }

      if (!settingsRef.current.autoConvert) {
        resetPredictiveSuggestionCadence();
        return;
      }

      recordTypingSpeed(update, userEvent);
      if (userEvent?.startsWith("input.delete") || userEvent?.startsWith("delete.")) {
        lastPredictiveRequestRef.current = null;
        schedulePredictiveSuggestion(update.view);
        return;
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
        const range = retainedConversionRange(update.state, cursor, trigger);
        if (range) {
          update.view.dispatch({ effects: rememberUnconvertedRange.of(range) });
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
    if (!settings.autoConvert || !isTriggerEnabled("typing", settings)) {
      resetPredictiveSuggestionCadence();
    }
  }, [
    settings.autoConvert,
    settings.inputPauseTiming,
    settings.triggers.space,
    settings.triggers.typing,
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
        inlineGhostActions.of({
          accept: acceptGhostSuggestion,
          open: suggestion => {
            clearPredictiveSuggestionTimer();
            setInlineDetailsId(null);
            onRetryGhostRef.current(suggestion);
          },
          details: suggestion => { clearPredictiveSuggestionTimer(); setInlineDetailsId(suggestion.id); },
        }),
        unconvertedRanges,
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
    const range = retainedConversionRange(view.state, cursor, "enter");
    if (!range) {
      return false;
    }

    view.dispatch({ effects: rememberUnconvertedRange.of(range) });
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
    if (composingRef.current || Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_GRACE_MS) return false;
    const range = extractManualConversionRange(view, "shortcut");
    if (range) {
      if (view.state.selection.main.empty) {
        view.dispatch({ effects: rememberUnconvertedRange.of(range) });
      }
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

    return retainedConversionRange(view.state, selection.head, trigger);
  }

  function acceptGhostSuggestion(view: EditorView) {
    const state = view.state.field(ghostSuggestionField);
    const suggestion = state.suggestion;
    if (!suggestion || suggestion.previewOnly) {
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
    const cursor = view.state.selection.main.head;
    if (isPendingNumericSeparator(view.state.doc.sliceString(0, cursor) + character, cursor + 1)) return false;
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

    if (requiresExplicitAcceptance(suggestion)) {
      const cursor = selection.head;
      view.dispatch({
        changes: { from: cursor, to: cursor, insert: character },
        selection: { anchor: cursor + character.length },
        effects: clearGhostSuggestion.of(suggestion.id),
        userEvent: "input.speculativeDismiss",
      });
      onDismissGhostRef.current(suggestion);
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
    clearPredictiveSuggestionTimer();
    const state = view.state.field(ghostSuggestionField);
    const suggestion = state.suggestion;
    if (!suggestion) {
      onRetryRecentRef.current();
      return true;
    }
    if (suggestion.previewOnly) return true;

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
    onDismissGhostRef.current(suggestion);
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
      {viewRef.current && (candidateList || (visibleSuggestion && !visibleSuggestion.previewOnly && inlineDetailsId === visibleSuggestion.id)) ? (
        <ConversionPopover
          key={candidateList?.ghost?.id ?? visibleSuggestion?.id ?? candidateList?.session.id}
          view={viewRef.current}
          suggestion={visibleSuggestion?.previewOnly ? null : visibleSuggestion}
          target={candidateList ?? null}
          onAccept={() => runEditorCommand(acceptGhostSuggestion)}
          onDismiss={() => { setInlineDetailsId(null); viewRef.current?.focus(); }}
          onOpen={() => { setInlineDetailsId(null); runEditorCommand(retryGhostSuggestion); }}
          onSelect={onSelectCandidate ?? (() => {})}
          onSpeculate={onSpeculate ?? (() => {})}
          onClose={() => { onCloseCandidateList?.(); viewRef.current?.focus(); }}
        />
      ) : null}
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
