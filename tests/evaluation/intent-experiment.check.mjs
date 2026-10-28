import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { artifactPath, projectRoot } from '../helpers/artifacts.mjs';

test('paired experiment changes only the selected factors and preserves immutable IDs', () => {
  mkdirSync(artifactPath('evaluation'), { recursive: true });
  const out = artifactPath('evaluation/intent-check-' + Date.now());
  execFileSync(process.execPath, ['tests/evaluation/intent-experiment.mjs', '--dry-run', '--out', out], { cwd: projectRoot, windowsHide: true });
  const requests = JSON.parse(readFileSync(out + '/requests.json', 'utf8'));
  assert.equal(requests.length, 160);
  for (const caseId of new Set(requests.map(r => r.caseId))) for (const repeat of [1, 2]) {
    const jobs = requests.filter(r => r.caseId === caseId && r.repeat === repeat);
    assert.equal(jobs.length, 8);
    assert.equal(new Set(jobs.map(r => r.seed)).size, 1);
    const get = id => jobs.find(r => r.arm === id).request;
    for (const instruction of ['current', 'intent']) for (const count of [1, 3]) {
      const kana = get(`${instruction}-kana-${count}`), both = get(`${instruction}-both-${count}`);
      assert.equal(kana.system, both.system);
      assert.deepEqual(kana.outputSchema, both.outputSchema);
      assert.deepEqual(kana.options, both.options);
      assert.equal(both.prompt.split('\nRaw romaji (additional view of the same possibly damaged input):\n')[0], kana.prompt);
    }
    for (const representation of ['kana', 'both']) {
      const current = get(`current-${representation}-1`), intent = get(`intent-${representation}-1`);
      assert.equal(current.prompt, intent.prompt);
      assert.deepEqual(current.outputSchema, intent.outputSchema);
      const multiple = get(`current-${representation}-3`);
      assert.equal(current.prompt, multiple.prompt);
      assert.deepEqual(multiple.outputSchema.properties.candidates.items, current.outputSchema);
    }
    if (caseId === 'literal-control') {
      assert.match(get('current-both-1').prompt, /"literal":"MR-62"/);
      assert.deepEqual(get('current-both-1').outputSchema.properties.segments.items.properties.id.enum, ['edit-1']);
    }
  }
});
