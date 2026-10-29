import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { artifactPath, projectRoot } from '../helpers/artifacts.mjs';
import { summarizeIntentReview } from './intent-smoke-review.mjs';

test('smoke uses current production candidate requests for all cases', () => {
  const out = artifactPath('evaluation/intent-smoke-check-' + Date.now());
  execFileSync(process.execPath, ['tests/evaluation/intent-smoke.mjs', '--dry-run', '--out', out], { cwd: projectRoot, windowsHide: true });
  const report = JSON.parse(readFileSync(out + '/review.json', 'utf8'));
  assert.equal(report.rows.length, 8);
  for (const row of report.rows) {
    assert.equal(row.error, undefined);
    assert.equal(row.requests.length, 1);
    assert.equal(row.requests[0].outputSchema.properties.candidates.maxItems, 3);
    assert.ok(row.requests[0].prompt.includes(row.id === 'literal-control' ? 'MR-62' : row.input));
    assert.ok(!JSON.stringify(row.requests).includes(row.criterion), 'Review criteria must stay private');
  }
  assert.throws(() => summarizeIntentReview(report), /live run/);
});
test('manual semantic scoring counts alternative candidates, empty/error cases, and refuses unfinished review', () => {
  const report = { complete: true, reviewer: 'test', rows: Array.from({ length: 8 }, (_, id) => ({ id, candidates: [{ text: '自由な言い換え', score: 2 }] })) };
  report.rows[0].candidates = [{ score: 0 }, { score: 1 }];
  report.rows[1].candidates = [];
  report.rows[2].error = 'offline';
  assert.deepEqual(summarizeIntentReview(report), { total: 8, usefulTop1: 5, usefulAny: 6, intentAny: 5, errors: 1, failures: [1, 2] });
  report.rows[3].candidates[0].score = null;
  assert.throws(() => summarizeIntentReview(report), /Unreviewed/);
});
