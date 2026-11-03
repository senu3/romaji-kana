export function comparableCharacters(value: string): string[] {
  return Array.from(value).filter((character) => !/\s/u.test(character));
}

/** Punctuation, spaces and decorative symbols do not make a kana-only spelling useful. */
export function isAllHiraganaOutput(value: string): boolean {
  const text = value.normalize("NFC");
  return /\p{Script=Hiragana}/u.test(text) && /^[\p{Script=Hiragana}\p{M}ー\s\p{P}\p{S}]+$/u.test(text);
}

/** Keep one kana-only fallback only when no other spelling is available. */
export function filterHiraganaCandidates<T>(candidates: T[], output: (candidate: T) => string): T[] {
  const alternatives = candidates.filter(candidate => !isAllHiraganaOutput(output(candidate)));
  return alternatives.length ? alternatives : candidates.slice(0, 1);
}

function isSubsequence(source: string[], candidate: string[]): boolean {
  let sourceIndex = 0;
  for (const character of candidate) {
    if (character === source[sourceIndex]) {
      sourceIndex += 1;
    }
  }
  return sourceIndex === source.length;
}

function collectInsertedSpans(source: string[], candidate: string[]): string[] {
  const insertions: string[] = [];
  let sourceIndex = 0;
  let pendingInsertion = "";

  for (const character of candidate) {
    if (character === source[sourceIndex]) {
      if (pendingInsertion) {
        insertions.push(pendingInsertion);
        pendingInsertion = "";
      }
      sourceIndex += 1;
      continue;
    }
    pendingInsertion += character;
  }

  if (pendingInsertion) {
    insertions.push(pendingInsertion);
  }
  return insertions;
}

export function collectReadingAdditions(
  source: string,
  candidate: string,
): string[] {
  const sourceCharacters = comparableCharacters(source);
  const candidateCharacters = comparableCharacters(candidate);
  if (!isSubsequence(sourceCharacters, candidateCharacters)) {
    return [];
  }
  return collectInsertedSpans(sourceCharacters, candidateCharacters);
}

export interface ConversionOutput { convertedText: string; completedKana: string }
export function parseConversionOutput(text: string): ConversionOutput | null {
  try {
    const value = JSON.parse(text);
    if (!value || Object.keys(value).length !== 2 || typeof value.convertedText !== "string" || typeof value.completedKana !== "string") return null;
    return { convertedText: value.convertedText.trim(), completedKana: value.completedKana.trim() };
  } catch { return null; }
}
export function isAvoidedConversionOutput(output: string, avoided: string[] | undefined): boolean {
  return Boolean(output.trim() && avoided?.some(value => value.trim() === output.trim()));
}

/** A deliberately narrow surface comparison, not a semantic/synonym detector.
 * Keep polarity, tense, question endings and content words distinct. */
export function isRejectedSurfaceVariant(output: string, avoided: readonly string[] | undefined): boolean {
  const comparable = (text: string) => text.normalize("NFC").trim().replace(/[。．.]$/u, "")
    .replace(/なかったです$/u, "なかった")
    .replace(/ないです$/u, "ない")
    .replace(/いませんでした$/u, "いなかった")
    .replace(/いません$/u, "いない")
    .replace(/ありませんでした$/u, "なかった")
    .replace(/ありません$/u, "ない");
  const value = comparable(output);
  return Boolean(value && avoided?.some(text => comparable(text) === value));
}
