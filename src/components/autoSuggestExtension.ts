import { Prec, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { commitEditorText } from "../lib/editorCommit";
import { suggestAfterConversion } from "../lib/editorConversionEffects";
import { suggestWords, type WordSuggestion } from "../lib/kanaEngine";
import { conversionLearningChoices } from "../lib/conversionLearning";
import { convertedSuggestTarget, rankSuggestions, suggestTarget, type SuggestTarget } from "../lib/autoSuggest";
import type { AppSettings } from "../lib/types";

interface GhostPosition {
  text: string;
  candidate: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Menu { target: SuggestTarget; candidates: WordSuggestion[] }
const REFRESH_CHARACTER_COUNT = 3;
const IDLE_REFRESH_MS = 500;
// Conversion supplies the known reading; no reverse lookup or model call is needed.

export function autoSuggestExtension(settings: () => AppSettings, converting: (view: EditorView) => boolean, blocked: (view: EditorView) => boolean, retryConversion: (view: EditorView) => boolean) {
  const setMenu = StateEffect.define<Menu | null>();
  const refresh = StateEffect.define<void>();
  const allowed = (view: EditorView) => settings().autoSuggest && !blocked(view) && !view.composing && view.hasFocus && view.state.selection.main.empty;
  const convertedTarget = StateField.define<SuggestTarget | null>({ create: () => null, update(value, tr) {
    if (tr.docChanged && value) {
      const to = tr.changes.mapPos(value.to, 1);
      const text = tr.state.doc.sliceString(value.from, to);
      value = text.startsWith(value.original) && /^[、。，．,.\s]+$/u.test(text.slice(value.original.length))
        ? convertedSuggestTarget(value.from, text, value.reading) : null;
    }
    for (const effect of tr.effects) if (effect.is(suggestAfterConversion)) value = effect.value;
    const cursor = tr.state.selection.main.head;
    if (value && cursor > value.to && /^[、。，．,.\s]+$/u.test(tr.state.doc.sliceString(value.to, cursor))) {
      value = convertedSuggestTarget(value.from, tr.state.doc.sliceString(value.from, cursor), value.reading);
    }
    if (value && (!tr.state.selection.main.empty || tr.state.selection.main.head !== value.to ||
      tr.state.doc.sliceString(value.from, value.to) !== value.original || !/^[ぁ-ゖー]{2,80}$/u.test(value.reading))) return null;
    return value;
  } });
  const accept = (view: EditorView) => {
    const menu = view.state.field(field);
    if (!menu || !allowed(view) || pluginValue(view)?.ghost.hidden !== false) return false;
    const { target } = menu;
    if (view.state.selection.main.head !== target.to || view.state.doc.sliceString(target.from, target.to) !== target.original) return false;
    const candidate = menu.candidates[0];
    const insert = candidate.text + (target.suffix ?? "");
    if (!commitEditorText(view, { from: target.from, to: target.to, original: target.original, text: insert,
      cursor: "end", effects: [setMenu.of(null)], userEvent: "input.autosuggest" })) return false;
    view.focus();
    return true;
  };
  const field = StateField.define<Menu | null>({ create: () => null, update(value, tr) {
    if (tr.docChanged && value && (tr.isUserEvent("input.type") || tr.isUserEvent("delete")) &&
      tr.state.selection.main.empty && tr.state.selection.main.head === tr.changes.mapPos(value.target.to, 1)) {
      const to = tr.state.selection.main.head;
      const original = tr.state.doc.sliceString(value.target.from, to);
      const target = suggestTarget(tr.state.doc.toString(), to);
      // Retain a candidate only while the updated reading still supports it.
      if (!/^[A-Za-zぁ-ゖァ-ヶー]+$/u.test(original) || (target && target.from !== value.target.from)) value = null;
      else {
        const candidates = target ? value.candidates.filter(c => c.reading.startsWith(target.reading) && c.reading.length > target.reading.length) : [];
        value = target && candidates.length ? { target, candidates } : null;
      }
    } else if (tr.docChanged || tr.selection) value = null;
    for (const effect of tr.effects) if (effect.is(setMenu)) value = effect.value;
    return value;
  } });
  const plugin = ViewPlugin.fromClass(class {
    timer?: ReturnType<typeof setTimeout>;
    revision = 0; destroyed = false; controller?: AbortController;
    cache = new Map<string, WordSuggestion[]>();
    typedSinceRequest = 0; hasRequested = false;
    config = ""; wasConverting = false;
    ghost = document.createElement("button");
    constructor(readonly view: EditorView) {
      this.config = this.configKey();
      this.ghost.type = "button";
      this.ghost.className = "cm-autosuggest-ghost";
      this.ghost.hidden = true;
      this.ghost.tabIndex = -1;
      this.ghost.addEventListener("mousedown", event => event.preventDefault());
      this.ghost.addEventListener("click", () => accept(view));
      view.dom.appendChild(this.ghost);
    }
    measureGhost = {
      key: this,
      read: (view: EditorView) => {
        const menu = view.state.field(field);
        if (!menu || !allowed(view)) return null;
        const { target } = menu;
        if (view.state.doc.lineAt(target.to).to !== target.to) return null;
        const caret = view.coordsAtPos(target.to, 1);
        const viewport = view.scrollDOM.getBoundingClientRect();
        const editor = view.dom.getBoundingClientRect();
        if (!caret || caret.left < viewport.left || caret.right + 24 > viewport.right ||
          caret.top < viewport.top || caret.bottom > viewport.bottom) return null;
        const candidate = menu.candidates[0];
        const prefix = target.suffix ? target.original.slice(0, -target.suffix.length) : target.original;
        const continuation = !target.suffix && candidate.text.startsWith(prefix);
        return {
          text: continuation ? candidate.text.slice(prefix.length) : ` → ${candidate.text}`,
          candidate: candidate.text,
          left: caret.right - editor.left + 2,
          top: caret.top - editor.top,
          width: viewport.right - caret.right - 8,
          height: caret.bottom - caret.top,
        };
      },
      write: (position: GhostPosition | null) => {
        this.ghost.hidden = !position;
        if (!position) return;
        this.ghost.textContent = position.text;
        this.ghost.setAttribute("aria-label", `${position.candidate} を補完 (Tab)`);
        this.ghost.title = `${position.candidate} を補完 (Tab)`;
        Object.assign(this.ghost.style, {
          left: `${position.left}px`, top: `${position.top}px`,
          maxWidth: `${position.width}px`, lineHeight: `${position.height}px`,
        });
      },
    };
    configKey() { return JSON.stringify([settings().autoSuggest, settings().personalDictionary]); }
    update(update: ViewUpdate) {
      const completion = update.state.field(field);
      if (!completion || !allowed(this.view)) this.ghost.hidden = true;
      if (update.viewportChanged || update.geometryChanged || update.focusChanged ||
        completion !== update.startState.field(field)) this.view.requestMeasure(this.measureGhost);
      const nextConfig = this.configKey(), nextConverting = converting(this.view);
      const configChanged = nextConfig !== this.config;
      this.config = nextConfig;
      if (configChanged) this.cache.clear();
      const conversionChanged = nextConverting !== this.wasConverting; this.wasConverting = nextConverting;
      const converted = update.transactions.some(t => t.effects.some(e => e.is(suggestAfterConversion) || e.is(refresh)));
      if (!update.docChanged && !update.selectionSet && !update.focusChanged && !configChanged && !conversionChanged && !converted) return;
      const typing = update.docChanged && update.transactions.every(t => !t.docChanged || t.isUserEvent("input.type") || t.isUserEvent("delete"));
      if (typing) update.changes.iterChanges((from, to, _fromB, _toB, inserted) => { this.typedSinceRequest += Math.max(to - from, inserted.length); });
      else if (update.docChanged || update.selectionSet || configChanged) { this.typedSinceRequest = 0; this.hasRequested = false; }
      const revision = ++this.revision;
      clearTimeout(this.timer); this.controller?.abort();
      // Keep a valid ghost visible while normal conversion is running.
      if (!allowed(this.view) || configChanged) queueMicrotask(() => { if (!this.destroyed && revision === this.revision && this.view.state.field(field)) this.view.dispatch({ effects: setMenu.of(null) }); });
      if (!allowed(this.view) || update.transactions.some(t => t.isUserEvent("input.autosuggest") || t.isUserEvent("undo") || t.isUserEvent("redo"))) return;
      if (nextConverting) return;
      const target = this.view.state.field(convertedTarget) ?? suggestTarget(this.view.state.doc.toString(), this.view.state.selection.main.head);
      if (!target) {
        this.timer = setTimeout(() => { if (!this.destroyed && revision === this.revision) this.view.dispatch({ effects: setMenu.of(null) }); }, 350);
        return;
      }
      this.timer = setTimeout(async () => {
        this.typedSinceRequest = 0; this.hasRequested = true;
        const controller = new AbortController(); this.controller = controller;
        try {
          let candidates = this.cache.get(target.reading);
          if (!candidates) {
            candidates = await suggestWords(target.reading, settings().personalDictionary ?? [], controller.signal);
            if (this.destroyed || revision !== this.revision) return;
            if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(target.reading, candidates);
          }
          if (this.destroyed || revision !== this.revision || !allowed(this.view)) return;
          const ranked = rankSuggestions(target.reading, candidates, conversionLearningChoices())
            .filter(candidate => candidate.text + (target.suffix ?? "") !== target.original);
          const previous = this.view.state.field(field);
          const retained = previous?.target.from === target.from
            ? ranked.find(candidate => candidate.text === previous.candidates[0].text) : undefined;
          const ordered = retained ? [retained, ...ranked.filter(candidate => candidate !== retained)] : ranked;
          this.view.dispatch({ effects: setMenu.of(ordered.length ? { target, candidates: ordered } : null) });
        } catch {
          if (!this.destroyed && revision === this.revision) this.view.dispatch({ effects: setMenu.of(null) });
        }
      }, typing && this.hasRequested ? (this.typedSinceRequest >= REFRESH_CHARACTER_COUNT ? 0 : IDLE_REFRESH_MS) : 120);
    }
    dismiss() {
      ++this.revision;
      clearTimeout(this.timer);
      this.controller?.abort();
      if (this.view.state.field(field)) this.view.dispatch({ effects: setMenu.of(null) });
    }
    destroy() {
      this.destroyed = true;
      ++this.revision;
      clearTimeout(this.timer);
      this.controller?.abort();
      this.ghost.remove();
    }
  }, { eventHandlers: { scroll() { this.view.requestMeasure(this.measureGhost); }, compositionstart() {
    ++this.revision; clearTimeout(this.timer); this.controller?.abort();
    if (this.view.state.field(field)) this.view.dispatch({ effects: setMenu.of(null) });
    return false;
  }, compositionend() {
    queueMicrotask(() => { if (!this.destroyed) this.view.dispatch({ effects: refresh.of() }); });
    return false;
  } } });
  const pluginValue = (view: EditorView) => view.plugin(plugin);
  return [field, convertedTarget, plugin, Prec.highest(keymap.of([
    { key: "Tab", run: accept },
    { key: "Escape", run: view => {
      if (view.composing) return false;
      const retry = retryConversion(view);
      if (!retry && !view.state.field(field)) return false;
      pluginValue(view)?.dismiss();
      return true;
    } },
  ])), EditorView.baseTheme({
    ".cm-autosuggest-ghost": {
      position: "absolute", zIndex: "2", border: "0", padding: "0", background: "transparent",
      color: "var(--ink-muted)", font: "inherit", fontFamily: "var(--editor-font-family, monospace)",
      fontSize: "var(--editor-font-size, 16px)", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis",
    },
  })];
}
