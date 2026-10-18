export function comparableCharacters(value: string): string[] {
  return Array.from(value).filter((character) => !/\s/u.test(character));
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
