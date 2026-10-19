import { classifyConversionChanges } from "./conversionChanges";
import { generateKanaConversion } from "./conversionGeneration";
import { hasConvertibleRomaji, normalizeRomajiReadingCandidate } from "./conversionInput";
import { isAllowedSpeculativeConversion } from "./conversionPolicy";
import { preservesProtectedContent, type ConversionProtection } from "./conversionProtection";
import { prepareConversionRequest, type ConversionRequest } from "./conversionRequest";
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
  if (changes.readingAssessment.status === "contradicted") return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "reading", rejectionDetail: "reading-contradiction" };
  if (!preservesProtectedContent(protection.source, text, protection.literalTerms) || !preservesProtectedContent(protection.source, reading, protection.literalTerms)) {
    return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "protected", rejectionDetail: "protected-content" };
  }
  if (text.trim() === protection.source.trim() || (options.purpose === "speculative" && !isAllowedSpeculativeConversion(protection.source, text))) {
    return { ...result, text: "", suggestionRejected: true, suggestionRejectedReason: "speculative", rejectionDetail: "speculative-policy" };
  }
  return result;
}

function splitAroundLiterals(value: string, literals: readonly string[]): string[] | undefined {
  const spans: string[] = [];
  let cursor = 0;
  for (const literal of literals) {
    const index = value.indexOf(literal, cursor);
    if (index < 0) return undefined;
    spans.push(value.slice(cursor, index));
    cursor = index + literal.length;
  }
  return [...spans, value.slice(cursor)];
}

async function reinterpretWholeTarget(settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions, preparedInput: ReturnType<typeof prepareConversionRequest>): Promise<JapaneseConversionResult> {
  const { parts, protection, documentVocabulary } = preparedInput;
  const literals = parts.flatMap(part => part.type === "text" ? [] : [part.output]).filter(Boolean);
  const source = parts.map(part => part.type === "text" ? romajiToKana(part.value).kana : part.output).join("");
  const prepared = parts.map(part => part.type === "text" ? romajiToKana(normalizeRomajiReadingCandidate(part.value)).kana : part.output).join("");
  const rejected = (detail: "no-candidate" | "protected-content"): JapaneseConversionResult => ({
    text: "", reviewKana: source, suggestionRejected: true, suggestionRejectedReason: detail === "protected-content" ? "protected" : "unconvertible", rejectionDetail: detail,
  });
  if (!parts.some(part => part.type === "text" && hasConvertibleRomaji(part.value))) return rejected("no-candidate");
  const candidate = await generateKanaConversion({
    target: { originalRomaji: parts.map(part => part.type === "text" ? part.value : part.output).join(""), mechanicalReading: prepared, preparedReading: prepared, protectedLiterals: literals },
    reference: { beforeTarget: options.contextBefore ?? "", afterTarget: options.contextAfter, documentVocabulary },
  }, settings, transport, options);
  if (!candidate.text) return rejected("no-candidate");
  // Reject broken or duplicated anchors before splitting/verification. The model
  // emits one full target; the application never guesses a rejected sub-fragment.
  if (!preservesProtectedContent(protection.source, candidate.text, literals) || !preservesProtectedContent(protection.source, candidate.reading, literals)) return rejected("protected-content");
  const textSpans = splitAroundLiterals(candidate.text, literals);
  const readingSpans = splitAroundLiterals(candidate.reading, literals);
  const reportedSpans = splitAroundLiterals(candidate.reportedReading, literals);
  const sourceSpans = splitAroundLiterals(source, literals);
  if (!textSpans || !readingSpans || !reportedSpans || !sourceSpans) return rejected("protected-content");
  const segments: GeneratedSegment[] = [];
  for (let i = 0; i < textSpans.length; i++) {
    throwIfConversionAborted(options.signal);
    if (textSpans[i] || readingSpans[i] || sourceSpans[i]) {
      const assessment = await assessReadingWithEngine(textSpans[i], readingSpans[i], true, options.readingVerifier,
        options.kanaEngine, settings.personalDictionary, options.signal);
      segments.push({ text: textSpans[i], reading: readingSpans[i], source: sourceSpans[i], assessment,
        reported: reportedSpans[i], numeric: candidate.numericReadingNormalized });
    }
    if (i < literals.length) segments.push({ text: literals[i], reading: literals[i], source: literals[i], assessment: { status: "verified", origin: "literal", proof: "preserved" } });
  }
  return finishGeneration(segments, protection, options);
}
