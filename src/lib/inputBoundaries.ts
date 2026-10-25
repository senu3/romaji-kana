/** Existing Japanese before a new romaji run is reference text, not an edit target.
 * Do not split Japanese embedded inside a run that already starts with romaji. */
export function existingJapanesePrefixLength(text: string): number {
  // A numeric label such as 3D/2D may precede committed Japanese. Require
  // Japanese after it so an entirely romaji/numeric input remains convertible.
  const prefix = /^(?:[A-Za-z0-9]*[0-9][A-Za-z0-9]*[\t ]*)?[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆\t ]+(?=[A-Za-z`])/u.exec(text)?.[0];
  return prefix && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(prefix) ? prefix.length : 0;
}

/** Completion is word-based; conversion may keep spaces and inline Japanese.
 * Both must leave the existing Japanese prefix outside the replacement range. */
export function trailingReadingToken(text: string): string | undefined {
  const input = text.slice(existingJapanesePrefixLength(text));
  return /(?:[A-Za-z]+|[ぁ-ゖァ-ヶー]+)$/u.exec(input)?.[0];
}
