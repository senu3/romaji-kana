import type { JapaneseConversionResult } from "./japaneseConversionTypes";

/** Project observed changes into the legacy API once, at the public boundary.
 * Internal classification must never read these compatibility fields back. */
export function withLegacyCompletionMetadata(result: JapaneseConversionResult): JapaneseConversionResult {
  const { inputCompletionApplied: _applied, inputCompletionSourceKana: _source, inputCompletionAdditions: _additions, ...current } = result;
  if (current.suggestionRejected || !current.changes || !["completion", "correction", "rewrite"].includes(current.changes.kind)) return current;
  return { ...current, inputCompletionApplied: true,
    inputCompletionSourceKana: current.changes.sourceReading, inputCompletionAdditions: current.changes.additions };
}
