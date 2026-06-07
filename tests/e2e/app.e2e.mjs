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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.clear();
  });

  const page = await context.newPage();
  let conversionRequestCount = 0;
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
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ response: body.prompt ? "あなたは誰ですか。" : "" }),
    });
  });

  await page.goto(appUrl);
  await page.getByRole("heading", { name: "Romaji Kana" }).waitFor();
  await page.getByRole("dialog", { name: "Set up your local model" }).waitFor();
  await assertVisibleText(page, "anatahadonnakotogasukidesuka.");
  await assertVisibleText(page, "Settings");

  await waitForVisibleText(page, 'Selected "gemma4:latest". Checking model availability...');
  await waitForVisibleText(page, 'Connected to Ollama. Loaded "gemma4:latest". 2 model(s) available.');
  await page.getByRole("button", { name: "Start writing" }).click();
  await page.getByRole("dialog", { name: "Set up your local model" }).waitFor({ state: "hidden" });
  await page
    .locator(".settings-panel .accordion-trigger")
    .filter({ hasText: "Triggers" })
    .click();
  await page.getByLabel("Enter (IME composing ignored)").check();
  assert.equal(
    await page.getByLabel("Enter (IME composing ignored)").isChecked(),
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

  conversionRequestCount = 0;
  await page.locator(".cm-content").click();
  await page.keyboard.type("anatahadaredesuka");
  await page.getByText("anatahadaredesuka").waitFor();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  assert.equal(
    conversionRequestCount,
    1,
    `Enter should trigger conversion. Editor text: ${await page.locator(".cm-content").textContent()}`,
  );
  await page.getByText("あなたは誰ですか。").waitFor();
  assert.equal(conversionRequestCount, 1, "Enter should trigger exactly one conversion.");
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByText("anatahadaredesuka").waitFor();
  await page.waitForTimeout(300);
  assert.equal(conversionRequestCount, 1, "Undo should not re-trigger conversion.");

  await page.getByRole("button", { name: "Open dictionary" }).click();
  await page.getByRole("dialog", { name: "Dictionary" }).waitFor();
  const dictionaryInputs = page.locator(".dictionary-add-form input");
  await dictionaryInputs.nth(0).fill("openai");
  await dictionaryInputs.nth(1).fill("OpenAI");
  await dictionaryInputs.nth(2).fill("company name");
  await page.getByRole("button", { name: "Add entry" }).click();
  await assertLocatorValue(page.getByLabel("Dictionary output 1"), "OpenAI");
  await page.getByRole("button", { name: "Close dictionary" }).click();
  await page
    .getByRole("button", { name: "Open dictionary, 1 enabled entries" })
    .waitFor();

  await page.getByRole("button", { name: "Show local models" }).click();
  await page.getByRole("option", { name: "qwen3.5:0.8b" }).waitFor();

  await page.getByRole("button", { name: "Style" }).click();
  await page.getByRole("region", { name: "Conversion prompt editor" }).waitFor();
  await page.getByRole("button", { name: "ビジネスメール" }).click();
  await page.getByText("Work messages and email drafts.").waitFor();
  await page.getByRole("button", { name: "Close prompt" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("dialog", { name: "Settings" }).waitFor();
  await assertVisibleText(page, "Connected");
  await page.getByRole("button", { name: "Close settings" }).click();
  assert.ok(
    await page.getByRole("button", { name: "Style" }).isVisible(),
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
