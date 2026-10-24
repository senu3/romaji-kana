import { Prec, StateEffect, StateField, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { suggestWords, type WordSuggestion } from "../lib/kanaEngine";
import { conversionLearningChoices } from "../lib/conversionLearning";
import { convertedSuggestTarget, rankSuggestions, suggestTarget, type SuggestTarget } from "../lib/autoSuggest";
import type { AppSettings } from "../lib/types";

interface Menu { target: SuggestTarget; candidates: WordSuggestion[]; selected: number; pending?: boolean }
// Conversion supplies the known reading; no reverse lookup or model call is needed.
export const suggestAfterConversion = StateEffect.define<SuggestTarget>();
export function autoSuggestExtension(settings: () => AppSettings, converting: (view: EditorView) => boolean) {
  const setMenu = StateEffect.define<Menu | null>();
  const refresh = StateEffect.define<void>();
  const allowed = (view: EditorView) => settings().autoSuggest && !view.composing && view.hasFocus && view.state.selection.main.empty;
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
  const accept = (view: EditorView, index?: number) => {
    const menu = view.state.field(field);
    if (!menu || menu.pending || !allowed(view)) return false;
    const { target } = menu;
    if (view.state.selection.main.head !== target.to || view.state.doc.sliceString(target.from, target.to) !== target.original) return false;
    const candidate = menu.candidates[index ?? menu.selected];
    const insert = candidate.text + (target.suffix ?? "");
    view.dispatch({ changes: { from: target.from, to: target.to, insert },
      selection: { anchor: target.from + insert.length }, effects: setMenu.of(null),
      annotations: [Transaction.userEvent.of("input.autosuggest"), isolateHistory.of("full")] });
    view.focus();
    return true;
  };
  const createTooltip: Tooltip["create"] = view => {
      const dom = document.createElement("div"); dom.className = "word-suggestions";
      dom.setAttribute("role", "group"); dom.setAttribute("aria-label", "補完候補");
      let rendered: Menu | null = null;
      const render = () => {
      const menu = view.state.field(field); if (!menu || menu === rendered) return;
      rendered = menu;
      dom.replaceChildren();
      dom.setAttribute("aria-busy", String(Boolean(menu.pending)));
      const heading = dom.appendChild(document.createElement("div")); heading.className = "word-suggestions-heading";
      heading.textContent = menu.pending ? "補完 · 更新中" : "補完 · ↑↓で選択 / Alt+Enterで確定";
      menu.candidates.forEach((c, index) => {
        const button = dom.appendChild(document.createElement("button")); button.type = "button";
        button.className = index === menu.selected ? "selected" : "";
        button.setAttribute("aria-label", `${c.text} を補完`);
        button.setAttribute("aria-pressed", String(index === menu.selected));
        button.tabIndex = -1;
        button.disabled = Boolean(menu.pending);
        const text = button.appendChild(document.createElement("strong")); text.textContent = c.text;
        const reading = button.appendChild(document.createElement("small")); reading.textContent = c.reading;
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("click", () => accept(view, index));
      });
      };
      render();
      return { dom, update: render };
  };
  const tooltip = (menu: Menu): Tooltip => ({ pos: menu.target.to, above: false, strictSide: false, create: createTooltip });
  const field = StateField.define<Menu | null>({ create: () => null, update(value, tr) {
    if (tr.docChanged && value && (tr.isUserEvent("input.type") || tr.isUserEvent("delete")) &&
      tr.state.selection.main.empty && tr.state.selection.main.head === tr.changes.mapPos(value.target.to, 1)) {
      value = { ...value, pending: true, target: { ...value.target, to: tr.state.selection.main.head } };
    } else if (tr.docChanged || tr.selection) value = null;
    for (const effect of tr.effects) if (effect.is(setMenu)) value = effect.value;
    return value;
  }, provide: f => showTooltip.from(f, value => value ? tooltip(value) : null) });
  const plugin = ViewPlugin.fromClass(class {
    timer?: ReturnType<typeof setTimeout>;
    revision = 0; destroyed = false; controller?: AbortController;
    cache = new Map<string, WordSuggestion[]>();
    config = ""; wasConverting = false;
    constructor(readonly view: EditorView) { this.config = this.configKey(); }
    configKey() { return JSON.stringify([settings().autoSuggest, settings().personalDictionary]); }
    update(update: ViewUpdate) {
      const nextConfig = this.configKey(), nextConverting = converting(this.view);
      const configChanged = nextConfig !== this.config;
      this.config = nextConfig;
      if (configChanged) this.cache.clear();
      const conversionChanged = nextConverting !== this.wasConverting; this.wasConverting = nextConverting;
      const converted = update.transactions.some(t => t.effects.some(e => e.is(suggestAfterConversion) || e.is(refresh)));
      if (!update.docChanged && !update.selectionSet && !update.focusChanged && !configChanged && !conversionChanged && !converted) return;
      const revision = ++this.revision;
      clearTimeout(this.timer); this.controller?.abort();
      // Keep existing alternatives visible while normal conversion is running.
      if (!allowed(this.view) || configChanged) queueMicrotask(() => { if (!this.destroyed && revision === this.revision && this.view.state.field(field)) this.view.dispatch({ effects: setMenu.of(null) }); });
      if (!allowed(this.view) || update.transactions.some(t => t.isUserEvent("input.autosuggest") || t.isUserEvent("undo") || t.isUserEvent("redo"))) return;
      if (nextConverting) return;
      const target = this.view.state.field(convertedTarget) ?? suggestTarget(this.view.state.doc.toString(), this.view.state.selection.main.head);
      if (!target) {
        this.timer = setTimeout(() => { if (!this.destroyed && revision === this.revision) this.view.dispatch({ effects: setMenu.of(null) }); }, 350);
        return;
      }
      this.timer = setTimeout(async () => {
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
          const ranked = rankSuggestions(target.reading, candidates, conversionLearningChoices());
          this.view.dispatch({ effects: setMenu.of(ranked.length ? { target, candidates: ranked, selected: 0 } : null) });
        } catch {
          if (!this.destroyed && revision === this.revision) this.view.dispatch({ effects: setMenu.of(null) });
        }
      }, 120);
    }
    destroy() { this.destroyed = true; ++this.revision; clearTimeout(this.timer); this.controller?.abort(); }
  }, { eventHandlers: { compositionstart() {
    ++this.revision; clearTimeout(this.timer); this.controller?.abort();
    if (this.view.state.field(field)) this.view.dispatch({ effects: setMenu.of(null) });
    return false;
  }, compositionend() {
    queueMicrotask(() => { if (!this.destroyed) this.view.dispatch({ effects: refresh.of() }); });
    return false;
  } } });
  const move = (view: EditorView, direction: number) => {
    const menu = view.state.field(field); if (!menu || menu.pending || !allowed(view)) return false;
    view.dispatch({ effects: setMenu.of({ ...menu, selected: (menu.selected + direction + menu.candidates.length) % menu.candidates.length }) }); return true;
  };
  return [field, convertedTarget, plugin, Prec.highest(keymap.of([
    { key: "Alt-Enter", run: view => accept(view) },
    { key: "ArrowDown", run: view => move(view, 1) }, { key: "ArrowUp", run: view => move(view, -1) },
    { key: "Escape", run: view => { if (!view.state.field(field)) return false; view.dispatch({ effects: setMenu.of(null) }); return true; } },
  ])), EditorView.baseTheme({
    ".cm-tooltip.word-suggestions": { minWidth: "220px", maxWidth: "min(360px, 90vw)", padding: "6px", background: "var(--surface, white)", color: "var(--ink, #16343b)", border: "1px solid var(--line, #cbd8dc)" },
    ".word-suggestions-heading": { padding: "6px", fontSize: "11px" },
    ".word-suggestions button": { display: "flex", justifyContent: "space-between", gap: "16px", width: "100%", padding: "8px", background: "transparent", color: "inherit", border: "0", textAlign: "left", cursor: "pointer", overflowWrap: "anywhere" },
    ".word-suggestions button.selected, .word-suggestions button:hover": { background: "var(--accent-soft, #e4f5f0)" },
    ".word-suggestions button:focus-visible": { outline: "2px solid var(--accent, #007f83)" },
    ".word-suggestions button:disabled": { cursor: "progress", opacity: "0.6" },
  })];
}
