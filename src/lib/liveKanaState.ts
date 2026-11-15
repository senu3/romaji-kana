import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { analyzeInput, isExcludedInput } from "./inputAnalysis";
import { getMarkdownLineBoundary, isInsideExcludedMarkdown } from "./conversion";
import { isPendingNumericSeparator } from "./conversionBoundaries";
import { romajiToKana } from "./romajiKana";
import type { ConversionRange, ConversionTrigger } from "./types";

interface LiveInput { from: number; to: number; source: string }
export const rememberLiveKana = StateEffect.define<LiveInput>();
export const liveKanaSource = StateField.define<LiveInput | null>({
  create: () => null,
  update(value, tr) {
    const effect = tr.effects.find(e => e.is(rememberLiveKana));
    if (effect) return effect.value;
    if (!tr.docChanged) return value;
    return null;
  },
});

// The document contains real kana (including for save/copy/Undo). Source keys
// remain separate so an unfinished syllable and a pause can be continued.
export function renderLiveKana(source: string): string {
  return analyzeInput(source).map(span => span.kind === "text"
    ? romajiToKana(source.slice(span.from, span.to)).kana
    : source.slice(span.from, span.to)).join("");
}

export function liveKanaRange(state: EditorState, cursor: number, trigger: ConversionTrigger): ConversionRange | null {
  const value = state.field(liveKanaSource, false);
  if (!value || cursor !== value.to || !/[a-zぁ-ゖ]/iu.test(value.source) ||
    isInsideExcludedMarkdown(state.doc.toString(), cursor) ||
    isPendingNumericSeparator(value.source, value.source.length)) return null;
  const spans = analyzeInput(value.source);
  const protectedEnd = spans.reduce((end, span) => isExcludedInput(span) ? span.to : end, 0);
  const sourceStart = Math.max(protectedEnd, value.from === state.doc.lineAt(value.from).from ? getMarkdownLineBoundary(value.source) : 0);
  const source = value.source.slice(sourceStart);
  const trimmed = source.trimStart();
  const from = value.from + renderLiveKana(value.source.slice(0, sourceStart + source.length - trimmed.length)).length;
  if (!trimmed || !analyzeInput(trimmed).some(span => span.kind === "text" && /[a-zぁ-ゖ]/iu.test(trimmed.slice(span.from, span.to)))) return null;
  return { from, to: value.to, text: state.sliceDoc(from, value.to), inputText: trimmed, trigger };
}

