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
  const explicitRescue = options.completionMode || options.speculativeMode;
  const requestOptions = !explicitRescue && hasAvoidOutputs(options.avoidOutputs)
    ? { ...options, alternativeMode: true } : options;
  const runAttempt = async (attemptOptions: JapaneseConversionOptions) => {
    throwIfConversionAborted(attemptOptions.signal);
    const candidate = await convertInputOnce(input, settings, transport, attemptOptions);
    return attemptOptions.speculativeMode ? { ...candidate, conversionStrategy: "speculative" as const }
      : attemptOptions.completionMode ? { ...candidate, conversionStrategy: "completion" as const } : candidate;
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
