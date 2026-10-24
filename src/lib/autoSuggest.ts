import { isInsideExcludedMarkdown } from "./conversion";
import { romajiToKana } from "./romajiKana";
import { normalizeKanaWidth } from "./readingComparison";
import type { Choice } from "./conversionLearning";
import type { WordSuggestion } from "./kanaEngine";

export interface SuggestTarget { from: number; to: number; original: string; reading: string; suffix?: string }
export function convertedSuggestTarget(from: number, original: string, reading: string): SuggestTarget {
  const suffix = /[、。，．,.\s]+$/u.exec(original)?.[0] ?? "";
  return { from, to: from + original.length, original, reading: reading.replace(/[、。，．,.\s]+$/u, ""), suffix };
}
export function suggestTarget(doc: string, cursor: number): SuggestTarget | null {
  if (isInsideExcludedMarkdown(doc, cursor) || /[\wぁ-ゖァ-ヶー]/u.test(doc[cursor] ?? "")) return null;
  // Kana already committed before romaji belongs to the document, not this token.
  const match = /(?:[A-Za-z]+|[ぁ-ゖァ-ヶー]+)$/u.exec(doc.slice(Math.max(0, cursor - 81), cursor));
  if (!match || match[0].length > 80) return null;
  const original = match[0], from = cursor - original.length;
  if (/[\w]/u.test(doc[from - 1] ?? "")) return null;
  if (isInsideExcludedMarkdown(doc, from)) return null;
  const converted = romajiToKana(normalizeKanaWidth(original));
  if (converted.lowConfidenceSpans.length || !/^[ぁ-ゖー]{2,80}$/u.test(converted.kana)) return null;
  return { from, to: cursor, original, reading: converted.kana };
}
export function rankSuggestions(reading: string, candidates: WordSuggestion[], choices: Choice[]): WordSuggestion[] {
  const counts = new Map(choices.map(c => [JSON.stringify([c.reading, c.text]), c.count]));
  const learned = choices.map(c => ({ reading: c.reading, text: c.text, source: "learning" as const, cost: 0 }));
  const seen = new Set<string>();
  return [...learned, ...candidates].filter(c => c.reading.startsWith(reading) && c.reading.length > reading.length &&
    c.reading.length <= reading.length + 12 && c.text.length <= 80 && c.text.length > 0 && !/[\r\n]/u.test(c.text))
    .sort((a, b) => (counts.get(JSON.stringify([b.reading, b.text])) ?? 0) - (counts.get(JSON.stringify([a.reading, a.text])) ?? 0) ||
      Number(b.source === "user") - Number(a.source === "user") || a.cost - b.cost || a.reading.length - b.reading.length || a.text.localeCompare(b.text, "ja"))
    .filter(c => !seen.has(c.text) && Boolean(seen.add(c.text))).slice(0, 5);
}
