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
  await page.route("**/api/tags", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ models: TEST_MODELS }),
    });
  });
  await page.route("**/api/generate", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ response: "" }),
    });
  });

  await page.goto(appUrl);
  await page.getByRole("heading", { name: "Romaji Kana" }).waitFor();
  await assertVisibleText(page, "anatahadonnakotogasukidesuka.");
  await assertVisibleText(page, "Settings");

  await waitForVisibleText(page, 'Selected "gemma4:latest". Checking model availability...');
  await waitForVisibleText(page, 'Connected to Ollama. Loaded "gemma4:latest". 2 model(s) available.');

  const modelInput = page.getByRole("combobox");
  await assertLocatorValue(modelInput, "gemma4:latest");

  await page.getByRole("button", { name: "Show local models" }).click();
  await page.getByRole("option", { name: "qwen3.5:0.8b" }).waitFor();

  await page.getByRole("button", { name: "Prompt" }).click();
  await page.getByRole("region", { name: "Conversion prompt editor" }).waitFor();
  await page.getByRole("button", { name: "Close prompt" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await assertVisibleText(page, 'Connected to Ollama. Loaded "gemma4:latest". 2 model(s) available.');
  assert.ok(
    await page.getByRole("button", { name: "Prompt" }).isVisible(),
    "Prompt action should remain visible on a narrow viewport.",
  );
} finally {
  await browser?.close();
  await server.close();
}

async function assertVisibleText(page, text) {
  assert.ok(await page.getByText(text).first().isVisible(), `Expected visible text: ${text}`);
}

async function assertLocatorValue(locator, expectedValue) {
  const value = await locator.inputValue();
  assert.equal(value, expectedValue);
}

async function waitForVisibleText(page, text) {
  await page.getByText(text).first().waitFor();
}
