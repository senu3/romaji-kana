import { createServer } from 'vite';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactPath, projectRoot } from '../../helpers/artifacts.mjs';

await mkdir(artifactPath('evaluation/audits'), { recursive: true });
const out = await mkdtemp(artifactPath('evaluation/audits/audit-candidates-'));
console.log(`Output: ${out}`);
const vite = await createServer({ root: projectRoot, cacheDir: artifactPath('cache/audits'), configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
try {
  const { defaultSettings } = await vite.ssrLoadModule('/tests/evaluation/legacy/settings.ts');
  const { convertRomajiToJapaneseDetailed } = await vite.ssrLoadModule('/tests/evaluation/legacy/ollama.ts');
  const { defaultOllamaTransport } = await vite.ssrLoadModule('/src/lib/ollamaProxy.ts');
  const rows = [];
  trials: for (const input of ['honwoyomu.', 'ariga.', 'ashitanoyottei.']) {
    for (const level of ['none', 'word', 'sentence']) {
      const calls = [];
      const transport = { ...defaultOllamaTransport, async generate(...args) {
        const started = performance.now();
        const call = { system: args[2].system, prompt: args[2].prompt };
        calls.push(call);
        try { call.response = await defaultOllamaTransport.generate(...args); return call.response; }
        catch (error) { call.error = String(error); throw error; }
        finally { call.elapsedMs = performance.now() - started; }
      } };
      const row = { input, level, model: 'gemma4:latest', calls };
      try { row.result = await convertRomajiToJapaneseDetailed(input, { ...defaultSettings, modelName: 'gemma4:latest', inputCompletionLevel: level }, transport); }
      catch (error) { row.error = String(error); }
      rows.push(row);
      await writeFile(join(out, 'candidate-audit-2026-10-16.json'), JSON.stringify(rows, null, 2));
      console.log(JSON.stringify({ input, level, result: row.result, error: row.error, calls: calls.length }));
      if (row.error) { process.exitCode = 1; break trials; }
    }
  }
} finally { await vite.close(); }
