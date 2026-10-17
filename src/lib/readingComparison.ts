/** Comparison only. Never apply these transformations to protected body text. */
export function normalizeKanaWidth(value: string): string {
  return value.normalize("NFKC").replace(/[ァ-ヶ]/gu,
    char => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

/** Phonetic comparison ignores spacing but retains punctuation. */
export function normalizeReading(value: string): string {
  return normalizeKanaWidth(value).replace(/\s/gu, "");
}

/** Change classification additionally ignores terminal punctuation. */
export function normalizeComparableReading(value: string): string {
  return normalizeReading(value).replace(/[。、,.!?！？]+$/u, "");
}

/** Numeric alignment must retain line breaks for the protection check. */
export function normalizeNumericAlignment(value: string): string {
  return normalizeKanaWidth(value).replace(/[ \t]/gu, "");
}

export function comparableKanaCharacters(value: string): string[] {
  return Array.from(normalizeKanaWidth(value)).filter(char => /[\p{Script=Hiragana}ー]/u.test(char));
}

export function splitTerminalPunctuation(value: string): { body: string; punctuation: string } {
  const match = value.match(/([。、.!?！？]*)$/u)!;
  return { body: value.slice(0, value.length - match[0].length), punctuation: match[0] };
}
