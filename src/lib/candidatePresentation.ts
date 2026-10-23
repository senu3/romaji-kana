export function candidatePresentation(candidate: { conversionStrategy?: "correction" | "speculative" }) {
  if (candidate.conversionStrategy === "speculative") return { label: "推測候補", description: "入力から推測した候補です。内容を確認して採用してください。" };
  if (candidate.conversionStrategy === "correction") return { label: "誤字修正候補", description: "入力の誤字を修正した候補です。変更内容を確認して採用してください。" };
  return { label: "通常変換", description: "入力の読みをもとに表記を変換した候補です。" };
}
