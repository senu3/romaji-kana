import { liveKanaSource } from "../lib/liveKanaState";
import { Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { commitEditorText } from "../lib/editorCommit";
import { suggestAfterConversion } from "../lib/editorConversionEffects";
import { suggestSurface, suggestWords, type WordSuggestion } from "../lib/kanaEngine";
import { conversionLearningChoices } from "../lib/conversionLearning";
import { convertedSuggestTarget, matchesSuggestionReading, suggestTargets, wordSuggestionLabel, type SuggestTarget } from "../lib/autoSuggest";
import type { AppSettings } from "../lib/types";
import { candidateBindings } from "../lib/candidateInteraction";
import { applyCandidatePlacement, measureCandidate, type CandidatePlacement } from "../lib/candidatePlacement";

import { resolveCompletion, type Completion as Menu } from "../lib/completionResolver";

const REFRESH_CHARACTER_COUNT = 3;
const IDLE_REFRESH_MS = 500;

function targetsAtCursor(state: EditorState, retainedFrom?: number): SuggestTarget[] {
  return suggestTargets(state.doc.toString(), state.selection.main.head, {
    liveInput: state.field(liveKanaSource, false) ?? undefined,
    retainedFrom,
  });
}

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
      tr.state.doc.sliceString(value.from, value.to) !== value.original)) return null;
    return value;
  } });
  const accept = (view: EditorView) => {
    const menu = view.state.field(field);
    if (!menu || !allowed(view) || pluginValue(view)?.ghost.hidden !== false ||
      pluginValue(view)?.ghost.style.visibility !== "visible") return false;
    const { target } = menu;
    if (view.state.selection.main.head !== target.to || view.state.doc.sliceString(target.from, target.to) !== target.original) return false;
    const insert = menu.kind === "continuation"
      ? { from: target.to, original: "", text: menu.text }
      : menu.kind === "correction" ? { from: target.from, original: target.original, text: menu.text }
      : { from: target.from, original: target.original, text: menu.candidates[0].text + (menu.target.suffix ?? "") };
    if (!commitEditorText(view, { ...insert, to: target.to,
      cursor: "end", effects: [setMenu.of(null)], userEvent: "input.autosuggest" })) return false;
    view.focus();
    return true;
  };
  const field = StateField.define<Menu | null>({ create: () => null, update(value, tr) {
    if (tr.docChanged && value?.kind === "word" && (tr.isUserEvent("input.type") || tr.isUserEvent("delete")) &&
      tr.state.selection.main.empty && tr.state.selection.main.head === tr.changes.mapPos(value.target.to, 1)) {
      const targets = targetsAtCursor(tr.state, value.target.from);
      const matches = value.candidates.flatMap(candidate => {
        const target = targets.find(target => matchesSuggestionReading(target.reading, candidate.reading, target.pendingRomaji) &&
          wordSuggestionLabel(target, candidate.text, candidate.lexical) !== null);
        return target ? [{ candidate, target }] : [];
      });
      value = matches.length ? { kind: "word", target: matches[0].target, candidates: matches.map(match => match.candidate) } : null;
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
        const text = document.createElement("span"); text.className = "candidate-completion-text";
        if (completion.kind === "correction") {
          text.textContent = " → " + completion.text;
          this.ghost.setAttribute("aria-label", completion.text + " に訂正 (Tabで採用)");
        } else if (completion.kind === "continuation") {
          text.textContent = completion.text;
          this.ghost.setAttribute("aria-label", `${completion.text} を挿入 (Tabで採用)`);
        } else {
          const { target } = completion, candidate = completion.candidates[0];
          text.textContent = wordSuggestionLabel(target, candidate.text, candidate.lexical);
          this.ghost.setAttribute("aria-label", `${candidate.text} を補完 (Tabで採用)`);
        }
        const hint = document.createElement("span"); hint.className = "candidate-accept-hint";
        hint.innerHTML = '採用 <kbd>Tab</kbd>';
        this.ghost.replaceChildren(text, hint);
        if (this.ghost.hidden) this.ghost.style.visibility = "hidden";
        this.ghost.hidden = false;
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
      // Keep the current candidate while it is valid. Search again when it stops matching.
      if (completion && !configChanged) return;
      const committedTarget = this.view.state.field(convertedTarget);
      const targets = committedTarget && /^[ぁ-ゖー]{2,80}$/u.test(committedTarget.reading)
        ? [committedTarget] : targetsAtCursor(this.view.state);
      // Some IMEs deliver the final text transaction after compositionend.
      const japaneseCommit = update.transactions.some(tr => (tr.isUserEvent("input.type") || tr.isUserEvent("input.paste")) &&
        !tr.state.field(liveKanaSource, false) && tr.newSelection.main.empty &&
        /[ぁ-ゖァ-ヶ一-龯々ー]$/u.test(tr.newDoc.sliceString(Math.max(0, tr.newSelection.main.head - 1), tr.newSelection.main.head)));
      const ime = japaneseCommit || update.transactions.some(t => t.effects.some(e => e.is(refresh)));
      const committed = update.transactions.some(t => t.isUserEvent("input.convert") && t.effects.some(e => e.is(suggestAfterConversion)));
      if (!targets.length && !ime && !committed) return;
      this.timer = setTimeout(async () => {
        if (!allowed(this.view)) return;
        this.typedSinceRequest = 0; this.hasRequested = true;
        const controller = new AbortController(); this.controller = controller;
        try {
          const personal = settings().personalDictionary ?? [];
          const result = await resolveCompletion({
            doc: this.view.state.doc.toString(), cursor: this.view.state.selection.main.head,
            targets, ime, committed, personal, lookupSurface: suggestSurface, choices: conversionLearningChoices(), signal: controller.signal,
            lookup: async reading => {
              const cached = this.cache.get(reading);
              if (cached) return cached;
              const words = await suggestWords(reading, personal, controller.signal);
              if (!controller.signal.aborted) {
                if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
                this.cache.set(reading, words);
              }
              return words;
            },
          });
          if (!this.destroyed && revision === this.revision && allowed(this.view))
            this.view.dispatch({ effects: setMenu.of(result) });
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
      if (view.state.field(field)?.kind === "continuation") {
        pluginValue(view)?.dismiss();
        return true;
      }
      const retry = retryConversion(view);
      if (!retry && !view.state.field(field)) return false;
      pluginValue(view)?.dismiss();
      return true;
    },
  })))];
}
