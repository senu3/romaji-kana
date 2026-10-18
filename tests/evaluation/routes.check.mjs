import { test } from "node:test";
import assert from "node:assert/strict";
import { observeRoute, summarizeRoutes } from "./routes.mjs";

test("observes normal, correction, speculation and rejection independently of quality", () => {
  assert.deepEqual(observeRoute({ text: "不自然な文章" }, ["normal"]), {
    finalRoute: "normal", expectedRoutes: ["normal"], matchesExpectation: true,
  });
  assert.equal(observeRoute({ text: "本", conversionStrategy: "completion" }, ["normal"]).matchesExpectation, false);
  assert.equal(observeRoute({ text: "本", conversionStrategy: "completion" }).finalRoute, "correction");
  assert.equal(observeRoute({ text: "本", conversionStrategy: "speculative" }).finalRoute, "speculative");
  assert.equal(observeRoute({ suggestionRejected: true, conversionStrategy: "speculative" }).finalRoute, "rejected");
  assert.equal(observeRoute({}).matchesExpectation, null);
  assert.equal(observeRoute({ text: " " }).finalRoute, "empty");
});

test("keeps errors and cases without route expectations out of the expectation denominator", () => {
  const rows = [
    { route: observeRoute({ text: "本" }, ["normal"]) },
    { route: observeRoute({ text: "本", conversionStrategy: "completion" }) },
    { caseId: "unknown", repeat: 2, route: observeRoute({ text: "本", conversionStrategy: "speculative" }, ["rejected"]) },
    { outcome: "error" },
  ];
  assert.deepEqual(summarizeRoutes(rows), {
    counts: { normal: 1, correction: 1, speculative: 1, rejected: 0, empty: 0, error: 1 },
    expectationsEvaluated: 2, expectationMismatches: [{ caseId: "unknown", repeat: 2 }],
  });
});
