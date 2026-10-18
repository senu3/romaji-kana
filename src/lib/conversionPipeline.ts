import { classifyConversionChanges } from "./conversionChanges";
import { generateKanaConversion } from "./conversionGeneration";
import { hasConvertibleRomaji, normalizeRomajiReadingCandidate } from "./conversionInput";
import { isAllowedSpeculativeConversion } from "./conversionPolicy";
import { preservesProtectedContent } from "./conversionProtection";
import { prepareConversionRequest, type ConversionRequest } from "./conversionRequest";
import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { convertLocally } from "./localConversion";
import { isAllowedLocalKanaCorrection } from "./localKanaCorrection";
import type { OllamaTransport } from "./ollamaProxy";
import { assessReadingWithEngine, combineReadingAssessments, type ReadingAssessment } from "./readingAssessment";
import { romajiToKana } from "./romajiKana";
import type { AppSettings } from "./types";

export async function convertInputOnce(input: string, settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions): Promise<JapaneseConversionResult> {
  throwIfConversionAborted(options.signal);
  if (!options.purpose || options.purpose === "normal") return convertLocally(input, settings, transport, options);
  const { parts, protection, documentVocabulary } = prepareConversionRequest(input, settings, options);
  const segments: Array<{ text: string; source: string; reading: string; assessment: ReadingAssessment; reported?: string; numeric?: boolean }> = [];
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
  const source = segments.map(s => s.source).join("");
  const text = segments.map(s => s.text).join("");
  const reading = segments.map(s => s.reading).join("");
  const changes = classifyConversionChanges(source, reading, "model-reading");
  changes.readingAssessment = combineReadingAssessments(segments.map(s => s.assessment));
  changes.readingAssessment.reportedReading = segments.map(s => s.reported ?? s.reading).join("");
  if (segments.some(s => s.numeric)) changes.readingAssessment.numericReadingNormalized = true;
  const result: JapaneseConversionResult = { text, reviewKana: reading, changes };
  if (changes.readingAssessment.status === "contradicted") return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "reading", rejectionDetail: "reading-contradiction" };
  if (!preservesProtectedContent(protection.source, text, protection.literalTerms) || !preservesProtectedContent(protection.source, reading, protection.literalTerms)) {
    return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "protected", rejectionDetail: "protected-content" };
  }
  if (text.trim() === protection.source.trim() || (options.purpose === "speculative" && !isAllowedSpeculativeConversion(protection.source, text))) {
    return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "speculative", rejectionDetail: "speculative-policy" };
  }
  return result;
}
