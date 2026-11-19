import { isInsideExcludedMarkdown } from "./conversion";
import { romajiPrefixMatchesReading, romajiToKana } from "./romajiKana";
import { normalizeKanaWidth } from "./readingComparison";
import type { Choice } from "./conversionLearning";
import type { WordSuggestion } from "./kanaEngine";
import { trailingReadingToken } from "./inputBoundaries";
import { analyzeInput } from "./inputAnalysis";

export interface SuggestTarget { from: number; to: number; original: string; reading: string; pendingRomaji?: string; suffix?: string }
interface LiveReading { from: number; to: number; source: string }
const sentenceSegmenter = new Intl.Segmenter("ja", { granularity: "sentence" });
const wordSegmenter = new Intl.Segmenter("ja", { granularity: "word" });
const MAX_CONTINUATION_CONTEXT = 8_192;
const MAX_CONTINUATION_LENGTH = 32;
const MIN_CONTINUATION_LENGTH = 3;
const JAPANESE_PROSE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々、。！？]+$/u;

function hasEnoughContinuation(text: string): boolean {
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= MIN_CONTINUATION_LENGTH;
}

export function convertedSuggestTarget(from: number, original: string, reading: string): SuggestTarget {
  const suffix = /[、。，．,.\s]+$/u.exec(original)?.[0] ?? "";
  return { from, to: from + original.length, original, reading: reading.replace(/[、。，．,.\s]+$/u, ""), suffix };
}
export function suggestTarget(doc: string, cursor: number): SuggestTarget | null {
  return suggestTargets(doc, cursor)[0] ?? null;
}

/** Reuse a short continuation from the most recent matching sentence in this document. */
export function suggestDocumentContinuation(doc: string, cursor: number): string | null {
  if (cursor === 0 || (cursor !== doc.length && doc[cursor] !== "\n")) return null;
  const lineStart = doc.lastIndexOf("\n", cursor - 1) + 1;
  const line = doc.slice(lineStart, cursor);
  const prefix = sentenceSegmenter.segment(line).containing(line.length - 1)?.segment.trimStart();
  if (!prefix || prefix.length < 2 || !JAPANESE_PROSE.test(prefix) || /[。！？]$/u.test(prefix)) return null;

  const prefixFrom = cursor - prefix.length;
  const spans = analyzeInput(doc);
  const isProse = (from: number, to: number) => spans.some(span => span.kind === "text" && span.from <= from && span.to >= to);
  if (!isProse(prefixFrom, cursor)) return null;

  const start = Math.max(0, prefixFrom - MAX_CONTINUATION_CONTEXT);
  const history = doc.slice(start, prefixFrom);
  let continuation: string | null = null;
  for (const { segment, index } of sentenceSegmenter.segment(history)) {
    if (start > 0 && index === 0 && doc[start - 1] !== "\n") continue;
    const sentence = segment.trim();
    if (!sentence.startsWith(prefix)) continue;
    const tail = sentence.slice(prefix.length);
    if (tail.length > MAX_CONTINUATION_LENGTH || !JAPANESE_PROSE.test(tail) || !hasEnoughContinuation(tail)) continue;
    const from = start + index + segment.length - segment.trimStart().length;
    if (isProse(from, from + sentence.length)) continuation = tail;
  }
  return continuation;
}

