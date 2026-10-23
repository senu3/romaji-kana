import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { artifactPath, screenshotPath } from '../helpers/artifacts.mjs';

const server = await createServer({ cacheDir: artifactPath('cache/e2e-dictionary'), server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    if (localStorage.getItem('dictionary-test-seeded')) return;
    localStorage.setItem('dictionary-test-seeded', 'true');
    localStorage.setItem('romaji-kana-document-session', JSON.stringify({ kind: 'new', content: '航海を記録する。' }));
    localStorage.setItem('romaji-kana-settings', JSON.stringify({ autoConvert: false }));
    localStorage.setItem('romaji-kana-conversion-learning-v1', JSON.stringify([
      { reading: 'こうかい', text: '後悔', count: 2, updated: Date.now() },
      { reading: 'こうかい', text: '航海', count: 1, updated: Date.now() },
    ]));
  });
  const page = await context.newPage();
  await page.route('**/api/tags', route => route.abort('connectionrefused'));
  await page.route('**/api/generate', route => route.abort('connectionrefused'));
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('button', { name: /辞書を開く/ }).click();
  const panel = page.getByRole('region', { name: '辞書項目' });
  assert.equal(await panel.getByRole('tabpanel').count(), 1);
  assert.equal(await panel.getByRole('tab', { name: /スニペット/ }).count(), 0);
  await panel.getByRole('tab', { name: /文書から検出/ }).click();
  await panel.getByRole('button', { name: '航海 を個人語彙に追加', exact: true }).click();
  await panel.getByRole('textbox', { name: '検出語彙のかな読み' }).fill('コウカイ');
  await panel.getByRole('button', { name: '個人語彙に追加', exact: true }).click();
  await panel.getByRole('button', { name: '航海 は個人語彙に登録済み' }).waitFor();
  assert.equal(await panel.getByRole('button', { name: '航海 は個人語彙に登録済み' }).isDisabled(), true);
  await panel.getByRole('checkbox').check();
  await panel.getByRole('tab', { name: /個人語彙/ }).click();
  await panel.getByRole('checkbox', { name: '有効' }).uncheck();
  await panel.getByRole('tab', { name: /文書から検出/ }).click();
  await panel.getByRole('button', { name: '航海 の個人語彙を有効にする' }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('romaji-kana-settings')).personalDictionary?.[0]?.enabled);
  await panel.getByRole('tab', { name: '学習履歴' }).click();
  await panel.getByRole('button', { name: 'こうかい → 後悔 の学習を削除' }).click();
  assert.equal(await panel.getByRole('button', { name: 'こうかい → 後悔 の学習を削除' }).count(), 0);
  await panel.getByRole('button', { name: '学習履歴をすべて削除' }).click();
  assert.ok((await panel.innerText()).includes('学習履歴はありません'));
  await page.reload();
  await page.getByRole('button', { name: /辞書を開く/ }).click();
  assert.ok((await panel.innerText()).includes('こうかい'));
  await panel.getByRole('tab', { name: /文書から検出/ }).click();
  assert.equal(await panel.getByRole('checkbox').isChecked(), true);
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('romaji-kana-settings')));
  assert.equal(settings.personalDictionary.length, 1);
  assert.equal(settings.userDictionary, undefined);
  await page.screenshot({ path: await screenshotPath('test-results/e2e/dictionary-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: await screenshotPath('test-results/e2e/dictionary-mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log('Dictionary E2E passed: detected registration, reactivation, learning deletion, persistence, narrow layout.');
} finally { await browser?.close(); await server.close(); }
