import {
  comparableCharacters,
  countCharacter,
  isAvoidedConversionOutput,
  preservesProtectedAsciiTokens,
  preservesProtectedSuggestionSyntax,
} from "./completionValidation";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import type { InputCompletionLevel } from "./types";

export type SegmentRoute =
  | { kind: "word" | "sentence" }
  | { kind: "faithful" | "typo-completion" | "speculative" };

/** Current precedence, including suggestion modes overriding retry flags.
 * This makes the existing behavior explicit; it does not expand permissions. */
export function selectSegmentRoute(level: InputCompletionLevel, options: JapaneseConversionOptions): SegmentRoute {
  if (level !== "none") return { kind: level };
  if (options.speculativeMode) return { kind: "speculative" };
  if (options.completionMode) return { kind: "typo-completion" };
  return { kind: "faithful" };
}

export function* alternativeConversionAttempts(options: JapaneseConversionOptions) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    yield {
      kind: "alternative" as const,
      options: { ...options, strictAlternative: true, alternativeAttempt: attempt, completionMode: false },
    };
  }
  yield {
    kind: "typo-completion" as const,
    options: { ...options, strictAlternative: true, alternativeAttempt: 0, completionMode: true },
  };
}

export function hasAvoidOutputs(avoidOutputs: string[] | undefined): boolean {
  return Boolean(avoidOutputs?.some((output) => output.trim()));
}

export function isUsableConversionResult(
  result: JapaneseConversionResult,
  options: JapaneseConversionOptions,
): boolean {
  if (result.suggestionRejected || !result.text.trim() || isHiraganaOnlyConversion(result.text)) {
    return false;
  }

  if (isAvoidedConversionOutput(result.text, options.avoidOutputs)) {
    return false;
  }

  if (
    hasAvoidOutputs(options.avoidOutputs) &&
    result.text.trim() &&
    result.text.trim() === result.reviewKana.trim()
  ) {
    return false;
  }

  return true;
}

export function isHiraganaOnlyConversion(value: string): boolean {
  const hasHiragana = /[\u3041-\u3096]/u.test(value);
  const hasNonHiraganaWriting = /[\u30a1-\u30ff\u3400-\u9fff々〆ヵヶA-Za-z]/u.test(value);
  return hasHiragana && !hasNonHiraganaWriting;
}

export function isAllowedSpeculativeConversion(source: string, candidate: string): boolean {
  const normalizedSource = source.trim();
  const normalizedCandidate = candidate.trim();
  if (!normalizedSource || !normalizedCandidate || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(candidate)) {
    return false;
  }
  if (
    !preservesProtectedAsciiTokens(normalizedSource, normalizedCandidate) ||
    !preservesProtectedSuggestionSyntax(normalizedSource, normalizedCandidate) ||
    countCharacter(normalizedSource, "\n") !== countCharacter(normalizedCandidate, "\n")
  ) {
    return false;
  }

  const sourceLength = comparableCharacters(normalizedSource).length;
  const candidateLength = comparableCharacters(normalizedCandidate).length;
  return (
    candidateLength >= Math.max(1, Math.ceil(sourceLength * 0.2)) &&
    candidateLength <= Math.max(24, sourceLength * 2)
  );
}
