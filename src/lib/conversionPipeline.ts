import {
  knownWordCompletionSeed,
  preservesProtectedAsciiTokens,
} from "./completionValidation";
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
import { preservesProtectedContent } from "./conversionProtection";
import { prepareConversionRequest } from "./conversionRequest";
import { faithfulConversionRule } from "./conversionRules";
import { isAllowedLocalKanaCorrection } from "./localKanaCorrection";
import { assessReading, combineReadingAssessments, type ReadingAssessment } from "./readingAssessment";

/** Reuse the prior reading without asking the model to repair/complete again.
 * Literal anchors retain their original boundaries and never enter generation. */
function alternativeReadingParts(parts: ReturnType<typeof splitInputForConversion>, reading: string): (string | undefined)[] | null {
  const readings: (string | undefined)[] = [];
  let cursor = 0;
  for (const [index, part] of parts.entries()) {
    if (part.type !== "text") {
      if (!reading.startsWith(part.output, cursor)) return null;
      readings.push(undefined);
      cursor += part.output.length;
      continue;
    }
    const next = parts[index + 1];
    if (next?.type === "text") return null; // Ambiguous split: do not guess.
    const end = next ? reading.indexOf(next.output, cursor) : reading.length;
    if (end < cursor) return null;
    const value = reading.slice(cursor, end);
    if (hasConvertibleRomaji(part.value) && !value.trim()) return null;
    if (!hasConvertibleRomaji(part.value) && value !== part.value) return null;
    readings.push(value);
    cursor = end;
  }
  return cursor === reading.length ? readings : null;
}

function protectedRejection(result: JapaneseConversionResult): JapaneseConversionResult {
  return {
    ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "protected",
    changes: classifyConversionChanges(result.changes?.sourceReading ?? result.reviewKana, undefined, "unavailable"),
    inputCompletionApplied: undefined, inputCompletionSourceKana: undefined, inputCompletionAdditions: undefined,
  };
}

interface ConvertedSegment {
  wordCompletion?: boolean;
  text: string;
  sourceReading: string;
  preparedReading: string;
  reviewReading: string;
  finalReading?: string;
  readingAvailable: boolean;
  readingAssessment: ReadingAssessment;
  knownRepair: boolean;
  modelReading: boolean;
}

