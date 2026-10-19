import { classifyConversionChanges } from "./conversionChanges";
import { isRejectedSurfaceVariant } from "./conversionOutput";
import { generateKanaConversion, generateReinterpretationSegments } from "./conversionGeneration";
import { hasConvertibleRomaji, normalizeRomajiReadingCandidate } from "./conversionInput";
import { isAllowedSpeculativeConversion } from "./conversionPolicy";
import { preservesProtectedContent, type ConversionProtection } from "./conversionProtection";
import { prepareConversionRequest, type ConversionRequest, type ReinterpretationPart } from "./conversionRequest";
import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { convertLocally } from "./localConversion";
import { isAllowedLocalKanaCorrection } from "./localKanaCorrection";
import type { OllamaTransport } from "./ollamaProxy";
import { assessReadingWithEngine, combineReadingAssessments, type ReadingAssessment } from "./readingAssessment";
import { romajiToKana } from "./romajiKana";
import type { AppSettings } from "./types";

type GeneratedSegment = { text: string; source: string; reading: string; assessment: ReadingAssessment; reported?: string; numeric?: boolean };

export async function convertInputOnce(input: string, settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions): Promise<JapaneseConversionResult> {
  throwIfConversionAborted(options.signal);
  if (!options.purpose || options.purpose === "normal") return convertLocally(input, settings, transport, options);
  const preparedInput = prepareConversionRequest(input, settings, options);
  const { parts, protection, documentVocabulary } = preparedInput;
  if (options.userRequestedSpeculation) return reinterpretWholeTarget(settings, transport, options, preparedInput);
  const segments: GeneratedSegment[] = [];
  for (const part of parts) {
    throwIfConversionAborted(options.signal);
    if (part.type !== "text" || !hasConvertibleRomaji(part.value)) {
      const text = part.type === "text" ? part.value : part.output;
      segments.push({ text, source: text, reading: text, assessment: { status: "verified", origin: "literal", proof: "preserved" } });
      continue;
    }
    const source = romajiToKana(part.value).kana;
    const prepared = romajiToKana(normalizeRomajiReadingCandidate(part.value)).kana;
    const request: ConversionRequest = {
      target: { originalRomaji: part.value, mechanicalReading: prepared, preparedReading: prepared },
      reference: {
        beforeTarget: (options.contextBefore ?? "") + segments.map(s => s.text).join(""),
        afterTarget: options.contextAfter, beforeTargetReading: segments.map(s => s.source).join(""), documentVocabulary
      }
    };
    const candidate = await generateKanaConversion(request, settings, transport, options);
    if (!candidate.text) return { text: "", reviewKana: source, suggestionRejected: true, suggestionRejectedReason: "unconvertible", rejectionDetail: "no-candidate" };
    if (options.purpose === "correction" && !isAllowedLocalKanaCorrection(prepared, candidate.reading)) {
      return { text: "", reviewKana: source, suggestionRejected: true, suggestionRejectedReason: "diverged", rejectionDetail: "local-correction" };
    }
    const assessment = await assessReadingWithEngine(candidate.text, candidate.reading, true, options.readingVerifier,
      options.kanaEngine, settings.personalDictionary, options.signal);
    segments.push({ text: candidate.text, source, reading: candidate.reading, assessment, reported: candidate.reportedReading, numeric: candidate.numericReadingNormalized });
  }
  return finishGeneration(segments, protection, options);
}

