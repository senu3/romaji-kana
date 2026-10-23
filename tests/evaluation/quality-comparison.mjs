import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { createServer } from 'vite';
import { artifactPath, resolveArtifactPath, projectRoot as root } from '../helpers/artifacts.mjs';
import { createKanaEngineClient } from '../../tools/kana-engine-client.mjs';
import { variantSource, augmentSpeculation } from './quality-comparison-variants.mjs';

const { values: args } = parseArgs({ options: {
  model: { type: 'string', default: 'gemma4:latest' }, out: { type: 'string' },
  case: { type: 'string' }, repeats: { type: 'string' }, 'dry-run': { type: 'boolean' },
} });
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const hash = s => createHash('sha256').update(s).digest('hex');
const raw = await readFile(resolve(root, 'tests/evaluation/quality-comparison.json'), 'utf8');
const data = JSON.parse(raw);
const repeats = Number(args.repeats ?? data.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw Error('Invalid repeats');
const cases = data.cases.filter(c => !args.case || args.case.split(',').includes(c.id));
if (!cases.length || (args.case && args.case.split(',').some(id => !cases.some(c => c.id === id)))) throw Error('Unknown case');
const out = args.out ? resolveArtifactPath(args.out) : artifactPath('evaluation/comparison-' + Date.now());
await mkdir(dirname(out), { recursive: true });
await mkdir(out);
const baseline = git('rev-parse', data.baselineRef);
const files = git('ls-tree', '-r', '--name-only', baseline, 'src/lib').split('\n').filter(f => f.endsWith('.ts'));
const arms = [...new Set(cases.flatMap(c => data.arms[c.group]))];
const snapshots = {};
for (const arm of arms) {
  const dir = resolve(out, 'snapshots', arm);
  await mkdir(dir, { recursive: true });
  snapshots[arm] = {};
  for (const file of files) {
    const name = file.slice('src/lib/'.length);
    const source = variantSource(name, git('show', baseline + ':' + file), arm);
    await mkdir(dirname(resolve(dir, name)), { recursive: true });
    await writeFile(resolve(dir, name), source);
    snapshots[arm][name] = hash(source);
  }
}
let state = data.seed;
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
const schedule = [];
for (let repeat = 1; repeat <= repeats; repeat++) for (const c of cases) {
  const order = [...data.arms[c.group]];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  schedule.push(...order.map(arm => ({ caseId: c.id, group: c.group, repeat, arm })));
}
const manifest = { baseline, gitSha: git('rev-parse', 'HEAD'), gitStatus: git('status', '--porcelain'),
  datasetHash: hash(raw), data, schedule, snapshots, model: args.model,
  createdAt: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model,
  scope: 'Exploratory quality evaluation with 60s per model call and 180s total; production deadline exceedance recorded separately. No production latency claim.',
  dictionary: JSON.parse(await readFile(resolve(root, 'src-engine/data/manifest.json'), 'utf8')) };
await writeFile(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(out, schedule.length, 'trials');
if (args['dry-run']) process.exit(0);
const vite = await createServer({ root, configFile: false, cacheDir: artifactPath('cache/comparison'), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
const engine = createKanaEngineClient();
const load = (arm, file) => vite.ssrLoadModule(resolve(out, 'snapshots', arm, file).replaceAll('\\', '/'));
try {
  manifest.tags = await (await fetch('http://localhost:11434/api/tags')).json();
  manifest.server = await (await fetch('http://localhost:11434/api/version')).json();
  const start = performance.now();
  const warm = await fetch('http://localhost:11434/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: args.model, prompt: 'Reply OK.', stream: false, think: false, keep_alive: '30m', options: { num_predict: 8 } }), signal: AbortSignal.timeout(120000) });
  if (!warm.ok) throw Error('Warmup HTTP ' + warm.status);
  manifest.warmup = { response: await warm.json(), elapsedMs: performance.now() - start };
  await writeFile(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const job of schedule) {
    const c = cases.find(c => c.id === job.caseId && c.group === job.group);
    const { defaultSettings } = await load(job.arm, 'settings.ts');
    const { convertRomajiToJapaneseDetailed: convert } = await load(job.arm, 'ollama.ts');
    const { defaultOllamaTransport: base } = await load(job.arm, 'ollamaProxy.ts');
    const row = { ...job, input: c.input, calls: [], engineCalls: 0, missingLetterSearches: [] };
    const transport = { ...base, generate: async (provider, url, request, timeout, signal) => {
      const body = c.group === 'speculation' ? augmentSpeculation(request, job.arm, c.input, c.options ?? {}) : request;
      const record = { request: body, productionTimeoutMs: timeout };
      row.calls.push(record);
      const started = performance.now();
      try { return record.response = await base.generate(provider, url, body, 60000, signal); }
      catch (error) { record.error = String(error); throw error; }
      finally { record.elapsedMs = performance.now() - started; record.exceededProductionDeadline = record.elapsedMs > timeout; }
    } };
    const kanaEngine = {
      search: (reading, words) => { row.engineCalls++; return engine.request({ operation: 'search', reading, words: words.filter(w => w.enabled), limit: job.arm === 'pool32' ? 32 : 24 }); },
      verify: async (text, reading, words) => (await engine.request({ operation: 'verify', text, reading, words: words.filter(w => w.enabled) })).status,
    };
    const started = performance.now();
    try {
      row.result = await convert(c.input, { ...structuredClone(defaultSettings), ...c.settingsOverrides, modelName: args.model, useDocumentVocabulary: Boolean(c.options?.documentVocabulary?.length) }, transport,
        { ...c.options, kanaEngine, rerank: true, autoRescue: true, timeoutMs: 180000, onMissingLetterSearch: m => row.missingLetterSearches.push(m) });
      row.outcome = row.result.suggestionRejected ? 'rejected' : row.result.text?.trim() ? 'candidate' : 'empty';
    } catch (error) { row.outcome = 'error'; row.error = String(error); row.diagnostic = error.diagnostic; }
    row.elapsedMs = performance.now() - started;
    row.exactMatch = c.acceptableExamples.length ? c.acceptableExamples.includes(row.result?.text) : null;
    row.poolMatch = c.acceptableExamples.length ? Boolean(row.result?.session?.candidates.some(p => c.acceptableExamples.includes(p.result.text))) : null;
    await appendFile(resolve(out, 'trials.jsonl'), JSON.stringify(row) + '\n');
    console.log(job.group, job.caseId, job.repeat, job.arm, row.outcome, JSON.stringify(row.result?.text), Math.round(row.elapsedMs));
    // Do not queue another generation after a transport timeout; it can remain active server-side.
    if (row.calls.some(call => call.error)) throw Error('Stopped after transport failure; partial results preserved');
  }
} finally { engine.close(); await vite.close(); }
