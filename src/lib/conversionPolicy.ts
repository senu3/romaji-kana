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
  | { kind: "faithful" | "alternative" | "typo-repair" | "speculative" };

/** Explicit request purposes override the configured completion level. */
export function selectSegmentRoute(level: InputCompletionLevel, options: JapaneseConversionOptions): SegmentRoute {
  if (options.speculativeMode) return { kind: "speculative" };
  if (options.completionMode) return { kind: "typo-repair" };
  if (options.alternativeMode) return { kind: "alternative" };
  if (level !== "none") return { kind: level };
  return { kind: "faithful" };
}

export function* alternativeConversionAttempts(options: JapaneseConversionOptions) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    yield {
      kind: "alternative" as const,
      options: { ...options, alternativeMode: true, strictAlternative: true, alternativeAttempt: attempt, completionMode: false, speculativeMode: false },
    };
  }
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
