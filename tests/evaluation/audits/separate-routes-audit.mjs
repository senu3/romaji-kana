import { createServer } from 'vite';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactPath, projectRoot } from '../../helpers/artifacts.mjs';

await mkdir(artifactPath('evaluation/audits'), { recursive: true });
const out = await mkdtemp(artifactPath('evaluation/audits/separate-routes-audit-'));
console.log(`Output: ${out}`);
const vite = await createServer({ root: projectRoot, cacheDir: artifactPath('cache/audits'), configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
try {
  const { defaultSettings } = await vite.ssrLoadModule('/tests/evaluation/legacy/settings.ts');
  const { convertRomajiToJapaneseDetailed } = await vite.ssrLoadModule('/tests/evaluation/legacy/ollama.ts');
  const { defaultOllamaTransport } = await vite.ssrLoadModule('/src/lib/ollamaProxy.ts');
  const cases = [
    { input: 'honwoyomu.', level: 'word' },
    { input: 'ariga.', level: 'word' },
    { input: 'shoruinokakuni.', level: 'word' },
    { input: 'ashitanoyotteiwoonega.', level: 'word' },
    { input: 'ashitakaigi', level: 'sentence' },
    { input: 'ariga.', level: 'word', options: { avoidOutputs: ['ありがとう。'], alternativeReading: 'ありがとう。' } },
    { input: 'ashitanoyottei.', level: 'word', options: { completionMode: true } },
  ];
  const rows = [];
  for (const test of cases) {
    const calls = [];
    const transport = { ...defaultOllamaTransport, async generate(...args) {
      const start = performance.now();
      const call = { system: args[2].system, prompt: args[2].prompt }; calls.push(call);
      try { call.response = await defaultOllamaTransport.generate(...args); return call.response; }
      catch (error) { call.error = String(error); throw error; }
      finally { call.elapsedMs = performance.now() - start; }
    } };
    const row = { ...test, model: 'gemma4:latest', calls };
    try { row.result = await convertRomajiToJapaneseDetailed(test.input, { ...defaultSettings, modelName: row.model, inputCompletionLevel: test.level }, transport, test.options); }
    catch (error) { row.error = String(error); }
    rows.push(row);
    await writeFile(join(out, 'separate-routes-audit-2026-10-17.json'), JSON.stringify(rows, null, 2));
    console.log(JSON.stringify({ ...test, result: row.result, calls: calls.length, error: row.error }));
    if (row.error && !row.error.includes('別候補に変換できませんでした。')) { process.exitCode = 1; break; }
  }
} finally { await vite.close(); }
