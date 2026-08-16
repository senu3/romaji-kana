import type { AppSettings } from "./types";
import { normalizeInputForPrompt } from "./conversion";
import {
  buildKanaKanjiSystemPrompt,
  buildKanaRepairSystemPrompt,
  buildSuggestionConversionSystemPrompt,
} from "./prompts";
import {
  defaultOllamaTransport,
  normalizeLmStudioBaseUrl,
  normalizeOllamaBaseUrl as normalizeOllamaBaseUrlFromProxy,
  type LocalGenerateResponse,
  type OllamaTransport,
} from "./ollamaProxy";
import { rebuildRomajiKanaResult, romajiToKana } from "./romajiKana";
import type {
  RomajiKanaResult,
  RomajiKanaSpan,
  RomajiKanaToken,
  InputCompletionLevel,
  UserDictionaryEntry,
} from "./types";

interface DictionaryTextPart {
  type: "text";
  value: string;
}

interface DictionaryEntryPart {
  type: "dictionary";
  output: string;
}

interface LiteralNounPart {
  type: "literal";
  output: string;
}

type DictionarySplitPart = DictionaryTextPart | DictionaryEntryPart;
type ConversionSplitPart = DictionaryTextPart | DictionaryEntryPart | LiteralNounPart;

interface DictionaryCandidate {
  normalizedReading: string;
  output: string;
}

const MAX_ALTERNATIVE_CONVERSION_ATTEMPTS = 2;
const ALTERNATIVE_CONVERSION_FAILED_MESSAGE = "別候補に変換できませんでした。";
const PROTECTED_SUGGESTION_SYNTAX = ["#", "`", "[", "]", "{", "}", "<", ">"] as const;
const SAFE_WORD_COMPLETION_SEEDS: ReadonlyArray<readonly [string, string]> = [
  ["ありが", "ありがとう"],
  ["おはよ", "おはよう"],
  ["こんにち", "こんにちは"],
  ["すみませ", "すみません"],
  ["おねが", "おねがい"],
  ["よろし", "よろしく"],
];

export type ProtectedDictionaryEntry = Pick<
  UserDictionaryEntry,
  "reading" | "output" | "enabled"
>;

export interface JapaneseConversionResult {
  text: string;
  reviewKana: string;
  conversionStrategy?: "completion";
  inputCompletionApplied?: boolean;
  inputCompletionSourceKana?: string;
  inputCompletionAdditions?: string[];
  suggestionRejected?: boolean;
}

interface StructuredSuggestionConversion {
  completedKana: string;
  convertedText: string;
  additions: string[];
}

export interface JapaneseConversionOptions {
  avoidOutputs?: string[];
  strictAlternative?: boolean;
  alternativeAttempt?: number;
  completionMode?: boolean;
  completionSourceRomaji?: string;
  protectedDictionaryEntries?: ProtectedDictionaryEntry[];
  documentVocabulary?: string[];
  signal?: AbortSignal;
}

export async function convertRomajiToJapanese(
  input: string,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
): Promise<string> {
  const result = await convertRomajiToJapaneseDetailed(input, settings, transport);
  return result.text;
}

export async function convertRomajiToJapaneseDetailed(
  input: string,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
  options: JapaneseConversionOptions = {},
): Promise<JapaneseConversionResult> {
  throwIfConversionAborted(options.signal);
  const result = await convertRomajiToJapaneseDetailedOnce(input, settings, transport, options);
  if (isUsableConversionResult(result, options)) {
    return result;
  }

  if (!hasAvoidOutputs(options.avoidOutputs)) {
    return result;
  }

  for (let attempt = 1; attempt <= MAX_ALTERNATIVE_CONVERSION_ATTEMPTS; attempt += 1) {
    throwIfConversionAborted(options.signal);
    const alternative = await convertRomajiToJapaneseDetailedOnce(input, settings, transport, {
      ...options,
      strictAlternative: true,
      alternativeAttempt: attempt,
      completionMode: false,
    });
    if (isUsableConversionResult(alternative, options)) {
      return alternative;
    }
  }

  const completion = await convertRomajiToJapaneseDetailedOnce(input, settings, transport, {
    ...options,
    strictAlternative: true,
    alternativeAttempt: 0,
    completionMode: true,
  });
  if (isUsableConversionResult(completion, options)) {
    return {
      ...completion,
      conversionStrategy: "completion",
    };
  }

  throw new Error(ALTERNATIVE_CONVERSION_FAILED_MESSAGE);
}

