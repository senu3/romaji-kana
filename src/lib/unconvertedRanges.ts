import { isSentenceBoundary } from "./conversionBoundaries";
import { StateEffect, StateField, Transaction, type EditorState } from "@codemirror/state";
import { extractConversionRange, isInsideExcludedMarkdown } from "./conversion";
import type { ConversionRange, ConversionTrigger } from "./types";

interface Range { from: number; to: number }
export const rememberUnconvertedRange = StateEffect.define<Range>();
const settledEvents = ["input.convert", "input.historyApply", "input.ghostAccept", "input.autosuggest"];

// Kept independently of ghost decorations: failed/rejected candidates must not
// lose the original editing range. Positions follow CodeMirror transactions.
export const unconvertedRanges = StateField.define<readonly Range[]>({
  create: () => [],
  update(ranges, transaction) {
    const event = transaction.annotation(Transaction.userEvent) ?? "";
    if (event.startsWith("document.")) return [];
    let next: Range[] = [];
    for (const range of ranges) {
      let parts = [range];
      if (settledEvents.includes(event)) {
        transaction.changes.iterChangedRanges((from, to) => {
          parts = parts.flatMap(part => {
            if (to <= part.from || from >= part.to) return [part];
            return [
              { from: part.from, to: Math.min(from, part.to) },
              { from: Math.max(to, part.from), to: part.to },
            ].filter(part => part.from < part.to);
          });
        });
      }
      next.push(...parts.map(part => ({
        from: transaction.changes.mapPos(part.from, settledEvents.includes(event) ? 1 : -1),
        to: transaction.changes.mapPos(part.to, settledEvents.includes(event) ? -1 : 1),
      })).filter(part => part.from < part.to));
    }
    for (const effect of transaction.effects) {
      if (!effect.is(rememberUnconvertedRange)) continue;
      const range = effect.value;
      // Replace overlapping memories, but never merge adjacent sentences.
      next = next.filter(part => part.to <= range.from || part.from >= range.to);
      next.push(range);
    }
    return next;
  },
});

export function retainedConversionRange(
  state: EditorState,
  cursor: number,
  trigger: ConversionTrigger,
): ConversionRange | null {
  const doc = state.doc.toString();
  const position = Math.max(0, Math.min(cursor, doc.length));
  if (isInsideExcludedMarkdown(doc, position)) return null;
  const retained = state.field(unconvertedRanges, false)?.find(range =>
    range.from <= position && position <= range.to,
  );

  // Punctuation explicitly typed at the caret ends this request. In particular,
  // inserting a period into a remembered sentence must not consume the next one.
  if ((trigger === "period" || trigger === "comma") || isSentenceBoundary(doc, position - 1)) {
    return extractConversionRange(doc, position, trigger);
  }

  let end = position;
  const lineEnd = Math.min(state.doc.lineAt(position).to, retained?.to ?? doc.length);
  while (end < lineEnd) {
    const char = doc[end];
    if (isSentenceBoundary(doc, end)) { end++; break; }
    // For restored/unrequested text, extend through romaji only. A remembered
    // range can include mixed Japanese, but never cross Markdown code/URLs.
    if ((!retained || end >= retained.to) && !/[A-Za-z0-9.,\t '\-]/u.test(char)) break;
    if (char === "`" || isInsideExcludedMarkdown(doc, end)) break;
    end++;
  }
  // Exclusion checks include the opening boundary of code/URLs. Whitespace
  // before that boundary belongs to neither protected text nor the request.
  if (isInsideExcludedMarkdown(doc, end)) {
    while (end > position && /\s/u.test(doc[end - 1])) end--;
  }
  const range = extractConversionRange(doc, end, trigger);
  // A Japanese/Markdown boundary may cause the extractor to jump past the
  // caret. Never convert a different phrase just because it follows the caret.
  if (!range || range.from > position) return extractConversionRange(doc, position, trigger);
  if (retained && retained.from > range.from) {
    const from = retained.from;
    return { from, to: range.to, text: doc.slice(from, range.to), trigger };
  }
  return range;
}
