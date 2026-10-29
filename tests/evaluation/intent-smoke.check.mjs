import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { artifactPath, projectRoot } from '../helpers/artifacts.mjs';
import { summarizeIntentReview } from './intent-smoke-review.mjs';

test('smoke uses current production candidate requests for all cases', () => {
  const out = artifactPath('evaluation/intent-smoke-check-' + Date.now());
  execFileSync(process.execPath, ['tests/evaluation/intent-smoke.mjs', '--dry-run', '--out', out], { cwd: projectRoot, windowsHide: true });
  const report = JSON.parse(readFileSync(out + '/review.json', 'utf8'));
  assert.equal(report.rows.length, 10);
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
  const report = { complete: true, caseIds: Array.from({ length: 8 }, (_, id) => id), reviewer: 'test', rows: Array.from({ length: 8 }, (_, id) => ({ id, candidates: [{ text: '自由な言い換え', score: 2 }] })) };
  report.rows[0].candidates = [{ score: 0 }, { score: 1 }];
  report.rows[1].candidates = [];
  report.rows[2].error = 'offline';
  assert.deepEqual(summarizeIntentReview(report), { total: 8, usefulTop1: 5, usefulAny: 6, intentAny: 5, errors: 1, failures: [1, 2], intentFailures: [0, 1, 2] });
  report.rows[3].candidates[0].score = null;
  assert.throws(() => summarizeIntentReview(report), /Unreviewed/);
});


test('review rejects duplicate and unknown case identities', () => {
  const report = { complete: true, reviewer: 'test', caseIds: ['a', 'b'], rows: [{ id: 'a', candidates: [] }, { id: 'a', candidates: [] }] };
  assert.throws(() => summarizeIntentReview(report), /case ID/);
  report.rows[1].id = 'unknown';
  assert.throws(() => summarizeIntentReview(report), /case ID/);
});

test('review CLI requires an intent match, and saves the semantic summary', () => {
  const out = artifactPath('evaluation/intent-review-check-' + Date.now());
  mkdirSync(out, { recursive: true });
  const report = { complete: true, reviewer: 'test', caseIds: ['a'], rows: [{ id: 'a', candidates: [{ score: 1 }] }] };
  const path = out + '/review.json';
  const run = () => spawnSync(process.execPath, ['tests/evaluation/intent-smoke.mjs', '--review', path], { cwd: projectRoot, windowsHide: true, encoding: 'utf8' });
  writeFileSync(path, JSON.stringify(report));
  assert.equal(run().status, 1, 'A useful candidate still needs an intent match');
  const summary = JSON.parse(readFileSync(out + '/summary.json', 'utf8'));
  assert.equal(summary.usefulAny, 1);
  assert.deepEqual(summary.intentFailures, ['a']);
  report.rows[0].candidates[0].score = 2;
  writeFileSync(path, JSON.stringify(report));
  assert.equal(run().status, 0);
});