function finishGeneration(segments: GeneratedSegment[], protection: ConversionProtection, options: JapaneseConversionOptions): JapaneseConversionResult {
  const source = segments.map(s => s.source).join("");
  const text = segments.map(s => s.text).join("");
  const reading = segments.map(s => s.reading).join("");
  const changes = classifyConversionChanges(source, reading, "model-reading");
  changes.readingAssessment = combineReadingAssessments(segments.map(s => s.assessment));
  changes.readingAssessment.reportedReading = segments.map(s => s.reported ?? s.reading).join("");
  if (segments.some(s => s.numeric)) changes.readingAssessment.numericReadingNormalized = true;
  const result: JapaneseConversionResult = { text, reviewKana: reading, changes };
  if (options.userRequestedSpeculation && isRejectedSurfaceVariant(text, options.avoidOutputs)) {
    return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "speculative", rejectionDetail: "avoided-output" };
  }
  if (changes.readingAssessment.status === "contradicted") return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "reading", rejectionDetail: "reading-contradiction" };
  if (!preservesProtectedContent(protection.source, text, protection.literalTerms) || !preservesProtectedContent(protection.source, reading, protection.literalTerms)) {
    return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "protected", rejectionDetail: "protected-content" };
  }
  if (text.trim() === protection.source.trim() || (options.purpose === "speculative" && !isAllowedSpeculativeConversion(protection.source, text))) {
    return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "speculative", rejectionDetail: "speculative-policy" };
  }
  return result;
}

async function reinterpretWholeTarget(settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions, preparedInput: ReturnType<typeof prepareConversionRequest>): Promise<JapaneseConversionResult> {
  const { parts, protection, documentVocabulary } = preparedInput;
  const source = parts.map(part => part.type === "text" ? romajiToKana(part.value).kana : part.output).join("");
  const request: ConversionRequest = {
    target: {
      originalRomaji: parts.map(part => part.type === "text" ? part.value : part.output).join(""),
      mechanicalReading: source,
      preparedReading: parts.map(part => part.type === "text" ? romajiToKana(normalizeRomajiReadingCandidate(part.value)).kana : part.output).join(""),
    },
    reference: { beforeTarget: options.contextBefore ?? "", afterTarget: options.contextAfter, documentVocabulary },
  };
  const rejected = (): JapaneseConversionResult => ({ text: "", reviewKana: source, suggestionRejected: true,
    suggestionRejectedReason: "unconvertible", rejectionDetail: "no-candidate" });
  if (!parts.some(part => part.type === "text" && hasConvertibleRomaji(part.value))) return rejected();
  const hasLiterals = parts.some(part => part.type !== "text");
  const layout: ReinterpretationPart[] = parts.map((part, index) => part.type === "text" && hasConvertibleRomaji(part.value)
    ? { id: "edit-" + index, originalInput: part.value }
    : { literal: part.type === "text" ? part.value : part.output });
  const editableReadings = parts.flatMap(part => part.type === "text" && hasConvertibleRomaji(part.value)
    ? [romajiToKana(normalizeRomajiReadingCandidate(part.value)).kana] : []);
  const generated = hasLiterals
    ? await generateReinterpretationSegments(request, layout, editableReadings, settings, transport, options)
    : [await generateKanaConversion(request, settings, transport, options)];
  if (!generated.length || generated.some(segment => !segment.text)) return rejected();
  const segments: GeneratedSegment[] = [];
  let index = 0;
  // One model request sees the complete target and full rejections. Immutable
  // spans are inserted by the app, never generated or pronounced by the model.
  for (const part of hasLiterals ? layout : [{ id: "whole", originalInput: request.target.originalRomaji }]) {
    throwIfConversionAborted(options.signal);
    if ("literal" in part) {
      segments.push({ text: part.literal, reading: part.literal, source: part.literal,
        assessment: { status: "verified", origin: "literal", proof: "preserved" } });
      continue;
    }
    const candidate = generated[index];
    const segmentSource = hasLiterals ? romajiToKana(part.originalInput).kana : source;
    index++;
    const assessment = await assessReadingWithEngine(candidate.text, candidate.reading, true, options.readingVerifier,
      options.kanaEngine, settings.personalDictionary, options.signal);
    throwIfConversionAborted(options.signal);
    segments.push({ text: candidate.text, reading: candidate.reading, source: segmentSource, assessment,
      reported: candidate.reportedReading, numeric: candidate.numericReadingNormalized });
  }
  return finishGeneration(segments, protection, options);
}
