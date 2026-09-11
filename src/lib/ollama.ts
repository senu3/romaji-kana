import {
  collectInputCompletionAdditions,
  comparableCharacters,
  countCharacter,
  isAllowedStructuredSuggestion,
  isAvoidedConversionOutput,
  knownWordCompletionSeed,
  parseStructuredSuggestion,
  preservesProtectedAsciiTokens,
  preservesProtectedSuggestionSyntax,
  reportedSuggestionAdditions,
  type StructuredSuggestionConversion,
} from "./completionValidation";
import { normalizeInputForPrompt } from "./conversion";
import {
  hasConvertibleRomaji,
  normalizeRomajiReadingCandidate,
  splitInputForConversion,
} from "./conversionInput";
import {
  generatedText,
  generateWithAbort,
  stripThinkBlock,
  throwIfConversionAborted,
} from "./generationUtils";
import type {
  JapaneseConversionOptions,
  JapaneseConversionResult,
} from "./japaneseConversionTypes";
import { currentProviderBaseUrl, providerLabel } from "./modelProvider";
import { defaultOllamaTransport, type OllamaTransport } from "./ollamaProxy";
import {
  buildKanaKanjiSystemPrompt,
  buildKanaRepairSystemPrompt,
  buildSpeculativeConversionSystemPrompt,
  buildSuggestionConversionSystemPrompt,
} from "./prompts";
import { rebuildRomajiKanaResult, romajiToKana } from "./romajiKana";
import type {
  AppSettings,
  InputCompletionLevel,
  RomajiKanaResult,
  RomajiKanaSpan,
  RomajiKanaToken,
} from "./types";

const MAX_ALTERNATIVE_CONVERSION_ATTEMPTS = 2;

const ALTERNATIVE_CONVERSION_FAILED_MESSAGE = "別候補に変換できませんでした。";

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
  const result = await applySpeculativeFallback(
    input,
    await convertRomajiToJapaneseDetailedOnce(input, settings, transport, options),
    settings,
    transport,
    options,
  );
  if (isUsableConversionResult(result, options)) {
    return result;
  }

  if (!hasAvoidOutputs(options.avoidOutputs)) {
    return result;
  }

  for (let attempt = 1; attempt <= MAX_ALTERNATIVE_CONVERSION_ATTEMPTS; attempt += 1) {
    throwIfConversionAborted(options.signal);
    const alternativeOptions: JapaneseConversionOptions = {
      ...options,
      strictAlternative: true,
      alternativeAttempt: attempt,
      completionMode: false,
    };
    const alternative = await applySpeculativeFallback(
      input,
      await convertRomajiToJapaneseDetailedOnce(
        input,
        settings,
        transport,
        alternativeOptions,
      ),
      settings,
      transport,
      alternativeOptions,
    );
    if (isUsableConversionResult(alternative, options)) {
      return alternative;
    }
  }

  const completionOptions: JapaneseConversionOptions = {
    ...options,
    strictAlternative: true,
    alternativeAttempt: 0,
    completionMode: true,
  };
  const completion = await applySpeculativeFallback(
    input,
    await convertRomajiToJapaneseDetailedOnce(
      input,
      settings,
      transport,
      completionOptions,
    ),
    settings,
    transport,
    completionOptions,
  );
  if (isUsableConversionResult(completion, options)) {
    return {
      ...completion,
      conversionStrategy: completion.conversionStrategy ?? "completion",
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
          suggestionRejectedReason: "diverged",
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

function hasAvoidOutputs(avoidOutputs: string[] | undefined): boolean {
  return Boolean(avoidOutputs?.some((output) => output.trim()));
}

function isUsableConversionResult(
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

async function applySpeculativeFallback(
  originalRomaji: string,
  result: JapaneseConversionResult,
  settings: AppSettings,
  transport: OllamaTransport,
  options: JapaneseConversionOptions,
): Promise<JapaneseConversionResult> {
  if (result.suggestionRejected || !isHiraganaOnlyConversion(result.text)) {
    return result;
  }

  const speculative = await kanjiizeKana(result.reviewKana, settings, transport, {
    ...options,
    speculativeMode: true,
    completionMode: false,
    completionSourceRomaji: originalRomaji,
    avoidOutputs: Array.from(new Set([...(options.avoidOutputs ?? []), result.text])),
  });
  if (
    isHiraganaOnlyConversion(speculative) ||
    isAvoidedConversionOutput(speculative, [...(options.avoidOutputs ?? []), result.text]) ||
    !isAllowedSpeculativeConversion(result.reviewKana, speculative)
  ) {
    return {
      ...result,
      text: "",
      suggestionRejected: true,
      suggestionRejectedReason: "speculative",
    };
  }

  return {
    ...result,
    text: speculative,
    conversionStrategy: "speculative",
  };
}

function isAllowedSpeculativeConversion(source: string, candidate: string): boolean {
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
      system: options.speculativeMode
        ? buildSpeculativeConversionSystemPrompt(
          settings.conversionPrompt,
          options.avoidOutputs ?? [],
          options.documentVocabulary ?? [],
        )
        : buildKanaKanjiSystemPrompt(
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
        temperature: options.speculativeMode
          ? 0.45
          : options.completionMode
            ? 0.35
            : options.alternativeAttempt
              ? 0.25
              : 0.1,
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
  if (!options.completionMode && !options.speculativeMode) {
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

export { collectInputCompletionAdditions, isAllowedInputCompletion } from "./completionValidation";
export { buildProtectedDictionaryEntries, normalizeRomajiReadingCandidate } from "./conversionInput";
export type { ProtectedDictionaryEntry } from "./conversionInput";
export type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
export { currentProviderApiBaseUrl, currentProviderBaseUrl, normalizeOllamaBaseUrl, providerLabel } from "./modelProvider";
