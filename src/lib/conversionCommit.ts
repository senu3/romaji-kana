import type { EditorView } from "@codemirror/view";
import type { GhostConversionSuggestion } from "./types";
import { commitEditorText } from "./editorCommit";
import { acceptConversionSession } from "./conversionSession";
import { convertedSuggestTarget } from "./autoSuggest";
import { clearGhostSuggestion, removeLoadingDecoration, suggestAfterConversion } from "./editorConversionEffects";
import type { JapaneseConversionResult } from "./japaneseConversionTypes";
import type { AppSettings, ConversionTrigger } from "./types";
import { isSelectingCompletion } from "./completionSelection";

export function canApplyConversionAutomatically(view: EditorView, result: JapaneseConversionResult,
  mode: AppSettings["conversionMode"], trigger?: ConversionTrigger): boolean {
  if (mode !== "replace" || trigger === "space" || isSelectingCompletion(view.state) || result.suggestionRejected) return false;
  if (result.session?.rerankStatus === "pending" || result.session?.rerankStatus === "failed") return false;
  if (result.changes?.readingAssessment?.status !== "verified" || result.conversionStrategy === "speculative") return false;
  const kind = result.changes.kind;
  return kind === "notation" || (kind === "correction" && result.conversionStrategy === "correction");
}

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
