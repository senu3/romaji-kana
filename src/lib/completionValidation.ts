import { stripThinkBlock } from "./generationUtils";
import type { JapaneseConversionOptions } from "./japaneseConversionTypes";
import type { InputCompletionLevel } from "./types";

const PROTECTED_SUGGESTION_SYNTAX = ["#", "`", "[", "]", "{", "}", "<", ">"] as const;

const SAFE_WORD_COMPLETION_SEEDS: ReadonlyArray<readonly [string, string]> = [
  ["ありが", "ありがとう"],
  ["おはよ", "おはよう"],
  ["こんにち", "こんにちは"],
  ["すみませ", "すみません"],
  ["おねが", "おねがい"],
  ["よろし", "よろしく"],
];

export interface StructuredSuggestionConversion {
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

  if (!preservesProtectedAsciiTokens(normalizedSource, normalizedCandidate)) {
    return false;
  }

  if (!preservesProtectedSuggestionSyntax(normalizedSource, normalizedCandidate)) {
    return false;
  }

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
      candidateCharacters.length <= sourceCharacters.length + 12
    );
  }

  const minimumLengthRatio = 0.25;
  const maximumLength = Math.max(32, sourceCharacters.length * 3);
  if (
    candidateCharacters.length < Math.max(1, Math.ceil(sourceCharacters.length * minimumLengthRatio)) ||
    candidateCharacters.length > maximumLength
  ) {
    return false;
  }

  const minimumSharedCharacters = sourceCharacters.length <= 2
    ? 0
    : sourceCharacters.length <= 4
      ? 1
      : Math.min(3, Math.max(2, Math.ceil(sourceCharacters.length * 0.12)));
  return countSharedCharacters(sourceCharacters, candidateCharacters) >= minimumSharedCharacters;
}

function splitTerminalPunctuation(value: string): { body: string; punctuation: string } {
  const match = value.match(/^(.*?)([。、.!?！？]*)$/u);
  return {
    body: match?.[1] ?? value,
    punctuation: match?.[2] ?? "",
  };
}

export function preservesProtectedAsciiTokens(source: string, candidate: string): boolean {
  const sourceTokens = source.match(/[A-Za-z0-9][A-Za-z0-9._:/-]*/g) ?? [];
  const candidateTokens = candidate.match(/[A-Za-z0-9][A-Za-z0-9._:/-]*/g) ?? [];
  return (
    sourceTokens.length === candidateTokens.length &&
    sourceTokens.every((token, index) => candidateTokens[index] === token)
  );
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
      (value.additions !== undefined &&
        (!Array.isArray(value.additions) ||
          !value.additions.every((addition) => typeof addition === "string")))
    ) {
      return null;
    }
    return {
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
  if (!candidate.completedKana || !candidate.convertedText) {
    return false;
  }
  if (!isAllowedInputCompletion(mechanicalKana, candidate.completedKana, level)) {
    return false;
  }

  if (!preservesProtectedAsciiTokens(candidate.completedKana, candidate.convertedText)) {
    return false;
  }
  if (!preservesProtectedSuggestionSyntax(candidate.completedKana, candidate.convertedText)) {
    return false;
  }
  if (/\p{Cc}/u.test(candidate.convertedText)) {
    return false;
  }

  const kanaLength = comparableCharacters(candidate.completedKana).length;
  const convertedLength = comparableCharacters(candidate.convertedText).length;
  if (
    convertedLength < Math.max(1, Math.ceil(kanaLength * 0.2)) ||
    convertedLength > Math.max(24, kanaLength * 2)
  ) {
    return false;
  }
  return !isAvoidedConversionOutput(candidate.convertedText, options.avoidOutputs);
}

export function preservesProtectedSuggestionSyntax(source: string, candidate: string): boolean {
  return PROTECTED_SUGGESTION_SYNTAX.every(
    (character) => countCharacter(source, character) === countCharacter(candidate, character),
  );
}

export function countCharacter(value: string, target: string): number {
  return Array.from(value).filter((character) => character === target).length;
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
    (addition) => addition && /^[\p{Script=Hiragana}ー。、！？!?]+$/u.test(addition),
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
  const maximumLength = level === "word" ? 6 : Math.max(24, Math.ceil(sourceLength * 1.25));
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
