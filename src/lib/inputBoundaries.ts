/** Existing Japanese before a new romaji run is reference text, not an edit target.
 * Do not split Japanese embedded inside a run that already starts with romaji. */
export function existingJapanesePrefixLength(text: string): number {
  const prefix = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆\t ]+(?=[A-Za-z`])/u.exec(text)?.[0];
  return prefix && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(prefix) ? prefix.length : 0;
}

/** Completion is word-based; conversion may keep spaces and inline Japanese.
 * Both must leave the existing Japanese prefix outside the replacement range. */
export function trailingReadingToken(text: string): string | undefined {
  const input = text.slice(existingJapanesePrefixLength(text));
  return /(?:[A-Za-z]+|[ぁ-ゖァ-ヶー]+)$/u.exec(input)?.[0];
}