async function convertRomajiToJapaneseDetailedOnce(
  input: string,
  settings: AppSettings,
  transport: OllamaTransport,
  options: JapaneseConversionOptions,
): Promise<JapaneseConversionResult> {
  throwIfConversionAborted(options.signal);
  const normalized = normalizeInputForPrompt(input, settings);
  const parts = splitInputForConversion(normalized, [
    ...(options.protectedDictionaryEntries ?? []),
    ...settings.userDictionary,
  ]);
  const convertedParts: string[] = [];
  const reviewKanaParts: string[] = [];
  const inputCompletionSourceParts: string[] = [];
  const inputCompletionAdditions: string[] = [];
  let inputCompletionApplied = false;
  let finalMeaningfulPartIndex = -1;
  parts.forEach((part, index) => {
    const value = part.type === "text" ? part.value : part.output;
    if (value.trim()) {
      finalMeaningfulPartIndex = index;
    }
  });
  const finalPart = parts[finalMeaningfulPartIndex];
  const inputCompletionPartIndex =
    finalPart?.type === "text" && hasConvertibleRomaji(finalPart.value)
      ? finalMeaningfulPartIndex
      : -1;

  for (const [partIndex, part] of parts.entries()) {
    throwIfConversionAborted(options.signal);
    if (part.type === "dictionary" || part.type === "literal") {
      convertedParts.push(part.output);
      reviewKanaParts.push(part.output);
      inputCompletionSourceParts.push(part.output);
      continue;
    }

    if (!hasConvertibleRomaji(part.value)) {
      convertedParts.push(part.value);
      reviewKanaParts.push(part.value);
      inputCompletionSourceParts.push(part.value);
      continue;
    }

    const kanaResult = romajiToKana(normalizeRomajiReadingCandidate(part.value));
    const suggestionLevel =
      partIndex === inputCompletionPartIndex ? settings.inputCompletionLevel : "none";
    if (suggestionLevel !== "none") {
      const completionSeed = suggestionLevel === "word"
        ? knownWordCompletionSeed(kanaResult.kana)
        : kanaResult.kana;
      const suggestion = await generateStructuredSuggestion(
        part.value,
        kanaResult.kana,
        completionSeed,
        suggestionLevel,
        inputCompletionSourceParts.join(""),
        settings,
        transport,
        options,
      );
      if (!suggestion) {
        return {
          text: "",
          reviewKana: [...reviewKanaParts, kanaResult.kana].join(""),
          suggestionRejected: true,
        };
      }
      inputCompletionSourceParts.push(kanaResult.kana);
      reviewKanaParts.push(suggestion.completedKana);
      inputCompletionAdditions.push(...suggestion.additions);
      inputCompletionApplied ||=
        suggestion.completedKana !== kanaResult.kana || suggestion.additions.length > 0;
      convertedParts.push(suggestion.convertedText);
      continue;
    }

    const repaired = await repairLowConfidenceKana(
      kanaResult,
      settings,
      transport,
      options.signal,
    );
    inputCompletionSourceParts.push(repaired.kana);
    reviewKanaParts.push(repaired.kana);
    convertedParts.push(
      await kanjiizeKana(repaired.kana, settings, transport, {
        ...options,
        completionSourceRomaji: options.completionMode
          ? part.value
          : options.completionSourceRomaji,
      }),
    );
  }

  const result: JapaneseConversionResult = {
    text: convertedParts.join(""),
    reviewKana: reviewKanaParts.join(""),
  };
  if (inputCompletionApplied) {
    const inputCompletionSourceKana = inputCompletionSourceParts.join("");
    result.inputCompletionApplied = true;
    result.inputCompletionSourceKana = inputCompletionSourceKana;
    result.inputCompletionAdditions = inputCompletionAdditions.length > 0
      ? inputCompletionAdditions
      : collectInputCompletionAdditions(inputCompletionSourceKana, result.reviewKana);
  }
  return result;
}

