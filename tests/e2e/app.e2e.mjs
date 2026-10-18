import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const TEST_MODELS = [
  { name: "gemma4:latest", modified_at: "2026-01-01T00:00:00Z", size: 1 },
  { name: "qwen3.5:0.8b", modified_at: "2026-01-02T00:00:00Z", size: 2 },
];

const server = await createServer({
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
    await firstRunPage.screenshot({ path: process.env.E2E_CANDIDATE_SCREENSHOT + ".mobile.png" });
  }
  assert.equal(
    await firstRunPage.getByRole("dialog").count(),
    0,
    "First run should open directly in the document instead of blocking typing with setup.",
  );
  await firstRunContext.close();

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.clear();
    // Keep the legacy model-contract regression suite independent of dictionary coverage.
    // The real Rust-engine UI is exercised in local-engine.e2e.mjs.
    localStorage.setItem("romaji-kana-settings", JSON.stringify({ conversionEngine: "llm" }));
    localStorage.setItem(
      "romaji-kana-document-session",
      JSON.stringify({ kind: "new", content: "restored unsaved draft." }),
    );
  });

  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  let conversionRequestCount = 0;
  let activeConversionRequests = 0;
  let maxActiveConversionRequests = 0;
  const conversionPrompts = [];
  const conversionSystems = [];
  await page.route("**/api/tags", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ models: TEST_MODELS }),
    });
  });
  await page.route("**/api/generate", async (route) => {
    const body = route.request().postDataJSON();
    const target = body.prompt?.split("Prepared kana (conversion target):\n")[1]?.trim() ?? body.prompt;
    if (body.prompt) {
      conversionRequestCount += 1;
      conversionPrompts.push(target);
      conversionSystems.push(body.system ?? "");
      activeConversionRequests += 1;
      maxActiveConversionRequests = Math.max(maxActiveConversionRequests, activeConversionRequests);
      if (
        body.prompt === "いち。" ||
        body.prompt?.trim() === "あした" ||
        body.prompt?.trim() === "あしたかいぎ" ||
        body.prompt?.trim() === "あしたかいぎのて"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    const response = conversionResponseForPrompt(body.prompt, body.system ?? "");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ response }),
    });
    if (body.prompt) {
      activeConversionRequests -= 1;
    }
  });

  await page.goto(`${appUrl}?setup=1`);
  await page.getByRole("heading", { name: "最初のモデル設定" }).waitFor();
  const setupDialog = page.getByRole("dialog", { name: "最初のモデル設定" });
  await setupDialog.waitFor();
  assert.equal(await editorText(page), "restored unsaved draft.");
  await assertVisibleText(page, "設定");

  await setupDialog.locator("label").filter({ hasText: "Ollama" }).click();
  const setupProviderSegmentVisual = await selectedSegmentVisual(
    setupDialog.locator(".provider-control label.selected"),
  );
  await setupDialog.getByRole("button", { name: "接続チェック" }).click();
  await waitForVisibleText(page, 'Ollama に接続しましたが、"gemma3" は見つかりませんでした。候補: "gemma4:latest".');
  await setupDialog.getByRole("combobox").selectOption("gemma4:latest");
  await setupDialog.getByRole("button", { name: "接続チェック" }).click();
  await waitForVisibleText(page, 'Ollama に接続しました。"gemma4:latest" を読み込みました。利用可能なモデル: 2 件。');
  await page.getByRole("button", { name: "書き始める" }).click();
  await setupDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "変換を開く", exact: true }).click();
  const applyMethodSegment = page
    .getByRole("group", { name: "変換結果の適用方法" })
    .locator("button.selected");
  assert.equal(await page.getByRole("radiogroup", { name: "入力補完レベル" }).count(), 0);
  const expectedSegmentVisual = await selectedSegmentVisual(applyMethodSegment);
  assert.deepEqual(
    await page
      .locator(".conversion-result-settings")
      .evaluateAll((sections) =>
        sections.map((section) => getComputedStyle(section).borderBottomWidth),
      ),
    ["0px"],
    "Conversion panel sections should use spacing instead of stray horizontal rules.",
  );
  assert.deepEqual(
    setupProviderSegmentVisual,
    expectedSegmentVisual,
    "Setup provider and conversion controls should share the same selected-state colors.",
  );
  await page
    .locator(".inspector-drawer .accordion-trigger")
    .filter({ hasText: "変換タイミング" })
    .click();
  assert.equal(
    await page.getByLabel("入力停止後に候補を生成").isChecked(),
    true,
    "Pause-triggered suggestions should be enabled by default.",
  );
  assert.equal(
    await page.getByRole("radio", { name: "自動", exact: true }).isChecked(),
    true,
    "Input pause timing should adapt to typing speed by default.",
  );
  await page.getByLabel("Enterで変換（IME 変換中は無視）").check();
  assert.equal(
    await page.getByLabel("Enterで変換（IME 変換中は無視）").isChecked(),
    true,
    "Enter trigger checkbox should be enabled before editor input.",
  );
  await page.waitForFunction(() => {
    const rawSettings = localStorage.getItem("romaji-kana-settings");
    if (!rawSettings) {
      return false;
    }
    return JSON.parse(rawSettings).triggers?.enter === true;
  });

  await page.getByRole("button", { name: "変換 を閉じる" }).click();
  await page.getByRole("button", { name: "モデルを開く", exact: true }).click();
  const modelDrawer = page.getByRole("dialog", { name: "モデル" });
  await assertLocatorValue(modelDrawer.getByRole("combobox"), "gemma4:latest");
  assert.deepEqual(
    await selectedSegmentVisual(modelDrawer.locator(".provider-control label.selected")),
    expectedSegmentVisual,
    "Model provider and conversion controls should share the same selected-state colors.",
  );
  await page.getByRole("button", { name: "モデル を閉じる" }).click();

  // Editing an earlier typo must regenerate the complete unfinished phrase,
  // even after its first candidate has been dismissed.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  const typoPhrase = "ashitanoyottei";
  await page.keyboard.type(typoPhrase);
  await page.locator(".cm-ghost-source").waitFor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Home");
  for (let index = 0; index < typoPhrase.indexOf("tt") + 1; index++) {
    await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("Delete");
  await page.waitForFunction(() =>
    document.querySelector(".cm-ghost-source")?.textContent === "ashitanoyotei",
  );
  assert.equal(await page.locator(".cm-ghost-source").textContent(), "ashitanoyotei");
  await page.keyboard.press("Escape");

  conversionRequestCount = 0;
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("ai");
  await page.waitForTimeout(180);
  assert.equal(
    conversionRequestCount,
    0,
    "Even a short input burst should wait for the pause threshold.",
  );
  await waitForCondition(
    () => conversionRequestCount === 1,
    "A short input burst should generate after input stops without a character minimum.",
  );
  await page.locator(".cm-ghost-source").waitFor();
  await page.keyboard.press("Escape");

  conversionRequestCount = 0;
  await page.keyboard.press("Control+A");
  await page.keyboard.type("ashita");
  await waitForCondition(
    () => conversionRequestCount === 1,
    "A candidate should be ready before punctuation commits it.",
  );
  await page.locator(".cm-ghost-source").waitFor();
  await acceptUnverifiedCandidate(page, "明日");
  await page.keyboard.press(".");
  await waitForEditorText(page, "明日.");
  await page.waitForTimeout(500);
  assert.equal(
    conversionRequestCount,
    1,
    "A period should commit the visible candidate without another model request.",
  );
  await page.keyboard.press("Control+Z");
  await waitForEditorText(page, "ashita");
  assert.equal(
    await editorText(page),
    "ashita",
    "Undo should restore the original after explicit adoption and punctuation.",
  );

  conversionRequestCount = 0;
  await page.keyboard.press("Control+A");
  await page.keyboard.type("ashita");
  await waitForCondition(
    () => conversionRequestCount === 1,
    "A candidate should be ready before comma commits it.",
  );
  await page.locator(".cm-ghost-source").waitFor();
  await acceptUnverifiedCandidate(page, "明日");
  await page.keyboard.press(",");
  await waitForEditorText(page, "明日,");
  await page.waitForTimeout(500);
  assert.equal(
    conversionRequestCount,
    1,
    "A comma should commit the visible candidate without another model request.",
  );

  conversionRequestCount = 0;
  await page.keyboard.press("Control+A");
  await page.keyboard.type("ashita");
  await page.locator(".cm-ghost-text-suggestion").filter({ hasText: "明日" }).waitFor();
  await page.keyboard.press(".");
  assert.equal(await editorText(page), "ashita.", "Punctuation must not implicitly accept unverified Kanji.");
  assert.equal(conversionRequestCount, 1);

  conversionRequestCount = 0;
  await page.keyboard.press("Control+A");
  await page.keyboard.type("ashitakaigi");
  await page.waitForTimeout(180);
  assert.equal(
    conversionRequestCount,
    0,
    "A predictive request should not start while the input burst is still active.",
  );
  await waitForCondition(
    () => conversionRequestCount === 1,
    "The first predictive request should start after input stops.",
  );
  await page.keyboard.type("note");
  await page.waitForFunction(
    () => document.querySelector(".cm-ghost-source")?.textContent === "ashitakaigi",
  );
  assert.equal(
    await page.locator(".cm-ghost-source").textContent(),
    "ashitakaigi",
    "A completed candidate should remain visible after input continues.",
  );
  await page.locator(".cm-ghost-text-suggestion").filter({ hasText: "明日会議の手" }).waitFor();
  assert.equal(
    await page.locator(".cm-ghost-source").textContent(),
    "ashitakaiginote",
    "The displayed candidate should update to the newest queued source.",
  );
  await page.keyboard.press("Tab");
  await waitForEditorText(page, "明日会議の手");
  await page.waitForTimeout(400);
  assert.equal(
    await editorText(page),
    "明日会議の手",
    "A stale response must not replace the latest result.",
  );
  assert.equal(conversionRequestCount, 2, "Continuous input should keep only one latest queued request.");

  await page.getByRole("button", { name: "変換を開く", exact: true }).click();
  await page
    .locator(".inspector-drawer .accordion-trigger")
    .filter({ hasText: "変換タイミング" })
    .click();
  await page.getByLabel("入力停止後に候補を生成").uncheck();
  await page.getByLabel("Spaceで候補を生成").uncheck();
  await page.getByRole("button", { name: "変換 を閉じる" }).click();

  conversionRequestCount = 0;
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("anatahadaredesuka");
  await waitForEditorText(page, "anatahadaredesuka");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  assert.equal(
    conversionRequestCount,
    1,
    `Enter should trigger conversion. Editor text: ${await page.locator(".cm-content").textContent()}`,
  );
  await acceptUnverifiedCandidate(page, "あなたは誰ですか。");
  await waitForEditorText(page, "あなたは誰ですか。");
  assert.deepEqual((await editorLines(page)).slice(0, 2), ["あなたは誰ですか。", ""]);
  assert.equal(conversionRequestCount, 1, "Enter should trigger exactly one conversion.");
  await page.getByRole("button", { name: "元に戻す" }).click();
  await waitForEditorText(page, "anatahadaredesuka");
  await page.waitForTimeout(300);
  assert.equal(conversionRequestCount, 1, "Undo should not re-trigger conversion.");

  conversionRequestCount = 0;
  conversionPrompts.length = 0;
  await page.getByRole("button", { name: "自動変換をオフにする", exact: true }).click();
  await page.waitForFunction(() => {
    const rawSettings = localStorage.getItem("romaji-kana-settings");
    return rawSettings ? JSON.parse(rawSettings).autoConvert === false : false;
  });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("ichi.");
  await page.waitForTimeout(300);
  assert.equal(conversionRequestCount, 0, "Auto conversion should stop while the toolbar toggle is off.");
  await page.keyboard.press("Control+Enter");
  await acceptUnverifiedCandidate(page, "一。");
  await waitForEditorText(page, "一。");
  assert.equal(conversionRequestCount, 1, "Manual conversion should remain available while auto conversion is off.");
  await page.getByRole("button", { name: "自動変換をオンにする", exact: true }).click();
  await page.waitForFunction(() => {
    const rawSettings = localStorage.getItem("romaji-kana-settings");
    return rawSettings ? JSON.parse(rawSettings).autoConvert === true : false;
  });

  conversionRequestCount = 0;
  conversionPrompts.length = 0;
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("ichi.");
  await acceptUnverifiedCandidate(page, "一。");
  await page.keyboard.press("Enter");
  await page.keyboard.type("ni.");
  await waitForEditorText(page, "一。");
  await acceptUnverifiedCandidate(page, "二。");
  await waitForEditorText(page, "二。");
  await page.waitForTimeout(300);
  assert.deepEqual(conversionPrompts, ["いち。", "に。"]);
  assert.equal(
    conversionRequestCount,
    2,
    "Enter after a period-triggered conversion should not queue a duplicate conversion while typing continues on the next line.",
  );
  assert.deepEqual((await editorLines(page)).slice(0, 2), ["一。", "二。"]);

  await page.keyboard.press("Control+A");
  await page.keyboard.type("already written ashita no yotei");
  await waitForEditorText(page, "already written ashita no yotei");
  for (let index = 0; index < "ashita no yotei".length; index += 1) {
    await page.keyboard.press("Shift+ArrowLeft");
  }
  conversionRequestCount = 0;
  conversionPrompts.length = 0;
  await page.keyboard.press("Control+Enter");
  await acceptUnverifiedCandidate(page, "明日の予定");
  await waitForEditorText(page, "already written 明日の予定");
  assert.deepEqual(
    conversionPrompts,
    ["あしたのよてい"],
    "Manual shortcut should preserve the selected phrase as one contextual conversion.",
  );

  conversionRequestCount = 0;
  activeConversionRequests = 0;
  maxActiveConversionRequests = 0;
  conversionPrompts.length = 0;
  conversionSystems.length = 0;
  await page.keyboard.press("Control+A");
  await page.keyboard.type("ichi.");
  await page.keyboard.type("ni.");
  await acceptUnverifiedCandidate(page, "二。");
  assert.equal(await editorText(page), "ichi.二。");
  assert.deepEqual(conversionPrompts, ["いち。", "に。"]);
  await page.keyboard.press("Control+Home");
  for (let index = 0; index < 5; index++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+Enter");
  await acceptUnverifiedCandidate(page, "一。");
  await waitForEditorText(page, "一。二。");
  assert.deepEqual(conversionPrompts, ["いち。", "に。", "いち。"]);
  assert.equal(conversionRequestCount, 3, "Unverified candidates require explicit adoption; the remaining range can be requested again.");
  assert.equal(maxActiveConversionRequests, 1, "Conversions should run sequentially.");

  conversionRequestCount = 0;
  conversionPrompts.length = 0;
  conversionSystems.length = 0;
  await page.getByRole("button", { name: /履歴を開く/ }).click();
  await page
    .locator(".history-item")
    .filter({ hasText: "ichi." })
    .first()
    .getByRole("button", { name: "別候補" })
    .click();
  await acceptUnverifiedCandidate(page, "壱。");
  await waitForEditorText(page, "壱。二。");
  assert.deepEqual(conversionPrompts, ["いち。"]);
  assert.ok(
    conversionSystems[0]?.includes("Avoid returning these previous outputs exactly:"),
    "History Try again should ask for an alternative candidate.",
  );
  await page.getByRole("button", { name: /履歴を開く/ }).click();
  assert.ok(
    (await page.locator(".history-item").count()) >= 2,
    "History should remain available after Try again closes the panel.",
  );
  await page
    .locator(".history-item")
    .first()
    .getByText("壱。")
    .waitFor();
  await page.getByRole("button", { name: "履歴 を閉じる" }).click();

  await page.keyboard.press("Control+N");
  await page.waitForFunction(() => {
    const text = document.querySelector(".cm-content")?.textContent ?? "";
    return text === "" || text === "romaji で日本語を書いてください...";
  });
  assert.equal(await editorText(page), "", "New file shortcut should clear the editor.");

  await page.locator(".cm-content").click();
  await page.keyboard.type("first line");
  await page.getByText("行 1, 列 11").waitFor();
  await page.getByText("10 文字").waitFor();
  await page.getByRole("button", { name: "検索と置換" }).click();
  await page.getByRole("textbox", { name: "検索" }).waitFor();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();

  await page.getByRole("button", { name: "辞書を開く" }).click();
  await page.getByRole("dialog", { name: "辞書" }).waitFor();
  await page.getByRole("tab", { name: /登録済み/ }).click();
  const dictionaryInputs = page.locator(".dictionary-add-form input");
  await dictionaryInputs.nth(0).fill("openai");
  await dictionaryInputs.nth(1).fill("OpenAI");
  await dictionaryInputs.nth(2).fill("company name");
  await page.getByRole("button", { name: "追加" }).click();
  await assertLocatorValue(page.getByLabel("辞書の出力 1"), "OpenAI");
  await page.getByRole("button", { name: "辞書 を閉じる" }).click();
  await page
    .getByRole("button", { name: "辞書を開く、1 件有効" })
    .waitFor();

  await page.getByRole("button", { name: "モデル設定を開く" }).click();
  const modelSettingsDialog = page.getByRole("dialog", { name: "モデル設定" });
  assert.equal(
    await modelSettingsDialog.getByRole("option", { name: "qwen3.5:0.8b" }).count(),
    1,
  );
  await modelSettingsDialog.getByRole("button", { name: "モデル設定を閉じる" }).click();

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(
    "要件定義を確認します。\n要件定義を更新します。\nローカルモデルを確認します。\n",
  );
  await page.getByRole("button", { name: "辞書を開く、1 件有効" }).click();
  await page.getByRole("tab", { name: /文書から検出/ }).click();
  await page.getByRole("button", { name: "要件定義 を辞書に追加" }).waitFor();
  await page.getByRole("button", { name: "ローカルモデル を辞書に追加" }).waitFor();
  await page.getByLabel("文書の語彙に合わせる").check();
  await page.getByRole("button", { name: "要件定義 を辞書に追加" }).click();
  await page.getByLabel("検出語彙の Romaji reading").fill("youkenteigi");
  await page.getByLabel("検出語彙のメモ").fill("文書で検出");
  await assertLocatorValue(page.getByLabel("検出語彙の Romaji reading"), "youkenteigi");
  await page.getByRole("button", { name: "辞書に追加", exact: true }).click();
  await page.getByText("要件定義 を辞書に追加しました。").waitFor();
  await page.getByRole("button", { name: "辞書 を閉じる" }).click();

  await page.getByRole("button", { name: "変換を開く" }).click();
  await page.getByRole("region", { name: "変換設定" }).waitFor();
  assert.equal(await page.getByRole("radiogroup", { name: "入力補完レベル" }).count(), 0);
  await page.getByRole("button", { name: "変換 を閉じる" }).click();

  conversionRequestCount = 0;
  conversionPrompts.length = 0;
  conversionSystems.length = 0;
  await page.getByRole("button", { name: "変換を開く", exact: true }).click();
  await page
    .getByRole("group", { name: "変換結果の適用方法" })
    .getByRole("button", { name: "候補を表示", exact: true })
    .click();
  await page.getByRole("button", { name: "変換 を閉じる" }).click();
  await page.waitForFunction(() => {
    const rawSettings = localStorage.getItem("romaji-kana-settings");
    if (!rawSettings) {
      return false;
    }
    return JSON.parse(rawSettings).conversionMode === "ghost";
  });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("san.");
  await page.waitForTimeout(500);
  assert.ok(
    conversionRequestCount > 0,
    `Ghost mode period trigger should request a conversion. Editor text: ${await editorText(page)}`,
  );
  assert.notEqual(
    await editorText(page),
    "三。",
    "Ghost mode should show a suggestion instead of replacing the editor text immediately.",
  );
  assert.ok(
    (await page.locator(".cm-ghost-text-hint").count()) > 0,
    `Ghost mode should render a suggestion widget. Editor text: ${await editorText(page)} Status: ${
      (await page.locator(".status-bar").textContent()) ?? ""
    }`,
  );
  await page.locator(".cm-ghost-text-hint").filter({ hasText: "Ctrl/Cmd+/で別候補" }).waitFor();
  await page.locator(".cm-ghost-text-suggestion").filter({ hasText: "三。" }).waitFor();
  assert.equal(await editorText(page), "san.", "A displayed candidate must not count as committed document text.");
  await page.keyboard.press("Control+/");
  await page.locator(".cm-ghost-text-suggestion").filter({ hasText: "参。" }).waitFor();
  assert.equal(await editorText(page), "san.", "An alternative must leave the source intact until acceptance.");
  assert.deepEqual(conversionPrompts, ["さん。", "さん。"]);
  assert.ok(
    conversionSystems[1]?.includes("Avoid returning these previous outputs exactly:"),
    "Ghost retry should ask for an alternative candidate.",
  );
  await page.keyboard.press("Tab");
  await waitForEditorText(page, "参。");
  conversionRequestCount = 0;
  conversionPrompts.length = 0;
  conversionSystems.length = 0;
  await page.getByRole("button", { name: /履歴を開く/ }).click();
  await page
    .locator(".history-item")
    .filter({ hasText: "san." })
    .first()
    .getByRole("button", { name: "別候補" })
    .click();
  await page.locator(".cm-ghost-text-hint").waitFor();
  await page.locator(".cm-ghost-text-suggestion").filter({ hasText: "參。" }).waitFor();
  assert.equal(await editorText(page), "参。", "History previews must not replace committed text before Tab.");
  assert.deepEqual(conversionPrompts, ["さん。"], "History spelling exploration must retain the previous reading.");
  assert.ok(!conversionSystems[0].includes("infer a minimal romaji typo repair"));
  await page.keyboard.press("Tab");
  await waitForEditorText(page, "參。");
  await page.getByRole("button", { name: /履歴を開く/ }).click();
  await page
    .locator(".history-item")
    .first()
    .getByText("參。")
    .waitFor();
  await page.getByRole("button", { name: "履歴 を閉じる" }).click();

  await page.setViewportSize({ width: 390, height: 520 });
  assert.ok(
    await page.locator(".editor-shell").evaluate((element) => element.getBoundingClientRect().width >= 380),
    "Editor should retain the full viewport width on a narrow screen.",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    "Minimum window size should not create horizontal page overflow.",
  );
  const longUnbrokenText = "romajikana".repeat(48);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(longUnbrokenText);
  await waitForEditorText(page, longUnbrokenText);
  const editorWrapLayout = await page.locator(".cm-editor").evaluate((editor) => {
    const scroller = editor.querySelector(".cm-scroller");
    const line = editor.querySelector(".cm-line");
    if (!(scroller instanceof HTMLElement) || !(line instanceof HTMLElement)) {
      return null;
    }
    const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
    return {
      hasHorizontalOverflow: scroller.scrollWidth > scroller.clientWidth + 1,
      lineHeight: line.getBoundingClientRect().height,
      singleRowHeight: lineHeight,
    };
  });
  assert.ok(editorWrapLayout, "Editor wrapping layout should be measurable.");
  assert.equal(
    editorWrapLayout.hasHorizontalOverflow,
    false,
    "A long unbroken line should wrap instead of overflowing past the editor's right edge.",
  );
  assert.ok(
    editorWrapLayout.lineHeight > editorWrapLayout.singleRowHeight * 2,
    "A long unbroken line should occupy multiple visual rows.",
  );
  await page.getByRole("button", { name: "スマホ連携を開く", exact: true }).click();
  const companionPanel = page.locator(".inspector-body > .companion-panel");
  await companionPanel.waitFor();
  const companionInsets = await companionPanel.evaluate((panel) => {
    const body = panel.parentElement;
    const firstSection = panel.querySelector(".companion-state");
    if (!body || !(firstSection instanceof HTMLElement)) {
      return null;
    }
    const firstSectionRect = firstSection.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    return {
      left: firstSectionRect.left - bodyRect.left,
      right: bodyRect.right - firstSectionRect.right,
    };
  });
  assert.ok(companionInsets, "Smartphone panel spacing should be measurable.");
  assert.ok(
    companionInsets.left >= 18 && companionInsets.right >= 18,
    "Smartphone panel should keep comfortable horizontal padding inside the drawer.",
  );
  await page.getByRole("button", { name: "スマホ連携 を閉じる" }).click();
  await page.getByRole("button", { name: "モデルを開く", exact: true }).click();
  await page.getByRole("dialog", { name: "モデル" }).waitFor();
  await assertVisibleText(page, "接続済み");
  await page.getByRole("button", { name: "モデル を閉じる" }).click();
  assert.ok(
    await page.getByRole("button", { name: "変換を開く" }).isVisible(),
    "Conversion action should remain visible on a narrow viewport.",
  );
  assert.ok(
    await page.getByRole("button", { name: "自動変換をオフにする", exact: true }).isVisible(),
    "Auto conversion toggle should remain visible on a narrow viewport.",
  );
} finally {
  await browser?.close();
  await server.close();
}

async function assertVisibleText(page, text) {
  const matches = await page.getByText(text).all();
  for (const match of matches) {
    if (await match.isVisible()) {
      return;
    }
  }
  assert.fail(`Expected visible text: ${text}`);
}

async function assertLocatorValue(locator, expectedValue) {
  const value = await locator.inputValue();
  assert.equal(value, expectedValue);
}

async function selectedSegmentVisual(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
    };
  });
}

