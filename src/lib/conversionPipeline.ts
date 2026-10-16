import {
  isAvoidedConversionOutput,
  knownWordCompletionSeed,
  preservesProtectedAsciiTokens,
} from "./completionValidation";
import { normalizeInputForPrompt } from "./conversion";
import { classifyConversionChanges, type ConversionChanges } from "./conversionChanges";
import {
  hasConvertibleRomaji,
  normalizeRomajiReadingCandidate,
  splitInputForConversion,
} from "./conversionInput";
import {
  generateStructuredSuggestion,
  kanjiizeKanaDetailed,
  repairLowConfidenceKana,
} from "./conversionGeneration";
import {
  isAllowedSpeculativeConversion,
  isHiraganaOnlyConversion,
  selectSegmentRoute,
} from "./conversionPolicy";
import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import type { OllamaTransport } from "./ollamaProxy";
import { romajiToKana } from "./romajiKana";
import type { AppSettings } from "./types";

interface ConvertedSegment {
  text: string;
  sourceReading: string;
  preparedReading: string;
  reviewReading: string;
  finalReading?: string;
  readingReliable: boolean;
  knownRepair: boolean;
  modelReading: boolean;
}

function preservedSegment(text: string): ConvertedSegment {
  return {
    text, sourceReading: text, preparedReading: text, reviewReading: text,
    finalReading: text, readingReliable: true, knownRepair: false, modelReading: false,
  };
}

/** Suggestions currently apply only to the last meaningful, convertible part.
 * A protected tail intentionally disables suggestions for earlier parts. */
function suggestionPartIndex(parts: ReturnType<typeof splitInputForConversion>): number {
  let last = -1;
  parts.forEach((part, index) => {
    if ((part.type === "text" ? part.value : part.output).trim()) last = index;
  });
  const part = parts[last];
  return part?.type === "text" && hasConvertibleRomaji(part.value) ? last : -1;
}

export async function convertInputOnce(
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
  const segments: ConvertedSegment[] = [];
  const inputCompletionPartIndex = suggestionPartIndex(parts);

  for (const [partIndex, part] of parts.entries()) {
    throwIfConversionAborted(options.signal);
    if (part.type !== "text") {
      segments.push(preservedSegment(part.output));
      continue;
    }
    if (!hasConvertibleRomaji(part.value)) {
      segments.push(preservedSegment(part.value));
      continue;
    }

    const kanaResult = romajiToKana(normalizeRomajiReadingCandidate(part.value));
    const originalKana = romajiToKana(part.value).kana;
    const suggestionLevel =
      partIndex === inputCompletionPartIndex ? settings.inputCompletionLevel : "none";
    const route = selectSegmentRoute(suggestionLevel, options);
    if (route.kind === "word" || route.kind === "sentence") {
      const completionSeed = route.kind === "word"
        ? knownWordCompletionSeed(kanaResult.kana)
        : kanaResult.kana;
      const suggestion = await generateStructuredSuggestion(
        part.value,
        kanaResult.kana,
        completionSeed,
        route.kind,
        segments.map(segment => segment.preparedReading).join(""),
        settings,
        transport,
        options,
      );
      if (!suggestion) {
        return {
          text: "",
          reviewKana: segments.map(segment => segment.reviewReading).join("") + kanaResult.kana,
          suggestionRejected: true,
          suggestionRejectedReason: "diverged",
        };
      }
      segments.push({
        text: suggestion.convertedText,
        sourceReading: originalKana,
        preparedReading: kanaResult.kana,
        reviewReading: suggestion.completedKana,
        finalReading: suggestion.completedKana,
        // A claimed addition contradicting an unchanged reading is not proof.
        readingReliable: !(suggestion.completedKana === kanaResult.kana && suggestion.additions.length),
        knownRepair: originalKana !== kanaResult.kana,
        modelReading: true,
      });
      continue;
    }

    const repaired = await repairLowConfidenceKana(
      kanaResult,
      settings,
      transport,
      options.signal,
    );
    const convertedPart = await kanjiizeKanaDetailed(repaired.kana, settings, transport, {
      ...options,
      completionSourceRomaji: options.completionMode ? part.value : options.completionSourceRomaji,
    });
    segments.push({
      text: convertedPart.text,
      sourceReading: originalKana,
      preparedReading: repaired.kana,
      reviewReading: repaired.kana,
      finalReading: convertedPart.reading,
      readingReliable: convertedPart.reading !== undefined,
      knownRepair: originalKana !== kanaResult.kana || repaired.kana !== kanaResult.kana,
      modelReading: convertedPart.modelReading,
    });
  }
  return assembleConversionResult(segments);
}