async function generateStructuredSuggestion(
  originalRomaji: string,
  mechanicalKana: string,
  completionSeed: string,
  level: Exclude<InputCompletionLevel, "none">,
  contextBefore: string,
  settings: AppSettings,
  transport: OllamaTransport,
  options: JapaneseConversionOptions,
): Promise<StructuredSuggestionConversion | null> {
  const result = await generateWithAbort(() => transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: buildSuggestionConversionSystemPrompt(
        level,
        settings.conversionPrompt,
        options.avoidOutputs,
        options.documentVocabulary,
      ),
      prompt: [
        "Read-only context before the target:",
        contextBefore.trim() || "(none)",
        "",
        "Original romaji input:",
        originalRomaji,
        "",
        "Mechanical kana:",
        mechanicalKana,
        "",
        "Application completion seed:",
        completionSeed,
      ].join("\n"),
      stream: false,
      think: settings.think,
      options: {
        temperature: level === "word" ? 0.05 : 0.2,
      },
      keep_alive: "5m",
    },
    30_000,
  ), options.signal);

  const candidate = parseStructuredSuggestion(generatedText(result));
  if (!candidate || !isAllowedStructuredSuggestion(mechanicalKana, candidate, level, options)) {
    return null;
  }
  return {
    ...candidate,
    additions: reportedSuggestionAdditions(
      mechanicalKana,
      completionSeed,
      candidate,
      level,
    ),
  };
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

  if (level === "word") {
    const sourceParts = splitTerminalPunctuation(normalizedSource);
    const candidateParts = splitTerminalPunctuation(normalizedCandidate);
    const addedLength = Array.from(candidateParts.body).length - Array.from(sourceParts.body).length;
    return (
      sourceParts.punctuation === candidateParts.punctuation &&
      candidateParts.body.startsWith(sourceParts.body) &&
      addedLength > 0 &&
      addedLength <= 6
    );
  }

  const sourceCharacters = comparableCharacters(normalizedSource);
  const candidateCharacters = comparableCharacters(normalizedCandidate);
  const addedLength = candidateCharacters.length - sourceCharacters.length;
  const maximumAddedLength = Math.max(24, Math.ceil(sourceCharacters.length * 1.25));
  if (
    addedLength <= 0 ||
    addedLength > maximumAddedLength ||
    !isSubsequence(sourceCharacters, candidateCharacters) ||
    !preservesProtectedSuggestionSyntax(normalizedSource, normalizedCandidate)
  ) {
    return false;
  }

  return true;
}

function splitTerminalPunctuation(value: string): { body: string; punctuation: string } {
  const match = value.match(/^(.*?)([。、.!?！？]*)$/u);
  return {
    body: match?.[1] ?? value,
    punctuation: match?.[2] ?? "",
  };
}

function preservesProtectedAsciiTokens(source: string, candidate: string): boolean {
  const sourceTokens = source.match(/[A-Za-z0-9][A-Za-z0-9._:/-]*/g) ?? [];
  const candidateTokens = candidate.match(/[A-Za-z0-9][A-Za-z0-9._:/-]*/g) ?? [];
  return (
    sourceTokens.length === candidateTokens.length &&
    sourceTokens.every((token, index) => candidateTokens[index] === token)
  );
}

function comparableCharacters(value: string): string[] {
  return Array.from(value).filter((character) => !/\s/u.test(character));
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
  return collectInsertedSpans(
    comparableCharacters(source),
    comparableCharacters(candidate),
  );
}

