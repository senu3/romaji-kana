// Evaluation-only conversion baseline: a89d523. Never import from production.
import { collectInputCompletionAdditions } from "./completionValidation";
import { localCorrectionRule, wordCompletionRule, type CompletionBoundaryStatus } from "./conversionRules";
import type { ReadingAssessment } from "./readingAssessment";
import { normalizeComparableReading } from "../../../src/lib/readingComparison";
export { normalizeComparableReading } from "../../../src/lib/readingComparison";

/** A description of the observed change, independent of the requested mode
 * and generation strategy. Model readings are evidence, not semantic proof. */
export interface ConversionChanges {
  readingAssessment?: ReadingAssessment;
  wordBoundary?: "unverified";
  kind: "notation" | "completion" | "correction" | "rewrite" | "unknown";
  evidence: "literal" | "dictionary-path" | "model-reading" | "repair-stage" | "unavailable";
  sourceReading: string;
  resultReading?: string;
  /** Validated reading after local correction, before any completion. */
  correctedReading?: string;
  additions: string[];
  /** Observed boundary of an insertion, independent of requested mode. */
  additionKind?: "word" | "phrase" | "unverified";
}

export function classifyConversionChanges(
  sourceReading: string,
  resultReading: string | undefined,
  evidence: ConversionChanges["evidence"],
  repaired = false,
  correctedReading?: string,
  completionBoundary?: CompletionBoundaryStatus,
): ConversionChanges {
  const base = { sourceReading, resultReading, evidence, additions: [] as string[],
    ...(correctedReading !== undefined ? { correctedReading } : {}),
  };
  if (resultReading === undefined) return { ...base, kind: "unknown", evidence: "unavailable" };
  const source = normalizeComparableReading(sourceReading);
  const result = normalizeComparableReading(resultReading);
  if (source === result) return { ...base, kind: "notation" };
  // A known repair stage may replace or delete characters. Do not guess that
  // any small arbitrary model rewrite is necessarily a typing correction.
  if (repaired) return { ...base, kind: "correction" };
  const completionSource = correctedReading === undefined ? source : normalizeComparableReading(correctedReading);
  const additions = collectInputCompletionAdditions(completionSource, result);
  if (additions.length) {
    const additionKind = wordCompletionRule.additionKind(completionSource, result, completionBoundary);
    return { ...base, kind: "completion", additions, additionKind };
  }
  // A local replacement/deletion/transposition is a correction candidate.
  // This describes the edit shape, not proof of the author's intended meaning.
  const a = Array.from(source), b = Array.from(result);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const changedLength = Math.max(endA - start, endB - start);
  if (changedLength <= localCorrectionRule.maximumChange(Math.max(a.length, b.length))) {
    return { ...base, kind: "correction" };
  }
  return { ...base, kind: "rewrite" };
}

export function literalCandidateReading(text: string): string | undefined {
  // Latin tokens may be protected literals. Kanji require a reading we do not
  // have; never pretend an earlier stage's kana describes a new final output.
  return /[\p{Script=Han}々〆]/u.test(text) ? undefined : text;
}
