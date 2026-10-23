export interface DocumentVocabularyProfile {
  terms: string[];
  revision: string;
}

export const MAX_DOCUMENT_VOCABULARY_TERMS = 30;

interface VocabularyCandidate {
  term: string;
  count: number;
  firstIndex: number;
  kind: "japanese" | "latin";
}

const wordSegmenter = new Intl.Segmenter("ja", { granularity: "word" });
const JAPANESE_ONLY = /^[一-龯々〆ヵヶァ-ヴー]+$/u;
const LATIN_PHRASE_PATTERN =
  /\b[A-Z][A-Za-z0-9+.#_-]{1,31}(?:[ \t]+[A-Z][A-Za-z0-9+.#_-]{1,31}){1,2}\b/g;
const LATIN_TERM_PATTERN = /\b[A-Za-z][A-Za-z0-9+.#_-]{1,31}\b/g;

export function buildDocumentVocabularyProfile(
  documentText: string,
  maxTerms = MAX_DOCUMENT_VOCABULARY_TERMS,
): DocumentVocabularyProfile {
  const source = stripNonProseContent(documentText);
  const candidates = new Map<string, VocabularyCandidate>();

  collectJapanese(source, candidates);
  collectMatches(source, LATIN_PHRASE_PATTERN, "latin", candidates);
  collectMatches(source, LATIN_TERM_PATTERN, "latin", candidates);

  const ranked = [...candidates.values()]
    .filter((candidate) => candidate.kind === "japanese" || isLikelyNamedLatinTerm(candidate))
    .sort(compareCandidates)
    .slice(0, Math.max(0, maxTerms));
  const terms = ranked.map((candidate) => candidate.term);
  const revisionSource = ranked
    .map((candidate) => `${candidate.term}\u0000${candidate.count}`)
    .join("\u0001");

  return {
    terms,
    revision: fnv1a(revisionSource),
  };
}

function stripNonProseContent(text: string): string {
  let fence: { marker: string; length: number } | undefined;
  return text.split(/\r?\n/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return "";
    }
    if (marker) { fence = { marker: marker[1][0], length: marker[1].length }; return ""; }
    return line;
  }).join("\n")
    .replace(/`[^`\r\n]*`/g, " ")
    .replace(/https?:\/\/[^\s)>]+/gi, " ");
}

function collectJapanese(source: string, candidates: Map<string, VocabularyCandidate>): void {
  let pending = "", start = 0;
  const flush = () => {
    if (pending.length >= 2 && pending.length <= 24) addCandidate(pending, "japanese", start, candidates);
    pending = "";
  };
  for (const part of wordSegmenter.segment(source)) {
    if (part.isWordLike && JAPANESE_ONLY.test(part.segment)) {
      if (!pending) start = part.index;
      pending += part.segment;
    } else {
      flush();
      // Keep whole mixed-script words, rather than clipping their kanji stems.
      if (part.isWordLike && /[一-龯]/u.test(part.segment) && /^[一-龯々ぁ-ゖー]{2,24}$/u.test(part.segment)) {
        addCandidate(part.segment, "japanese", part.index, candidates);
      }
    }
  }
  flush();
}

function addCandidate(term: string, kind: VocabularyCandidate["kind"], firstIndex: number,
  candidates: Map<string, VocabularyCandidate>): void {
  const key = kind === "latin" ? term.toLocaleLowerCase("en-US") : term;
  const current = candidates.get(key);
  if (current) current.count += 1;
  else candidates.set(key, { term, kind, firstIndex, count: 1 });
}

function collectMatches(
  source: string,
  pattern: RegExp,
  kind: VocabularyCandidate["kind"],
  candidates: Map<string, VocabularyCandidate>,
): void {
  pattern.lastIndex = 0;

  for (const match of source.matchAll(pattern)) {
    const term = match[0].trim().replace(/\s+/g, " ");
    if (!term) {
      continue;
    }

    addCandidate(term, kind, match.index ?? 0, candidates);
  }
}

function isLikelyNamedLatinTerm(candidate: VocabularyCandidate): boolean {
  const term = candidate.term;
  return (
    /\s/.test(term) ||
    /^[A-Z0-9._+#-]+$/.test(term) ||
    /^[A-Z][a-z]{2,}$/.test(term) ||
    /[A-Z].*[A-Z]/.test(term) ||
    /[0-9._+#-]/.test(term)
  );
}

function compareCandidates(left: VocabularyCandidate, right: VocabularyCandidate): number {
  return (
    right.count - left.count ||
    Number(right.kind === "japanese") - Number(left.kind === "japanese") ||
    left.firstIndex - right.firstIndex ||
    right.term.length - left.term.length ||
    left.term.localeCompare(right.term, "ja")
  );
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
