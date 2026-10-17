import { preservesProtectedContent } from "./conversionProtection";
import { MAX_WORD_COMPLETION_KANA } from "./conversionLimits";
export { countCharacter, preservesProtectedAsciiTokens, preservesProtectedSuggestionSyntax } from "./conversionProtection";
import { stripThinkBlock } from "./generationUtils";
import type { JapaneseConversionOptions } from "./japaneseConversionTypes";
import type { InputCompletionLevel } from "./types";
import { isAllowedLocalKanaCorrection } from "./localKanaCorrection";
import { convertedTextLengthRule, declaredSuggestionAdditionRule, finalReadingRule, sentenceCompletionRule, wordCompletionRule } from "./conversionRules";
import type { WordCompletionBoundary } from "./conversionRules";
import { comparableKanaCharacters as comparableReadingCharacters, splitTerminalPunctuation } from "./readingComparison";
import type { ConversionDiagnostic } from "./conversionDiagnostics";

const SAFE_WORD_COMPLETION_SEEDS: ReadonlyArray<readonly [string, string]> = [
  ["ありが", "ありがとう"],
  ["おはよ", "おはよう"],
  ["こんにち", "こんにちは"],
  ["すみませ", "すみません"],
  ["おねが", "おねがい"],
  ["よろし", "よろしく"],
];

export interface StructuredSuggestionConversion {
  reportedKana?: string;
  numericReadingNormalized?: boolean;
  /** Application assessment, never parsed from the model's declaration. */
  boundaryUnverified?: boolean;
  wordCompletion?: WordCompletionBoundary;
  correctedKana?: string;
  completedKana: string;
  convertedText: string;
  additions: string[];
}

export function isAllowedInputCompletion(
  source: string,
  candidate: string,
  level: Exclude<InputCompletionLevel, "none">,
  wordBoundary?: WordCompletionBoundary,
  convertedText?: string,
  allowUnverifiedBoundary = false,
): boolean {
  const normalizedSource = source.trim();
  const normalizedCandidate = candidate.trim();
  if (!normalizedCandidate || (normalizedCandidate === normalizedSource && !wordBoundary)) {
    return normalizedCandidate === normalizedSource;
  }

  if (!preservesProtectedContent(normalizedSource, normalizedCandidate)) return false;

  const sourceParts = splitTerminalPunctuation(normalizedSource);
  const candidateParts = splitTerminalPunctuation(normalizedCandidate);
  if (sourceParts.punctuation && sourceParts.punctuation !== candidateParts.punctuation) {
    return false;
  }

  const sourceCharacters = comparableReadingCharacters(sourceParts.body);
  const candidateCharacters = comparableReadingCharacters(candidateParts.body);
  if (level === "word") {
    // Horizontal spacing cleanup is notation, not a kana correction or a
    // completion. Protection above still forbids joining ASCII tokens.
    if (!wordBoundary && sourceParts.body.replace(/[ \t]/gu, "") === candidateParts.body.replace(/[ \t]/gu, "")) return true;
    const convertedBody = convertedText === undefined ? undefined : splitTerminalPunctuation(convertedText).body;
    const status = wordCompletionRule.boundaryStatus(sourceParts.body, candidateParts.body, convertedBody, wordBoundary);
    return (
      candidateParts.body.startsWith(sourceParts.body) &&
      (status === "confirmed" || allowUnverifiedBoundary && status === "unverified") &&
      candidateCharacters.length >= sourceCharacters.length &&
      candidateCharacters.length <= sourceCharacters.length + MAX_WORD_COMPLETION_KANA
    );
  }

  const minimumLengthRatio = sentenceCompletionRule.minimumLengthRatio;
  const maximumLength = Math.max(sentenceCompletionRule.maximumLengthFloor, sourceCharacters.length * sentenceCompletionRule.maximumLengthRatio);
  if (
    candidateCharacters.length < Math.max(1, Math.ceil(sourceCharacters.length * minimumLengthRatio)) ||
    candidateCharacters.length > maximumLength
  ) {
    return false;
  }

  const minimumSharedCharacters = sentenceCompletionRule.minimumSharedCharacters(sourceCharacters.length);
  return countSharedCharacters(sourceCharacters, candidateCharacters) >= minimumSharedCharacters;
}

export function comparableCharacters(value: string): string[] {
  return Array.from(value).filter((character) => !/\s/u.test(character));
}

