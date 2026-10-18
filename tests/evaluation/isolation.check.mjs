import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';

test('production bundle excludes evaluation code and retired completion routes', async () => {
  const result = await build({ logLevel: 'silent', build: { write: false } });
  const chunks = result.output.filter(item => item.type === 'chunk');
  const modules = chunks.flatMap(chunk => chunk.moduleIds.map(id => id.replaceAll('\\', '/')));
  assert.equal(modules.some(id => id.includes('/tests/evaluation/')), false);
  const app = chunks.map(chunk => chunk.code).join('\n');
  for (const marker of ['inputCompletionLevel', 'conversionEngine', 'handleSpeculateGhost', 'wordCompletion:', 'Alternative conversion request:']) {
    assert.equal(app.includes(marker), false, marker + ' must not be shipped');
  }
});
