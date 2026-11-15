import { liveKanaSource } from "../lib/liveKanaState";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { commitEditorText } from "../lib/editorCommit";
import { suggestAfterConversion } from "../lib/editorConversionEffects";
import { suggestWords, type WordSuggestion } from "../lib/kanaEngine";
import { conversionLearningChoices } from "../lib/conversionLearning";
import { convertedSuggestTarget, rankSuggestions, suggestTargets, type SuggestTarget } from "../lib/autoSuggest";
import type { AppSettings } from "../lib/types";
import { candidateBindings } from "../lib/candidateInteraction";
import { applyCandidatePlacement, measureCandidate, type CandidatePlacement } from "../lib/candidatePlacement";

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
    if (!menu || !allowed(view) || pluginValue(view)?.ghost.hidden !== false ||
      pluginValue(view)?.ghost.style.visibility !== "visible") return false;
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
      const target = suggestTargets(tr.state.doc.toString(), to, tr.state.field(liveKanaSource, false)?.from)
        .find(target => target.from === value!.target.from);
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
    observer?: ResizeObserver;
    constructor(readonly view: EditorView) {
      this.config = this.configKey();
      this.ghost.type = "button";
      this.ghost.className = "cm-autosuggest-ghost candidate-surface candidate-completion";
      this.ghost.hidden = true;
      this.ghost.tabIndex = -1;
      this.ghost.addEventListener("mousedown", event => event.preventDefault());
      this.ghost.addEventListener("click", () => accept(view));
      view.dom.appendChild(this.ghost);
      this.observer = new ResizeObserver(this.requestPlacement);
      this.observer.observe(this.ghost);
      window.visualViewport?.addEventListener("resize", this.requestPlacement);
      window.visualViewport?.addEventListener("scroll", this.requestPlacement);
    }
    requestPlacement = () => this.view.requestMeasure(this.measureGhost);
    measureGhost = {
      key: this,
      read: (view: EditorView) => {
        const menu = view.state.field(field);
        if (!menu || !allowed(view)) return null;
        const { target } = menu;
        return measureCandidate(view, target.to, this.ghost, view.state.doc.lineAt(target.to).to === target.to);
      },
      write: (position: CandidatePlacement | null) => applyCandidatePlacement(this.ghost, position),
    };
    configKey() { return JSON.stringify([settings().autoSuggest, settings().personalDictionary]); }
    update(update: ViewUpdate) {
      const completion = update.state.field(field);
      if (!completion || !allowed(this.view)) this.ghost.hidden = true;
      else if (completion !== update.startState.field(field) || this.ghost.hidden) {
        const { target } = completion, candidate = completion.candidates[0];
        const prefix = target.suffix ? target.original.slice(0, -target.suffix.length) : target.original;
        const continuation = !target.suffix && candidate.text.startsWith(prefix);
        const text = document.createElement("span"); text.className = "candidate-completion-text";
        text.textContent = continuation ? candidate.text.slice(prefix.length) : ` → ${candidate.text}`;
        const hint = document.createElement("span"); hint.className = "candidate-accept-hint";
        hint.innerHTML = '採用 <kbd>Tab</kbd>';
        this.ghost.replaceChildren(text, hint);
        this.ghost.setAttribute("aria-label", `${candidate.text} を補完 (Tabで採用)`);
        this.ghost.hidden = false;
        this.ghost.style.visibility = "hidden";
      }
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
      const committedTarget = this.view.state.field(convertedTarget);
      const targets = committedTarget ? [committedTarget] : suggestTargets(this.view.state.doc.toString(), this.view.state.selection.main.head, this.view.state.field(liveKanaSource, false)?.from);
      if (!targets.length) {
        this.timer = setTimeout(() => { if (!this.destroyed && revision === this.revision) this.view.dispatch({ effects: setMenu.of(null) }); }, 350);
        return;
      }
      this.timer = setTimeout(async () => {
        this.typedSinceRequest = 0; this.hasRequested = true;
        const controller = new AbortController(); this.controller = controller;
        try {
          for (const target of targets) {
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
            if (!ranked.length) continue;
            const previous = this.view.state.field(field);
            const retained = previous?.target.from === target.from
              ? ranked.find(candidate => candidate.text === previous.candidates[0].text) : undefined;
            const ordered = retained ? [retained, ...ranked.filter(candidate => candidate !== retained)] : ranked;
            this.view.dispatch({ effects: setMenu.of({ target, candidates: ordered }) });
            return;
          }
          this.view.dispatch({ effects: setMenu.of(null) });
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
      this.observer?.disconnect();
      window.visualViewport?.removeEventListener("resize", this.requestPlacement);
      window.visualViewport?.removeEventListener("scroll", this.requestPlacement);
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
  return [field, convertedTarget, plugin, Prec.highest(keymap.of(candidateBindings({
    accept,
    dismiss: view => {
      const retry = retryConversion(view);
      if (!retry && !view.state.field(field)) return false;
      pluginValue(view)?.dismiss();
      return true;
    },
  })))];
}
