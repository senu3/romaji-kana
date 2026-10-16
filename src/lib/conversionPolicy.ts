import {
  comparableCharacters,
  isAvoidedConversionOutput,
} from "./completionValidation";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import type { InputCompletionLevel } from "./types";
import { preservesProtectedContent } from "./conversionProtection";
import { convertedTextLengthRule, finalReadingRule, speculativeRule } from "./conversionRules";

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
  if (result.suggestionRejected || !result.text.trim()) {
    return false;
  }

  if (isAvoidedConversionOutput(result.text, options.avoidOutputs)) {
    return false;
  }

  return true;
}

export function isHiraganaOnlyConversion(value: string): boolean {
  return speculativeRule.isHiraganaOnlyCandidate(value);
}

export function isAllowedSpeculativeConversion(source: string, candidate: string): boolean {
  const normalizedSource = source.trim();
  const normalizedCandidate = candidate.trim();
  if (!normalizedSource || !normalizedCandidate || finalReadingRule.forbiddenControls.test(candidate)) {
    return false;
  }
  if (
    !preservesProtectedContent(normalizedSource, normalizedCandidate)
  ) {
    return false;
  }

  const sourceLength = comparableCharacters(normalizedSource).length;
  const candidateLength = comparableCharacters(normalizedCandidate).length;
  return convertedTextLengthRule.accepts(sourceLength, candidateLength);
}
