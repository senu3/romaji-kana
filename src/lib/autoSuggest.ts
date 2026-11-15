import { isInsideExcludedMarkdown } from "./conversion";
import { romajiToKana } from "./romajiKana";
import { normalizeKanaWidth } from "./readingComparison";
import type { Choice } from "./conversionLearning";
import type { WordSuggestion } from "./kanaEngine";
import { trailingReadingToken } from "./inputBoundaries";
import { analyzeInput } from "./inputAnalysis";

export interface SuggestTarget { from: number; to: number; original: string; reading: string; suffix?: string }
export function convertedSuggestTarget(from: number, original: string, reading: string): SuggestTarget {
  const suffix = /[、。，．,.\s]+$/u.exec(original)?.[0] ?? "";
  return { from, to: from + original.length, original, reading: reading.replace(/[、。，．,.\s]+$/u, ""), suffix };
}
export function suggestTarget(doc: string, cursor: number): SuggestTarget | null {
  return suggestTargets(doc, cursor)[0] ?? null;
}

export function suggestTargets(doc: string, cursor: number, inputFrom?: number): SuggestTarget[] {
  if (isInsideExcludedMarkdown(doc, cursor) || /[\wぁ-ゖァ-ヶー]/u.test(doc[cursor] ?? "")) return [];
  // Kana already committed before romaji belongs to the document, not this token.
  const span = analyzeInput(doc).find(part => part.kind === "text" && part.from < cursor && part.to >= cursor);
  if (!span) return [];
  const original = trailingReadingToken(doc.slice(Math.max(span.from, inputFrom ?? span.from), cursor));
  if (!original) return [];
  const from = cursor - original.length;
  if (from > span.from && /[\w]/u.test(doc[from - 1] ?? "")) return [];
  const converted = romajiToKana(normalizeKanaWidth(original));
  const targets: SuggestTarget[] = [];
  // Only split at transliteration token boundaries, never inside sha/kya etc.
  // Try the longest available prefix first, then bounded word-sized suffixes.
  for (const token of converted.tokens) {
    if (converted.kana.length - token.kanaFrom > 80) continue;
    const reading = converted.kana.slice(token.kanaFrom);
    if (!/^[ぁ-ゖー]{2,80}$/u.test(reading) || /^[ゃゅょぁぃぅぇぉっー]/u.test(reading)) continue;
    if (targets.length && reading.length > 12) continue;
    targets.push({ from: from + token.inputFrom, to: cursor, original: original.slice(token.inputFrom), reading });
  }
  return targets;
}
export function rankSuggestions(reading: string, candidates: WordSuggestion[], choices: Choice[]): WordSuggestion[] {
  const counts = new Map(choices.map(c => [JSON.stringify([c.reading, c.text]), c.count]));
  const learned = choices.map(c => ({ reading: c.reading, text: c.text, source: "learning" as const, cost: 0 }));
  const seen = new Set<string>();
  return [...learned, ...candidates].filter(c => c.reading.startsWith(reading) && c.reading.length > reading.length &&
    c.reading.length <= reading.length + 12 && /^[ぁ-ゖー]+$/u.test(c.reading) && c.text.length <= 80 && c.text.length > 0 && !/[\r\n]/u.test(c.text))
    .sort((a, b) => (counts.get(JSON.stringify([b.reading, b.text])) ?? 0) - (counts.get(JSON.stringify([a.reading, a.text])) ?? 0) ||
      Number(b.source === "user") - Number(a.source === "user") || a.cost - b.cost || a.reading.length - b.reading.length || a.text.localeCompare(b.text, "ja"))
    .filter(c => !seen.has(c.text) && Boolean(seen.add(c.text))).slice(0, 5);
}
