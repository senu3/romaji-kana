import { createServer } from 'vite';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactPath, projectRoot } from '../../helpers/artifacts.mjs';

await mkdir(artifactPath('evaluation/audits'), { recursive: true });
const out = await mkdtemp(artifactPath('evaluation/audits/local-correction-audit-'));
console.log(`Output: ${out}`);
const vite = await createServer({ root: projectRoot, cacheDir: artifactPath('cache/audits'), configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
try {
  const { defaultSettings } = await vite.ssrLoadModule('/tests/evaluation/legacy/settings.ts');
  const { convertRomajiToJapaneseDetailed } = await vite.ssrLoadModule('/tests/evaluation/legacy/ollama.ts');
  const { defaultOllamaTransport } = await vite.ssrLoadModule('/src/lib/ollamaProxy.ts');
  const rows = [];
  for (const input of ['honwoyomu.', 'ariga.', 'ashitanoyottei.', 'ashitanoyotteiwoonega.', 'ashita10jiniikanai.']) {
    const calls = [];
    const transport = { ...defaultOllamaTransport, async generate(...args) {
      const start = performance.now();
      const call = { system: args[2].system, prompt: args[2].prompt }; calls.push(call);
      try { call.response = await defaultOllamaTransport.generate(...args); return call.response; }
      catch (error) { call.error = String(error); throw error; }
      finally { call.elapsedMs = performance.now() - start; }
    } };
    const row = { input, level: 'word', model: 'gemma4:latest', calls };
    try { row.result = await convertRomajiToJapaneseDetailed(input, { ...defaultSettings, modelName: row.model, inputCompletionLevel: row.level }, transport); }
    catch (error) { row.error = String(error); }
    rows.push(row);
    await writeFile(join(out, 'local-correction-audit-2026-10-17.json'), JSON.stringify(rows, null, 2));
    console.log(JSON.stringify({ input, result: row.result, calls: calls.length, elapsedMs: calls.reduce((sum, call) => sum + call.elapsedMs, 0), error: row.error }));
    if (row.error) { process.exitCode = 1; break; }
  }
} finally { await vite.close(); }
