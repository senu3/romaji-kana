import { collectInputCompletionAdditions } from "./completionValidation";

/** A description of the observed change, independent of the requested mode
 * and generation strategy. Model readings are evidence, not semantic proof. */
export interface ConversionChanges {
  kind: "notation" | "completion" | "correction" | "rewrite" | "unknown";
  evidence: "literal" | "model-reading" | "repair-stage" | "unavailable";
  sourceReading: string;
  resultReading?: string;
  additions: string[];
}

export function normalizeComparableReading(value: string): string {
  return value.normalize("NFKC").replace(/[ァ-ヶ]/gu, char =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  ).replace(/\s/gu, "").replace(/[。、,.!?！？]+$/u, "");
}

export function classifyConversionChanges(
  sourceReading: string,
  resultReading: string | undefined,
  evidence: ConversionChanges["evidence"],
  repaired = false,
): ConversionChanges {
  const base = { sourceReading, resultReading, evidence, additions: [] as string[] };
  if (resultReading === undefined) return { ...base, kind: "unknown", evidence: "unavailable" };
  const source = normalizeComparableReading(sourceReading);
  const result = normalizeComparableReading(resultReading);
  if (source === result) return { ...base, kind: "notation" };
  // A known repair stage may replace or delete characters. Do not guess that
  // any small arbitrary model rewrite is necessarily a typing correction.
  if (repaired) return { ...base, kind: "correction" };
  const additions = collectInputCompletionAdditions(source, result);
  if (additions.length) return { ...base, kind: "completion", additions };
  // A local replacement/deletion/transposition is a correction candidate.
  // This describes the edit shape, not proof of the author's intended meaning.
  const a = Array.from(source), b = Array.from(result);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const changedLength = Math.max(endA - start, endB - start);
  if (changedLength <= 2 && changedLength / Math.max(a.length, b.length) <= 0.25) {
    return { ...base, kind: "correction" };
  }
  return { ...base, kind: "rewrite" };
}

export function literalCandidateReading(text: string): string | undefined {
  // Latin tokens may be protected literals. Kanji require a reading we do not
  // have; never pretend an earlier stage's kana describes a new final output.
  return /[\p{Script=Han}々〆]/u.test(text) ? undefined : text;
}
