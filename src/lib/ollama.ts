import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { defaultOllamaTransport, type OllamaTransport } from "./ollamaProxy";
import { convertInputOnce } from "./conversionPipeline";
import {
  alternativeConversionAttempts,
  hasAvoidOutputs,
  isUsableConversionResult,
} from "./conversionPolicy";
import type { AppSettings } from "./types";
import { createConversionSession, sessionResult } from "./conversionSession";
import { withLegacyCompletionMetadata } from "./conversionCompatibility";
import { defaultKanaEngine } from "./kanaEngine";
import { ConversionResponseError } from "./conversionDiagnostics";
import { faithfulConversionRule } from "./conversionRules";
import { searchMissingLetter } from "./missingLetterCorrection";

const ALTERNATIVE_CONVERSION_FAILED_MESSAGE = "別候補に変換できませんでした。";

export async function convertRomajiToJapanese(
  input: string,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
): Promise<string> {
  const result = await convertRomajiToJapaneseDetailed(input, settings, transport);
  return result.suggestionRejected ? input : result.text;
}

export async function convertRomajiToJapaneseDetailed(
  input: string,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
  options: JapaneseConversionOptions = {},
): Promise<JapaneseConversionResult> {
  options = { ...options, kanaEngine: options.kanaEngine ?? (settings.conversionEngine === "llm" ? undefined : defaultKanaEngine) };
  const explicitRescue = options.completionMode || options.speculativeMode;
  const requestOptions = !explicitRescue && hasAvoidOutputs(options.avoidOutputs)
    ? { ...options, alternativeMode: true } : options;
  const automaticRescue = options.autoRescue !== false && settings.conversionEngine !== "llm" &&
    settings.inputCompletionLevel === "none" && !explicitRescue && !requestOptions.alternativeMode;
  const runAttempt = async (attemptOptions: JapaneseConversionOptions) => {
    throwIfConversionAborted(attemptOptions.signal);
    const candidate = withLegacyCompletionMetadata(await convertInputOnce(input, settings, transport, attemptOptions));
    const result = attemptOptions.speculativeMode ? { ...candidate, conversionStrategy: "speculative" as const }
      : attemptOptions.completionMode ? { ...candidate, conversionStrategy: "completion" as const } : candidate;
    if (!options.kanaEngine || result.session || result.suggestionRejected) return result;
    return sessionResult(createConversionSession(input, [{ id: "proposal-0",
      kind: result.conversionStrategy === "speculative" || settings.inputCompletionLevel === "sentence" ? "proposal"
        : result.changes?.kind === "correction" ? "correction" : "completion", result }], options));
  };
  const runRescue = async (first: JapaneseConversionResult): Promise<JapaneseConversionResult> => {
    options.onRescueStart?.();
    const attempts: NonNullable<JapaneseConversionResult["attempts"]> = [{
      stage: "normal", outcome: "rejected", detail: first.rejectionDetail,
    }];
    for (const stage of ["correction", "speculative"] as const) {
      throwIfConversionAborted(options.signal);
      let candidate: JapaneseConversionResult;
      try {
        const searched = stage === "correction" && options.missingLetterCorrection !== false
          ? await searchMissingLetter(input, settings, transport, options) : undefined;
        candidate = searched ?? await runAttempt({ ...options, deferRanking: undefined, onLocalCandidates: undefined, onRankedCandidates: undefined,
          requireStructuredResponse: true, alternativeMode: false, completionMode: stage === "correction", speculativeMode: stage === "speculative" });
      } catch (error) {
        // Malformed candidates can be rescued; transport failures and user
        // cancellation are not evidence of unconvertible input.
        if (!(error instanceof ConversionResponseError)) throw error;
        candidate = { text: "", reviewKana: first.reviewKana, suggestionRejected: true,
          suggestionRejectedReason: "unconvertible", rejectionDetail: error.diagnostic };
      }
      const unchangedKana = candidate.text === candidate.reviewKana && candidate.changes?.sourceReading !== undefined &&
        faithfulConversionRule.sameReading(candidate.changes.sourceReading, candidate.reviewKana);
      const usable = isUsableConversionResult(candidate, options) && !unchangedKana;
      attempts.push({ stage, outcome: usable ? "candidate" : "rejected", detail: unchangedKana ? "no-candidate" : candidate.rejectionDetail });
      if (usable) return { ...candidate, attempts };
    }
    // Rejected candidates never replace the editor's original romaji.
    return { text: "", reviewKana: first.reviewKana, suggestionRejected: true,
      suggestionRejectedReason: "unconvertible", rejectionDetail: "no-candidate", attempts };
  };
  let rescue: Promise<JapaneseConversionResult> | undefined;
  const resolveNormal = async (candidate: JapaneseConversionResult): Promise<JapaneseConversionResult> => {
    if (!automaticRescue || candidate.session?.rerankStatus === "pending" || isUsableConversionResult(candidate, options)) return candidate;
    if (candidate.suggestionRejectedReason === "protected") return candidate;
    rescue ??= runRescue(candidate);
    return rescue;
  };
  const initialOptions = automaticRescue && options.onRankedCandidates ? { ...requestOptions,
    onRankedCandidates: async (candidate: JapaneseConversionResult) => {
      const resolved = await resolveNormal(candidate);
      throwIfConversionAborted(options.signal);
      await options.onRankedCandidates?.(resolved);
    },
  } : requestOptions;
  const result = await resolveNormal(await runAttempt(initialOptions));
  if (isUsableConversionResult(result, options)) {
    return result;
  }

  if (explicitRescue || !hasAvoidOutputs(options.avoidOutputs)) {
    return result;
  }

  for (const attempt of alternativeConversionAttempts(requestOptions)) {
    const candidate = await runAttempt(attempt.options);
    if (isUsableConversionResult(candidate, options)) {
      return candidate;
    }
  }

  throw new Error(ALTERNATIVE_CONVERSION_FAILED_MESSAGE);
}

export { collectInputCompletionAdditions, isAllowedInputCompletion } from "./completionValidation";
export { buildProtectedDictionaryEntries, normalizeRomajiReadingCandidate } from "./conversionInput";
export type { ProtectedDictionaryEntry } from "./conversionInput";
export type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
export { currentProviderApiBaseUrl, currentProviderBaseUrl, normalizeOllamaBaseUrl, providerLabel } from "./modelProvider";

export { kanjiizeKana, repairLowConfidenceKana } from "./conversionGeneration";
export { isHiraganaOnlyConversion } from "./conversionPolicy";
