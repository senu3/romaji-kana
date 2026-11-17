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
      localStorage.setItem('romaji-kana-settings', JSON.stringify({ inputMode: 'romaji', autoConvert: false, autoSuggest: true, ...settings }));
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
  for (const autoConvert of [false, true]) await scenario({ autoConvert, conversionMode: 'ghost' }, async (page, editor) => {
    const readings = [];
    await page.route('**/api/kana-engine', route => {
      const { operation, reading } = route.request().postDataJSON();
      if (operation !== 'suggest') return route.fallback();
      readings.push(reading);
      const candidates = reading === 'もし' ? [{ text: 'もしかして', reading: 'もしかして', cost: 0, source: 'mozc' }]
        : reading === 'わたしは' ? [{ text: '私は医者', reading: 'わたしはいしゃ', cost: 0, source: 'user' }] : [];
      return route.fulfill({ json: { candidates } });
    });
    await page.keyboard.type('moshi');
    await page.getByRole('button', { name: 'もしかして を補完' }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await editor.innerText(), 'もしかして');
    await page.keyboard.type('watasiha');
    await page.getByRole('button', { name: '私は医者 を補完' }).waitFor();
    assert.ok(readings.includes('わたしは'));
    assert.ok(!readings.includes('もしかしてわたしは'));
    await page.keyboard.press('Tab');
    assert.equal(await editor.innerText(), 'もしかして私は医者', 'The committed prefix survives a second completion');
  });
  await scenario({}, async (page, editor, requests, calls) => {
    const before = calls();
    await page.keyboard.type('kouka');
    await page.locator('.cm-autosuggest-ghost:visible').waitFor();
    await page.screenshot({ path: await screenshotPath('test-results/e2e/autosuggest-desktop.png') });
    await page.keyboard.press('Tab');
    assert.equal(await editor.innerText(), '航海');
    await page.waitForTimeout(700);
    assert.ok(requests.every(r => r.operation === 'suggest'));
    assert.equal(calls(), before, 'Suggestions must not call an LLM');
    assert.equal(await page.locator('.cm-autosuggest-ghost:visible').count(), 0);
    await page.keyboard.press('Control+z');
    assert.equal(await editor.innerText(), 'kouka');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('kouka');
    await page.getByRole('button', { name: '航海 を補完' }).click();
    assert.equal(await editor.innerText(), '航海');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('kouka');
    await page.locator('.cm-autosuggest-ghost:visible').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.cm-autosuggest-ghost').waitFor({ state: 'hidden' });
    assert.equal(await editor.innerText(), 'kouka');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('kouka');
    await page.locator('.cm-autosuggest-ghost:visible').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: await screenshotPath('test-results/e2e/autosuggest-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: await screenshotPath('test-results/e2e/autosuggest-dark.png') });
    await editor.dispatchEvent('compositionstart', { data: '' });
    await page.locator('.cm-autosuggest-ghost').waitFor({ state: 'hidden' });
    await editor.dispatchEvent('compositionend', { data: '' });
    await page.locator('.cm-autosuggest-ghost:visible').waitFor();
  });
  await scenario({}, async (page, editor) => {
    await page.keyboard.type('kouka');
    await page.locator('.cm-autosuggest-ghost:visible').waitFor();
    await page.keyboard.press('Enter');
    assert.equal((await editor.locator('.cm-line').allTextContents()).join('\n'), 'kouka\n', 'Enter stays a newline');
  });
  for (const inputMode of ['romaji', 'kana']) await scenario({ inputMode }, async (page, editor, requests) => {
    await page.keyboard.type('kou');
    const ghost = page.getByRole('button', { name: '航海 を補完' });
    await ghost.waitFor();
    const panel = await ghost.elementHandle();
    const initialRequests = requests.length;
    await page.keyboard.type('k');
    await ghost.waitFor({ timeout: 300 });
    assert.equal(requests.length, initialRequests, 'Unfinished keys retain the candidate without a fresh lookup');
    await page.keyboard.press('Tab');
    assert.equal(await editor.innerText(), '航海', 'Tab replaces the entire reading including unfinished keys');

    await page.keyboard.press('Control+a');
    await page.keyboard.type('kou');
    await ghost.waitFor();
    await page.keyboard.type('k');
    await ghost.waitFor({ timeout: 300 });
    await page.keyboard.type('a');
    await ghost.waitFor({ timeout: 300 });
    assert.ok(await panel.evaluate(el => el === document.querySelector('.cm-autosuggest-ghost')), 'Typing updates reuse the same ghost');
    await page.keyboard.press('Tab');
    assert.equal(await editor.innerText(), '航海', 'Retained suggestion replaces the entire current token');

    await page.keyboard.press('Control+a');
    await page.keyboard.type('kou');
    await ghost.waitFor();
    await page.keyboard.type('s');
    await ghost.waitFor({ state: 'hidden', timeout: 300 });
    assert.equal(await editor.innerText(), inputMode === 'kana' ? 'こうs' : 'kous', 'Incompatible keys dismiss the candidate and remain in the editor');

    await page.keyboard.press('Control+a');
    await page.keyboard.type('kou');
    await ghost.waitFor();
    await page.keyboard.type('k');
    await ghost.waitFor({ timeout: 300 });
    await page.keyboard.press('ArrowLeft');
    await ghost.waitFor({ state: 'hidden', timeout: 300 });
  });
  for (const [key, suffix, preview] of [[',', '、', true], ['.', '。', true], ['Enter', '\n', false]]) {
    await scenario({ autoConvert: true, conversionMode: preview ? 'ghost' : 'replace', inputPauseTiming: 'early', triggers: { enter: true } }, async (page, editor) => {
      await page.keyboard.type('kouka');
      if (preview) await page.locator('.cm-ghost-text-suggestion').waitFor();
      await page.keyboard.press(key);
      if (preview) {
        await page.locator('.cm-ghost-text-suggestion').filter({ hasText: suffix }).waitFor();
        await page.keyboard.press('Alt+Enter');
      }
      await page.getByRole('button', { name: '航海 を補完' }).click({ timeout: 3000 }).catch(async error => {
        const state = await editor.evaluate(el => ({ text: el.innerText, ghost: el.closest('.cm-editor').querySelector('.cm-autosuggest-ghost').outerHTML }));
        throw new Error(`No ghost after ${key}: ${JSON.stringify(state)}`, { cause: error });
      });
      const text = await editor.locator('.cm-line').allTextContents();
      assert.equal(text.join('\n'), `航海${suffix}`, `${key} completion preserves punctuation/newline`);
    });
  }
  await scenario({ autoSuggest: false }, async (page, _editor, requests) => {
    await page.keyboard.type('kouka'); await page.waitForTimeout(450);
    assert.equal(requests.length, 0);
    assert.equal(await page.locator('.cm-autosuggest-ghost:visible').count(), 0);
  });
  for (const [conversionMode, hasWordCandidate] of [['replace', false], ['replace', true], ['ghost', false]]) await scenario({ autoConvert: true, conversionMode, inputPauseTiming: 'early' }, async (page, editor, _requests, calls) => {
    await page.route('**/api/kana-engine', route => {
      const { operation } = route.request().postDataJSON();
      if (operation === 'suggest' && !hasWordCandidate) return route.fulfill({ json: { candidates: [] } });
      if (operation === 'verify') return route.fulfill({ json: { status: 'verified' } });
      return route.fallback();
    });
    const previous = '効果が確認できました。\n';
    const complete = page.getByRole('button', { name: 'が確認できました。 を挿入' });
    await page.keyboard.insertText(previous);
    await page.keyboard.type('kouka');
    if (conversionMode === 'ghost') {
      await page.locator('.cm-ghost-text-suggestion:visible').waitFor();
      await page.keyboard.press('Alt+Enter');
      await page.waitForTimeout(250);
      assert.equal(await complete.count(), 0, 'Accepting a conversion preview does not trigger a document continuation');
      assert.equal(await editor.innerText(), previous + '効果');
      return;
    }
    if (hasWordCandidate) {
      await page.waitForFunction(text => document.querySelector('.cm-content').innerText === text, previous + '効果');
      await page.getByRole('button', { name: '航海 を補完' }).waitFor();
      assert.equal(await complete.count(), 0, 'A dictionary candidate takes priority over the document continuation');
      return;
    }
    await complete.waitFor();
    assert.equal(await editor.innerText(), previous + '効果');
    await page.keyboard.press('Tab');
    assert.equal(await editor.innerText(), previous + '効果が確認できました。');
    await page.keyboard.press('Control+z');
    assert.equal(await editor.innerText(), previous + '効果');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.type('kouka');
    await complete.waitFor();
    await page.keyboard.press('Escape');
    await complete.waitFor({ state: 'hidden' });
    assert.equal(await editor.innerText(), previous + '効果');
    assert.equal(calls(), 0, 'Document continuations do not call an LLM');
  });
  await scenario({ autoConvert: true, conversionMode: 'ghost', inputPauseTiming: 'early' }, async (page) => {
    await page.keyboard.type('kouka');
    await page.locator('.cm-ghost-text-suggestion').waitFor();
    await page.locator('.cm-autosuggest-ghost').waitFor({ state: 'hidden' });
    await page.keyboard.press('Alt+Enter');
    assert.ok((await page.locator('.cm-content').innerText()).includes('効果'));
    await page.getByRole('button', { name: '航海 を補完' }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.cm-content').innerText(), '航海', 'Completion replaces converted range using its retained reading');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0);
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
    assert.equal(await page.locator('.cm-autosuggest-ghost:visible').count(), 0, 'Stale response must not reappear');
  });
  await scenario({ autoConvert: true, conversionMode: 'replace', triggers: { typing: false } }, async (page, editor) => {
    await page.keyboard.type('kouka');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.querySelector('.cm-content').textContent === '効果');
    const ghost = page.getByRole('button', { name: '航海 を補完' });
    await ghost.waitFor();
    assert.match(await ghost.textContent(), /→ 航海/);
    await ghost.click();
    assert.equal(await editor.innerText(), '航海', 'Direct replacement also retains its reading for completion');
  });
  await scenario({ autoConvert: true, inputPauseTiming: 'early' }, async (page, editor) => {
    let reviews = 0;
    await page.route('**/api/tags', route => route.fulfill({ json: { models: [{ name: 'gemma3' }] } }));
    await page.route('**/api/kana-engine', route => route.request().postDataJSON().operation === 'verify'
      ? route.fulfill({ json: { status: 'verified' } }) : route.fallback());
    await page.route('**/api/generate', route => {
      const body = route.request().postDataJSON();
      if (!body.format?.properties?.convertedText) return route.fulfill({ json: { response: 'ok' } });
      reviews++;
      return route.fulfill({ json: { response: JSON.stringify({ convertedText: '高価', completedKana: 'こうか' }) } });
    });
    await page.keyboard.type('kouka');
    await page.waitForFunction(() => document.querySelector('.cm-content').textContent === '効果');
    const ghost = page.getByRole('button', { name: '航海 を補完' });
    await ghost.waitFor();
    assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Escape');
    assert.equal(reviews, 0, 'Escape away from the conversion does not request a review');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await ghost.waitFor({ state: 'hidden' });
    const review = page.getByRole('group', { name: '推測候補', exact: true });
    await review.waitFor();
    assert.equal(reviews, 1);
    assert.equal(await review.locator(':scope > button').count(), 1);
    assert.equal(await editor.innerText(), '効果', 'Escape starts review without replacing the document');
    await review.getByRole('button', { name: '高価 を採用' }).click();
    assert.equal(await editor.innerText(), '高価');
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
    await page.locator('.cm-autosuggest-ghost:visible').waitFor();
    await page.getByRole('button', { name: /辞書を開く/ }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.cm-autosuggest-ghost:visible').count(), 0, 'Blur hides suggestions');
    await editor.click();
    await page.keyboard.press('Control+a'); await page.keyboard.type('kouka');
    await page.locator('.cm-autosuggest-ghost:visible').waitFor();
    await page.getByRole('button', { name: /変換を開く/ }).click();
    await page.getByRole('checkbox', { name: 'オートサジェスト', exact: true }).uncheck();
    await editor.click();
    await page.keyboard.press('Control+a'); await page.keyboard.type('kouka');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.cm-autosuggest-ghost:visible').count(), 0, 'Setting change applies immediately');
  });
  await scenario({}, async (page, editor) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.insertText('前'.repeat(12));
    await page.keyboard.type('kouka');
    const ghost = page.locator('.cm-autosuggest-ghost:visible');
    await ghost.waitFor();
    await page.waitForFunction(() => document.querySelector('.cm-autosuggest-ghost')?.dataset.placement === 'floating');
    const rect = await ghost.boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 390, 'Right-edge candidate stays inside the screen');
    assert.equal(await ghost.locator('.candidate-accept-hint').innerText(), '採用 Tab');
    await page.screenshot({ path: await screenshotPath('test-results/e2e/candidate-right-edge.png') });
    await page.keyboard.press('Tab');
    assert.equal(await editor.innerText(), '前'.repeat(12) + '航海');
  });
  await scenario({}, async (page, editor) => {
    await page.setViewportSize({ width: 390, height: 600 });
    const long = '航海の記録を確かめながら次の目的地を決める';
    await page.route('**/api/kana-engine', route => route.fulfill({ json: { candidates: [
      { text: long, reading: 'こうかい', cost: 0, source: 'mozc' },
    ] } }));
    await page.keyboard.type('kouka');
    const ghost = page.locator('.cm-autosuggest-ghost:visible');
    await ghost.waitFor();
    assert.equal(await ghost.locator('.candidate-completion-text').textContent(), ` → ${long}`);
    assert.ok(await ghost.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Long candidates wrap without hidden horizontal text');
    await page.screenshot({ path: await screenshotPath('test-results/e2e/candidate-long-completion.png') });
    await page.keyboard.press('Alt+Enter');
    assert.equal(await editor.innerText(), long);
  });
  await scenario({}, async (page, editor) => {
    await page.keyboard.type('kouka.tail');
    await page.keyboard.press('Home');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    const ghost = page.locator('.cm-autosuggest-ghost:visible');
    await ghost.waitFor();
    assert.equal(await ghost.getAttribute('data-placement'), 'floating', 'Mid-line offers use the same fallback surface');
    await page.keyboard.press('Tab');
    assert.equal(await editor.innerText(), '航海.tail', 'Acceptance preserves the suffix beside the caret');
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
    await page.locator('.cm-autosuggest-ghost:visible').waitFor();
    assert.ok(await page.locator('.cm-autosuggest-ghost:visible').count() > 0, 'Real Mozc dictionary returns completions');
  });
  console.log('Autosuggest E2E passed: real dictionary, independent requests, no LLM, acceptance, Undo, Escape, IME completion, settings, blur, conversion preview priority, completion after preview/direct conversion, late conversion, stale response, narrow/dark layout.');
} finally { await browser?.close(); await server.close(); }