function countSharedCharacters(source: string[], candidate: string[]): number {
  const available = new Map<string, number>();
  source.forEach((character) => {
    available.set(character, (available.get(character) ?? 0) + 1);
  });

  let shared = 0;
  candidate.forEach((character) => {
    const count = available.get(character) ?? 0;
    if (count > 0) {
      shared += 1;
      available.set(character, count - 1);
    }
  });
  return shared;
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

export function collectInputCompletionAdditions(
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

export function parseStructuredSuggestion(text: string): StructuredSuggestionConversion | null {
  const cleaned = stripThinkBlock(text).trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");
  if (objectStart === -1 || objectEnd < objectStart) {
    return null;
  }

  try {
    const value = JSON.parse(cleaned.slice(objectStart, objectEnd + 1)) as Record<string, unknown>;
    const word = value.wordCompletion as Record<string, unknown> | undefined;
    if (
      typeof value.completedKana !== "string" ||
      typeof value.convertedText !== "string" ||
      (value.correctedKana !== undefined && typeof value.correctedKana !== "string") ||
      (word !== undefined && (!word || typeof word !== "object" ||
        typeof word.sourceKana !== "string" || typeof word.completedKana !== "string" || typeof word.convertedText !== "string")) ||
      (value.additions !== undefined &&
        (!Array.isArray(value.additions) ||
          !value.additions.every((addition) => typeof addition === "string")))
    ) {
      return null;
    }
    return {
      ...(word ? { wordCompletion: { sourceKana: String(word.sourceKana).trim(), completedKana: String(word.completedKana).trim(), convertedText: String(word.convertedText).trim() } } : {}),
      ...(typeof value.correctedKana === "string" ? { correctedKana: value.correctedKana.trim() } : {}),
      completedKana: value.completedKana.trim(),
      convertedText: value.convertedText.trim(),
      additions: (value.additions ?? [])
        .map((addition) => String(addition).trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

export function isAllowedStructuredSuggestion(
  mechanicalKana: string,
  candidate: StructuredSuggestionConversion,
  level: Exclude<InputCompletionLevel, "none">,
  options: JapaneseConversionOptions,
  allowUnverifiedBoundary = false,
): boolean {
  return structuredSuggestionRejection(mechanicalKana, candidate, level, options, allowUnverifiedBoundary) === undefined;
}

export function structuredSuggestionRejection(
  mechanicalKana: string,
  candidate: StructuredSuggestionConversion,
  level: Exclude<InputCompletionLevel, "none">,
  options: JapaneseConversionOptions,
  allowUnverifiedBoundary = false,
): ConversionDiagnostic | undefined {
  if (!preservesProtectedContent(mechanicalKana, candidate.convertedText) ||
      !preservesProtectedContent(candidate.completedKana, candidate.convertedText)) return "protected-content";
  if (!finalReadingRule.accepts(candidate, "suggestion")) {
    return "reading-format";
  }
  const correctedKana = candidate.correctedKana ?? mechanicalKana;
  if (!isAllowedLocalKanaCorrection(mechanicalKana, correctedKana)) return "local-correction";
  if (!isAllowedInputCompletion(correctedKana, candidate.completedKana, level, candidate.wordCompletion, candidate.convertedText, allowUnverifiedBoundary)) return "completion-shape";

  const kanaLength = comparableCharacters(candidate.completedKana).length;
  const convertedLength = comparableCharacters(candidate.convertedText).length;
  if (!convertedTextLengthRule.accepts(kanaLength, convertedLength)) {
    return "text-length";
  }
  return isAvoidedConversionOutput(candidate.convertedText, options.avoidOutputs) ? "avoided-output" : undefined;
}

export function reportedSuggestionAdditions(
  mechanicalKana: string,
  completionSeed: string,
  candidate: StructuredSuggestionConversion,
  level: Exclude<InputCompletionLevel, "none">,
): string[] {
  const computed = collectInputCompletionAdditions(mechanicalKana, candidate.completedKana);
  if (computed.length > 0) {
    return computed;
  }

  if (level === "word" && completionSeed !== mechanicalKana) {
    const seeded = collectInputCompletionAdditions(mechanicalKana, completionSeed);
    if (additionsAppearInOrder(candidate.convertedText, seeded)) {
      return seeded;
    }
  }

  const declared = candidate.additions.filter(
    (addition) => addition && declaredSuggestionAdditionRule.allowedSpan.test(addition),
  );
  if (declared.length !== candidate.additions.length) {
    return [];
  }
  // A model declaration is only a fallback. Existing source text cannot prove an insertion.
  const sourceText = comparableCharacters(mechanicalKana).join("");
  if (declared.some((addition) => sourceText.includes(addition))) {
    return [];
  }
  const totalLength = declared.reduce((sum, addition) => sum + Array.from(addition).length, 0);
  const sourceLength = comparableCharacters(mechanicalKana).length;
  const maximumLength = level === "word" ? MAX_WORD_COMPLETION_KANA : Math.max(sentenceCompletionRule.declaredAdditionFloor, Math.ceil(sourceLength * sentenceCompletionRule.declaredAdditionRatio));
  if (totalLength === 0 || totalLength > maximumLength) {
    return [];
  }

  return additionsAppearInOrder(candidate.convertedText, declared) ? declared : [];
}

function additionsAppearInOrder(convertedText: string, additions: string[]): boolean {
  let searchFrom = 0;
  for (const addition of additions) {
    const index = convertedText.indexOf(addition, searchFrom);
    if (index === -1) {
      return false;
    }
    searchFrom = index + addition.length;
  }
  return true;
}

export function knownWordCompletionSeed(source: string): string {
  const parts = splitTerminalPunctuation(source);
  for (const [partial, completed] of SAFE_WORD_COMPLETION_SEEDS) {
    if (parts.body.endsWith(partial)) {
      return `${parts.body.slice(0, -partial.length)}${completed}${parts.punctuation}`;
    }
  }
  return source;
}

export function isAvoidedConversionOutput(output: string, avoidOutputs: string[] | undefined): boolean {
  const normalizedOutput = output.trim();
  return Boolean(
    normalizedOutput &&
    avoidOutputs?.some((avoidOutput) => avoidOutput.trim() === normalizedOutput),
  );
}
