import { normalizeNumericReading } from "./numericReading";
import { normalizeReading } from "./readingComparison";
import type { KanaEngine, PersonalWord } from "./kanaEngine";
export { normalizeReading } from "./readingComparison";

/** Independent local lookup. Model output and reference vocabulary are not
 * independent verifiers. An unknown entry must return undefined. */
export interface ReadingVerifier {
  lookupReadings?(text: string): readonly string[] | undefined;
  /** Missing or budget-exhausted paths must remain unverified. */
  verify?(text: string, reading: string): ReadingAssessment["status"];
}

export interface ReadingAssessment {
  /** Preserve the model's raw reading even when numeric representation is canonicalized. */
  reportedReading?: string;
  numericReadingNormalized?: boolean;
  status: "verified" | "unverified" | "contradicted";
  origin: "literal" | "dictionary" | "model" | "unavailable" | "mixed";
  proof?: "literal" | "independent" | "preserved" | "mixed";
}

export function assessReading(text: string, claimed: string | undefined, modelReading: boolean, verifier?: ReadingVerifier): ReadingAssessment {
  const origin = modelReading ? "model" : claimed === undefined ? "unavailable" : "literal";
  if (!/[\p{Script=Han}々〆]/u.test(text)) {
    return { status: claimed !== undefined && normalizeReading(text) !== normalizeReading(claimed) ? "contradicted" : "verified", origin, proof: "literal" };
  }
  if (claimed !== undefined && verifier?.verify) {
    const status = verifier.verify(text, claimed);
    return { status, origin, ...(status === "verified" ? { proof: "independent" as const } : {}) };
  }
  const readings = verifier?.lookupReadings?.(text);
  if (claimed !== undefined && readings?.length) {
    return { status: readings.some(reading => normalizeReading(normalizeNumericReading(claimed, reading).reading) === normalizeReading(claimed)) ? "verified" : "contradicted", origin, proof: "independent" };
  }
  return { status: "unverified", origin };
}

export async function assessReadingWithEngine(text: string, claimed: string | undefined, modelReading: boolean,
  verifier?: ReadingVerifier, engine?: KanaEngine, words: readonly PersonalWord[] = [], signal?: AbortSignal): Promise<ReadingAssessment> {
  const assessment = assessReading(text, claimed, modelReading, verifier);
  if (!engine || claimed === undefined || assessment.status !== "unverified") return assessment;
  const status = await engine.verify(text, claimed, words, signal);
  return { ...assessment, status, ...(status === "verified" ? { proof: "independent" as const } : {}) };
}

export function combineReadingAssessments(assessments: readonly ReadingAssessment[]): ReadingAssessment {
  const status = assessments.some(value => value.status === "contradicted") ? "contradicted"
    : assessments.some(value => value.status === "unverified") ? "unverified" : "verified";
  const origins = new Set(assessments.map(value => value.origin));
  const proofs = new Set(assessments.map(value => value.proof));
  return { status, origin: origins.size === 1 ? assessments[0].origin : "mixed",
    ...(status === "verified" ? { proof: proofs.size === 1 ? assessments[0]?.proof ?? "preserved" : "mixed" } : {}),
  };
}

export function requiresExplicitAcceptance(candidate: {
  changes?: { kind?: string; readingAssessment?: ReadingAssessment; wordBoundary?: "unverified"; additionKind?: "word" | "phrase" | "unverified" };
  conversionStrategy?: string;
}): boolean {
  return candidate.conversionStrategy === "speculative" || ["correction", "completion", "rewrite"].includes(candidate.changes?.kind ?? "") || candidate.changes?.wordBoundary === "unverified" || candidate.changes?.additionKind === "unverified" ||
    candidate.changes?.readingAssessment?.status !== "verified";
}
