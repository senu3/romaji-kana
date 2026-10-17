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
  options = { ...options, kanaEngine: options.kanaEngine ?? (settings.conversionEngine === "llm" ? undefined : defaultKanaEngine) };
  const explicitRescue = options.completionMode || options.speculativeMode;
  const requestOptions = !explicitRescue && hasAvoidOutputs(options.avoidOutputs)
    ? { ...options, alternativeMode: true } : options;
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
  const result = await runAttempt(requestOptions);
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
