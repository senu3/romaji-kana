import { StateField, type EditorState } from "@codemirror/state";
import { analyzeInput } from "./inputAnalysis";
import { defaultKanaEngine } from "./kanaEngine";
import { convertLocally } from "./localConversion";
import { defaultOllamaTransport } from "./ollamaProxy";
import type { AppSettings } from "./types";

/** Only consecutive edits in the current input run can supply a prefix. */
export const completionInputRun = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(run, tr) {
    if (!tr.docChanged) return tr.selection && !tr.selection.eq(tr.startState.selection) ? null : run;
    if (!(tr.isUserEvent("input.type") || tr.isUserEvent("input.paste") || tr.isUserEvent("delete")) ||
        !tr.newSelection.main.empty) return null;
    let result = null;
    tr.changes.iterChanges((from, to, newFrom, newTo) => {
      if (newTo !== tr.newSelection.main.head) return;
      const continuous = run && from >= run.from && to === run.to;
      result = { from: continuous ? run.from : newFrom, to: newTo };
    });
    return result;
  },
});

export function prefixBeforeCompletion(state: EditorState, from: number) {
  const run = state.field(completionInputRun);
  if (!run || run.to !== state.selection.main.head || run.from >= from) return "";
  const doc = state.doc.toString();
  const span = analyzeInput(doc).find(part => part.kind === "text" && part.from < from && from <= part.to);
  if (!span) return "";
  const before = doc.slice(Math.max(run.from, span.from), from);
  // A kana ending attached to existing kanji may be okurigana.
  return /(?:^|[\s。、！？!?，,「」『』])([ぁ-ゖーa-z]+)$/u.exec(before)?.[1] ?? "";
}

export async function convertCompletionPrefix(prefix: string, settings: AppSettings) {
  const result = await convertLocally(prefix, settings, defaultOllamaTransport, {
    purpose: "normal", kanaEngine: defaultKanaEngine, rerank: false,
  });
  return result.suggestionRejected || !result.text ? prefix : result.text;
}
