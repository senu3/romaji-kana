import type { GhostConversionSuggestion } from "./types";

type CandidateMetadata = Pick<GhostConversionSuggestion,
  "conversionStrategy" | "inputCompletionLevel">;

// Describe the generation path, not whether a model's suggestion is correct.
export function candidatePresentation(candidate: CandidateMetadata) {
  if (candidate.conversionStrategy === "speculative") {
    return { label: "推測候補", description: "入力から推測した候補です。内容を確認して採用してください。" };
  }
  if (candidate.inputCompletionLevel === "sentence") {
    return { label: "文章提案", description: "補足や言い換えを含むことがあります。変換前と比較してください。" };
  }
  if (candidate.inputCompletionLevel === "word") {
    return { label: "単語補完", description: "末尾の未完成の単語を補う候補です。" };
  }
  if (candidate.conversionStrategy === "completion") {
    return { label: "補完変換", description: "通常の変換で候補が得られず、入力を補って生成した候補です。" };
  }
  return { label: "通常変換", description: "入力の読みをもとに表記を変換した候補です。" };
}
