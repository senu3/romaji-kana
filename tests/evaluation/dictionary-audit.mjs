import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { artifactPath, projectRoot } from '../helpers/artifacts.mjs';
import { createKanaEngineClient } from '../../tools/kana-engine-client.mjs';

// Characterization audit, not a golden baseline. --live measures local Ollama.
const live = process.argv.includes('--live');
const out = artifactPath(`evaluation/dictionary-audit-${Date.now()}`);
await mkdir(out, { recursive: true });
console.log(out);
const server = await createServer({ configFile: false, root: projectRoot, esbuild: { jsx: 'automatic' },
  cacheDir: artifactPath('cache/dictionary-audit'), server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
const engine = createKanaEngineClient();
const report = { live, extractions: [], trials: [] };
try {
  const load = file => server.ssrLoadModule(resolve(projectRoot, file).replaceAll('\\', '/'));
  const { buildDocumentVocabularyProfile: profile } = await load('src/lib/documentVocabulary.ts');
  for (const text of ['取り扱いを見直す。申し込みを受け付ける。', '東京都千代田区丸の内。株式会社試験社。', 'koukainotokida koukainotokida', '```ts\nconst SecretProduct = 1;', '要件定義と基本設計。OpenAIを利用。']) {
    report.extractions.push({ text, ...profile(text) });
  }
  const { DictionaryModal } = await load('src/components/DictionaryModal.tsx');
  const markup = renderToStaticMarkup(createElement(DictionaryModal, {
    documentVocabularyProfile: profile('航海'), useDocumentVocabulary: true,
    onUseDocumentVocabularyChange() {}, personalWords: [], onPersonalWordsChange() {},
  }));
  report.initialPanels = [...markup.matchAll(/id="(dictionary-[^"]+-panel)"/g)].map(m => m[1]);
  const { convertRomajiToJapaneseDetailed: convert } = await load('src/lib/ollama.ts');
  const { defaultSettings } = await load('src/lib/settings.ts');
  const { defaultOllamaTransport } = await load('src/lib/ollamaProxy.ts');
  const kanaEngine = {
    search: (reading, words) => engine.request({ operation: 'search', reading, words: words.filter(w => w.enabled), limit: 24 }),
    verify: async (text, reading, words) => (await engine.request({ operation: 'verify', text, reading, words })).status,
  };
  for (const vocabulary of [[], ['航海'], ['後悔']]) for (let repeat = 0; repeat < (live ? 3 : 1); repeat++) {
    const trial = { vocabulary, repeat }; report.trials.push(trial);
    const transport = { ...defaultOllamaTransport, generate: async (...args) => {
      trial.request = args[2];
      const response = live ? await defaultOllamaTransport.generate(...args) : { response: '{"order":["candidate-0"],"repairNeeded":false}' };
      trial.response = response; return response;
    } };
    const result = await convert('koukainotokida', { ...defaultSettings, modelName: 'gemma4:latest' }, transport,
      { kanaEngine, documentVocabulary: vocabulary, autoRescue: false });
    trial.text = result.text; trial.rerankStatus = result.session?.rerankStatus;
    console.log(vocabulary.join(',') || '(none)', repeat, trial.text, trial.rerankStatus);
  }
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify(report, null, 2));
  engine.close(); await server.close();
}
