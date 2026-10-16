import { preservesProtectedContent } from "./conversionProtection";
import { MAX_WORD_COMPLETION_KANA } from "./conversionLimits";
export { countCharacter, preservesProtectedAsciiTokens, preservesProtectedSuggestionSyntax } from "./conversionProtection";
import { stripThinkBlock } from "./generationUtils";
import type { JapaneseConversionOptions } from "./japaneseConversionTypes";
import type { InputCompletionLevel } from "./types";
import { isAllowedLocalKanaCorrection } from "./localKanaCorrection";
import { convertedTextLengthRule, declaredSuggestionAdditionRule, finalReadingRule, sentenceCompletionRule } from "./conversionRules";

const SAFE_WORD_COMPLETION_SEEDS: ReadonlyArray<readonly [string, string]> = [
  ["ありが", "ありがとう"],
  ["おはよ", "おはよう"],
  ["こんにち", "こんにちは"],
  ["すみませ", "すみません"],
  ["おねが", "おねがい"],
  ["よろし", "よろしく"],
];

export interface StructuredSuggestionConversion {
  correctedKana?: string;
  completedKana: string;
  convertedText: string;
  additions: string[];
}

export function isAllowedInputCompletion(
  source: string,
  candidate: string,
  level: Exclude<InputCompletionLevel, "none">,
): boolean {
  const normalizedSource = source.trim();
  const normalizedCandidate = candidate.trim();
  if (!normalizedCandidate || normalizedCandidate === normalizedSource) {
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
    return (
      candidateParts.body.startsWith(sourceParts.body) &&
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

function splitTerminalPunctuation(value: string): { body: string; punctuation: string } {
  const match = value.match(/^(.*?)([。、.!?！？]*)$/u);
  return {
    body: match?.[1] ?? value,
    punctuation: match?.[2] ?? "",
  };
}

export function comparableCharacters(value: string): string[] {
  return Array.from(value).filter((character) => !/\s/u.test(character));
}

function comparableReadingCharacters(value: string): string[] {
  return Array.from(value.normalize("NFKC"))
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x30a1 && codePoint <= 0x30f6
        ? String.fromCodePoint(codePoint - 0x60)
        : character;
    })
    .filter((character) => /[\p{Script=Hiragana}ー]/u.test(character));
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
    if (
      typeof value.completedKana !== "string" ||
      typeof value.convertedText !== "string" ||
      (value.correctedKana !== undefined && typeof value.correctedKana !== "string") ||
      (value.additions !== undefined &&
        (!Array.isArray(value.additions) ||
          !value.additions.every((addition) => typeof addition === "string")))
    ) {
      return null;
    }
    return {
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
): boolean {
  if (!finalReadingRule.accepts(candidate, "suggestion")) {
    return false;
  }
  const correctedKana = candidate.correctedKana ?? mechanicalKana;
  if (!isAllowedLocalKanaCorrection(mechanicalKana, correctedKana) ||
      !isAllowedInputCompletion(correctedKana, candidate.completedKana, level)) {
    return false;
  }

  if (!preservesProtectedContent(mechanicalKana, candidate.convertedText)) return false;

  const kanaLength = comparableCharacters(candidate.completedKana).length;
  const convertedLength = comparableCharacters(candidate.convertedText).length;
  if (!convertedTextLengthRule.accepts(kanaLength, convertedLength)) {
    return false;
  }
  return !isAvoidedConversionOutput(candidate.convertedText, options.avoidOutputs);
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
