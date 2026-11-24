import { Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { GhostConversionSuggestion } from "../lib/types";
import { candidateDetails } from "../lib/conversionCandidate";
import { completionSelection } from "../lib/completionSelection";
import { suggestionMenuTheme } from "./suggestionMenu";
import { candidateBindings, candidateHelp, moveCandidateIndex } from "../lib/candidateInteraction";
import { candidateSurface } from "./candidateSurface";

interface Menu { suggestion: GhostConversionSuggestion; choices: GhostConversionSuggestion[]; selected: number }

export function speculationExtension(getSuggestion: (state: EditorState) => GhostConversionSuggestion | null, actions: {
  accept: (view: EditorView, suggestion: GhostConversionSuggestion) => void;
  dismiss: (view: EditorView) => void;
}) {
  const select = StateEffect.define<number>();
  const field = StateField.define<Menu | null>({ create: () => null, update(previous, tr) {
    const suggestion = getSuggestion(tr.state);
    if (!suggestion || suggestion.previewOnly || suggestion.conversionStrategy !== "speculative") return null;
    if (previous?.suggestion === suggestion && !tr.effects.some(effect => effect.is(select))) return previous;
    const seen = new Set<string>();
    const choices = (suggestion.session?.candidates.map(c => ({ ...suggestion, ...candidateDetails(c.result), session: suggestion.session })) ?? [suggestion])
      .filter(c => { const key = c.convertedText.normalize("NFKC").replace(/[\s。、,.!?！？]+/gu, ""); if (!key || seen.has(key)) return false; seen.add(key); return true; }).slice(0, 3);
    if (!choices.length) return null;
    let selected = previous?.suggestion === suggestion ? previous.selected
      : Math.max(0, choices.findIndex(choice => choice.convertedText === suggestion.convertedText));
    for (const effect of tr.effects) if (effect.is(select)) selected = effect.value;
    return { suggestion, choices, selected: selected < choices.length ? selected : -1 };
  }, provide: field => completionSelection.from(field, menu => Boolean(menu)) });
  const accept = (view: EditorView, index?: number) => {
    const menu = view.state.field(field);
    const chosen = index ?? menu?.selected ?? -1;
    if (!menu || view.composing || chosen < 0 || !menu.choices[chosen]) return false;
    const suggestion = menu.choices[chosen];
    if (getSuggestion(view.state)?.id !== suggestion.id || view.state.doc.sliceString(suggestion.from, suggestion.to) !== suggestion.originalText) return false;
    actions.accept(view, suggestion);
    return true;
  };
  const create = (view: EditorView) => {
    const dom = document.createElement("div"); dom.className = "word-suggestions speculation-suggestions";
    dom.setAttribute("role", "group"); dom.setAttribute("aria-label", "推測候補");
    dom.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); actions.dismiss(view); view.focus();
    });
    let rendered: Menu | null = null;
    const render = () => {
      const menu = view.state.field(field); if (!menu || menu === rendered) return;
      const detailsOpen = dom.querySelector("details")?.open ?? false;
      rendered = menu; dom.replaceChildren();
      const heading = dom.appendChild(document.createElement("div")); heading.className = "word-suggestions-heading";
      heading.setAttribute("aria-live", "polite");
      heading.textContent = `推測候補 · ${candidateHelp}`;
      menu.choices.forEach((choice, index) => {
        const button = dom.appendChild(document.createElement("button")); button.type = "button";
        button.className = index === menu.selected ? "selected" : "";
        button.setAttribute("aria-label", `${choice.convertedText} を採用`);
        button.setAttribute("aria-pressed", String(index === menu.selected)); button.tabIndex = -1;
        button.appendChild(document.createElement("strong")).textContent = choice.convertedText;
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("click", () => accept(view, index));
      });
      const announcement = dom.appendChild(document.createElement("span"));
      announcement.className = "sr-only"; announcement.setAttribute("role", "status");
      announcement.textContent = menu.selected < 0 ? `${menu.choices.length}件の推測候補` : `${menu.selected + 1}件目：${menu.choices[menu.selected].convertedText}`;
      const details = dom.appendChild(document.createElement("details")); details.open = detailsOpen;
      details.appendChild(document.createElement("summary")).textContent = "置き換える範囲と読み";
      const choice = menu.choices[menu.selected < 0 ? 0 : menu.selected];
      details.appendChild(document.createElement("p")).textContent = `変換前：${menu.suggestion.originalText}`;
      details.appendChild(document.createElement("p")).textContent = `候補の読み：${choice.reviewKana ?? "未確認"}`;
      const close = details.appendChild(document.createElement("button")); close.type = "button"; close.textContent = "推測候補を閉じる";
      close.addEventListener("click", () => { actions.dismiss(view); view.focus(); });
    };
    render(); return { dom, update: render };
  };
  const move = (view: EditorView, direction: number) => {
    const menu = view.state.field(field); if (!menu || view.composing) return false;
    const selected = moveCandidateIndex(menu.selected, menu.choices.length, direction);
    if (selected === null) return false;
    if (menu.suggestion.session) menu.suggestion.session.locked = true;
    view.dispatch({ effects: select.of(selected) }); return true;
  };
  return [field, candidateSurface(view => view.state.field(field)?.suggestion.to ?? null, create),
    Prec.highest(keymap.of(candidateBindings({ accept, move,
      dismiss: view => { if (!view.state.field(field)) return false; actions.dismiss(view); return true; },
    }))), EditorView.domEventHandlers({ compositionstart: (_event, view) => { if (view.state.field(field)) actions.dismiss(view); return false; } }), suggestionMenuTheme];
}
