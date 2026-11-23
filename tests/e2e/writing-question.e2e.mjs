import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { artifactPath } from '../helpers/artifacts.mjs';

const server = await createServer({ cacheDir: artifactPath('cache/e2e-writing-question'), server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('romaji-kana-document-session', JSON.stringify({ kind: 'new', content: '' }));
  });
  const generated = '試験に必要な日数を見直してから、改めて公開日を決める。';
  await page.route('**/api/generate', route => route.fulfill({ json: { response: generated } }));
  await page.goto(server.resolvedUrls.local[0]);
  const editor = page.locator('.cm-content');
  const hint = page.locator('.writing-question');
  await editor.click();
  await page.keyboard.insertText('公開を来週に延期した');
  assert.equal(await hint.count(), 0);
  await page.keyboard.insertText('。');
  await hint.waitFor({ timeout: 5000 });
  assert.equal(await hint.getByRole('status').textContent(), '判断の決め手は何だった？');
  assert.ok(!(await editor.innerText()).includes('決め手'));
  await hint.getByRole('button', { name: generated }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await hint.waitFor({ state: 'hidden' });
  await page.keyboard.press('Enter');
  assert.equal(await hint.count(), 0);
  await page.keyboard.insertText('辞書を試した');
  await page.keyboard.insertText('、');
  await hint.waitFor();
  assert.match(await hint.textContent(), /辞書/);
  const candidate = hint.getByRole('button').first();
  const text = await candidate.innerText();
  assert.match(text, /辞書.+。$/u);
  await candidate.click();
  assert.ok((await editor.innerText()).endsWith('辞書を試した、' + text));
  await hint.waitFor({ state: 'hidden' });
  await page.keyboard.press('Control+z');
  assert.ok((await editor.innerText()).endsWith('辞書を試した、'));
  await page.keyboard.insertText('続き');
  await hint.waitFor({ state: 'hidden' });
  await page.keyboard.insertText('。');
  await hint.waitFor();
  await page.keyboard.press('Enter');
  await hint.waitFor({ state: 'hidden' });
  console.log('Writing question E2E passed.');
} finally {
  await browser?.close();
  await server.close();
}
