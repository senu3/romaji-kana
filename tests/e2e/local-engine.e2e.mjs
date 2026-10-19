import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { artifactPath } from '../helpers/artifacts.mjs';

const server = await createServer({ cacheDir: artifactPath('cache/e2e'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('romaji-kana-settings', JSON.stringify({ autoConvert: false, conversionMode: 'ghost' }));
  });
  const page = await context.newPage();
  let modelCalls = 0;
  let release;
  let latestCandidates = [];
  await page.route('**/api/tags', route => route.fulfill({ json: { models: [{ name: 'gemma3' }] } }));
  await page.route('**/api/generate', async route => {
    const body = route.request().postDataJSON();
    if (body.prompt === 'ok') { await route.fulfill({ json: { response: 'ok' } }); return; }
    modelCalls++;
    latestCandidates = JSON.parse(body.prompt).candidates;
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { response: JSON.stringify({ order: latestCandidates.map(c => c.id).reverse() }) } });
  });
  await page.goto(url);
  const editor = page.locator('.cm-content');
  const ghost = page.locator('.cm-ghost-text-suggestion');
  async function typeInput(text) {
    await editor.click(); await page.keyboard.press('Control+A'); await page.keyboard.type(text);
    await page.keyboard.press('Control+Enter');
    await ghost.waitFor();
    await page.getByRole('dialog', { name: '変換候補', exact: true }).waitFor();
  }
  await typeInput('honwoyomu');
  assert.equal(await ghost.textContent(), '本を読む');
  await page.waitForTimeout(100);
  assert.equal(modelCalls, 1);
  assert.ok(latestCandidates.some(c => c.text === '本を読む'));
  await page.keyboard.press('Control+/');
  const list = page.getByRole('dialog', { name: 'ほかの候補', exact: true });
  await list.waitFor();
  const candidateButtons = list.getByRole('list', { name: '同じ読みの候補' }).getByRole('button');
  assert.ok(await candidateButtons.count() > 1);
  const selected = await candidateButtons.nth(1).locator('span').textContent();
  release();
  await page.waitForTimeout(200);
  assert.equal(await candidateButtons.nth(1).locator('span').textContent(), selected, 'Late ranking must not reorder an open list');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  assert.equal(await candidateButtons.nth(1).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await ghost.textContent(), selected, 'Late ranking must not move the selected candidate');
  assert.equal(modelCalls, 1, 'Stored candidate navigation must not call the model');
  await page.keyboard.press('Tab');
  assert.equal(await documentText(page), selected);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('romaji-kana-conversion-learning-v1'))[0].text), selected);
  await page.keyboard.press('Control+/');
  await list.waitFor();
  await candidateButtons.first().click();
  await ghost.waitFor();
  assert.equal(modelCalls, 1, 'History alternatives also use the retained candidate set');
  await page.keyboard.press('Escape');

  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n'.repeat(80) + 'end');
  await page.locator('.cm-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: /履歴を開く/ }).click();
  await page.locator('.history-item').first().getByRole('button', { name: 'ほかの候補', exact: true }).click();
  await list.waitFor();
  const historyButton = list.locator('.candidate-list-options button[aria-pressed="false"]').first();
  const historyText = await historyButton.locator('span').textContent();
  await historyButton.click();
  await page.keyboard.press('Tab');
  assert.equal(await documentText(page), historyText + '\n'.repeat(80) + 'end', 'Offscreen history must scroll into view and return focus for Tab acceptance');
  assert.equal(modelCalls, 1, 'History list selection must not generate');

  await typeInput('kisha');
  await page.waitForTimeout(100);
  const accepted = await ghost.textContent();
  await page.keyboard.press('Tab');
  release();
  await page.waitForTimeout(250);
  assert.equal(await documentText(page), accepted);
  assert.equal(await ghost.count(), 0, 'An accepted session must not be resurrected by ranking');

  await typeInput('honwoyomu');
  await page.waitForTimeout(100);
  await page.keyboard.press('Escape');
  release();
  await page.waitForTimeout(250);
  assert.equal(await documentText(page), 'honwoyomu');
  assert.equal(await ghost.count(), 0, 'A dismissed session must not be resurrected');

  // Canceling the request must also revoke its already displayed candidates.
  const rankingRequest = page.waitForRequest(request => request.url().endsWith('/api/generate') && request.postDataJSON().prompt !== 'ok');
  await typeInput('honwoyomu');
  await rankingRequest;
  await page.getByRole('button', { name: /履歴を開く/ }).click();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  assert.equal(await ghost.count(), 0, 'Canceled local candidates must disappear immediately');
  await page.getByRole('button', { name: '履歴 を閉じる', exact: true }).click();
  release();
  // Browser cancellation may abort the request instead of delivering a response.
  await page.waitForTimeout(150);
  assert.equal(await ghost.count(), 0, 'Late ranking must not restore a canceled candidate');
  await editor.focus();
  await page.keyboard.press('Tab');
  assert.notEqual(await documentText(page), '本を読む', 'Tab must not accept the canceled candidate');

  await page.getByRole('button', { name: /辞書を開く/ }).click();
  await page.getByRole('tab', { name: /個人語彙/ }).click();
  await page.getByLabel('個人語彙のかな読み').fill('てすとしゃ');
  await page.getByLabel('個人語彙の表記').fill('試験社');
  await page.getByLabel('個人語彙の種類').selectOption('organization');
  await page.getByRole('button', { name: '語彙を追加', exact: true }).click();
  await page.getByRole('button', { name: '試験社 を個人語彙から削除' }).waitFor();
  await page.getByRole('button', { name: '辞書 を閉じる' }).click();
  await typeInput('tesutosha');
  await page.waitForTimeout(100);
  assert.ok(latestCandidates.some(c => c.text === '試験社'));
  await page.keyboard.press('Escape'); release();
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: '変換を開く', exact: true }).click();
  assert.equal(await page.getByRole('radiogroup', { name: '入力補完レベル' }).count(), 0);
  await page.getByRole('button', { name: '変換 を閉じる' }).click();
  await context.close();
  console.log('Local engine E2E passed: real dictionary, held candidates, late ranking, cancellation, learning, personal words, current conversion UI.');
} finally { await browser?.close(); await server.close(); }

async function documentText(page) {
  return page.locator('.cm-content').evaluate(content => [...content.querySelectorAll('.cm-line')].map(line => {
    const copy = line.cloneNode(true); copy.querySelectorAll('[contenteditable="false"]').forEach(node => node.remove());
    return copy.textContent;
  }).join('\n'));
}
