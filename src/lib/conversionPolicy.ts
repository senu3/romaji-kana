import { comparableCharacters, isAvoidedConversionOutput } from "./conversionOutput";
import { preservesProtectedContent } from "./conversionProtection";
import { convertedTextLengthRule, finalReadingRule } from "./conversionRules";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
export function isUsableConversionResult(result: JapaneseConversionResult, options: JapaneseConversionOptions): boolean {
  return !result.suggestionRejected && Boolean(result.text.trim()) && !isAvoidedConversionOutput(result.text, options.avoidOutputs);
}
export function isAllowedSpeculativeConversion(source: string, candidate: string): boolean {
  return Boolean(source.trim() && candidate.trim()) && !finalReadingRule.forbiddenControls.test(candidate) &&
    preservesProtectedContent(source.trim(), candidate.trim()) && convertedTextLengthRule.accepts(comparableCharacters(source.trim()).length, comparableCharacters(candidate.trim()).length);
}
