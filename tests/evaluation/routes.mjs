export const finalRoutes = ["normal", "correction", "speculative", "rejected"];

// This describes the route, not the semantic quality of the returned text.
export function observeRoute(result, expectedRoutes) {
  const finalRoute = result.suggestionRejected ? "rejected"
    : !result.text?.trim() ? "empty"
    : ["completion", "correction"].includes(result.conversionStrategy) ? "correction"
    : result.conversionStrategy === "speculative" ? "speculative" : "normal";
  return { finalRoute, expectedRoutes: expectedRoutes ?? null,
    matchesExpectation: expectedRoutes ? expectedRoutes.includes(finalRoute) : null };
}

export function summarizeRoutes(rows) {
  return {
    counts: Object.fromEntries([...finalRoutes, "empty", "error"].map(route => [route,
      rows.filter(row => (row.route?.finalRoute ?? "error") === route).length])),
    expectationsEvaluated: rows.filter(row => row.route?.matchesExpectation != null).length,
    expectationMismatches: rows.filter(row => row.route?.matchesExpectation === false).map(row => ({ caseId: row.caseId, repeat: row.repeat })),
  };
}