function parseStructuredSuggestion(text: string): StructuredSuggestionConversion | null {
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

function isAllowedStructuredSuggestion(
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

function preservesProtectedSuggestionSyntax(source: string, candidate: string): boolean {
  return PROTECTED_SUGGESTION_SYNTAX.every(
    (character) => countCharacter(source, character) === countCharacter(candidate, character),
  );
}

function countCharacter(value: string, target: string): number {
  return Array.from(value).filter((character) => character === target).length;
}

function reportedSuggestionAdditions(
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

function knownWordCompletionSeed(source: string): string {
  const parts = splitTerminalPunctuation(source);
  for (const [partial, completed] of SAFE_WORD_COMPLETION_SEEDS) {
    if (parts.body.endsWith(partial)) {
      return `${parts.body.slice(0, -partial.length)}${completed}${parts.punctuation}`;
    }
  }
  return source;
}

function isAvoidedConversionOutput(output: string, avoidOutputs: string[] | undefined): boolean {
  const normalizedOutput = output.trim();
  return Boolean(
    normalizedOutput &&
      avoidOutputs?.some((avoidOutput) => avoidOutput.trim() === normalizedOutput),
  );
}

function hasAvoidOutputs(avoidOutputs: string[] | undefined): boolean {
  return Boolean(avoidOutputs?.some((output) => output.trim()));
}

function isUsableConversionResult(
  result: JapaneseConversionResult,
  options: JapaneseConversionOptions,
): boolean {
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
export async function repairLowConfidenceKana(
  result: RomajiKanaResult,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
  signal?: AbortSignal,
): Promise<RomajiKanaResult> {
  if (result.lowConfidenceSpans.length === 0) {
    return result;
  }

  let tokens = result.tokens;

  for (const span of result.lowConfidenceSpans) {
    throwIfConversionAborted(signal);
    const repairedKana = await repairKanaSpan(
      span,
      result.kana,
      settings,
      transport,
      signal,
    );
    if (!repairedKana) {
      continue;
    }

    tokens = replaceSpanWithRepair(tokens, span, repairedKana);
  }

  return rebuildRomajiKanaResult(tokens, result.lowConfidenceSpans[0]?.sourceRomaji ?? "");
}

export async function kanjiizeKana(
  kana: string,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
  options: JapaneseConversionOptions = {},
): Promise<string> {
  const result = await generateWithAbort(() => transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: buildKanaKanjiSystemPrompt(
        settings.conversionPrompt,
        options.avoidOutputs ?? [],
        options.strictAlternative ?? false,
        options.alternativeAttempt ?? 0,
        options.completionMode ?? false,
        options.completionMode ? [] : options.documentVocabulary ?? [],
      ),
      prompt: buildKanaKanjiUserPrompt(kana, options),
      stream: false,
      think: settings.think,
      options: {
        temperature: options.completionMode ? 0.35 : options.alternativeAttempt ? 0.25 : 0.1,
      },
      keep_alive: "5m",
    },
    30_000,
  ), options.signal);

  const rawText = generatedText(result);
  const text = stripThinkBlock(rawText).trim();
  if (!text) {
    throw new Error(`${providerLabel(settings)} returned an empty conversion.`);
  }

  return text;
}

function buildKanaKanjiUserPrompt(kana: string, options: JapaneseConversionOptions): string {
  if (!options.completionMode) {
    return kana;
  }

  return [
    "Original romaji input:",
    options.completionSourceRomaji?.trim() || "(not available)",
    "",
    "Mechanical kana:",
    kana,
  ].join("\n");
}

export function buildProtectedDictionaryEntries(
  input: string,
  currentText: string,
  entries: UserDictionaryEntry[],
): ProtectedDictionaryEntry[] {
  const protectedEntries: ProtectedDictionaryEntry[] = [];
  const seen = new Set<string>();

  const addEntry = (reading: string, output: string) => {
    const normalizedReading = normalizeDictionaryReading(reading);
    const trimmedOutput = output.trim();
    const key = `${normalizedReading}\t${trimmedOutput}`;
    if (
      !normalizedReading ||
      !trimmedOutput ||
      seen.has(key) ||
      !isRomajiDictionaryReading(normalizedReading) ||
      !hasDictionaryReadingMatch(input, normalizedReading)
    ) {
      return;
    }

    seen.add(key);
    protectedEntries.push({
      reading: normalizedReading,
      output: trimmedOutput,
      enabled: true,
    });
  };

  for (const entry of entries) {
    if (!entry.enabled || !entry.output.trim() || !currentText.includes(entry.output.trim())) {
      continue;
    }
    addEntry(entry.reading, entry.output);
  }

  for (const term of extractAsciiProtectedTerms(currentText)) {
    addEntry(term, term);
  }

  return protectedEntries;
}

function splitInputForConversion(
  input: string,
  entries: ProtectedDictionaryEntry[],
): ConversionSplitPart[] {
  const literalParts = splitInputByLiteralNouns(input).flatMap((part) => {
    if (part.type === "literal") {
      return [part];
    }

    return splitInputByInlineKanjiTerms(part.value);
  });

  const dictionaryParts = literalParts.flatMap((part): ConversionSplitPart[] => {
    if (part.type === "literal") {
      return [part];
    }

    return splitInputByDictionary(part.value, entries);
  });

  const hasProtectedLiteral = dictionaryParts.some((part) => part.type !== "text");
  if (!hasProtectedLiteral) {
    return dictionaryParts.map((part) =>
      part.type === "text"
        ? { type: "text" as const, value: normalizeSpacedRomajiParticles(part.value) }
        : part,
    );
  }

  return dictionaryParts.flatMap((part): ConversionSplitPart[] => {
    if (part.type !== "text") {
      return [part];
    }

    return splitInputByProtectedSpacedRomajiParticles(part.value);
  });
}

function splitInputByLiteralNouns(input: string): Array<DictionaryTextPart | LiteralNounPart> {
  const parts: Array<DictionaryTextPart | LiteralNounPart> = [];
  let index = 0;
  let lastCopiedIndex = 0;

  while (index < input.length) {
    if (input[index] !== "`" || isEscapedBacktick(input, index)) {
      index += 1;
      continue;
    }

    const end = findClosingBacktick(input, index + 1);
    if (end === -1) {
      index += 1;
      continue;
    }

    if (lastCopiedIndex < index) {
      parts.push({ type: "text", value: input.slice(lastCopiedIndex, index) });
    }

    parts.push({ type: "literal", output: input.slice(index + 1, end) });
    index = end + 1;
    lastCopiedIndex = index;
  }

  if (parts.length === 0) {
    return [{ type: "text", value: input }];
  }

  if (lastCopiedIndex < input.length) {
    parts.push({ type: "text", value: input.slice(lastCopiedIndex) });
  }

  return parts;
}

function splitInputByInlineKanjiTerms(input: string): Array<DictionaryTextPart | LiteralNounPart> {
  const parts: Array<DictionaryTextPart | LiteralNounPart> = [];
  let index = 0;
  let lastCopiedIndex = 0;

  while (index < input.length) {
    if (!isJapaneseTermCharacter(input[index] ?? "")) {
      index += 1;
      continue;
    }

    const start = index;
    let hasKanji = false;
    while (index < input.length && isJapaneseTermCharacter(input[index] ?? "")) {
      if (isKanjiCharacter(input[index] ?? "")) {
        hasKanji = true;
      }
      index += 1;
    }

    if (!hasKanji) {
      continue;
    }

    if (lastCopiedIndex < start) {
      parts.push({ type: "text", value: input.slice(lastCopiedIndex, start) });
    }
    parts.push({ type: "literal", output: input.slice(start, index) });
    lastCopiedIndex = index;
  }

  if (parts.length === 0) {
    return [{ type: "text", value: input }];
  }

  if (lastCopiedIndex < input.length) {
    parts.push({ type: "text", value: input.slice(lastCopiedIndex) });
  }

  return parts;
}

function normalizeSpacedRomajiParticles(input: string): string {
  const matches = Array.from(
    input.matchAll(/(?<!\S)(no|ni|wo|o|ha|wa|ga|to|de|e|he|mo|kara|made|yori)(?!\S)/gi),
  );
  if (matches.length === 0) {
    return input;
  }

  let normalized = "";
  let lastCopiedIndex = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const leadingText = input.slice(lastCopiedIndex, start).trimEnd();
    normalized += leadingText;
    normalized += romajiParticleToKana(match[0]);
    lastCopiedIndex = end;
    while (lastCopiedIndex < input.length && /\s/.test(input[lastCopiedIndex] ?? "")) {
      lastCopiedIndex += 1;
    }
  }

  if (lastCopiedIndex < input.length) {
    normalized += input.slice(lastCopiedIndex);
  }

  return normalized;
}

function splitInputByProtectedSpacedRomajiParticles(input: string): ConversionSplitPart[] {
  const matches = Array.from(
    input.matchAll(/(?<!\S)(no|ni|wo|o|ha|wa|ga|to|de|e|he|mo|kara|made|yori)(?!\S)/gi),
  );
  if (matches.length === 0) {
    return [{ type: "text", value: input }];
  }

  const parts: ConversionSplitPart[] = [];
  let lastCopiedIndex = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const leadingText = input.slice(lastCopiedIndex, start).trimEnd();
    if (leadingText.length > 0) {
      parts.push({ type: "text", value: leadingText });
    }
    parts.push({ type: "literal", output: romajiParticleToKana(match[0]) });
    lastCopiedIndex = end;
    while (lastCopiedIndex < input.length && /\s/.test(input[lastCopiedIndex] ?? "")) {
      lastCopiedIndex += 1;
    }
  }

  if (lastCopiedIndex < input.length) {
    parts.push({ type: "text", value: input.slice(lastCopiedIndex) });
  }

  return parts;
}

