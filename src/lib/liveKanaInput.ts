import { EditorState, Transaction } from "@codemirror/state";
import { isInsideExcludedMarkdown } from "./conversion";
import { isSentenceBoundary } from "./conversionBoundaries";
import { pauseConversion } from "./pauseConversion";
import { liveKanaSource, rememberLiveKana, renderLiveKana } from "./liveKanaState";

export function liveKanaInput(enabled: () => boolean) {
  return [liveKanaSource, EditorState.transactionFilter.of(tr => {
    if (!enabled() || tr.startState.selection.ranges.length !== 1) return tr;
    const event = tr.annotation(Transaction.userEvent) ?? "";
    if (event !== "input.type" && !event.startsWith("delete.")) return tr;
    const edits: { from: number; to: number; text: string }[] = [];
    tr.changes.iterChanges((from, to, _a, _b, inserted) => edits.push({ from, to, text: inserted.toString() }));
    if (edits.length !== 1) return tr;
    const edit = edits[0];
    if (/[^\x20-\x7e]/u.test(edit.text)) return tr;
    let previous = tr.startState.field(liveKanaSource);
    const paused = tr.startState.field(pauseConversion, false);
    if (!previous && paused && edit.from === paused.to && edit.to === paused.to && /^[a-z]+$/iu.test(edit.text)) {
      previous = { from: paused.from, to: paused.to, source: paused.original };
    }
    const continues = previous && edit.from === previous.to && edit.to === previous.to &&
      !isSentenceBoundary(previous.source + edit.text, previous.source.length - 1) &&
      !/[．!?！？]$/u.test(previous.source);
    let from = edit.from, to = edit.to, source = edit.text;
    if (continues) {
      from = previous!.from; to = previous!.to; source = previous!.source + edit.text;
    } else if (previous && edit.from >= previous.from && edit.from < previous.to && edit.to <= previous.to) {
      // An edit inside a syllable settles its spelling. This also makes deleting
      // one character of e.g. きゃ behave like normal document editing.
      from = previous.from; to = previous.to;
      source = tr.startState.sliceDoc(from, edit.from) + edit.text + tr.startState.sliceDoc(edit.to, to);
    } else if (!edit.text || isInsideExcludedMarkdown(tr.startState.doc.toString(), edit.from)) return tr;
    const display = renderLiveKana(source);
    const caretSource = source.length - (previous && !continues && to > edit.to ? to - edit.to : 0);
    const head = from + renderLiveKana(source.slice(0, caretSource)).length;
    return {
      changes: { from, to, insert: display }, selection: { anchor: head },
      effects: [...tr.effects, rememberLiveKana.of({ from, to: from + display.length, source })],
      annotations: [Transaction.userEvent.of(event), Transaction.addToHistory.of(tr.annotation(Transaction.addToHistory) !== false)],
      scrollIntoView: tr.scrollIntoView,
    };
  })];
}
