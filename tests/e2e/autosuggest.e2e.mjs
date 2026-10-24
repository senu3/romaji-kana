import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { artifactPath, screenshotPath } from '../helpers/artifacts.mjs';

const server = await createServer({ cacheDir: artifactPath('cache/e2e-autosuggest'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  async function scenario(settings, run) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(settings => {
      localStorage.setItem('romaji-kana-settings', JSON.stringify({ autoConvert: false, autoSuggest: true, ...settings }));
      localStorage.setItem('romaji-kana-document-session', JSON.stringify({ kind: 'new', content: '' }));
    }, settings);
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/tags', route => route.abort('connectionrefused'));
    let llmCalls = 0;
    await page.route('**/api/generate', route => { llmCalls++; return route.abort('connectionrefused'); });
    await page.route('**/api/kana-engine', route => {
      const body = route.request().postDataJSON(); requests.push(body);
      if (body.operation === 'suggest') return route.fulfill({ json: { candidates: [
        { text: '航海', reading: 'こうかい', cost: 0, source: 'mozc' },
        { text: '公開', reading: 'こうかい', cost: 100, source: 'mozc' },
      ] } });
      const reading = body.reading;
      return route.fulfill({ json: { candidates: [{ text: '効果', reading, cost: 0, tokens: [{ text: '効果', reading, from: 0, to: reading.length, source: 'mozc', entryId: 'test', lid: 0, rid: 0, wordCost: 0 }] }], dictionaryRevision: 'test', truncated: false } });
    });
    try {
      await page.goto(server.resolvedUrls.local[0]);
      const editor = page.locator('.cm-content');
      await editor.click();
      await run(page, editor, requests, () => llmCalls);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  await scenario({}, async (page, editor, requests, calls) => {
    const before = calls();
    await page.keyboard.type('kouka');
    await page.getByRole('group', { name: '補完候補', exact: true }).waitFor();
    assert.equal(await page.locator('.word-suggestions [aria-pressed="true"]').count(), 0, 'Visible suggestions are not selected yet');
    await page.screenshot({ path: await screenshotPath('test-results/e2e/autosuggest-desktop.png') });
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await editor.innerText(), '公開');
    await page.waitForTimeout(700);
    assert.ok(requests.every(r => r.operation === 'suggest'));
    assert.equal(calls(), before, 'Suggestions must not call an LLM');
    assert.equal(await page.locator('.word-suggestions').count(), 0);
    await page.keyboard.press('Control+z');
    assert.equal(await editor.innerText(), 'kouka');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('kouka');
    await page.getByRole('button', { name: '航海 を補完' }).click();
    assert.equal(await editor.innerText(), '航海');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('kouka');
    await page.locator('.word-suggestions').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.word-suggestions').count(), 0);
    assert.equal(await editor.innerText(), 'kouka');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('kouka');
    await page.locator('.word-suggestions').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: await screenshotPath('test-results/e2e/autosuggest-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: await screenshotPath('test-results/e2e/autosuggest-dark.png') });
    await editor.dispatchEvent('compositionstart', { data: '' });
    assert.equal(await page.locator('.word-suggestions').count(), 0, 'IME composition hides suggestions');
    await editor.dispatchEvent('compositionend', { data: '' });
    await page.locator('.word-suggestions').waitFor();
  });
  await scenario({ autoConvert: true, conversionMode: 'replace', inputPauseTiming: 'early' }, async (page, editor, requests) => {
    await page.keyboard.type('kouka');
    await page.locator('.word-suggestions').waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: '航海 を補完' }).getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: '公開 を補完' }).getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.getByRole('button', { name: '航海 を補完' }).getAttribute('aria-pressed'), 'true');
    const before = requests.length;
    await page.waitForTimeout(700);
    assert.equal(requests.length, before, 'Selecting candidates suspends delayed conversion and completion searches');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.word-suggestions').count(), 0);
    await page.keyboard.type('i');
    await page.waitForTimeout(700);
    assert.ok(requests.length > before, 'Typing resumes requests');
    assert.ok((await editor.innerText()).includes('koukai'));
  });
  await scenario({}, async (page, editor, requests) => {
    await page.keyboard.type('kou');
    await page.locator('.word-suggestions').waitFor();
    await page.keyboard.press('Tab');
    const before = requests.length;
    await page.keyboard.type('ka');
    assert.equal(await page.locator('.word-suggestions [aria-pressed="true"]').count(), 0, 'Typing leaves selection mode');
    await page.waitForTimeout(650);
    assert.ok(requests.length > before);
    assert.equal(await editor.innerText(), 'kouka');
  });
  await scenario({}, async (page, editor) => {
    await page.keyboard.type('kouka');
    await page.locator('.word-suggestions').waitFor();
    await page.keyboard.press('Enter');
    assert.equal((await editor.locator('.cm-line').allTextContents()).join('\n'), 'kouka\n', 'Enter without Tab stays a newline');
  });
  await scenario({}, async (page, editor) => {
    await page.keyboard.type('kou');
    await page.locator('.word-suggestions').waitFor();
    const panel = await page.locator('.word-suggestions').elementHandle();
    await page.keyboard.type('k');
    assert.equal(await page.getByRole('button', { name: '航海 を補完' }).isDisabled(), false);
    await page.keyboard.type('a');
    assert.ok(await panel.evaluate(el => el === document.querySelector('.word-suggestions')), 'Typing and response updates reuse the same panel');
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    assert.equal(await editor.innerText(), '航海', 'Retained suggestion replaces the entire current token');
  });
  await scenario({}, async (page, editor, requests) => {
    await page.keyboard.type('kou');
    await page.locator('.word-suggestions').waitFor();
    const before = requests.length;
    await page.keyboard.type('k'); await page.waitForTimeout(160);
    assert.equal(requests.length, before);
    await page.keyboard.type('a'); await page.waitForTimeout(160);
    assert.equal(requests.length, before, 'Two typed characters do not refresh yet');
    await page.keyboard.type('i'); await page.waitForTimeout(220);
    assert.equal(requests.length, before + 1, 'Three typed characters refresh');
    await page.keyboard.type('s'); await page.keyboard.type('h'); await page.keyboard.type('a');
    await page.waitForTimeout(220);
    const after = requests.length;
    await page.keyboard.type('i'); await page.waitForTimeout(180);
    assert.equal(requests.length, after);
    await page.waitForTimeout(400);
    assert.equal(requests.length, after + 1, 'Idle refresh covers fewer than three characters');
    assert.equal(await editor.innerText(), 'koukaishai');
  });
  for (const [key, suffix, preview] of [[',', '、', true], ['.', '。', true], ['Enter', '\n', true], ['Enter', '\n', false]]) {
    await scenario({ autoConvert: true, conversionMode: 'replace', inputPauseTiming: 'early', triggers: { enter: true } }, async (page, editor) => {
      await page.keyboard.type('kouka');
      if (preview) await page.locator('.cm-ghost-text-suggestion').waitFor();
      await page.keyboard.press(key);
      await page.getByRole('button', { name: '航海 を補完' }).click();
      const text = await editor.locator('.cm-line').allTextContents();
      assert.equal(text.join('\n'), `航海${suffix}`, `${key} completion preserves punctuation/newline`);
    });
  }
  await scenario({ autoSuggest: false }, async (page, _editor, requests) => {
    await page.keyboard.type('kouka'); await page.waitForTimeout(450);
    assert.equal(requests.length, 0);
    assert.equal(await page.locator('.word-suggestions').count(), 0);
  });
  await scenario({ autoConvert: true, conversionMode: 'ghost', inputPauseTiming: 'early' }, async (page) => {
    await page.keyboard.type('kouka');
    await page.locator('.cm-ghost-text-suggestion').waitFor();
    await page.waitForTimeout(200);
    await page.locator('.word-suggestions').waitFor();
    assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 1, 'Both choices stay visible');
    await page.screenshot({ path: await screenshotPath('test-results/e2e/autosuggest-with-conversion.png') });
    await page.keyboard.press('Alt+Enter');
    assert.ok((await page.locator('.cm-content').innerText()).includes('効果'));
    await page.getByRole('button', { name: '航海 を補完' }).waitFor();
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('.cm-content').innerText(), '航海', 'Completion replaces converted range using its retained reading');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0);
  });
  await scenario({ autoConvert: true, conversionMode: 'ghost', inputPauseTiming: 'early' }, async page => {
    await page.keyboard.type('kouka');
    await page.locator('.cm-ghost-text-suggestion').waitFor();
    await page.getByRole('button', { name: '航海 を補完' }).click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.cm-content').innerText(), '航海');
    assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0, 'Choosing completion dismisses the old conversion');
  });
  await scenario({}, async (page) => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let started;
    const requested = new Promise(resolve => { started = resolve; });
    await page.route('**/api/kana-engine', async route => {
      started(); await pending;
      await route.fulfill({ json: { candidates: [{ text: '航海', reading: 'こうかい', cost: 0, source: 'mozc' }] } }).catch(() => {});
    });
    await page.keyboard.type('kouka'); await requested;
    await page.keyboard.press('Control+a'); await page.keyboard.type('x');
    release(); await page.waitForTimeout(350);
    assert.equal(await page.locator('.word-suggestions').count(), 0, 'Stale response must not reappear');
  });
  await scenario({ autoConvert: true, conversionMode: 'replace', triggers: { typing: false } }, async (page, editor) => {
    await page.keyboard.type('kouka');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.querySelector('.cm-content').textContent === '効果');
    await page.getByRole('button', { name: '航海 を補完' }).click();
    assert.equal(await editor.innerText(), '航海', 'Direct replacement also retains its reading for completion');
  });
  await scenario({ autoConvert: true, inputPauseTiming: 'early' }, async (page, editor) => {
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { started = resolve; });
    await page.route('**/api/kana-engine', async route => {
      const { operation, reading } = route.request().postDataJSON();
      if (operation === 'suggest') return route.fallback();
      started(); await pending;
      await route.fulfill({ json: { candidates: [{ text: '効果', reading, cost: 0, tokens: [{ text: '効果', reading, from: 0, to: reading.length, source: 'mozc', entryId: 'test', lid: 0, rid: 0, wordCost: 0 }] }], dictionaryRevision: 'test', truncated: false } }).catch(() => {});
    });
    await page.keyboard.type('kouka');
    await page.getByRole('button', { name: '航海 を補完' }).waitFor();
    await requested;
    await page.getByRole('button', { name: '航海 を補完' }).click();
    release(); await page.waitForTimeout(600);
    assert.equal(await editor.innerText(), '航海', 'Late normal conversion must not overwrite accepted completion');
    assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0);
  });
  await scenario({}, async (page, editor) => {
    await page.keyboard.type('kouka');
    await page.locator('.word-suggestions').waitFor();
    await page.getByRole('button', { name: /辞書を開く/ }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.word-suggestions').count(), 0, 'Blur hides suggestions');
    await editor.click();
    await page.keyboard.press('Control+a'); await page.keyboard.type('kouka');
    await page.locator('.word-suggestions').waitFor();
    await page.getByRole('button', { name: /変換を開く/ }).click();
    await page.getByRole('checkbox', { name: 'オートサジェスト', exact: true }).uncheck();
    await editor.click();
    await page.keyboard.press('Control+a'); await page.keyboard.type('kouka');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.word-suggestions').count(), 0, 'Setting change applies immediately');
  });
  await scenario({ personalDictionary: [
    { id: 'custom', reading: 'てすとしゃ', text: '補完試験社', pos: 'organization', enabled: true },
    { id: 'disabled', reading: 'てすとしゃ', text: '無効語彙', pos: 'organization', enabled: false },
  ] }, async (page, editor) => {
    await page.unroute('**/api/kana-engine');
    await page.keyboard.type('tesuto');
    await page.getByRole('button', { name: '補完試験社 を補完' }).waitFor({ timeout: 120000 });
    assert.equal(await page.getByRole('button', { name: '無効語彙 を補完' }).count(), 0);
    await page.getByRole('button', { name: '補完試験社 を補完' }).click();
    assert.equal(await editor.innerText(), '補完試験社');
    await page.keyboard.press('Control+a'); await page.keyboard.type('kouka');
    await page.locator('.word-suggestions').waitFor();
    assert.ok(await page.locator('.word-suggestions button').count() > 0, 'Real Mozc dictionary returns completions');
  });
  console.log('Autosuggest E2E passed: real dictionary, independent requests, no LLM, acceptance, Undo, Escape, IME completion, settings, blur, simultaneous choices, completion after preview/direct conversion, late conversion, stale response, narrow/dark layout.');
} finally { await browser?.close(); await server.close(); }
