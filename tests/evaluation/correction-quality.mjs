// Exact accepted-output matches are reproducible checks, not semantic scores.
// Keep abstentions, errors and other candidates separate and in the denominator.
export function summarizeCorrectionQuality(rows) {
  return Object.fromEntries(["typo-correction", "correct-input", "unknown-input"].map(category => {
    const trials = rows.filter(row => row.category === category);
    const candidates = trials.filter(row => row.outcome === "candidate");
    return [category, {
      trials: trials.length,
      exactAcceptedOutputs: candidates.filter(row => row.exactReferenceMatch?.top === true).length,
      candidatesNeedingReview: candidates.filter(row => row.exactReferenceMatch?.top !== true).length,
      abstentions: trials.filter(row => row.outcome === "rejected" || row.outcome === "empty").length,
      errors: trials.filter(row => row.outcome === "error").length,
      unexpectedCorrections: category === "correct-input" ? candidates.filter(row =>
        row.route?.finalRoute === "correction" || ["correction", "addition", "rewrite"].includes(row.result?.changes?.kind)).length : null,
    }];
  }));
}
