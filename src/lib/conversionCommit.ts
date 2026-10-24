import type { EditorView } from "@codemirror/view";
import type { GhostConversionSuggestion } from "./types";
import { commitEditorText } from "./editorCommit";
import { acceptConversionSession } from "./conversionSession";
import { convertedSuggestTarget } from "./autoSuggest";
import { clearGhostSuggestion, removeLoadingDecoration, suggestAfterConversion } from "./editorConversionEffects";

export type ConversionCommitReason = "explicit" | "automatic" | "history";
export function commitConversion(view: EditorView, suggestion: GhostConversionSuggestion,
  reason: ConversionCommitReason, cursor: "end" | "map" = "map"): boolean {
  if (suggestion.previewOnly || (suggestion.session && suggestion.session.state !== "open")) return false;
  return commitEditorText(view, {
    from: suggestion.from, to: suggestion.to, original: suggestion.originalText, text: suggestion.convertedText, cursor,
    userEvent: reason === "explicit" ? "input.ghostAccept" : reason === "history" ? "input.historyApply" : "input.convert",
    effects: [removeLoadingDecoration.of(suggestion.id), clearGhostSuggestion.of(suggestion.id),
      suggestAfterConversion.of(convertedSuggestTarget(suggestion.from, suggestion.convertedText,
        suggestion.changes?.resultReading ?? suggestion.reviewKana ?? ""))],
  }, () => acceptConversionSession(suggestion.session));
}
