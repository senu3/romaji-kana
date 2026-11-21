import { rankSuggestions, suggestDocumentContinuation, type SuggestTarget } from "./autoSuggest";
import type { Choice } from "./conversionLearning";
import { buildDocumentVocabularyProfile } from "./documentVocabulary";
import { analyzeInput } from "./inputAnalysis";
import type { PersonalWord, WordSuggestion } from "./kanaEngine";

export type Completion =
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
  signal: AbortSignal;
}

function committedCompletion(request: CompletionRequest): Completion | null {
  const { doc, cursor, personal, choices } = request;
  const span = analyzeInput(doc).find(s => s.kind === "text" && s.from < cursor && cursor <= s.to);
  if (!span || /[\p{L}\p{N}]/u.test(doc[cursor] ?? "")) return null;
  const before = doc.slice(span.from, cursor);
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
  return tail ? append("", tail) : null;
}

/** An IME commit already supplies the desired surface. Prefer appending to it. */
export async function resolveCompletion(request: CompletionRequest): Promise<Completion | null> {
  if (request.ime) {
    const surface = committedCompletion(request);
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
