import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { artifactPath, screenshotPath } from "../helpers/artifacts.mjs";

const TEST_MODELS = [
  { name: "gemma4:latest", modified_at: "2026-01-01T00:00:00Z", size: 1 },
  { name: "qwen3.5:0.8b", modified_at: "2026-01-02T00:00:00Z", size: 2 },
];

const server = await createServer({
  cacheDir: artifactPath("cache/e2e"),
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
  },
});

let browser;

try {
  await server.listen();
  const appUrl = server.resolvedUrls?.local[0];
  assert.ok(appUrl, "Vite did not expose a local test URL.");

  browser = await chromium.launch({ headless: true });
  const firstRunContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const firstRunPage = await firstRunContext.newPage();
  await firstRunPage.goto(appUrl);
  await firstRunPage.getByRole("region", { name: "Markdownエディター" }).waitFor();
  const themeSelect = firstRunPage.getByRole("combobox", { name: "表示テーマ" });
  await firstRunPage.emulateMedia({ colorScheme: "dark" });
  await firstRunPage.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await firstRunPage.waitForFunction(() => getComputedStyle(document.querySelector(".rail-button")).color === "rgb(224, 233, 237)");
  const contrastRatios = await firstRunPage.evaluate(() => {
    const luminance = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    return [[".cm-content", ".cm-editor"], [".rail-button", ".app-rail"], [".theme-select", ".app-titlebar"]].map(([fg, bg]) => {
      const a = luminance(getComputedStyle(document.querySelector(fg)).color);
      const b = luminance(getComputedStyle(document.querySelector(bg)).backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  });
  assert.ok(contrastRatios.every(ratio => ratio >= 4.5), `Dark text contrast: ${contrastRatios}`);
  assert.equal(await themeSelect.inputValue(), "system");
  await themeSelect.selectOption("light");
  await firstRunPage.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await firstRunPage.reload();
  assert.equal(await themeSelect.inputValue(), "light");
  await themeSelect.selectOption("dark");
  await firstRunPage.emulateMedia({ colorScheme: "light" });
  assert.equal(await firstRunPage.locator("html").getAttribute("data-theme"), "dark");
  await themeSelect.selectOption("system");
  await firstRunPage.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await firstRunPage.emulateMedia({ colorScheme: "dark" });
  await firstRunPage.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await firstRunPage.setViewportSize({ width: 390, height: 844 });
  const selectorBounds = await themeSelect.boundingBox();
  assert.ok(selectorBounds && selectorBounds.x >= 0 && selectorBounds.x + selectorBounds.width <= 390);
  if (process.env.E2E_CANDIDATE_SCREENSHOT) {
    await firstRunPage.screenshot({ path: await screenshotPath(process.env.E2E_CANDIDATE_SCREENSHOT + ".mobile.png") });
  }
  assert.equal(
    await firstRunPage.getByRole("dialog").count(),
    0,
    "First run should open directly in the document instead of blocking typing with setup.",
  );
  await firstRunContext.close();

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem('romaji-kana-settings', JSON.stringify({ autoConvert: false, conversionMode: 'ghost' }));
    localStorage.setItem('romaji-kana-document-session', JSON.stringify({ kind: 'new', content: 'restored draft' }));
  });
  const page = await context.newPage();
  let modelCalls = 0;
  await page.route('**/api/tags', route => route.fulfill({ json: { models: TEST_MODELS } }));
  await page.route('**/api/generate', route => {
    if (route.request().postDataJSON().prompt !== 'ok') modelCalls++;
    return route.fulfill({ json: { response: 'ok' } });
  });
  await page.route('**/api/kana-engine', route => {
    const { operation, reading } = route.request().postDataJSON();
    assert.equal(operation, 'search');
    assert.equal(reading, 'きしゃ');
    return route.fulfill({ json: { candidates: [{ text: '記者', reading, cost: 100,
      tokens: [{ text: '記者', reading, from: 0, to: 3, source: 'mozc', entryId: 'test', lid: 0, rid: 0, wordCost: 100 }] }],
      truncated: false, dictionaryRevision: 'test' } });
  });
  await page.goto(appUrl);
  const editor = page.locator('.cm-content');
  assert.equal(await editor.innerText(), 'restored draft');
  await editor.click(); await page.keyboard.press('Control+A'); await page.keyboard.type('kisha');
  const lineBefore = await editor.locator('.cm-line').boundingBox();
  await page.keyboard.press('Control+Enter');
  await page.locator('.cm-ghost-text-suggestion').waitFor();
  const preview = page.getByRole('dialog', { name: '変換候補', exact: true });
  await preview.waitFor();
  assert.equal(await editor.innerText(), 'kisha', 'Preview controls must remain outside document text');
  assert.equal((await editor.locator('.cm-line').boundingBox()).height, lineBefore.height, 'Preview must not change line height');
  assert.notEqual(await preview.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: await screenshotPath('test-results/e2e/conversion-preview-desktop.png') });
  await page.getByRole('combobox', { name: '表示テーマ' }).selectOption('dark');
  await page.screenshot({ path: await screenshotPath('test-results/e2e/conversion-preview-dark.png') });
  await page.getByRole('combobox', { name: '表示テーマ' }).selectOption('light');
  await page.keyboard.press('Control+/');
  const list = page.getByRole('dialog', { name: 'ほかの候補', exact: true });
  await list.waitFor();
  assert.equal(await list.getByRole('button', { name: '同じ読みの候補を探す', exact: true }).count(), 0);
  assert.equal(await list.getByRole('button', { name: '読みも含めて見直す', exact: true }).count(), 1);
  assert.equal(modelCalls, 0, 'Opening dictionary candidates must not invoke legacy generation');
  assert.equal(await list.getAttribute('aria-modal'), 'false');
  await page.keyboard.press('ArrowDown');
  assert.equal(await list.locator('.candidate-list-options button').evaluate(el => el === document.activeElement), true);
  await page.screenshot({ path: await screenshotPath('test-results/e2e/conversion-alternatives-desktop.png') });
  await editor.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await list.count(), 0, 'Moving the editor selection must close the list');
  await page.keyboard.press('Control+/');
  await list.waitFor();
  await page.keyboard.press('Escape');
  await preview.getByRole('button', { name: '確定 Tab', exact: true }).click();
  assert.equal(await editor.innerText(), '記者');
  await page.getByRole('button', { name: /変換を開く/ }).click();
  const conversionSettings = page.getByRole('region', { name: '変換設定', exact: true });
  await conversionSettings.getByRole('heading', { name: '変換の開始', exact: true }).waitFor();
  assert.equal(await conversionSettings.getByRole('checkbox', { name: '入力が止まったら変換', exact: true }).isDisabled(), true);
  await conversionSettings.getByRole('checkbox', { name: '自動変換', exact: true }).check();
  await conversionSettings.getByText('長め', { exact: true }).click();
  await conversionSettings.getByRole('button', { name: /^キー操作/ }).click();
  await conversionSettings.getByRole('checkbox', { name: 'Spaceで変換', exact: true }).uncheck();
  await conversionSettings.getByRole('button', { name: '直接置換', exact: true }).click();
  await conversionSettings.getByRole('button', { name: /^詳細設定/ }).click();
  await conversionSettings.getByRole('checkbox', { name: '. を 。に置き換える', exact: true }).uncheck();
  const changed = await page.evaluate(() => JSON.parse(localStorage.getItem('romaji-kana-settings')));
  assert.equal(changed.inputPauseTiming, 'deliberate');
  assert.equal(changed.triggers.space, false);
  assert.equal(changed.conversionMode, 'replace');
  assert.equal(changed.punctuationConversion.periodToJapanese, false);
  await conversionSettings.getByRole('button', { name: /^詳細設定/ }).click();
  await conversionSettings.getByRole('button', { name: /^キー操作/ }).click();
  await page.locator('.inspector-body').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: await screenshotPath('test-results/e2e/conversion-settings-desktop.png') });
  assert.equal(await page.getByLabel('通常変換の方式').count(), 0);
  assert.equal(await page.getByRole('radiogroup', { name: '入力補完レベル' }).count(), 0);
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('romaji-kana-settings')));
  assert.equal('conversionEngine' in settings, false);
  assert.equal('inputCompletionLevel' in settings, false);
  await page.setViewportSize({ width: 390, height: 520 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('combobox', { name: '表示テーマ' }).selectOption('dark');
  await page.screenshot({ path: await screenshotPath('test-results/e2e/conversion-settings-mobile-dark.png') });
  console.log('App E2E passed: themes, responsive layout, restored document, dictionary conversion and current settings contract.');
  await context.close();
} finally { await browser?.close(); await server.close(); }
