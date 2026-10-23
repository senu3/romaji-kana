// Diagnostic only: force the repair stage to measure reachable candidates,
// without asking a model or letting reference answers influence selection.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { resolveArtifactPath, artifactPath, projectRoot as root } from '../helpers/artifacts.mjs';
import { createKanaEngineClient } from '../../tools/kana-engine-client.mjs';
const out = resolveArtifactPath(process.argv[2]);
const { data } = JSON.parse(await readFile(resolve(out, 'manifest.json'), 'utf8'));
const vite = await createServer({ root, configFile: false, cacheDir: artifactPath('cache/recall'), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
const engine = createKanaEngineClient();
const rows = [];
try {
  for (const arm of ['baseline', 'edit-all']) {
    const load = f => vite.ssrLoadModule(resolve(out, 'snapshots', arm, f).replaceAll('\\', '/'));
    const { searchMissingLetter } = await load('missingLetterCorrection.ts');
    const { defaultSettings } = await load('settings.ts');
    for (const c of data.cases.filter(c => c.group === 'repair')) {
      const row = { caseId: c.id, arm, offered: [], metrics: null };
      const transport = { generate: async (_p, _u, body) => { row.offered = JSON.parse(body.prompt).candidates; return { response: '{"order":[]}' }; } };
      await searchMissingLetter(c.input, defaultSettings, transport, { ...c.options, rerank: true,
        kanaEngine: { search: (reading, words) => engine.request({ operation: 'search', reading, words: words.filter(w => w.enabled), limit: 24 }) },
        onMissingLetterSearch: m => { row.metrics = m; } });
      row.referenceInPool = c.acceptableExamples.length ? row.offered.some(p => c.acceptableExamples.includes(p.text)) : null;
      rows.push(row);
      console.log(c.id, arm, row.referenceInPool, row.metrics?.engineCalls);
    }
  }
  await writeFile(resolve(out, 'repair-recall.json'), JSON.stringify(rows, null, 2), { flag: 'wx' });
} finally { engine.close(); await vite.close(); }
