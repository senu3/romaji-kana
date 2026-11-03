import { analyzeInput } from "./inputAnalysis";

export function isNumericSeparator(text: string, index: number): boolean {
  return /[.,]/u.test(text[index] ?? "") && /\d/u.test(text[index - 1] ?? "") && /\d/u.test(text[index + 1] ?? "");
}

/** A trailing separator after a digit may still become a decimal or grouping
 * separator. Automatic conversion waits for the next character. */
export function isPendingNumericSeparator(text: string, cursor: number): boolean {
  return /[.,]/u.test(text[cursor - 1] ?? "") && /\d/u.test(text[cursor - 2] ?? "");
}

export function isSentenceBoundary(text: string, index: number): boolean {
  return /[。、.,\n]/u.test(text[index] ?? "") && !isNumericSeparator(text, index);
}

// Compatibility adapter; lexical rules live in inputAnalysis.
export function excludedRanges(doc: string) {
  return analyzeInput(doc).filter(span => span.kind !== "text");
}
