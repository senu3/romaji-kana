import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { artifactPath, screenshotPath } from '../helpers/artifacts.mjs';

const server = await createServer({ cacheDir: artifactPath('cache/e2e'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('romaji-kana-settings', JSON.stringify({ autoConvert: false, autoSuggest: false, conversionMode: 'ghost' }));
  });
  const page = await context.newPage();
  await page.route('**/api/tags', route => route.fulfill({ json: { models: [{ name: 'gemma3' }] } }));
  let expected = '', calls = 0;
  await page.route('**/api/generate', route => {
    const body = route.request().postDataJSON();
    if (body.prompt === 'ok') return route.fulfill({ json: { response: 'ok' } });
    calls++;
    const prompt = JSON.parse(body.prompt);
    const candidate = prompt.candidates.find(c => c.text === expected);
    return route.fulfill({ json: { response: JSON.stringify({ order: candidate ? [candidate.id] : [], repairNeeded: false }) } });
  });
  await page.goto(server.resolvedUrls.local[0]);
  const editor = page.locator('.cm-content');
  const ghost = page.locator('.cm-ghost-text-suggestion');
  const documentText = () => editor.innerText();
  async function enter(input) {
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(input);
    await page.keyboard.press('Control+Enter');
  }
  for (const [input, output] of [
    ['PSDfairu', 'PSDファイル'],
    ['PSD ha nai', 'PSDはない'],
    [String.raw`docs\Sample.psd wo hiraku.`, String.raw`docs\Sample.psdを開く。`],
    ['`docs\\Sample\\`wohiraku.', 'docs\\Sample\\を開く。'],
    ['PSDfariu', 'PSDファイル'],
  ]) {
    expected = output;
    await enter(input);
    await page.waitForFunction(text => document.querySelector('.cm-ghost-text-suggestion')?.textContent === text, output);
    await page.keyboard.press('Alt+Enter');
    assert.equal(await documentText(), output, input);
    assert.equal(await ghost.count(), 0);
    console.log('converted', JSON.stringify(input), '=>', JSON.stringify(output));
  }
  for (const input of ['ASHITA', 'PSD', String.raw`docs\Sample.psd`]) {
    const before = calls;
    await enter(input);
    await page.waitForTimeout(250);
    assert.equal(await documentText(), input);
    assert.equal(await ghost.count(), 0);
    assert.equal(calls, before, 'Fixed-only input must not request generation');
  }
  // A selection that cuts through an automatically protected path must not convert its tail.
  const input = String.raw`docs\Sample.psd wo hiraku.`;
  await editor.click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(input);
  await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+Shift+End');
  const before = calls;
  await page.keyboard.press('Control+Enter'); await page.waitForTimeout(250);
  assert.equal(calls, before);
  assert.equal(await documentText(), input);
  await page.screenshot({ path: await screenshotPath('test-results/e2e/input-protection.png') });
  await context.close();
  console.log('input protection E2E passed (real dictionary, simulated model ranking)');
} finally { await browser?.close(); await server.close(); }
