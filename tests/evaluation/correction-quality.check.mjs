import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCorrectionQuality } from "./correction-quality.mjs";

test("correction quality separates accepted outputs, review, abstention and errors", () => {
  const rows = [
    { category: "typo-correction", outcome: "candidate", exactReferenceMatch: { top: true } },
    { category: "typo-correction", outcome: "candidate", exactReferenceMatch: { top: false } },
    { category: "typo-correction", outcome: "rejected" },
    { category: "typo-correction", outcome: "error" },
    { category: "correct-input", outcome: "candidate", route: { finalRoute: "correction" } },
    { category: "correct-input", outcome: "candidate", route: { finalRoute: "normal" }, result: { changes: { kind: "rewrite" } } },
    { category: "correct-input", outcome: "candidate", route: { finalRoute: "normal" }, exactReferenceMatch: { top: true } },
    { category: "unknown-input", outcome: "rejected" },
  ];
  const summary = summarizeCorrectionQuality(rows);
  assert.deepEqual(summary["typo-correction"], { trials: 4, exactAcceptedOutputs: 1, candidatesNeedingReview: 1,
    abstentions: 1, errors: 1, unexpectedCorrections: null });
  assert.equal(summary["correct-input"].unexpectedCorrections, 2);
  assert.equal(summary["unknown-input"].abstentions, 1);
  assert.equal(summarizeCorrectionQuality([])["typo-correction"].trials, 0);
});