export function suggestTargets(doc: string, cursor: number, { liveInput, retainedFrom }: {
  liveInput?: LiveReading; retainedFrom?: number;
} = {}): SuggestTarget[] {
  if (isInsideExcludedMarkdown(doc, cursor) || /[\wぁ-ゖァ-ヶー]/u.test(doc[cursor] ?? "")) return [];
  // Kana already committed before romaji belongs to the document, not this token.
  const span = analyzeInput(doc).find(part => part.kind === "text" && part.from < cursor && part.to >= cursor);
  if (!span) return [];
  const liveKana = liveInput?.to === cursor;
  const original = trailingReadingToken(doc.slice(Math.max(span.from, liveInput?.from ?? span.from), cursor), liveKana);
  if (!original) return [];
  const from = cursor - original.length;
  if (from > span.from && /[\w]/u.test(doc[from - 1] ?? "")) return [];
  const converted = romajiToKana(normalizeKanaWidth(original));
  const trailingUnknown = converted.lowConfidenceSpans.find(part => part.inputTo === original.length);
  if (trailingUnknown && retainedFrom === undefined) return [];
  const readingEnd = trailingUnknown?.kanaFrom ?? converted.kana.length;
  // A lone n is rendered as ん, but the next key may complete it as な, にゃ, etc.
  const sourceTokens = retainedFrom !== undefined && liveKana && /ん$/u.test(converted.kana) && /n$/iu.test(liveInput.source)
    ? romajiToKana(liveInput.source).tokens : converted.tokens;
  const last = sourceTokens[sourceTokens.length - 1];
  const ambiguousN = last?.kind === "n" && last.romaji.toLowerCase() === "n";
  const finalWord = retainedFrom === undefined
    ? wordSegmenter.segment(converted.kana).containing(readingEnd - 1)
    : undefined;
  const targets: SuggestTarget[] = [];
  const append = (token: (typeof converted.tokens)[number], end: number, pendingRomaji?: string) => {
    if (retainedFrom === undefined && end - token.kanaFrom > (token.kanaFrom === 0 ? 80 : 12)) return;
    const reading = converted.kana.slice(token.kanaFrom, end);
    if (!/^[ぁ-ゖー]{2,}$/u.test(reading) || /^[ゃゅょぁぃぅぇぉっー]/u.test(reading)) return;
    targets.push({ from: from + token.inputFrom, to: cursor, original: original.slice(token.inputFrom), reading,
      ...(pendingRomaji ? { pendingRomaji } : {}) });
  };
  // Look up the whole reading and the final word. A suffix must also start
  // at a transliteration boundary so accepting it can replace whole key sequences.
  for (const token of converted.tokens) {
    if (token.kanaFrom >= readingEnd) break;
    if (retainedFrom !== undefined) {
      if (from + token.inputFrom !== retainedFrom) continue;
    } else if (token.kanaFrom !== 0 && !(finalWord?.isWordLike && token.kanaFrom === finalWord.index)) continue;
    append(token, readingEnd, trailingUnknown?.romaji);
    if (retainedFrom !== undefined) {
      if (ambiguousN) append(token, readingEnd - 1, "n");
      break;
    }
  }
  return targets;
}

export function matchesSuggestionReading(reading: string, candidateReading: string, pendingRomaji?: string): boolean {
  return candidateReading.length > reading.length && candidateReading.startsWith(reading) &&
    (!pendingRomaji || romajiPrefixMatchesReading(pendingRomaji, candidateReading.slice(reading.length)));
}

/** Display the added text for an extension and the full word for a replacement. */
export function wordSuggestionLabel(target: SuggestTarget, text: string): string | null {
  if (text + (target.suffix ?? "") === target.original) return null;
  if (target.suffix || !text.startsWith(target.original)) return ` → ${text}`;
  const continuation = text.slice(target.original.length);
  return hasEnoughContinuation(continuation) ? continuation : null;
}

export function rankSuggestions(target: SuggestTarget, candidates: WordSuggestion[], choices: Choice[]): WordSuggestion[] {
  const { reading } = target;
  const counts = new Map(choices.map(c => [JSON.stringify([c.reading, c.text]), c.count]));
  const learned = choices.map(c => ({ reading: c.reading, text: c.text, source: "learning" as const, cost: 0 }));
  const seen = new Set<string>();
  return [...learned, ...candidates].filter(c => matchesSuggestionReading(reading, c.reading) &&
    c.reading.length <= reading.length + 12 && /^[ぁ-ゖー]+$/u.test(c.reading) && c.text.length <= 80 && c.text.length > 0 &&
    !/[\r\n]/u.test(c.text) && wordSuggestionLabel(target, c.text) !== null)
    .sort((a, b) => (counts.get(JSON.stringify([b.reading, b.text])) ?? 0) - (counts.get(JSON.stringify([a.reading, a.text])) ?? 0) ||
      Number(b.source === "user") - Number(a.source === "user") || a.cost - b.cost || a.reading.length - b.reading.length || a.text.localeCompare(b.text, "ja"))
    .filter(c => !seen.has(c.text) && Boolean(seen.add(c.text))).slice(0, 5);
}