async function waitForVisibleText(page, text) {
  await page.getByText(text).first().waitFor();
}

async function waitForCondition(condition, message, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      assert.fail(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function editorText(page) {
  return page.evaluate(readEditorDocument);
}

async function acceptUnverifiedCandidate(page, text) {
  const original = await editorText(page);
  await page.locator(".cm-ghost-text-suggestion").filter({ hasText: text }).waitFor();
  assert.equal(await editorText(page), original, "An unverified reading must not silently replace the original.");
  await page.getByText("読み未確認。差分はモデル申告に基づく候補です。Tabで確認して採用してください。", { exact: true }).waitFor();
  await page.keyboard.press("Tab");
}

async function editorLines(page) {
  return page.evaluate(readEditorDocument, { linesOnly: true });
}

async function waitForEditorText(page, text) {
  await page.waitForFunction(readEditorDocument, { contains: text });
}

// Read document characters only. CodeMirror widgets contain candidate text,
// hints and comparisons that must not satisfy an assertion about the document.
function readEditorDocument({ contains, linesOnly } = {}) {
  const lines = Array.from(document.querySelectorAll(".cm-content .cm-line"), line => {
    const copy = line.cloneNode(true);
    copy.querySelectorAll('[contenteditable="false"], .cm-ghost-text, .cm-placeholder').forEach(widget => widget.remove());
    return copy.textContent ?? "";
  });
  if (contains !== undefined) return lines.join("\n").includes(contains);
  return linesOnly ? lines : lines.join("\n");
}

function conversionResponseForPrompt(prompt, system = "") {
  prompt = prompt?.split("Prepared kana (conversion target):\n")[1]?.trim() ?? prompt;
  if (system.includes("one speculative Japanese writing candidate")) {
    return JSON.stringify({ completedKana: "ありがとう。", convertedText: system.includes("- 有難う。") ? "有り難う。" : "有難う。" });
  }
  if (system.includes("one Japanese writing suggestion")) {
    if (prompt?.includes("Prepared kana (correction/completion target):\nかくに。")) {
      return JSON.stringify({ completedKana: "かくにん。", convertedText: "かくにん。" });
    }
    if (prompt?.includes("Mechanical kana:\nあしたのよっていをおねが。")) {
      return JSON.stringify({ correctedKana: "あしたのよていをおねが。", convertedText: "明日の予定をお願い。", completedKana: "あしたのよていをおねがい。", additions: ["い"] });
    }
    if (prompt?.includes("Mechanical kana:\nありが。")) {
      const convertedText = system.includes("- ありがとう。") ? "有難う。" : "ありがとう。";
      return JSON.stringify({
        completedKana: "ありがとう。",
        convertedText,
        additions: ["とう"],
      });
    }
    if (prompt?.includes("Mechanical kana:\nあした")) {
      return JSON.stringify({
        completedKana: "あした",
        convertedText: "明日",
        additions: [],
      });
    }
    return JSON.stringify({
      completedKana: prompt?.split("Mechanical kana:\n")[1]?.trim() ?? "",
      convertedText: "あなたは誰ですか。",
      additions: [],
    });
  }
  if (prompt?.trim() === "あしたかいぎのて") {
    return "明日会議の手";
  }
  if (prompt?.trim() === "あしたかいぎ") {
    return "明日会議";
  }
  if (prompt?.trim() === "あしたの") {
    return "明日の";
  }
  if (prompt?.trim() === "あした") {
    return "明日";
  }
  if (
    system.includes("Complete only an unfinished final Japanese word.") &&
    prompt.includes("Mechanical kana:\nありが。")
  ) {
    return "ありがとう。";
  }
  if (system.includes("Avoid returning these previous outputs exactly:")) {
    if (prompt === "いち。") {
      return "壱。";
    }
    if (prompt === "さん。") {
      if (system.includes("- 参。") && system.includes("- 三。")) {
        return JSON.stringify({ completedKana: "さん。", convertedText: "參。" });
      }
      if (system.includes("- 参。")) {
        return "三。";
      }
      return "参。";
    }
    if (prompt === "ありがとう。") {
      return "有難う。";
    }
  }
  if (prompt === "いち。") {
    return "一。";
  }
  if (prompt === "に。") {
    return "二。";
  }
  if (prompt === "さん。") {
    return "三。";
  }
  if (prompt === "あしたのよてい") {
    return "明日の予定";
  }
  if (prompt === "ありがとう。") {
    return "ありがとう。";
  }
  return prompt ? "あなたは誰ですか。" : "";
}
