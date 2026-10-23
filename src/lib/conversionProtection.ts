import { numericReadingRule } from "./numericReading";

const PROTECTED_SUGGESTION_SYNTAX = ["#", "`", "[", "]", "{", "}", "<", ">"] as const;

/** Describes the invariants enforced by preservesProtectedContent below. */
export const protectedContentPrompt = [
  "Preserve every digit, Latin token and protected literal exactly, in the same order and with the same number of occurrences.",
  numericReadingRule.prompt(),
  `Preserve the order and count of Markdown markers (${PROTECTED_SUGGESTION_SYNTAX.join(" ")}) and the number of line breaks.`,
].join("\n");

export interface ConversionProtection {
  source: string;
  literalTerms: readonly string[];
  /** Capture before whitespace normalization, including CRLF vs LF. */
  lineBreaks?: readonly string[];
}

export function preservesInputLineBreaks(protection: ConversionProtection, candidate: string): boolean {
  const expected = protection.lineBreaks ?? protection.source.match(/\r\n|\r|\n/g) ?? [];
  return JSON.stringify(expected) === JSON.stringify(candidate.match(/\r\n|\r|\n/g) ?? []);
}

export function preservesProtectedAsciiTokens(source: string, candidate: string): boolean {
  const sourceTokens = source.match(/[A-Za-z0-9][A-Za-z0-9._:/-]*/g) ?? [];
  const candidateTokens = candidate.match(/[A-Za-z0-9][A-Za-z0-9._:/-]*/g) ?? [];
  return (
    sourceTokens.length === candidateTokens.length &&
    sourceTokens.every((token, index) => candidateTokens[index] === token)
  );
}

export function preservesProtectedSuggestionSyntax(source: string, candidate: string): boolean {
  return PROTECTED_SUGGESTION_SYNTAX.every(
    (character) => countCharacter(source, character) === countCharacter(candidate, character),
  );
}

export function countCharacter(value: string, target: string): number {
  return Array.from(value).filter((character) => character === target).length;
}

/** Mandatory invariants, shared by every generation route. */
export function preservesProtectedContent(
  source: string,
  candidate: string,
  literalTerms: readonly string[] = [],
): boolean {
  if (!preservesProtectedAsciiTokens(source, candidate) ||
      !preservesProtectedSuggestionSyntax(source, candidate) ||
      countCharacter(source, "\n") !== countCharacter(candidate, "\n")) return false;
  const numbers = /[+\-−－＋]?\d+(?:[.,:/-]\d+)*(?:%|％)?/g;
  const expectedNumbers = source.match(numbers) ?? [];
  const actualNumbers = candidate.match(numbers) ?? [];
  if (expectedNumbers.length !== actualNumbers.length ||
      expectedNumbers.some((number, index) => number !== actualNumbers[index])) return false;
  const syntax = /[#`\[\]{}<>]/g;
  if ((source.match(syntax) ?? []).join("") !== (candidate.match(syntax) ?? []).join("")) return false;
  if (!literalTerms.length) return true;
  const escaped = [...new Set(literalTerms)].filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return true;
  const pattern = new RegExp(escaped.join("|"), "gu");
  const expected = source.match(pattern) ?? [];
  const actual = candidate.match(pattern) ?? [];
  return expected.length === actual.length && expected.every((term, index) => term === actual[index]);
}
