import { createServer } from 'vite';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactPath, projectRoot } from '../../helpers/artifacts.mjs';

await mkdir(artifactPath('evaluation/audits'), { recursive: true });
const out = await mkdtemp(artifactPath('evaluation/audits/reading-policy-audit-'));
console.log(`Output: ${out}`);
const vite = await createServer({ root: projectRoot, cacheDir: artifactPath('cache/audits'), configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
try {
  const { defaultSettings } = await vite.ssrLoadModule('/tests/evaluation/legacy/settings.ts');
  const { convertRomajiToJapaneseDetailed } = await vite.ssrLoadModule('/tests/evaluation/legacy/ollama.ts');
  const { requiresExplicitAcceptance } = await vite.ssrLoadModule('/tests/evaluation/legacy/readingAssessment.ts');
  const { defaultOllamaTransport } = await vite.ssrLoadModule('/src/lib/ollamaProxy.ts');
  const cases = [
    { input: 'honwoyomu.', level: 'none' }, { input: 'ariga.', level: 'word' },
    { input: 'shoruinokakuni.', level: 'word' }, { input: 'yomima.', level: 'word' },
    { input: 'ikimase.', level: 'word' }, { input: 'yomi.', level: 'word' },
    { input: 'ashita10jiniikanai.', level: 'word' }, { input: '10jidesu.', level: 'none' },
  ];
  const rows = [];
  for (const test of cases) {
    const calls = [];
    const transport = { ...defaultOllamaTransport, async generate(...args) {
      const call = { system: args[2].system, prompt: args[2].prompt }; calls.push(call);
      try { call.response = await defaultOllamaTransport.generate(...args); return call.response; }
      catch (error) { call.error = String(error); throw error; }
    } };
    const row = { ...test, model: 'gemma4:latest', calls };
    try {
      row.result = await convertRomajiToJapaneseDetailed(test.input, { ...defaultSettings, modelName: row.model, inputCompletionLevel: test.level }, transport);
      row.explicitAcceptance = requiresExplicitAcceptance(row.result);
    } catch (error) { row.error = String(error); }
    rows.push(row);
    await writeFile(join(out, 'reading-policy-audit-2026-10-17.json'), JSON.stringify(rows, null, 2));
    console.log(JSON.stringify({ ...test, result: row.result, explicitAcceptance: row.explicitAcceptance, calls: calls.length, error: row.error }));
    if (row.error) { process.exitCode = 1; break; }
  }
} finally { await vite.close(); }
