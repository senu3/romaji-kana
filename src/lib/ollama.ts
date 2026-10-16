import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { defaultOllamaTransport, type OllamaTransport } from "./ollamaProxy";
import { applySpeculativeFallback, convertInputOnce } from "./conversionPipeline";
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
  const runAttempt = async (attemptOptions: JapaneseConversionOptions) => {
    throwIfConversionAborted(attemptOptions.signal);
    const candidate = await convertInputOnce(input, settings, transport, attemptOptions);
    return applySpeculativeFallback(input, candidate, settings, transport, attemptOptions);
  };
  const result = await runAttempt(options);
  if (isUsableConversionResult(result, options)) {
    return result;
  }

  if (!hasAvoidOutputs(options.avoidOutputs)) {
    return result;
  }

  for (const attempt of alternativeConversionAttempts(options)) {
    const candidate = await runAttempt(attempt.options);
    if (isUsableConversionResult(candidate, options)) {
      return attempt.kind === "typo-completion"
        ? { ...candidate, conversionStrategy: candidate.conversionStrategy ?? "completion" }
        : candidate;
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
