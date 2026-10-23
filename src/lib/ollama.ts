import { ConversionResponseError } from "./conversionDiagnostics";
import { convertInputOnce } from "./conversionPipeline";
import { isUsableConversionResult } from "./conversionPolicy";
import { faithfulConversionRule } from "./conversionRules";
import { createConversionSession, sessionResult } from "./conversionSession";
import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { defaultKanaEngine } from "./kanaEngine";
import { searchMissingLetter } from "./missingLetterCorrection";
import { defaultOllamaTransport, type OllamaTransport } from "./ollamaProxy";
import type { AppSettings } from "./types";

export async function convertRomajiToJapaneseDetailed(input: string, settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport, options: JapaneseConversionOptions = {}): Promise<JapaneseConversionResult> {
  options = { ...options, purpose: options.userRequestedSpeculation ? "speculative" : options.purpose ?? "normal", kanaEngine: options.kanaEngine ?? defaultKanaEngine };
  const runAttempt = async (attemptOptions: JapaneseConversionOptions) => {
    throwIfConversionAborted(attemptOptions.signal);
    const candidate = await convertInputOnce(input, settings, transport, attemptOptions);
    const result = attemptOptions.purpose === "speculative" ? { ...candidate, conversionStrategy: "speculative" as const }
      : attemptOptions.purpose === "correction" ? { ...candidate, conversionStrategy: "correction" as const } : candidate;
    if (result.session || result.suggestionRejected) return result;
    return sessionResult(createConversionSession(input, [{ id: "proposal-0", kind: result.conversionStrategy === "speculative" ? "proposal" : "correction", result }], options));
  };
  const automatic = options.purpose === "normal" && options.autoRescue !== false;
  const runRescue = async (first: JapaneseConversionResult): Promise<JapaneseConversionResult> => {
    options.onRescueStart?.();
    const attempts: NonNullable<JapaneseConversionResult["attempts"]> = [{ stage: "normal", outcome: "rejected", detail: first.rejectionDetail }];
    for (const stage of ["correction", "speculative"] as const) {
      throwIfConversionAborted(options.signal);
      let candidate: JapaneseConversionResult;
      try {
        const searched = stage === "correction" && options.missingLetterCorrection !== false ? await searchMissingLetter(input, settings, transport, options) : undefined;
        candidate = searched && isUsableConversionResult(searched, options) ? searched
          : await runAttempt({ ...options, purpose: stage, deferRanking: undefined, onLocalCandidates: undefined, onRankedCandidates: undefined });
      } catch (error) {
        if (!(error instanceof ConversionResponseError)) throw error;
        candidate = { text: "", reviewKana: first.reviewKana, suggestionRejected: true, suggestionRejectedReason: "unconvertible", rejectionDetail: error.diagnostic };
      }
      const unchangedKana = candidate.text === candidate.reviewKana && candidate.changes?.sourceReading !== undefined && faithfulConversionRule.sameReading(candidate.changes.sourceReading, candidate.reviewKana);
      const usable = isUsableConversionResult(candidate, options) && !unchangedKana;
      attempts.push({ stage, outcome: usable ? "candidate" : "rejected", detail: unchangedKana ? "no-candidate" : candidate.rejectionDetail });
      if (usable) return { ...candidate, attempts };
    }
    return { text: "", reviewKana: first.reviewKana, suggestionRejected: true, suggestionRejectedReason: "unconvertible", rejectionDetail: "no-candidate", attempts };
  };
  let rescue: Promise<JapaneseConversionResult> | undefined;
  const resolveNormal = async (candidate: JapaneseConversionResult): Promise<JapaneseConversionResult> => {
    if (!automatic || candidate.session?.rerankStatus === "pending" || isUsableConversionResult(candidate, options) || candidate.suggestionRejectedReason === "protected") return candidate;
    return rescue ??= runRescue(candidate);
  };
  const result = await resolveNormal(await runAttempt(automatic && options.onRankedCandidates ? {
    ...options,
    onRankedCandidates: async candidate => { const resolved = await resolveNormal(candidate); throwIfConversionAborted(options.signal); await options.onRankedCandidates?.(resolved); },
  } : options));
  return isUsableConversionResult(result, options) ? result : {
    ...result, text: "", suggestionRejected: true,
    suggestionRejectedReason: result.suggestionRejectedReason ?? (options.purpose === "speculative" ? "speculative" : "unconvertible")
  };
}
export { buildProtectedDictionaryEntries } from "./conversionInput";
export type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";

export { providerLabel } from "./modelProvider";
