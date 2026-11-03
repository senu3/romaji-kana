import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { artifactPath, screenshotPath } from '../helpers/artifacts.mjs';

const server = await createServer({ cacheDir: artifactPath('cache/e2e-speculation'), server: { host: '127.0.0.1', port: 0 } });
let browser;
const input = 'annwoonegasimasu';
const responses = [
  { convertedText: '案をお願いします', completedKana: 'あんをおねがいします' },
  { convertedText: '企画案をお願いします', completedKana: 'きかくあんをおねがいします' },
  { convertedText: '案をお願いします。', completedKana: 'あんをおねがいします。' },
];
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  async function scenario(run, candidates = responses, options = {}) {
    const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('romaji-kana-settings', JSON.stringify({ autoConvert: false, autoSuggest: true, conversionMode: 'ghost' }));
      localStorage.setItem('romaji-kana-document-session', JSON.stringify({ kind: 'new', content: '' }));
    });
    const page = await context.newPage(), errors = [], speculativeRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/tags', route => route.fulfill({ json: { models: [{ name: 'gemma3' }] } }));
    await page.route('**/api/generate', route => {
      const body = route.request().postDataJSON();
      if (body.format?.properties?.candidates) { speculativeRequests.push(body); return route.fulfill({ json: { response: JSON.stringify({ candidates }) } }); }
      return route.fulfill({ json: { response: JSON.stringify({ order: ['candidate-0'] }) } });
    });
    await page.route('**/api/kana-engine', route => {
      const body = route.request().postDataJSON();
      if (body.operation === 'verify') return route.fulfill({ json: { status: 'verified' } });
      if (body.operation === 'suggest') return route.fulfill({ json: { candidates: [{ text: '案内', reading: 'あんない', cost: 0, source: 'mozc' }] } });
      const text = '餡をおねがします', reading = body.reading;
      const spellings = Array.from({ length: options.manyCandidates ? 20 : 1 }, (_, index) => {
        const spelling = text + '案'.repeat(index);
        return { text: spelling, reading, cost: index, tokens: [{ text: spelling, reading, from: 0, to: reading.length, source: 'mozc', entryId: `test-${index}`, lid: 0, rid: 0, wordCost: index }] };
      });
      return route.fulfill({ json: { candidates: spellings, dictionaryRevision: 'test', truncated: false } });
    });
    try {
      await page.goto(server.resolvedUrls.local[0]);
      const editor = page.locator('.cm-content'); await editor.click(); await page.keyboard.type(input);
      assert.equal(speculativeRequests.length, 0, 'Typing does not launch speculation');
      await page.keyboard.press('Control+Enter');
      await page.locator('.cm-inline-candidate').waitFor();
      await page.getByRole('button', { name: 'ほかの候補', exact: true }).first().click();
      if (options.manyCandidates) {
        const list = page.getByRole('dialog', { name: 'ほかの候補', exact: true });
        const footerButton = list.getByRole('button', { name: '読みも含めて見直す', exact: true });
        const scrollArea = list.locator('.candidate-alternatives');
        await list.waitFor();
        assert.equal(await list.locator('.candidate-list-options button').count(), 20, 'All candidates remain available');
        assert.ok(await scrollArea.evaluate(el => el.scrollHeight > el.clientHeight), 'Long candidate lists scroll');
        const before = await footerButton.boundingBox();
        const panel = await list.boundingBox();
        assert.ok(before.y >= panel.y && before.y + before.height <= panel.y + panel.height, 'Speculation is visible before scrolling');
        await scrollArea.evaluate(el => { el.scrollTop = el.scrollHeight; });
        const after = await footerButton.boundingBox();
        assert.ok(Math.abs(before.y - after.y) <= 1, 'Footer stays in place while candidates scroll');
        await list.locator('.candidate-list-options button').first().focus();
        await page.keyboard.press('End');
        const last = await list.locator('.candidate-list-options button').last().boundingBox();
        assert.ok(last.y + last.height <= after.y + 1, 'Keyboard navigation reveals the last candidate above the footer');
        await page.keyboard.press('Tab');
        assert.equal(await footerButton.evaluate(el => el === document.activeElement), true, 'Footer follows the candidate list in tab order');
        await page.screenshot({ path: await screenshotPath(`test-results/e2e/candidate-footer-${options.viewport ? 'mobile' : 'desktop'}.png`) });
      }
      await page.getByRole('button', { name: '読みも含めて見直す' }).click();
      if (candidates.length) await page.getByRole('group', { name: '推測候補', exact: true }).waitFor();
      else await page.getByText('意図に合う推測候補を作れませんでした。本文は変更していません。').waitFor();
      assert.equal(speculativeRequests.length, 1);
      assert.ok(speculativeRequests[0].prompt.includes(input));
      await run(page, editor);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  for (const viewport of [undefined, { width: 390, height: 600 }]) {
    await scenario(async (page, editor) => {
      assert.equal(await editor.innerText(), input, 'Opening speculation does not commit text');
      await page.keyboard.press('Escape');
    }, responses, { manyCandidates: true, viewport });
  }
  await scenario(async (page, editor) => {
    const menu = page.getByRole('group', { name: '推測候補', exact: true });
    assert.equal(await editor.innerText(), input);
    assert.equal(await menu.locator(':scope > button').count(), 2, 'Duplicate interpretations are removed');
    assert.equal(await menu.locator('[aria-pressed="true"]').count(), 0);
    assert.equal(await page.getByRole('group', { name: '補完候補', exact: true }).count(), 0);
    assert.equal(await page.locator('.cm-speculation-source').innerText(), input);
    assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0);
    await page.screenshot({ path: await screenshotPath('test-results/e2e/speculation-desktop.png') });
    await page.keyboard.press('Tab'); await page.keyboard.press('ArrowDown');
    assert.equal(await menu.locator('[aria-pressed="true"]').innerText(), '企画案をお願いします');
    await page.keyboard.press('Enter');
    assert.equal(await editor.innerText(), '企画案をお願いします');
    assert.equal(await menu.count(), 0);
    await page.keyboard.press('Control+/');
    await menu.waitFor();
    assert.equal(await menu.locator(':scope > button').count(), 2, 'Reopened speculation keeps alternatives with different readings');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z'); assert.equal(await editor.innerText(), input);
  });
  await scenario(async (page, editor) => {
    await page.keyboard.press('Enter');
    assert.equal(await editor.textContent(), input);
    assert.equal(await editor.locator('.cm-line').count(), 2, 'Unselected Enter inserts a newline, not a candidate');
    assert.equal(await page.locator('.speculation-suggestions').count(), 0);
  });
  await scenario(async (page, editor) => {
    await page.keyboard.press('Escape'); assert.equal(await editor.innerText(), input);
    assert.equal(await page.locator('.speculation-suggestions').count(), 0);
  });
  await scenario(async (page, editor) => {
    await page.getByRole('button', { name: '企画案をお願いします を採用', exact: true }).click();
    assert.equal(await editor.innerText(), '企画案をお願いします');
  });
  await scenario(async (page, editor) => {
    await page.keyboard.type('x'); assert.equal(await editor.innerText(), input + 'x');
    assert.equal(await page.locator('.speculation-suggestions').count(), 0);
  });
  await scenario(async (page, editor) => {
    await editor.dispatchEvent('compositionstart', { data: '' });
    assert.equal(await page.locator('.speculation-suggestions').count(), 0);
    assert.equal(await editor.innerText(), input);
  });
  await scenario(async (page, editor) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: await screenshotPath('test-results/e2e/speculation-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const rect = await page.locator('.speculation-suggestions').boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 390);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: await screenshotPath('test-results/e2e/speculation-dark.png') });
    await page.getByText('置き換える範囲と読み', { exact: true }).click();
    await page.getByRole('button', { name: '推測候補を閉じる', exact: true }).click();
    assert.equal(await editor.innerText(), input);
  });
  await scenario(async (_page, editor) => { assert.equal(await editor.innerText(), input); }, []);
  await scenario(async (page, editor) => {
    await page.setViewportSize({ width: 390, height: 600 });
    const button = page.locator('.speculation-suggestions > button').first();
    assert.ok((await button.boundingBox()).height > 48, 'Long sentences wrap instead of truncating');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: await screenshotPath('test-results/e2e/speculation-long.png') });
    await page.keyboard.press('Escape'); assert.equal(await editor.innerText(), input);
  }, [{ convertedText: '次の企画についての案をいくつかお願いします', completedKana: 'つぎのきかくについてのあんをいくつかおねがいします' }]);
  console.log('Speculation menu: keyboard, click, undo, dismissal, IME, mobile, empty and explicit generation passed.');
} finally { await browser?.close(); await server.close(); }
