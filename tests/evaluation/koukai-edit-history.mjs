import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { artifactPath, projectRoot } from '../helpers/artifacts.mjs';
import { createKanaEngineClient } from '../../tools/kana-engine-client.mjs';

// Historical browser replay: restore the incomplete phrase and append a.
// Default uses a context-sensitive mock ranker; --live forwards to local Ollama.
// --auto-only waits for the automatic suggestion without pressing Ctrl+Enter.
// --offline rejects model connections; --learned seeds one explicit 後悔 choice.
// Each scenario uses fresh storage, so this does not reproduce personal learning.
const live = process.argv.includes('--live');
const automatic = process.argv.includes('--auto-only');
const offline = process.argv.includes('--offline');
const learned = process.argv.includes('--learned');
assert.ok(!(live && offline), '--live and --offline are mutually exclusive');
const out = artifactPath(`evaluation/koukai-edit-history-${Date.now()}`);
await mkdir(out, { recursive: true });
console.log(out);
const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
const refs = ['2eaed44976051e63af648f5431ca5745c46ee4e6', 'fd7a0a112574c6ee52be68340b460eecf7234289', 'HEAD'];
const engine = createKanaEngineClient();
const browser = await chromium.launch({ headless: true });
const rows = [];
try {
  if (live) {
    const warm = await fetch('http://localhost:11434/api/generate', { method: 'POST',
      body: JSON.stringify({ model: 'gemma4:latest', prompt: 'Reply OK', stream: false, think: false, options: { num_predict: 8 } }),
      signal: AbortSignal.timeout(120000) });
    assert.ok(warm.ok); await warm.text();
  }
  for (const ref of refs) {
    const sha = git('rev-parse', ref);
    assert.equal(git('rev-parse', `${sha}:src-engine`), git('rev-parse', 'HEAD:src-engine'));
    const root = resolve(out, sha);
    await mkdir(root, { recursive: true });
    const archive = execFileSync('git', ['archive', sha, 'src', 'public', 'index.html', 'tsconfig.json', 'tsconfig.node.json'], { cwd: projectRoot });
    execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });
    const server = await createServer({ root, configFile: false, esbuild: { jsx: 'automatic' },
      cacheDir: resolve(root, 'cache'), server: { host: '127.0.0.1', port: 0, fs: { allow: [projectRoot] } } });
    try {
      await server.listen();
      for (const delay of [0, 700]) {
        const row = { sha, delay, live, automatic, offline, learned, requests: [], errors: [] };
        rows.push(row);
        const context = await browser.newContext();
        try {
          await context.addInitScript(learned => {
            localStorage.setItem('romaji-kana-document-session', JSON.stringify({ kind: 'new', content: 'さあ船出の時だ、koukainotokid' }));
            localStorage.setItem('romaji-kana-settings', JSON.stringify({ modelName: 'gemma4:latest', conversionMode: 'ghost', inputPauseTiming: 'early' }));
            if (learned) localStorage.setItem('romaji-kana-conversion-learning-v1', JSON.stringify([
              { reading: 'こうかいのときだ', text: '後悔の時だ', count: 1, updated: Date.now() },
            ]));
          }, learned);
          const page = await context.newPage();
          page.on('pageerror', error => row.errors.push(String(error)));
          await page.route('**/api/tags', route => offline ? route.abort('connectionrefused') : route.fulfill({ json: { models: [{ name: 'gemma4:latest' }] } }));
          await page.route('**/api/kana-engine', async route => {
            try {
              const request = route.request().postDataJSON();
              await route.fulfill({ json: await engine.request(request) });
            } catch (error) { row.errors.push(String(error)); await route.abort().catch(() => {}); }
          });
          await page.route('**/api/generate', async route => {
            const body = route.request().postDataJSON();
            // App startup warm-up is separate from the ranking under test.
            if (body.prompt === 'ok') return offline ? route.abort('connectionrefused') : route.fulfill({ json: { response: 'ok' } });
            const call = { body }; row.requests.push(call);
            if (offline) { call.connectionRefused = true; return route.abort('connectionrefused'); }
            try {
              if (live) {
                const response = await fetch('http://localhost:11434/api/generate', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
                call.response = await response.json();
                await route.fulfill({ status: response.status, json: call.response });
              } else {
                const prompt = JSON.parse(body.prompt);
                const chosen = prompt.candidates.find(c => c.text === '航海の時だ');
                assert.equal(prompt.before, 'さあ船出の時だ、');
                assert.ok(chosen);
                call.response = { response: JSON.stringify({ order: [chosen.id], repairNeeded: false }) };
                await route.fulfill({ json: call.response });
              }
            } catch (error) { row.errors.push(String(error)); await route.abort(); }
          });
          await page.goto(server.resolvedUrls.local[0]);
          const editor = page.locator('.cm-content');
          try { await editor.click(); }
          catch (error) { row.startupText = await page.locator('body').innerText(); throw error; }
          await page.keyboard.press('Control+End');
          if (automatic && delay) await page.waitForTimeout(delay);
          await page.keyboard.type('a');
          if (!automatic) {
            if (delay) await page.waitForTimeout(delay);
            await page.keyboard.press('Control+Enter');
          }
          if (live) await page.waitForTimeout(10000);
          else if (offline) {
            await page.locator('.cm-ghost-text-suggestion').filter({ hasText: learned ? '後悔の時だ' : '公開の時だ' }).waitFor();
            await page.waitForTimeout(1000);
          }
          else await page.locator('.cm-ghost-text-suggestion').filter({ hasText: '航海の時だ' }).waitFor();
          row.visible = await page.locator('.cm-ghost-text-suggestion').allTextContents();
          row.document = await editor.innerText();
          row.screenText = await page.locator('body').innerText();
          assert.ok(row.requests.length, 'Expected at least one ranking request');
          assert.deepEqual(row.errors, []);
          if (!live) assert.deepEqual(row.visible, [offline ? learned ? '後悔の時だ' : '公開の時だ' : '航海の時だ']);
          console.log(sha.slice(0, 8), delay, JSON.stringify(row.visible), row.requests.length);
        } finally { await context.close(); }
        await writeFile(resolve(out, 'results.json'), JSON.stringify(rows, null, 2));
      }
    } finally { await server.close(); }
  }
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify(rows, null, 2));
  engine.close(); await browser.close();
}
