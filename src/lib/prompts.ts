import { finalReadingRule, localCorrectionRule, typoCorrectionRule } from "./conversionRules";
import { protectedContentPrompt } from "./conversionProtection";
export const defaultConversionPrompt = "You convert Japanese into natural writing while preserving the author's intent.\nPreserve the input reading in ordinary conversion. Correct or infer only when the application explicitly requests that route.\nPreserve numbers, identifiers, protected terms and punctuation. Never invent facts.\nIf no plausible candidate exists, report no candidate. Never return mechanical kana as a fallback.\nFollow the application's response format.";
function additionalConversionPreference(value: string): string { return value.trim() && value !== defaultConversionPrompt ? value.trim() : "None."; }
export function buildSpeculationSystemPrompt(userPrompt: string, segmented = false): string {
  return [
    "以下の文章には、変換ミス・誤字・脱字が含まれている可能性があります。",
    "前後の文脈から本来入力したかった内容を推測し、その意図を変えない範囲で自然な日本語に修正してください。",
    "- 誤変換、誤字、脱字、余分な文字を修正する",
    "- 助詞や活用の不自然さも修正する",
    "- 情報を勝手に追加しない",
    segmented
      ? 'The target is an ordered list of editable parts and immutable literals. Interpret them together. Return only {"segments":[{"id":"supplied editable ID","convertedText":"Japanese for this editable part","completedKana":"its hiragana reading"}]}, with every editable ID once in order. Never include or pronounce literal parts; the app restores them. For no candidate return {"segments":[]}.'
      : 'Return only {"convertedText":"Japanese target","completedKana":"its hiragana reading"}. For no candidate return {"convertedText":"","completedKana":""}.',
    "completedKana must read the generated text exactly, not the input. No kanji in completedKana; retain digits, punctuation and line breaks. No explanations or control characters except tabs and line breaks.",
    additionalConversionPreference(userPrompt) !== "None." ? "Additional preference: " + additionalConversionPreference(userPrompt) : "",
  ].filter(Boolean).join("\n");
}
export function conversionOutputContract(): string { return [
  "Return exactly one JSON object. Write convertedText (the FINAL Japanese output) and completedKana (its hiragana reading).",
  ...finalReadingRule.guidance, finalReadingRule.controlPrompt("final"),
].join("\n"); }

export function buildCorrectionSystemPrompt(userPrompt: string): string {
  return ["You minimally repair typing errors before converting Japanese kana text into natural Japanese writing.",
    ...typoCorrectionRule.guidance, localCorrectionRule.prompt().replace(/correctedKana/g, "completedKana"),
    protectedContentPrompt, "Additional user preference:", additionalConversionPreference(userPrompt),
    'If no plausible correction exists, return {"convertedText":"","completedKana":""}. Never echo the mechanical kana as a fallback.',
  ].join("\n");
}
