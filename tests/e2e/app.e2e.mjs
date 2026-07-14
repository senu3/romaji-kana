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
  assert.equal(
    await firstRunPage.getByRole("dialog").count(),
    0,
    "First run should open directly in the document instead of blocking typing with setup.",
  );
  await firstRunContext.close();

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.clear();
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
    if (body.prompt) {
      conversionRequestCount += 1;
      conversionPrompts.push(body.prompt);
      conversionSystems.push(body.system ?? "");
      activeConversionRequests += 1;
      maxActiveConversionRequests = Math.max(maxActiveConversionRequests, activeConversionRequests);
      if (body.prompt === "いち。") {
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
  await setupDialog.getByRole("button", { name: "接続チェック" }).click();
  await waitForVisibleText(page, 'Ollama に接続しましたが、"gemma3" は見つかりませんでした。候補: "gemma4:latest".');
  await setupDialog.getByRole("combobox").selectOption("gemma4:latest");
  await setupDialog.getByRole("button", { name: "接続チェック" }).click();
  await waitForVisibleText(page, 'Ollama に接続しました。"gemma4:latest" を読み込みました。利用可能なモデル: 2 件。');
  await page.getByRole("button", { name: "書き始める" }).click();
  await setupDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "設定を開く", exact: true }).click();
  await page
    .locator(".inspector-drawer .accordion-trigger")
    .filter({ hasText: "Triggers" })
    .click();
  await page.getByLabel("Enter（IME 変換中は無視）").check();
  assert.equal(
    await page.getByLabel("Enter（IME 変換中は無視）").isChecked(),
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

  const modelInput = page.getByRole("combobox");
  await assertLocatorValue(modelInput, "gemma4:latest");
  await page.getByRole("button", { name: "設定 を閉じる" }).click();

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
  await waitForEditorText(page, "あなたは誰ですか。");
  assert.deepEqual((await editorLines(page)).slice(0, 2), ["あなたは誰ですか。", ""]);
  assert.equal(conversionRequestCount, 1, "Enter should trigger exactly one conversion.");
  await page.getByRole("button", { name: "元に戻す" }).click();
  await waitForEditorText(page, "anatahadaredesuka");
  await page.waitForTimeout(300);
  assert.equal(conversionRequestCount, 1, "Undo should not re-trigger conversion.");

  conversionRequestCount = 0;
  conversionPrompts.length = 0;
  await page.keyboard.press("Control+A");
  await page.keyboard.type("ichi.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("ni.");
  await waitForEditorText(page, "一。");
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
  await waitForEditorText(page, "一。二。");
  assert.deepEqual(conversionPrompts, ["いち。", "に。"]);
  assert.equal(conversionRequestCount, 2, "Both triggers should be converted.");
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

  await page.getByRole("button", { name: "変換スタイルを開く" }).click();
  await page.getByRole("region", { name: "変換スタイル" }).waitFor();
  await page.getByLabel("ビジネスメール").check();
  await page.getByText("仕事の連絡やメール下書き向け。").waitFor();
  await page.getByRole("button", { name: "スタイル を閉じる" }).click();

  conversionRequestCount = 0;
  conversionPrompts.length = 0;
  conversionSystems.length = 0;
  await page.getByRole("button", { name: "Ghost", exact: true }).click();
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
  await waitForEditorText(page, "三。");
  await page.keyboard.press("Control+/");
  await waitForEditorText(page, "参。");
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
  await waitForEditorText(page, "あなたは誰ですか。");
  await page.keyboard.press("Tab");
  await waitForEditorText(page, "あなたは誰ですか。");
  await page.getByRole("button", { name: /履歴を開く/ }).click();
  await page
    .locator(".history-item")
    .first()
    .getByText("あなたは誰ですか。")
    .waitFor();
  await page.getByRole("button", { name: "履歴 を閉じる" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.locator(".editor-shell").evaluate((element) => element.getBoundingClientRect().width >= 380),
    "Editor should retain the full viewport width on a narrow screen.",
  );
  await page.getByRole("button", { name: "設定を開く", exact: true }).click();
  await page.getByRole("dialog", { name: "設定" }).waitFor();
  await assertVisibleText(page, "接続済み");
  await page.getByRole("button", { name: "設定 を閉じる" }).click();
  assert.ok(
    await page.getByRole("button", { name: "変換スタイルを開く" }).isVisible(),
    "Style action should remain visible on a narrow viewport.",
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

async function waitForVisibleText(page, text) {
  await page.getByText(text).first().waitFor();
}

async function editorText(page) {
  const text = (await page.locator(".cm-content").textContent()) ?? "";
  return text === "romaji で日本語を書いてください..." ? "" : text;
}

async function editorLines(page) {
  return page.locator(".cm-line").evaluateAll((lines) =>
    lines.map((line) => line.textContent ?? ""),
  );
}

async function waitForEditorText(page, text) {
  await page.waitForFunction(
    (expected) => document.querySelector(".cm-content")?.textContent?.includes(expected),
    text,
  );
}

function conversionResponseForPrompt(prompt, system = "") {
  if (system.includes("Avoid returning these previous outputs exactly:")) {
    if (prompt === "いち。") {
      return "壱。";
    }
    if (prompt === "さん。") {
      if (system.includes("- 参。")) {
        return "三。";
      }
      return "参。";
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
  return prompt ? "あなたは誰ですか。" : "";
}
