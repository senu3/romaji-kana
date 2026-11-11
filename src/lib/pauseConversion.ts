import { EditorState, StateField, Transaction } from "@codemirror/state";
import { rememberPauseConversion } from "./editorConversionEffects";
import { rememberUnconvertedRange } from "./unconvertedRanges";

// A pause changes the displayed spelling, but does not end the user's word.
// Explicit acceptance, navigation and delimiters settle it instead.
export const pauseConversion = StateField.define<{ from: number; to: number; original: string } | null>({
  create: () => null,
  update(previous, transaction) {
    const applied = transaction.effects.find(effect => effect.is(rememberPauseConversion));
    if (applied) return applied.value;
    return transaction.docChanged || transaction.selection ? null : previous;
  },
});

export const resumePauseConversion = EditorState.transactionFilter.of(transaction => {
  const previous = transaction.startState.field(pauseConversion, false);
  const selection = transaction.startState.selection.main;
  if (!previous || transaction.annotation(Transaction.userEvent) !== "input.type" || !selection.empty ||
    selection.head !== previous.to || transaction.startState.selection.ranges.length !== 1) return transaction;

  let continues = false;
  let count = 0;
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    count++;
    continues = from === previous.to && to === from && /^[A-Za-z]+$/u.test(inserted.toString());
  });
  if (count !== 1 || !continues) return transaction;

  // Restore the source in the same transaction as the new input. Selection and
  // Undo therefore see one edit, and conversion receives e.g. "hon" + "tou".
  return [transaction, {
    changes: { from: previous.from, to: previous.to, insert: previous.original },
    effects: rememberUnconvertedRange.of({ from: previous.from,
      to: transaction.newSelection.main.head + previous.original.length - (previous.to - previous.from) }),
    sequential: true,
  }];
});
