// Minimal current-production quality evaluation. Review meaning, not exact strings.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { createKanaEngineClient } from '../../tools/kana-engine-client.mjs';
import { artifactPath, resolveArtifactPath, projectRoot } from '../helpers/artifacts.mjs';
import { summarizeIntentReview } from './intent-smoke-review.mjs';

const { values: args } = parseArgs({ options: {
  model: { type: 'string', default: 'gemma4:latest' }, out: { type: 'string' },
  review: { type: 'string' }, 'dry-run': { type: 'boolean' },
} });
if (args.review) {
  const report = summarizeIntentReview(JSON.parse(await readFile(resolveArtifactPath(args.review), 'utf8')));
  console.log(JSON.stringify(report, null, 2));
  if (report.errors || report.usefulAny < report.total) process.exitCode = 1;
} else {
  const dataset = JSON.parse(await readFile(new URL('./intent-experiment.json', import.meta.url), 'utf8'));
  const ids = ['request-i', 'request-context', 'multiple-omissions', 'word-omission', 'clean-control', 'negative-control', 'literal-control', 'unrelated-context'];
  const cases = ids.map(id => { const c = dataset.cases.find(c => c.id === id); if (!c) throw Error('Missing case ' + id); return c; });
  const out = args.out ? resolveArtifactPath(args.out) : artifactPath('evaluation/intent-smoke-' + Date.now());
  await mkdir(out, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: projectRoot, encoding: 'utf8' }).trim();
  const report = { version: 1, dryRun: Boolean(args['dry-run']), createdAt: new Date().toISOString(),
    gitSha: git('rev-parse', 'HEAD'), gitStatus: git('status', '--porcelain'), model: args.model,
    reviewer: '', rubric: { 0: '意図を失う・創作・実用にならない', 1: '大まかに有用だが語句の調整が必要', 2: '意図に合う。表記・敬語・句読点の違いは許容' }, rows: [] };
  // Refuse to overwrite a previous run or its human review.
  const path = out + '/review.json';
  await writeFile(path, JSON.stringify(report, null, 2), { flag: 'wx' });
  const vite = await createServer({ root: projectRoot, configFile: false, cacheDir: artifactPath('cache/intent-smoke'),
    optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
  const engine = createKanaEngineClient();
  try {
    const { defaultSettings } = await vite.ssrLoadModule('/src/lib/settings.ts');
    const { convertRomajiToJapaneseDetailed: convert } = await vite.ssrLoadModule('/src/lib/ollama.ts');
    const { defaultOllamaTransport } = await vite.ssrLoadModule('/src/lib/ollamaProxy.ts');
    report.settings = { ...defaultSettings, modelName: args.model };
    for (const c of cases) {
      const row = { ...c, candidates: [], requests: [] }, started = performance.now();
      try {
        const transport = { ...defaultOllamaTransport, generate: async (provider, url, request, ...rest) => {
          row.requests.push(request);
          if (args['dry-run']) return { response: '{"candidates":[]}' };
          return defaultOllamaTransport.generate(provider, url, request, ...rest);
        } };
        const result = await convert(c.input, report.settings, transport, {
          userRequestedSpeculation: true, speculationCandidates: true,
          contextBefore: c.before ?? '', contextAfter: c.after ?? '',
          kanaEngine: { search: () => { throw Error('Unexpected dictionary search'); },
            verify: async (text, reading, words) => (await engine.request({ operation: 'verify', text, reading, words })).status },
        });
        row.result = result;
        row.candidates = (result.session?.candidates ?? []).map(candidate => ({ text: candidate.result.text, score: null, note: '' }));
      } catch (error) { row.error = String(error); process.exitCode = 1; }
      row.elapsedMs = Math.round(performance.now() - started);
      report.rows.push(row);
      console.log(c.id, row.error ?? (row.candidates.map(c => c.text).join(' / ') || '(候補なし)'));
      await writeFile(path, JSON.stringify(report, null, 2));
    }
    report.complete = true;
    await writeFile(path, JSON.stringify(report, null, 2));
    console.log('Review:', path);
  } finally { engine.close(); await vite.close(); }
}