function preservedSegment(text: string): ConvertedSegment {
  return {
    text, sourceReading: text, preparedReading: text, reviewReading: text,
    finalReading: text, readingAvailable: true, knownRepair: false, modelReading: false,
    readingAssessment: { status: "verified", origin: "literal", proof: "preserved" },
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
  const { parts, protection, documentVocabulary } = prepareConversionRequest(input, settings, options);
  options = { ...options, documentVocabulary };
  const isAlternative = selectSegmentRoute("none", options).kind === "alternative";
  const alternateReadings = isAlternative && options.alternativeReading !== undefined
    ? alternativeReadingParts(parts, options.alternativeReading) : undefined;
  if (alternateReadings === null ||
      (options.alternativeReading !== undefined && isAlternative &&
       !preservesProtectedContent(protection.source, options.alternativeReading, protection.literalTerms)) ||
      (isAlternative && options.alternativeCorrectedReading !== undefined &&
       !preservesProtectedContent(protection.source, options.alternativeCorrectedReading, protection.literalTerms))) {
    return protectedRejection({ text: "", reviewKana: protection.source });
  }
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
    // Spelling exploration reuses a fixed reading; it never repairs it again.
    const repaired = route.kind === "alternative"
      ? { kana: alternateReadings?.[partIndex] ?? kanaResult.kana }
      : await repairLowConfidenceKana(kanaResult, settings, transport, options.signal);
    if (route.kind === "word" || route.kind === "sentence") {
      const completionSeed = route.kind === "word"
        ? knownWordCompletionSeed(repaired.kana)
        : repaired.kana;
      const suggestion = await generateStructuredSuggestion(
        {
          target: { originalRomaji: part.value, mechanicalReading: kanaResult.kana, preparedReading: repaired.kana, completionSeed },
          reference: { beforeTarget: segments.map(segment => segment.preparedReading).join(""), documentVocabulary },
        },
        route.kind,
        settings,
        transport,
        options,
      );
      if (!suggestion) {
        return {
          text: "",
          reviewKana: segments.map(segment => segment.reviewReading).join("") + repaired.kana,
          suggestionRejected: true,
          suggestionRejectedReason: "diverged",
        };
      }
      segments.push({
        text: suggestion.convertedText,
        sourceReading: originalKana,
        preparedReading: suggestion.correctedKana ?? repaired.kana,
        reviewReading: suggestion.completedKana,
        finalReading: suggestion.completedKana,
        // A claimed addition contradicting an unchanged reading is not proof.
        readingAvailable: !(suggestion.completedKana === (suggestion.correctedKana ?? repaired.kana) && suggestion.additions.length),
        readingAssessment: assessReading(suggestion.convertedText, suggestion.completedKana, true, options.readingVerifier),
        knownRepair: originalKana !== (suggestion.correctedKana ?? repaired.kana),
        modelReading: true,
        wordCompletion: route.kind === "word" && suggestion.completedKana !== (suggestion.correctedKana ?? repaired.kana),
      });
      continue;
    }

    const convertedPart = await kanjiizeKanaDetailed(repaired.kana, settings, transport, {
      ...options,
      completionSourceRomaji: options.completionMode ? part.value : options.completionSourceRomaji,
    });
    if (convertedPart.reading !== undefined && (
      route.kind === "alternative" && !faithfulConversionRule.sameReading(repaired.kana, convertedPart.reading) ||
      route.kind === "typo-repair" && !isAllowedLocalKanaCorrection(repaired.kana, convertedPart.reading)
    )) {
      return { text: "", reviewKana: repaired.kana, suggestionRejected: true, suggestionRejectedReason: "diverged" };
    }
    segments.push({
      text: convertedPart.text,
      sourceReading: originalKana,
      preparedReading: repaired.kana,
      reviewReading: repaired.kana,
      finalReading: convertedPart.reading,
      readingAvailable: convertedPart.reading !== undefined,
      readingAssessment: assessReading(convertedPart.text, convertedPart.reading, convertedPart.modelReading, options.readingVerifier),
      knownRepair: route.kind !== "alternative" && (originalKana !== kanaResult.kana || repaired.kana !== kanaResult.kana),
      modelReading: convertedPart.modelReading,
    });
  }
  const result = assembleConversionResult(segments, isAlternative ? options.alternativeCorrectedReading : undefined);
  if (result.changes?.readingAssessment?.status === "contradicted") {
    return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "reading",
      inputCompletionApplied: undefined, inputCompletionSourceKana: undefined, inputCompletionAdditions: undefined };
  }
  if (isAlternative && options.alternativeReading !== undefined && options.alternativeAdditionKind && result.changes?.kind === "completion") {
    result.changes.additionKind = options.alternativeAdditionKind;
  }
  const preserves = (candidate: string) => preservesProtectedContent(protection.source, candidate, protection.literalTerms);
  if (!preserves(result.text) ||
      (segments.every(segment => segment.finalReading !== undefined) &&
       !preserves(segments.map(segment => segment.finalReading).join("")))) {
    return protectedRejection(result);
  }
  if (options.speculativeMode && (isHiraganaOnlyConversion(result.text) ||
      !isAllowedSpeculativeConversion(protection.source, result.text))) {
    return { text: "", reviewKana: result.reviewKana, suggestionRejected: true, suggestionRejectedReason: "speculative" };
  }
  return result;
}

function assembleConversionResult(segments: ConvertedSegment[], previousCorrectedReading?: string): JapaneseConversionResult {
  const sourceReading = segments.map(segment => segment.sourceReading).join("");
  const preparedReading = previousCorrectedReading ?? segments.map(segment => segment.preparedReading).join("");
  const finalReading = segments.map(segment => segment.finalReading ?? "").join("");
  const readingAvailable = segments.every(segment => segment.readingAvailable);
  const hasKnownRepair = (previousCorrectedReading !== undefined && previousCorrectedReading !== sourceReading) || segments.some(segment => segment.knownRepair);
  const evidence: ConversionChanges["evidence"] = hasKnownRepair
    ? "repair-stage" : segments.some(segment => segment.modelReading) ? "model-reading" : "literal";

  const result: JapaneseConversionResult = {
    text: segments.map(segment => segment.text).join(""),
    reviewKana: readingAvailable && preservesProtectedAsciiTokens(sourceReading, finalReading)
      ? finalReading : segments.map(segment => segment.reviewReading).join(""),
    changes: classifyConversionChanges(
      sourceReading, readingAvailable ? finalReading : undefined,
      evidence, hasKnownRepair && finalReading === preparedReading,
      hasKnownRepair ? preparedReading : undefined,
    ),
  };
  result.changes!.readingAssessment = combineReadingAssessments(segments.map(segment => segment.readingAssessment));
  if (result.changes?.kind === "completion" && segments[segments.length - 1]?.wordCompletion &&
      segments.slice(0, -1).every(segment => segment.finalReading !== undefined && faithfulConversionRule.sameReading(segment.preparedReading, segment.finalReading))) {
    result.changes.additionKind = "word";
  }
  if (result.changes && ["completion", "correction", "rewrite"].includes(result.changes.kind)) {
    result.inputCompletionApplied = true;
    result.inputCompletionSourceKana = result.changes.sourceReading;
    result.inputCompletionAdditions = result.changes.additions;
  }
  return result;
}
