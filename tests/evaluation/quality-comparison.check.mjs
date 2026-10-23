import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { projectRoot } from '../helpers/artifacts.mjs';
import { variantSource, augmentSpeculation, replaceOnce } from './quality-comparison-variants.mjs';
import { summarize } from './quality-comparison-summary.mjs';

test('summary retains errors and abstentions in denominator and requires complete review', () => {
  const rows = ['a', 'b', 'c'].map(caseId => ({ group: 'g', arm: 'baseline', caseId, repeat: 1, exactMatch: null, calls: [] }));
  const reviews = rows.map((r, i) => ({ ...r, verdict: ['usable', 'correctAbstention', 'errors'][i] }));
  const result = summarize(rows, reviews)['g/baseline'];
  assert.equal(result.trials, 3);
  assert.equal(result.usable, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.correctAbstention, 1);
  assert.equal(result.referenceTrials, 0);
  assert.throws(() => summarize(rows, reviews.slice(1)));
  assert.throws(() => summarize(rows, [...reviews, reviews[0]]));
});

test('source changes fail closed on stale or ambiguous source', () => {
  assert.throws(() => replaceOnce('a a', 'a', 'b'));
  assert.throws(() => replaceOnce('x', 'a', 'b'));
  assert.equal(replaceOnce('a', 'a', 'b'), 'b');
});
test('each prompt arm adds only its declared reference; never rubric or expected output', () => {
  const request = { prompt: 'target', system: 'system', options: { temperature: 0 } };
  const options = { avoidOutputs: ['old', 'last'], documentVocabulary: ['term'], acceptableExamples: ['SECRET'] };
  assert.equal(augmentSpeculation(request, 'baseline', 'romaji', options), request);
  for (const [arm, expected] of [['plus-romaji', { originalRomaji: 'romaji' }], ['plus-rejection', { rejectedOutputForThisOccurrence: ['last'] }], ['plus-vocabulary', { referenceVocabulary: ['term'] }]]) {
    const result = augmentSpeculation(request, arm, 'romaji', options);
    assert.deepEqual(JSON.parse(result.prompt.split('\n').at(-1)), expected);
    assert.equal(result.system, request.system);
    assert.equal(result.options, request.options);
    assert.ok(!result.prompt.includes('SECRET'));
  }
  assert.equal(request.prompt, 'target');
});
test('experiments leave baseline and unrelated source intact, retain repair budgets', async () => {
  for (const file of ['localConversion.ts', 'missingLetterCorrection.ts']) {
    const source = execFileSync('git', ['show', '2bbae00:src/lib/' + file], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(variantSource(file, source, 'baseline'), source);
    assert.equal(variantSource(file, source, 'plus-romaji'), source);
    const modified = variantSource(file, source, 'edit-all');
    assert.notEqual(modified, source);
    if (file === 'missingLetterCorrection.ts') for (const limit of ['MAX_PLANS', 'MAX_ENGINE_CALLS']) assert.ok(modified.includes(`const ${limit} = 128;`));
  }
});
test('fixture has unambiguous paired cases and explicit expectations', async () => {
  const data = JSON.parse(await readFile(new URL('./quality-comparison.json', import.meta.url), 'utf8'));
  assert.equal(new Set(data.cases.map(c => c.group + '/' + c.id)).size, data.cases.length);
  for (const c of data.cases) {
    assert.ok(data.arms[c.group].includes('baseline'));
    assert.ok(c.criteria.length);
    assert.ok(c.acceptableExamples.length || c.expectedRoutes.length);
  }
});
