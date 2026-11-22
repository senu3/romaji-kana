import { rankSuggestions, suggestDocumentContinuation, type SuggestTarget } from "./autoSuggest";
import type { Choice } from "./conversionLearning";
import { buildDocumentVocabularyProfile } from "./documentVocabulary";
import { analyzeInput } from "./inputAnalysis";
import { romajiToKana } from "./romajiKana";
import { kanaWordCosts } from "./kanaEngine";
import type { PersonalWord, WordSuggestion } from "./kanaEngine";

export type Completion =
  | { kind: "correction"; target: Pick<SuggestTarget, "from" | "to" | "original">; text: string }
  | { kind: "word"; target: SuggestTarget; candidates: WordSuggestion[] }
  | { kind: "continuation"; target: Pick<SuggestTarget, "from" | "to" | "original">; text: string };

interface CompletionRequest {
  doc: string;
  cursor: number;
  targets: SuggestTarget[];
  committed: boolean;
  ime: boolean;
  personal: readonly PersonalWord[];
  choices: Choice[];
  lookup: (reading: string) => Promise<WordSuggestion[]>;
  lookupSurface: (prefix: string, signal: AbortSignal) => Promise<string | null>;
  signal: AbortSignal;
}

/** A lone consonant between kana may be missing its vowel. Require an exact dictionary word. */
async function mixedKanaCorrection(before: string, cursor: number, signal: AbortSignal): Promise<Completion | null> {
  const match = /([ぁ-ゖ]{1,12})([bcdfghjklmpqrstvwxyz])([ぁ-ゖ]{1,12})$/u.exec(before.normalize("NFC"));
  if (!match || !before.endsWith(match[0])) return null;
  const [, left, consonant, right] = match;
  const syllables = [...new Set(Array.from("aiueo", vowel => romajiToKana(consonant + vowel).kana))]
    .filter(kana => /^[ぁ-ゖ]$/u.test(kana));
  const plans = [];
  for (let start = 0; start < left.length; start++) {
    const original = left.slice(start) + consonant + right;
    for (const kana of syllables) plans.push({ original, text: left.slice(start) + kana + right });
  }
  if (!plans.length) return null;
  const costs = await kanaWordCosts(plans.map(plan => plan.text), signal);
  const matches = plans.flatMap((plan, i) => costs[i] == null ? [] : [{ ...plan, cost: costs[i] }])
    .sort((a, b) => b.original.length - a.original.length || a.cost - b.cost);
  const best = matches[0];
  if (!best) return null;
  return { kind: "correction", target: { from: cursor - best.original.length, to: cursor, original: best.original }, text: best.text };
}

async function committedCompletion(request: CompletionRequest): Promise<Completion | null> {
  const { doc, cursor, personal, choices } = request;
  const span = analyzeInput(doc).find(s => s.kind === "text" && s.from < cursor && cursor <= s.to);
  if (!span || /[\p{L}\p{N}]/u.test(doc[cursor] ?? "")) return null;
  const before = doc.slice(span.from, cursor);
  const correction = await mixedKanaCorrection(before, cursor, request.signal);
  if (correction) return correction;
  const prefix = /[\p{Script=Han}々\p{Script=Katakana}ー]{2,24}$/u.exec(before)?.[0];
  const append = (original: string, text: string): Completion => ({
    kind: "continuation", target: { from: cursor - original.length, to: cursor, original }, text,
  });
  if (prefix) {
    const terms = [
      ...personal.filter(word => word.enabled).map(word => word.text),
      ...[...choices].sort((a, b) => b.count - a.count).map(word => word.text),
      ...buildDocumentVocabularyProfile(doc).terms,
    ];
    const term = terms.find(word => word.startsWith(prefix) && word.length > prefix.length && !/[\r\n]/u.test(word));
    if (term) return append(prefix, term.slice(prefix.length));
  }
  const tail = suggestDocumentContinuation(doc, cursor);
  if (tail) return append("", tail);
  if (request.ime && prefix) {
    const term = await request.lookupSurface(prefix, request.signal);
    if (term?.startsWith(prefix) && term.length > prefix.length) return append(prefix, term.slice(prefix.length));
  }
  return null;
}

/** An IME commit already supplies the desired surface. Prefer appending to it. */
export async function resolveCompletion(request: CompletionRequest): Promise<Completion | null> {
  if (request.ime) {
    const surface = await committedCompletion(request);
    if (surface) return surface;
  }
  for (const target of request.targets) {
    if (request.signal.aborted) return null;
    const words = await request.lookup(target.reading);
    const candidates = rankSuggestions(target, words, request.choices);
    if (candidates.length) return { kind: "word", target, candidates };
  }
  return request.committed && !request.ime ? committedCompletion(request) : null;
}
