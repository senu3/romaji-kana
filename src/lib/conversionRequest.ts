import { normalizeInputForPrompt } from "./conversion";
import { splitInputForConversion } from "./conversionInput";
import type { ConversionProtection } from "./conversionProtection";
import type { JapaneseConversionOptions } from "./japaneseConversionTypes";
import { romajiToKana } from "./romajiKana";
import type { AppSettings } from "./types";

export interface ConversionTarget {
  /** Source fragment after prompt punctuation normalization, before kana conversion. */
  readonly originalRomaji: string;
  readonly mechanicalReading: string;
  /** Reading after preprocessing; correction/completion is validated against it. */
  readonly preparedReading: string;
  readonly completionSeed: string;
}

export interface ConversionReference {
  readonly beforeTarget: string;
  readonly documentVocabulary?: readonly string[];
}

export interface SuggestionRequest {
  readonly target: ConversionTarget;
  readonly reference: ConversionReference;
}

/** Only the original target supplies mandatory protection. Reference data can
 * affect spelling preferences, never the target or its protected content. */
export function prepareConversionRequest(input: string, settings: AppSettings, options: JapaneseConversionOptions) {
  const parts = splitInputForConversion(normalizeInputForPrompt(input, settings), [
    ...(options.protectedDictionaryEntries ?? []), ...settings.userDictionary,
  ]);
  const protection: ConversionProtection = {
    literalTerms: parts.flatMap(part => part.type === "text" ? [] : [part.output]),
    source: parts.map(part => part.type !== "text" ? part.output
      : romajiToKana(part.value).tokens.map(token =>
        token.kind === "unknown" && /^[A-Za-z]$/u.test(token.kana) ? " " : token.kana,
      ).join("")).join(""),
  };
  return { originalInput: input, parts, protection, documentVocabulary: options.documentVocabulary?.slice() };
}

export function suggestionTargetPrompt({ target, reference }: SuggestionRequest): string {
  return [
    "Read-only context before the target:", reference.beforeTarget.trim() || "(none)", "",
    "Original romaji input:", target.originalRomaji, "",
    "Mechanical kana:", target.mechanicalReading, "",
    "Prepared kana (correction/completion target):", target.preparedReading, "",
    "Application completion seed:", target.completionSeed,
  ].join("\n");
}
