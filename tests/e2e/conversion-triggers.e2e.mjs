import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const url = server.resolvedUrls.local[0];
  async function scenario(settings, run) {
    const context = await browser.newContext();
    await context.addInitScript(settings => {
      localStorage.clear();
      localStorage.setItem('romaji-kana-settings', JSON.stringify({
        conversionEngine: 'local', conversionMode: 'ghost', inputPauseTiming: 'early', ...settings,
      }));
    }, settings);
    const page = await context.newPage();
    const searches = [];
    await page.route('**/api/tags', route => route.fulfill({ json: { models: [{ name: 'gemma3' }] } }));
    await page.route('**/api/generate', route => route.fulfill({ json: { response: JSON.stringify({ order: ['candidate-0'] }) } }));
    await page.route('**/api/kana-engine', route => {
      const { reading } = route.request().postDataJSON();
      searches.push(reading);
      const candidate = (text, cost) => ({ text, reading, cost, tokens: [{ text, reading,
        from: 0, to: [...reading].length, source: 'mozc', entryId: 'test', lid: 0, rid: 0, wordCost: cost }] });
      return route.fulfill({ json: { candidates: [candidate(reading, 0), candidate('候補', 100)], dictionaryRevision: 'test', truncated: false } });
    });
    try {
      await page.goto(url);
      const editor = page.locator('.cm-content');
      await editor.click();
      await run(page, editor, searches);
    } finally { await context.close(); }
  }

  await scenario({ triggers: { typing: true, space: false } }, async (page, _editor, searches) => {
    await page.keyboard.type('hon ');
    await page.waitForTimeout(100);
    assert.equal(searches.length, 0, 'Disabled Space must not request immediately');
    await page.locator('.cm-ghost-text-suggestion').waitFor();
    assert.equal(searches.length, 1, 'Pause still generates when Space is disabled');
  });
  await scenario({ triggers: { typing: false, space: true } }, async (page, _editor, searches) => {
    await page.keyboard.type('hon');
    await page.waitForTimeout(600);
    assert.equal(searches.length, 0, 'Disabled pause must not generate');
    await page.keyboard.type(' ');
    await page.locator('.cm-ghost-text-suggestion').waitFor();
    assert.equal(searches.length, 1, 'Space works independently of pause');
  });
  for (const level of ['word', 'sentence']) {
    await scenario({ inputCompletionLevel: level }, async (page, editor) => {
      const reading = 'あとじどうへんかんが';
      await page.route('**/api/kana-engine', route => {
        const request = route.request().postDataJSON();
        assert.equal(request.operation, 'search', 'Saved completion modes must not invoke prefix completion');
        assert.equal(request.reading, reading);
        return route.fulfill({ json: { candidates: [{ text: 'あと自動変換が', reading, cost: 100,
          tokens: [{ text: 'あと自動変換が', reading, from: 0, to: [...reading].length, source: 'mozc', entryId: 'test', lid: 0, rid: 0, wordCost: 100 }] }],
          dictionaryRevision: 'test', truncated: false } });
      });
      await page.keyboard.type('atozidouhennkannga');
      await page.locator('.cm-ghost-text-suggestion').waitFor();
      assert.equal(await page.locator('.cm-ghost-text-suggestion').textContent(), 'あと自動変換が');
      await page.keyboard.press('Tab');
      assert.equal(await editor.innerText(), 'あと自動変換が');
      await page.getByRole('button', { name: /変換を開く/ }).click();
      assert.equal(await page.getByRole('radiogroup', { name: '入力補完レベル' }).count(), 0);
      await page.setViewportSize({ width: 390, height: 520 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('romaji-kana-settings')).inputCompletionLevel), 'none');
    });
  }
  await scenario({ triggers: { typing: true, space: true } }, async (page, editor, searches) => {
    await editor.evaluate(element => {
      const data = new DataTransfer();
      data.setData('text/plain', 'hon.');
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(600);
    assert.equal(await editor.innerText(), 'hon.');
    assert.equal(searches.length, 0, 'Paste must not generate or replace text');
    await page.keyboard.press('Control+Enter');
    await page.locator('.cm-ghost-text-suggestion').waitFor();
    assert.ok(searches.length > 0, 'Pasted text remains manually convertible');
  });
  await scenario({}, async (page, editor, searches) => {
    await editor.dispatchEvent('compositionstart');
    await page.keyboard.type('hon.');
    await editor.dispatchEvent('compositionend');
    await page.waitForTimeout(600);
    assert.equal(searches.length, 0, 'IME edits must not start punctuation or pause conversion');
  });
  await scenario({ autoConvert: false }, async (page, editor) => {
    let release;
    const requested = new Promise(resolve => {
      page.route('**/api/generate', async route => {
        if (route.request().postDataJSON().prompt === 'ok') return route.fulfill({ json: { response: 'ok' } });
        resolve();
        await new Promise(done => { release = done; });
        await route.fulfill({ json: { response: '{"order":["candidate-1","candidate-0"]}' } });
      });
    });
    await page.keyboard.type('mae\nhon');
    await page.keyboard.press('Control+Enter');
    await page.locator('.cm-ghost-text-suggestion').waitFor();
    await requested;
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0, 'Moving to another line dismisses the candidate');
    release();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0, 'Late ranking must not restore a candidate after cursor movement');
    await page.keyboard.press('Tab');
    assert.equal(await editor.innerText(), 'mae\nhon', 'Tab must not accept a candidate dismissed by cursor movement');
  });
  await scenario({ autoConvert: false }, async (page, editor) => {
    await page.keyboard.type('hon');
    await page.keyboard.press('Control+Enter');
    await page.locator('.cm-ghost-text-suggestion').waitFor();
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: /履歴を開く/ }).click();
    await page.locator('.history-item.success').hover();
    await page.locator('.cm-history-preview').waitFor();
    await editor.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.history-item.success').count(), 1, 'Tab on a history preview must not record another acceptance');
    assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0);
  });
  await scenario({ autoConvert: false }, async (page, _editor, searches) => {
    await page.keyboard.type('mae\n```\ncode\n```\nato');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(150);
    assert.equal(searches.length, 0, 'A selection containing a fence must be rejected');
    await page.keyboard.type('nedanwa1.5endesu.');
    await page.keyboard.press('Control+Enter');
    await page.locator('.cm-ghost-source').waitFor();
    assert.equal(await page.locator('.cm-ghost-source').textContent(), 'nedanwa1.5endesu.');
    assert.match(await page.locator('.cm-ghost-text-suggestion').textContent(), /1\.5/);
  });
  for (const succeeds of [false, true]) {
    await scenario({ autoConvert: false }, async (page, editor) => {
      const stages = [];
      await page.route('**/api/kana-engine', route => route.fulfill({ json: { candidates: [], dictionaryRevision: 'test', truncated: false } }));
      await page.route('**/api/generate', route => {
        const body = route.request().postDataJSON();
        if (body.prompt === 'ok') return route.fulfill({ json: { response: 'ok' } });
        const speculative = body.system.includes('speculative Japanese');
        stages.push(speculative ? 'speculative' : 'correction');
        return route.fulfill({ json: { response: JSON.stringify({ convertedText: speculative && succeeds ? '本' : 'ほん', completedKana: 'ほん' }) } });
      });
      await page.keyboard.type('hon');
      await page.keyboard.press('Control+Enter');
      if (succeeds) {
        await page.locator('.cm-ghost-text-suggestion').waitFor();
        assert.equal(await editor.innerText().then(text => text.startsWith('hon')), true);
        assert.match(await page.locator('.cm-ghost-text-hint').textContent(), /推測候補/);
        await page.keyboard.press('Tab');
        assert.equal(await editor.innerText(), '本');
      } else {
        await page.getByText('通常変換・誤字修正・推測で候補が得られなかったため、ローマ字を残しました。', { exact: true }).first().waitFor();
        assert.equal(await editor.innerText(), 'hon');
        assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0);
      }
      assert.deepEqual(stages, ['correction', 'speculative']);
    });
  }
  for (const cancel of [false, true]) {
    await scenario({ autoConvert: false }, async (page, editor) => {
      const reading = 'かいぎのじかんをかえないでください';
      const text = '会議の時間を変えないでください';
      await page.route('**/api/kana-engine', route => {
        const requested = route.request().postDataJSON().reading;
        return route.fulfill({ json: { candidates: requested === reading ? [{ text, reading, cost: 100,
          tokens: [{ text, reading, from: 0, to: [...reading].length, source: 'mozc', entryId: 'test', lid: 0, rid: 0, wordCost: 100 }] }] : [],
          dictionaryRevision: 'test', truncated: false } });
      });
      let release;
      let sawSelection;
      const selection = new Promise(resolve => { sawSelection = resolve; });
      await page.route('**/api/generate', async route => {
        const body = route.request().postDataJSON();
        if (body.prompt === 'ok') return route.fulfill({ json: { response: 'ok' } });
        const prompt = JSON.parse(body.prompt);
        assert.equal(prompt.originalInput, 'kaiginojkanwokaenaidekudasai.');
        assert.equal(prompt.candidates[0].kind, 'correction');
        sawSelection();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ json: { response: JSON.stringify({ order: [prompt.candidates[0].id] }) } });
      });
      await page.keyboard.type('kaiginojkanwokaenaidekudasai.');
      await page.keyboard.press('Control+Enter');
      await selection;
      assert.equal(await editor.innerText(), 'kaiginojkanwokaenaidekudasai.', 'Dictionary repair must not replace the original while ranking');
      if (cancel) {
        await page.getByRole('button', { name: /履歴を開く/ }).click();
        await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
      }
      release();
      if (cancel) {
        await page.waitForTimeout(200);
        assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0, 'Canceled correction must not reappear');
        assert.equal(await editor.innerText(), 'kaiginojkanwokaenaidekudasai.');
      } else {
        await page.locator('.cm-ghost-text-suggestion').waitFor();
        assert.match(await page.locator('.cm-ghost-text-hint').textContent(), /誤字修正候補/);
        await page.keyboard.press('Tab');
        assert.equal(await editor.innerText(), `${text}。`);
      }
    });
  }
  console.log('Conversion trigger E2E passed: independent pause/Space, paste, IME, ghost dismissal, history previews, fences, numeric ranges and ordered rescue.');
} finally { await browser?.close(); await server.close(); }
