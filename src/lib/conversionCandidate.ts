import type { JapaneseConversionResult } from "./japaneseConversionTypes";

/** Shared projection for manual, history and predictive candidate displays. */
export function candidateDetails(result: JapaneseConversionResult) {
  return {
    convertedText: result.text, reviewKana: result.reviewKana, changes: result.changes,
    conversionStrategy: result.conversionStrategy, session: result.session
  };
}

export function isOpenConversionResult(result: JapaneseConversionResult): boolean {
  return !result.session || (result.session.state === "open" && !result.session.locked);
}
