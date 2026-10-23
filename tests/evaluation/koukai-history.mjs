import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { artifactPath, projectRoot as root } from '../helpers/artifacts.mjs';
import { createKanaEngineClient } from '../../tools/kana-engine-client.mjs';
import { EditorState } from '@codemirror/state';

// node tests/evaluation/koukai-history.mjs [--live]
// Default: capture requests/ranges with a synthetic ranking, not an accuracy test.
// --live: compare three trials per case against local Ollama gemma4:latest.
// Uses default settings and no persisted learning; does not replay editor timing.
const live = process.argv.includes('--live');
const refs = ['2eaed44976051e63af648f5431ca5745c46ee4e6', 'fd7a0a1^', 'fd7a0a112574c6ee52be68340b460eecf7234289', 'HEAD'];
const cases = [
  { id: 'context', input: 'koukainotokida', options: { contextBefore: 'さあ船出の時だ、' } },
  { id: 'whole', input: 'さあ船出の時だ、koukainotokida', options: {} },
  { id: 'without-context', input: 'koukainotokida', options: {} },
];
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const hash = s => createHash('sha256').update(s).digest('hex');
const out = artifactPath('evaluation/koukai-history-' + Date.now());
await mkdir(out, { recursive: true });
const snapshots = [];
for (const ref of refs) {
  const sha = git('rev-parse', ref), dir = resolve(out, sha);
  await mkdir(dir, { recursive: true });
  for (const file of git('ls-tree', '-r', '--name-only', sha, 'src/lib').split('\n').filter(f => f.endsWith('.ts'))) {
    const target = resolve(dir, file.slice(8));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, git('show', sha + ':' + file));
  }
  snapshots.push({ ref, sha, dir });
}
console.log(out);
const metadata = { live, snapshots, cases, model: 'gemma4:latest', sharedEngineTree: git('rev-parse', 'HEAD:src-engine'), engineTrees: refs.map(ref => [ref, git('rev-parse', ref + ':src-engine')]) };
if (metadata.engineTrees.some(([, tree]) => tree !== metadata.sharedEngineTree)) throw Error('Engine trees differ: build each revision separately before comparing');
const vite = await createServer({ root, configFile: false, cacheDir: artifactPath('cache/koukai-history'), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
const engine = createKanaEngineClient();
const all = [];
try {
  metadata.ranges = [];
  const doc = 'さあ船出の時だ、koukainotokida';
  for (const snapshot of snapshots) {
    const load = f => vite.ssrLoadModule(resolve(snapshot.dir, f).replaceAll('\\', '/'));
    const { extractSelectedConversionRange } = await load('conversion.ts');
    const { retainedConversionRange, unconvertedRanges, rememberUnconvertedRange } = await load('unconvertedRanges.ts');
    const state = EditorState.create({ doc, extensions: [unconvertedRanges] });
    const remembered = state.update({ effects: rememberUnconvertedRange.of({ from: 0, to: doc.length }) }).state;
    for (const [operation, range] of [
      ['typing', retainedConversionRange(state, doc.length, 'typing')],
      ['shortcut', retainedConversionRange(state, doc.length, 'shortcut')],
      ['remembered-whole-shortcut', retainedConversionRange(remembered, doc.length, 'shortcut')],
      ['select-whole', extractSelectedConversionRange(doc, 0, doc.length, 'shortcut')],
    ]) metadata.ranges.push({ ref: snapshot.ref, operation, range, contextBefore: range ? doc.slice(Math.max(0, range.from - 1200), range.from) : null });
  }
  if (live) {
    metadata.models = await (await fetch('http://localhost:11434/api/tags')).json();
    const warm = await fetch('http://localhost:11434/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: metadata.model, prompt: 'Reply OK.', stream: false, think: false, options: { num_predict: 8 } }), signal: AbortSignal.timeout(120000) });
    if (!warm.ok) throw Error('Warmup failed');
    await warm.text();
  }
  await writeFile(resolve(out, 'manifest.json'), JSON.stringify(metadata, null, 2));
  // Interleave versions for each repeated case, avoiding a version-only time block.
  for (let repeat = 1; repeat <= (live ? 3 : 1); repeat++) for (const c of cases) for (const snapshot of (repeat % 2 ? snapshots : [...snapshots].reverse())) {
    const load = f => vite.ssrLoadModule(resolve(snapshot.dir, f).replaceAll('\\', '/'));
    const { convertRomajiToJapaneseDetailed: convert } = await load('ollama.ts');
    const { defaultSettings } = await load('settings.ts');
    const { defaultOllamaTransport: transport } = await load('ollamaProxy.ts');
    const row = { ref: snapshot.ref, sha: snapshot.sha, caseId: c.id, repeat, calls: [], searches: [] };
    const kanaEngine = { search: async (reading, words) => {
      const result = await engine.request({ operation: 'search', reading, words: words.filter(w => w.enabled), limit: 24 });
      row.searches.push({ reading, result }); return result;
    }, verify: async (text, reading, words) => (await engine.request({ operation: 'verify', text, reading, words: words.filter(w => w.enabled) })).status };
    const observed = { ...transport, generate: async (provider, url, body, timeout, signal) => {
      const call = { request: body, requestHash: hash(JSON.stringify(body)), timeout };
      row.calls.push(call);
      if (!live) {
        const candidates = JSON.parse(body.prompt).candidates;
        const candidate = candidates.find(p => p.text.endsWith('航海の時だ')) ?? candidates[0];
        return call.response = { response: JSON.stringify({ order: [candidate.id], repairNeeded: false }) };
      }
      try { return call.response = await transport.generate(provider, url, body, timeout, signal); }
      catch (error) { call.error = String(error); throw error; }
    } };
    const started = performance.now();
    try { row.result = await convert(c.input, { ...structuredClone(defaultSettings), modelName: metadata.model }, observed, { ...c.options, kanaEngine, autoRescue: false }); }
    catch (error) { row.error = String(error); }
    row.elapsedMs = performance.now() - started;
    all.push(row);
    await appendFile(resolve(out, 'trials.jsonl'), JSON.stringify(row) + '\n');
    console.log(snapshot.ref.slice(0, 8), c.id, repeat, row.result?.text ?? row.error, row.result?.session?.rerankStatus, row.calls[0]?.requestHash.slice(0, 12));
    if (row.error || row.calls.some(call => call.error)) throw Error('Conversion or transport failure; inspect trials.jsonl');
  }
  const groups = [];
  for (const snapshot of snapshots) for (const c of cases) {
    const rows = all.filter(r => r.sha === snapshot.sha && r.caseId === c.id);
    groups.push({ ref: snapshot.ref, caseId: c.id, trials: rows.length,
      outputs: rows.map(r => r.result?.text ?? r.error), requestHashes: [...new Set(rows.flatMap(r => r.calls.map(c => c.requestHash)))],
      rankingStates: rows.map(r => r.result?.session?.rerankStatus) });
  }
  await writeFile(resolve(out, 'summary.json'), JSON.stringify({ live, groups, ranges: metadata.ranges }, null, 2));
} finally { engine.close(); await vite.close(); }
