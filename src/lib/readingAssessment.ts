/** Independent local lookup. Model output and reference vocabulary are not
 * independent verifiers. An unknown entry must return undefined. */
export interface ReadingVerifier {
  lookupReadings(text: string): readonly string[] | undefined;
}

export interface ReadingAssessment {
  status: "verified" | "unverified" | "contradicted";
  origin: "literal" | "model" | "unavailable" | "mixed";
  proof?: "literal" | "independent" | "preserved" | "mixed";
}

export function normalizeReading(value: string): string {
  return value.normalize("NFKC").replace(/[ァ-ヶ]/gu,
    char => String.fromCharCode(char.charCodeAt(0) - 0x60)).replace(/\s/gu, "");
}

export function assessReading(text: string, claimed: string | undefined, modelReading: boolean, verifier?: ReadingVerifier): ReadingAssessment {
  const origin = modelReading ? "model" : claimed === undefined ? "unavailable" : "literal";
  if (!/[\p{Script=Han}々〆]/u.test(text)) {
    return { status: claimed !== undefined && normalizeReading(text) !== normalizeReading(claimed) ? "contradicted" : "verified", origin, proof: "literal" };
  }
  const readings = verifier?.lookupReadings(text);
  if (claimed !== undefined && readings?.length) {
    return { status: readings.some(reading => normalizeReading(reading) === normalizeReading(claimed)) ? "verified" : "contradicted", origin, proof: "independent" };
  }
  return { status: "unverified", origin };
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
  changes?: { readingAssessment?: ReadingAssessment; wordBoundary?: "unverified"; additionKind?: "word" | "phrase" | "unverified" };
  conversionStrategy?: string;
}): boolean {
  return candidate.conversionStrategy === "speculative" || candidate.changes?.wordBoundary === "unverified" || candidate.changes?.additionKind === "unverified" ||
    candidate.changes?.readingAssessment?.status !== "verified";
}