function romajiParticleToKana(particle: string): string {
  switch (particle.toLowerCase()) {
    case "no":
      return "の";
    case "ni":
      return "に";
    case "wo":
    case "o":
      return "を";
    case "ha":
    case "wa":
      return "は";
    case "ga":
      return "が";
    case "to":
      return "と";
    case "de":
      return "で";
    case "e":
    case "he":
      return "へ";
    case "mo":
      return "も";
    case "kara":
      return "から";
    case "made":
      return "まで";
    case "yori":
      return "より";
    default:
      return particle;
  }
}

function isJapaneseTermCharacter(character: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff々〆ヵヶ]/u.test(character);
}

function isKanjiCharacter(character: string): boolean {
  return /[\u3400-\u9fff々〆]/u.test(character);
}

function findClosingBacktick(input: string, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === "`" && !isEscapedBacktick(input, index)) {
      return index;
    }
  }
  return -1;
}

function isEscapedBacktick(input: string, index: number): boolean {
  let slashCount = 0;
  for (let position = index - 1; position >= 0 && input[position] === "\\"; position -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function splitInputByDictionary(
  input: string,
  entries: ProtectedDictionaryEntry[],
): DictionarySplitPart[] {
  const candidates = buildDictionaryCandidates(entries);

  if (candidates.length === 0) {
    return [{ type: "text", value: input }];
  }

  const lowerInput = input.toLowerCase();
  const parts: DictionarySplitPart[] = [];
  let index = 0;
  let lastCopiedIndex = 0;

  while (index < input.length) {
    const match = candidates.find(
      (candidate) =>
        lowerInput.startsWith(candidate.normalizedReading, index) &&
        canMatchDictionaryCandidate(lowerInput, index, candidate),
    );

    if (!match) {
      index += 1;
      continue;
    }

    if (lastCopiedIndex < index) {
      parts.push({ type: "text", value: input.slice(lastCopiedIndex, index) });
    }
    parts.push({ type: "dictionary", output: match.output });
    index += match.normalizedReading.length;
    lastCopiedIndex = index;
  }

  if (parts.length === 0) {
    return [{ type: "text", value: input }];
  }

  if (lastCopiedIndex < input.length) {
    parts.push({ type: "text", value: input.slice(lastCopiedIndex) });
  }
  return parts;
}

function buildDictionaryCandidates(entries: ProtectedDictionaryEntry[]): DictionaryCandidate[] {
  return entries
    .map((entry) => ({
      normalizedReading: normalizeDictionaryReading(entry.reading),
      output: entry.output.trim(),
      enabled: entry.enabled,
    }))
    .filter(
      (entry) =>
        entry.enabled &&
        entry.normalizedReading.length > 0 &&
        entry.output.length > 0 &&
        isRomajiDictionaryReading(entry.normalizedReading),
    )
    .sort((a, b) => b.normalizedReading.length - a.normalizedReading.length);
}

function normalizeDictionaryReading(reading: string): string {
  return reading.toLowerCase().replace(/[\s'-]+/g, "");
}

function canMatchDictionaryCandidate(
  input: string,
  start: number,
  candidate: DictionaryCandidate,
): boolean {
  const length = candidate.normalizedReading.length;
  if (length <= 4) {
    return hasDictionaryWordBoundary(input, start, length);
  }

  return hasAllowedLongDictionarySuffix(input, start + length);
}

function hasDictionaryReadingMatch(input: string, normalizedReading: string): boolean {
  const normalizedInput = input.toLowerCase();
  const candidate: DictionaryCandidate = {
    normalizedReading,
    output: normalizedReading,
  };
  let index = normalizedInput.indexOf(normalizedReading);
  while (index !== -1) {
    if (canMatchDictionaryCandidate(normalizedInput, index, candidate)) {
      return true;
    }
    index = normalizedInput.indexOf(normalizedReading, index + 1);
  }
  return false;
}

function isRomajiDictionaryReading(reading: string): boolean {
  return /^[a-z0-9][a-z0-9' -]*[a-z0-9]$/i.test(reading) || /^[a-z0-9]$/i.test(reading);
}

function extractAsciiProtectedTerms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*/g)) {
    const term = match[0].trim();
    const key = term.toLowerCase();
    if (term.length < 3 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function hasDictionaryWordBoundary(input: string, start: number, length: number): boolean {
  const before = input[start - 1] ?? "";
  const after = input[start + length] ?? "";
  return !isAsciiWordCharacter(before) && !isAsciiWordCharacter(after);
}

function hasAllowedLongDictionarySuffix(input: string, suffixStart: number): boolean {
  const next = input[suffixStart] ?? "";
  if (!isAsciiWordCharacter(next)) {
    return true;
  }

  return ROMAJI_DICTIONARY_SUFFIXES.some((suffix) => input.startsWith(suffix, suffixStart));
}

function isAsciiWordCharacter(character: string): boolean {
  return /[a-z0-9]/i.test(character);
}

function hasConvertibleRomaji(value: string): boolean {
  return /[a-z]/i.test(value);
}

export function normalizeRomajiReadingCandidate(input: string): string {
  return normalizeAmbiguousParticleWo(normalizeCommonRomajiTypos(input));
}

function normalizeCommonRomajiTypos(input: string): string {
  return input
    .replace(/dseu/gi, preserveCaseReplacement("desu"))
    .replace(/deus/gi, preserveCaseReplacement("desu"))
    .replace(/dsu/gi, preserveCaseReplacement("desu"));
}

function normalizeAmbiguousParticleWo(input: string): string {
  return input.replace(/wo(?=ga|ha|wa|wo|ni|de|to|mo|e|he|kara|made|yori)/gi, (match, offset) => {
    const previous = input[offset - 1] ?? "";
    if (!/[a-z]/i.test(previous)) {
      return match;
    }

    return match[0] === "W" ? "O" : "o";
  });
}

function preserveCaseReplacement(replacement: string): (match: string) => string {
  return (match) => (match.toUpperCase() === match ? replacement.toUpperCase() : replacement);
}

const ROMAJI_DICTIONARY_SUFFIXES = [
  "nitsuite",
  "ni",
  "de",
  "no",
  "wo",
  "o",
  "ha",
  "wa",
  "ga",
  "to",
  "e",
  "he",
  "mo",
  "kara",
  "made",
  "yori",
];

async function repairKanaSpan(
  span: RomajiKanaSpan,
  mechanicalKana: string,
  settings: AppSettings,
  transport: OllamaTransport,
  signal?: AbortSignal,
): Promise<string> {
  const result = await generateWithAbort(() => transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: buildKanaRepairSystemPrompt(),
      prompt: [
        `未確定部分: ${span.kana}`,
        `周辺: ${span.contextKana}`,
        `元入力: ${span.romaji}`,
        `機械変換全文: ${mechanicalKana}`,
      ].join("\n"),
      stream: false,
      think: settings.think,
      options: {
        temperature: 0,
      },
      keep_alive: "5m",
    },
    30_000,
  ), signal);

  return cleanKanaFragment(generatedText(result));
}

function throwIfConversionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("変換候補の生成を中止しました。", "AbortError");
  }
}

function generateWithAbort<T>(
  createPromise: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return createPromise();
  }
  throwIfConversionAborted(signal);
  const promise = createPromise();

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("変換候補の生成を中止しました。", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function replaceSpanWithRepair(
  tokens: RomajiKanaToken[],
  span: RomajiKanaSpan,
  repairedKana: string,
): RomajiKanaToken[] {
  const start = tokens.findIndex((token) => token.inputFrom === span.inputFrom);
  const end = tokens.findIndex((token) => token.inputTo === span.inputTo);
  if (start === -1 || end === -1 || end < start) {
    return tokens;
  }

  const first = tokens[start];
  const last = tokens[end];
  const repairedToken: RomajiKanaToken = {
    romaji: span.romaji,
    kana: repairedKana,
    inputFrom: first.inputFrom,
    inputTo: last.inputTo,
    kanaFrom: first.kanaFrom,
    kanaTo: first.kanaFrom + repairedKana.length,
    confidence: 0.8,
    kind: "repaired",
  };

  return [...tokens.slice(0, start), repairedToken, ...tokens.slice(end + 1)];
}

function cleanKanaFragment(text: string): string {
  return stripThinkBlock(text)
    .trim()
    .replace(/^["'「『]|["'」』]$/g, "")
    .trim();
}

export function normalizeOllamaBaseUrl(url: string): string {
  return normalizeOllamaBaseUrlFromProxy(url);
}

export function currentProviderBaseUrl(settings: AppSettings): string {
  if (settings.modelProvider === "lmstudio") {
    return settings.lmStudioApiUrl;
  }

  return settings.ollamaApiUrl;
}

export function currentProviderApiBaseUrl(settings: AppSettings): string {
  if (settings.modelProvider === "lmstudio") {
    return normalizeLmStudioBaseUrl(settings.lmStudioApiUrl);
  }

  return normalizeOllamaBaseUrl(settings.ollamaApiUrl);
}

export function providerLabel(settings: AppSettings): string {
  return settings.modelProvider === "lmstudio" ? "LM Studio" : "Ollama";
}

function generatedText(result: LocalGenerateResponse): string {
  if ("response" in result && result.response) {
    return result.response;
  }
  if ("message" in result && result.message?.content) {
    return result.message.content;
  }
  if ("choices" in result) {
    return result.choices?.[0]?.message?.content ?? "";
  }

  return "";
}

function stripThinkBlock(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