function assembleConversionResult(segments: ConvertedSegment[]): JapaneseConversionResult {
  const sourceReading = segments.map(segment => segment.sourceReading).join("");
  const preparedReading = segments.map(segment => segment.preparedReading).join("");
  const finalReading = segments.map(segment => segment.finalReading ?? "").join("");
  const readingReliable = segments.every(segment => segment.readingReliable);
  const hasKnownRepair = segments.some(segment => segment.knownRepair);
  const evidence: ConversionChanges["evidence"] = hasKnownRepair
    ? "repair-stage" : segments.some(segment => segment.modelReading) ? "model-reading" : "literal";

  const result: JapaneseConversionResult = {
    text: segments.map(segment => segment.text).join(""),
    reviewKana: readingReliable && preservesProtectedAsciiTokens(sourceReading, finalReading)
      ? finalReading : segments.map(segment => segment.reviewReading).join(""),
    changes: classifyConversionChanges(
      sourceReading, readingReliable ? finalReading : undefined,
      evidence, hasKnownRepair && finalReading === preparedReading,
    ),
  };
  if (result.changes && ["completion", "correction", "rewrite"].includes(result.changes.kind)) {
    result.inputCompletionApplied = true;
    result.inputCompletionSourceKana = result.changes.sourceReading;
    result.inputCompletionAdditions = result.changes.additions;
  }
  return result;
}

export async function applySpeculativeFallback(
  originalRomaji: string,
  result: JapaneseConversionResult,
  settings: AppSettings,
  transport: OllamaTransport,
  options: JapaneseConversionOptions,
): Promise<JapaneseConversionResult> {
  if (result.suggestionRejected || !isHiraganaOnlyConversion(result.text)) {
    return result;
  }

  const speculativeResult = await kanjiizeKanaDetailed(result.reviewKana, settings, transport, {
    ...options,
    speculativeMode: true,
    completionMode: false,
    completionSourceRomaji: originalRomaji,
    avoidOutputs: Array.from(new Set([...(options.avoidOutputs ?? []), result.text])),
  });
  const speculative = speculativeResult.text;
  if (
    isHiraganaOnlyConversion(speculative) ||
    isAvoidedConversionOutput(speculative, [...(options.avoidOutputs ?? []), result.text]) ||
    !isAllowedSpeculativeConversion(result.changes?.sourceReading ?? result.reviewKana, speculative)
  ) {
    return {
      ...result,
      text: "",
      changes: classifyConversionChanges(result.changes?.sourceReading ?? result.reviewKana, undefined, "unavailable"),
      inputCompletionApplied: undefined,
      inputCompletionSourceKana: undefined,
      inputCompletionAdditions: undefined,
      suggestionRejected: true,
      suggestionRejectedReason: "speculative",
    };
  }

  const changes = classifyConversionChanges(
    result.changes?.sourceReading ?? result.reviewKana,
    speculativeResult.reading,
    speculativeResult.modelReading ? "model-reading" : "literal",
  );
  const applied = ["completion", "correction", "rewrite"].includes(changes.kind);
  return {
    ...result,
    text: speculative,
    conversionStrategy: "speculative",
    changes,
    reviewKana: speculativeResult.reading ?? result.reviewKana,
    // Only the final candidate can establish additions, never the earlier one.
    inputCompletionApplied: applied || undefined,
    inputCompletionSourceKana: applied ? changes.sourceReading : undefined,
    inputCompletionAdditions: applied ? changes.additions : undefined,
  };
}
