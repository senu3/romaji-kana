import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { artifactPath } from '../helpers/artifacts.mjs';

const server = await createServer({ cacheDir: artifactPath('cache/e2e-live-kana'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  async function scenario(settings, run) {
    const context = await browser.newContext();
    await context.addInitScript(settings => {
      localStorage.setItem('romaji-kana-settings', JSON.stringify(settings));
      localStorage.setItem('romaji-kana-document-session', JSON.stringify({ kind: 'new', content: '' }));
    }, settings);
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/tags', route => route.abort());
    await page.route('**/api/generate', route => route.abort());
    await page.route('**/api/kana-engine', route => {
      const body = route.request().postDataJSON(); requests.push(body);
      if (body.operation === 'suggest') return route.fulfill({ json: { candidates: body.reading === 'こうか'
        ? [{ text: '航海', reading: 'こうかい', cost: 0, source: 'mozc' }] : [] } });
      const reading = body.reading;
      const text = ({ 'ほん': '本', 'ほんとう': '本当', 'かな': '仮名', 'こうか': '効果' })[reading] ?? reading;
      return route.fulfill({ json: { candidates: [{ text, reading, cost: 0, tokens: [{ text, reading, from: 0, to: reading.length, source: 'mozc', entryId: 'test', lid: 0, rid: 0, wordCost: 0 }] }], dictionaryRevision: 'test', truncated: false } });
    });
    try {
      await page.goto(server.resolvedUrls.local[0]);
      const editor = page.locator('.cm-content');
      await editor.click();
      await run(page, editor, requests);
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error({ errors, requests: requests.slice(-5), screen: await page.locator('body').innerText() });
      throw error;
    } finally { await context.close(); }
  }
  await scenario({ autoConvert: false, autoSuggest: false }, async (page, editor) => {
    await page.keyboard.type('konnichiha');
    assert.equal(await editor.innerText(), 'こんにちは');
    await page.keyboard.type('k');
    assert.equal(await editor.innerText(), 'こんにちはk');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('kyou');
    assert.equal(await editor.innerText(), 'こんにちはきょう');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('https://example.com');
    assert.equal(await editor.innerText(), 'https://example.com');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('`kana`');
    assert.equal(await editor.innerText(), '`kana`');
  });
  await scenario({ autoSuggest: false }, async (page, editor, requests) => {
    await page.keyboard.type('hon');
    await page.locator('.live-spelling-preview').filter({ hasText: /^本$/u }).waitFor();
    const placement = await editor.evaluate(el => {
      const view = el.cmTile.root.view;
      const start = view.coordsAtPos(0);
      const panel = view.dom.querySelector('.live-spelling-preview').getBoundingClientRect();
      return { gap: panel.top - start.bottom, offset: panel.left - start.left, left: panel.left, top: panel.top };
    });
    assert.ok(placement.gap >= 0 && placement.gap <= 10 && Math.abs(placement.offset) <= 2);
    assert.equal(await editor.innerText(), 'ほん');
    await page.keyboard.type('t');
    const panel = page.locator('.live-spelling-preview');
    assert.ok(await panel.isVisible());
    assert.equal(await panel.textContent(), '本');
    await page.keyboard.type('ou');
    assert.ok(await panel.isVisible());
    assert.equal(await editor.innerText(), 'ほんとう');
    await page.locator('.live-spelling-preview').filter({ hasText: /^本当$/u }).waitFor();
    const finalPosition = await panel.boundingBox();
    assert.ok(Math.abs(finalPosition.x - placement.left) <= 1 && Math.abs(finalPosition.y - placement.top) <= 1);
    assert.equal(await editor.innerText(), 'ほんとう');
    assert.equal(await editor.evaluate(el => el.cmTile.root.view.state.selection.main.head), 4);
    await page.keyboard.press('ArrowLeft');
    await page.locator('.live-spelling-preview').waitFor({ state: 'hidden' });
    assert.ok(requests.some(request => request.reading === 'ほんとう'));
  });
  await scenario({ autoConvert: false, autoSuggest: false, conversionMode: 'ghost' }, async (page, editor) => {
    await page.unroute('**/api/kana-engine');
    const warmed = await page.request.post(new URL('/api/kana-engine', server.resolvedUrls.local[0]).href, {
      data: { operation: 'search', reading: 'わたし', words: [], limit: 1 },
    });
    assert.ok(warmed.ok(), await warmed.text());
    await page.keyboard.type('watashi');
    assert.equal(await editor.innerText(), 'わたし');
    await page.keyboard.press('Control+Enter');
    await page.locator('.cm-ghost-text-suggestion:visible').waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await editor.innerText(), '私', 'Live kana uses the real local dictionary');
  });
  await scenario({ autoConvert: false, autoSuggest: true }, async (page, editor, requests) => {
    await page.keyboard.type('kana'.repeat(90) + 'kouka');
    await page.locator('.cm-autosuggest-ghost:visible').waitFor();
    await page.keyboard.press('Tab');
    await page.waitForFunction(expected => document.querySelector('.cm-content').textContent === expected, 'かな'.repeat(90) + '航海');
    assert.ok(requests.filter(request => request.operation === 'suggest').every(request => request.reading.length <= 80));
    await page.keyboard.press('Control+z');
    assert.equal(await editor.innerText(), 'かな'.repeat(90) + 'こうか');
  });
  await scenario({ autoConvert: false, autoSuggest: false, conversionMode: 'ghost' }, async (page, editor, requests) => {
    await page.keyboard.type('kana'.repeat(90));
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => !document.querySelector('.cm-conversion-loading'));
    await page.waitForTimeout(700);
    const searches = requests.filter(request => request.operation === 'search');
    assert.ok(searches.length >= 2, 'Long input reaches the engine as bounded segments');
    assert.ok(searches.every(request => request.reading.length <= 160));
    assert.equal(await editor.innerText(), 'かな'.repeat(90));
  });
  await scenario({ autoConvert: false, autoSuggest: true }, async (page, editor) => {
    await page.setViewportSize({ width: 390, height: 720 });
    await page.keyboard.insertText('前'.repeat(12));
    await page.keyboard.type('kouka');
    await page.locator('.live-spelling-preview').filter({ hasText: /^効果$/u }).waitFor();
    await page.locator('.cm-autosuggest-ghost:visible').waitFor();
    await page.waitForFunction(() => {
      const preview = document.querySelector('.live-spelling-preview').getBoundingClientRect();
      const menu = document.querySelector('.cm-autosuggest-ghost').getBoundingClientRect();
      return preview.left >= 0 && preview.right <= innerWidth && preview.bottom <= innerHeight &&
        (preview.top >= menu.bottom || preview.bottom <= menu.top || preview.right <= menu.left || preview.left >= menu.right);
    });
    assert.equal(await editor.innerText(), '前'.repeat(12) + 'こうか');
  });
  console.log('Live kana input and long suggestions passed');
} finally { await browser?.close(); await server.close(); }
