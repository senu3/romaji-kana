import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { artifactPath, screenshotPath } from '../helpers/artifacts.mjs';

const server = await createServer({ cacheDir: artifactPath('cache/e2e'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
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
        conversionMode: 'ghost', inputPauseTiming: 'early', autoSuggest: false, ...settings,
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

  const selectedCandidateFailures = [];
  for (const entry of ['ghost', 'recent', 'history']) for (const trigger of [',', '.', ' ', 'Enter', 'pause']) {
    await scenario({ conversionMode: entry === 'ghost' ? 'ghost' : 'replace', triggers: { typing: true, space: true, enter: true } }, async (page, editor, searches) => {
      await page.route('**/api/kana-engine', route => {
        const { reading } = route.request().postDataJSON();
        searches.push(reading);
        const candidates = ['公開のときだ', '航海のときだ'].map((text, index) => ({
          text, reading, cost: index * 100, tokens: [{ text, reading, from: 0, to: [...reading].length,
            source: 'mozc', entryId: text, lid: 0, rid: 0, wordCost: index * 100 }],
        }));
        return route.fulfill({ json: { candidates, dictionaryRevision: 'test', truncated: false } });
      });
      await page.keyboard.insertText('さあ船出のときだ、');
      await page.keyboard.type('koukainotokida');
      if (entry === 'ghost') {
        await page.locator('.cm-ghost-text-suggestion').filter({ hasText: '公開のときだ' }).waitFor();
        await page.getByRole('group', { name: '変換候補', exact: true }).getByRole('button', { name: 'ほかの候補', exact: true }).click();
      } else {
        await page.keyboard.press('Control+Enter');
        if (entry === 'recent') await page.locator('.recent-retry-chip-main').click();
        else {
          await page.getByRole('button', { name: /履歴を開く/ }).click();
          await page.locator('.history-item').getByRole('button', { name: 'ほかの候補' }).click();
        }
      }
      await page.getByRole('dialog', { name: 'ほかの候補', exact: true }).getByRole('button', { name: '航海のときだ', exact: true }).click();
      await page.locator('.cm-ghost-text-suggestion').filter({ hasText: '航海のときだ' }).waitFor();
      const previousSearches = searches.length;
      if (trigger === 'Enter') await page.keyboard.press('Enter');
      else if (trigger !== 'pause') await page.keyboard.type(trigger);
      await page.waitForTimeout(700);
      try {
        if (trigger === 'pause' || trigger === ' ') {
          assert.equal(await page.locator('.cm-ghost-text-suggestion').textContent(), '航海のときだ');
        } else {
          const suffix = trigger === ',' ? '、' : trigger === '.' ? '。' : trigger === 'Enter' ? '\n' : ' ';
          const text = await editor.locator('.cm-line').evaluateAll(lines => lines.map(line => {
            const copy = line.cloneNode(true);
            copy.querySelectorAll('.cm-ghost-text').forEach(widget => widget.remove());
            return copy.textContent;
          }).join('\n'));
          assert.equal(text, `さあ船出のときだ、航海のときだ${suffix}`);
          assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0);
        }
        assert.equal(searches.length, previousSearches, 'A selected candidate must not start another conversion');
      } catch (error) { selectedCandidateFailures.push(`${entry}/${JSON.stringify(trigger)}: ${error.message}`); }
    });
  }
  assert.deepEqual(selectedCandidateFailures, []);

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
  for (const entry of ['ghost', 'recent', 'history']) {
    await scenario({ autoConvert: false, conversionMode: entry === 'ghost' ? 'ghost' : 'replace' }, async (page, editor) => {
      await page.route('**/api/kana-engine', route => {
        const request = route.request().postDataJSON();
        if (request.operation === 'verify') return route.fulfill({ json: { status: 'verified' } });
        assert.equal(request.reading, 'かくに');
        return route.fulfill({ json: { candidates: [{ text: '角煮', reading: 'かくに', cost: 100,
          tokens: [{ text: '角煮', reading: 'かくに', from: 0, to: 3, source: 'mozc', entryId: 'test', lid: 0, rid: 0, wordCost: 100 }] }],
          dictionaryRevision: 'test', truncated: false } });
      });
      let proposals = 0;
      await page.route('**/api/generate', route => {
        const body = route.request().postDataJSON();
        if (body.prompt === 'ok') return route.fulfill({ json: { response: 'ok' } });
        // The current request sends the reading and nearby context. Rejected
        // surfaces are enforced locally; the scenarios below check behavior.
        assert.deepEqual(body.format.required, ['convertedText', 'completedKana']);
        assert.match(body.prompt, /かくに/);
        assert.ok(!body.prompt.includes('角煮'));
        assert.match(body.prompt, /資料を/);
        assert.match(body.prompt, /してください。/);
        proposals++;
        return route.fulfill({ json: { response: JSON.stringify(entry === 'recent'
          ? { convertedText: '角煮', completedKana: 'かくに' }
          : { convertedText: '確認', completedKana: 'かくにん' }) } });
      });
      await page.keyboard.insertText('資料をkakuniしてください。');
      await page.keyboard.press('Control+Home');
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
      for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Control+Enter');
      if (entry === 'ghost') await page.locator('.cm-ghost-text-suggestion').waitFor();
      else await page.getByRole('complementary', { name: '変換結果の見直し' }).waitFor();
      assert.equal(proposals, 0, 'A valid ordinary conversion must not automatically speculate');
      if (entry === 'history') await page.getByRole('button', { name: /履歴を開く/ }).click();
      const action = entry === 'ghost' ? page.getByRole('group', { name: '変換候補', exact: true }).getByRole('button', { name: 'ほかの候補', exact: true })
        : entry === 'recent' ? page.locator('.recent-retry-chip-main')
        : page.locator('.history-item').getByRole('button', { name: 'ほかの候補' });
      await action.click();
      const list = page.getByRole('dialog', { name: 'ほかの候補', exact: true });
      await list.waitFor();
      assert.equal(proposals, 0, 'Opening the list must not speculate');
      if (entry === 'ghost') {
        await page.keyboard.press('Escape');
        assert.equal(await list.count(), 0, 'Escape must close only the list');
        assert.equal(await page.locator('.cm-ghost-text-suggestion').textContent(), '角煮');
        await action.click();
        await page.setViewportSize({ width: 390, height: 520 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.notEqual(await list.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'The candidate list must have an opaque surface');
        await page.screenshot({ path: await screenshotPath('test-results/prototypes/inline/candidate-list-mobile.png'), fullPage: true });
      }
      await list.getByRole('button', { name: '読みも含めて見直す', exact: true }).click();
      if (entry === 'recent') {
        await page.getByText('意図に合う推測候補を作れませんでした。本文は変更していません。', { exact: true }).first().waitFor();
        assert.equal(await editor.innerText(), '資料を角煮してください。');
        assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0);
      } else {
        await page.locator('.cm-ghost-text-suggestion').filter({ hasText: '確認' }).waitFor();
        await page.getByRole('button', { name: '変更の詳細', exact: true }).click();
        assert.equal(await page.locator('.candidate-reading-change ins').textContent(), 'ん');
        assert.match(await page.locator('.candidate-details').textContent(), /かくに.*かくにん/s);
        const doc = await editor.evaluate(element => { const clone = element.cloneNode(true); clone.querySelectorAll('.cm-ghost-text').forEach(e => e.remove()); return clone.textContent; });
        assert.equal(doc, entry === 'ghost' ? '資料をkakuniしてください。' : '資料を角煮してください。', 'Speculation must await explicit acceptance even in replace mode');
        await page.setViewportSize({ width: 390, height: 520 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (entry === 'ghost') await page.screenshot({ path: await screenshotPath('test-results/prototypes/inline/speculate-mobile.png'), fullPage: true });
        await editor.focus();
        await page.keyboard.press('Alt+Enter');
        assert.equal(await editor.innerText(), '資料を確認してください。');
      }
      assert.equal(proposals, 1, 'Explicit reinterpretation must issue only one proposal');
    });
  }
  await scenario({ autoConvert: false }, async (page, editor) => {
    await page.route('**/api/kana-engine', route => {
      const body = route.request().postDataJSON();
      if (body.operation === 'verify') return route.fulfill({ json: { status: 'verified' } });
      const text = '講師は終わらなかった';
      return route.fulfill({ json: { candidates: [{ text, reading: body.reading, cost: 100,
        tokens: [{ text, reading: body.reading, from: 0, to: [...body.reading].length,
          source: 'mozc', entryId: 'fixture', lid: 0, rid: 0, wordCost: 100 }] }], truncated: false, dictionaryRevision: 'test' } });
    });
    let proposals = 0;
    await page.route('**/api/generate', route => {
      const body = route.request().postDataJSON();
      if (body.prompt === 'ok') return route.fulfill({ json: { response: 'ok' } });
      const editableIds = body.format.properties.segments.items.properties.id.enum;
      assert.equal(editableIds.length, 1);
      assert.match(body.prompt, /XR-34/);
      assert.ok(!body.prompt.includes('講師'));
      proposals++;
      return route.fulfill({ json: { response: JSON.stringify({ segments: [{ id: editableIds[0],
        convertedText: '更新は終わらなかった。', completedKana: 'こうしんはおわらなかった。' }] }) } });
    });
    const source = '`XR-34` no koushihaowaranakatta.';
    await editor.click(); await page.keyboard.insertText(source);
    await page.keyboard.press('Control+Enter');
    await page.locator('.cm-ghost-text-suggestion').waitFor();
    await page.keyboard.press('Control+/');
    await page.getByRole('dialog', { name: 'ほかの候補', exact: true }).getByRole('button', { name: '読みも含めて見直す', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.cm-ghost-text-suggestion')?.textContent === 'XR-34の更新は終わらなかった。');
    const documentText = await editor.evaluate(element => {
      const clone = element.cloneNode(true);
      clone.querySelectorAll('.cm-ghost-text').forEach(widget => widget.remove());
      return clone.textContent;
    });
    assert.equal(documentText, source, 'Reconstructed protected output must remain a preview');
    await editor.focus(); await page.keyboard.press('Alt+Enter');
    assert.equal(await editor.innerText(), 'XR-34の更新は終わらなかった。');
    assert.equal(proposals, 1);
  });
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
    await page.keyboard.press('Alt+Enter');
    assert.equal(await editor.innerText(), 'mae\nhon', 'Alt+Enter must not accept a candidate dismissed by cursor movement');
  });
  await scenario({ autoConvert: false }, async (page, editor) => {
    await page.keyboard.type('hon');
    await page.keyboard.press('Control+Enter');
    await page.locator('.cm-ghost-text-suggestion').waitFor();
    await page.keyboard.press('Alt+Enter');
    await page.getByRole('button', { name: /履歴を開く/ }).click();
    await page.locator('.history-item.success').hover();
    await page.locator('.cm-history-preview').waitFor();
    await editor.focus();
    await page.keyboard.press('Alt+Enter');
    assert.equal(await page.locator('.history-item.success').count(), 1, 'Alt+Enter on a history preview must not record another acceptance');
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
        // Automatic rescue stops at correction; explicit reinterpretation is
        // exercised separately above through the user-facing actions.
        stages.push('correction');
        return route.fulfill({ json: { response: JSON.stringify({ convertedText: succeeds ? '本' : 'ほん', completedKana: 'ほん' }) } });
      });
      await page.keyboard.type('hon');
      await page.keyboard.press('Control+Enter');
      if (succeeds) {
        await page.locator('.cm-ghost-text-suggestion').waitFor();
        assert.equal(await editor.innerText().then(text => text.startsWith('hon')), true);
        assert.match(await page.locator('.conversion-kind').textContent(), /修正候補/);
        await page.keyboard.press('Alt+Enter');
        assert.equal(await editor.innerText(), '本');
      } else {
        await page.getByText('通常変換・誤字修正で候補が得られなかったため、ローマ字を残しました。', { exact: true }).first().waitFor();
        assert.equal(await editor.innerText(), 'hon');
        assert.equal(await page.locator('.cm-ghost-text-suggestion').count(), 0);
      }
      assert.deepEqual(stages, ['correction']);
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
        assert.match(await page.locator('.conversion-kind').textContent(), /誤字修正候補/);
        await page.keyboard.press('Alt+Enter');
        assert.equal(await editor.innerText(), `${text}。`);
      }
    });
  }
  console.log('Conversion trigger E2E passed: selected candidate punctuation commits, pause/Space, paste, IME, ghost dismissal, history previews, fences, numeric ranges, ordered rescue and user-requested speculation.');
} finally { await browser?.close(); await server.close(); }
