import { convertInputOnce } from "./conversionPipeline";
import { prepareConversionRequest, type PreparedConversionInput } from "./conversionRequest";
import { isUsableConversionResult } from "./conversionPolicy";
import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { searchMissingLetter } from "./missingLetterCorrection";
import type { OllamaTransport } from "./ollamaProxy";
import type { AppSettings } from "./types";

/** Shared by automatic rescue and explicit correction requests. A valid empty
 * ranking is abstention; an invalid ranking is failure, not permission to invent
 * a replacement through another generation request. Transport failures propagate. */
export async function correctInput(input: string, settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions, preparedInput: PreparedConversionInput = prepareConversionRequest(input, settings, options)): Promise<JapaneseConversionResult> {
  throwIfConversionAborted(options.signal);
  const correctionOptions: JapaneseConversionOptions = {
    ...options, purpose: "correction", deferRanking: undefined,
    onLocalCandidates: undefined, onRankedCandidates: undefined,
  };
  const searched = options.missingLetterCorrection !== false
    ? await searchMissingLetter(input, settings, transport, correctionOptions, preparedInput) : undefined;
  if (searched && (isUsableConversionResult(searched, options) || searched.rejectionDetail === "ranking-invalid")) return searched;
  return convertInputOnce(input, settings, transport, correctionOptions, preparedInput);
}
