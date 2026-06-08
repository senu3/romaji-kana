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
      activeConversionRequests += 1;
      maxActiveConversionRequests = Math.max(maxActiveConversionRequests, activeConversionRequests);
      if (body.prompt === "いち。") {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    const response = conversionResponseForPrompt(body.prompt);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ response }),
    });
    if (body.prompt) {
      activeConversionRequests -= 1;
    }
  });

  await page.goto(appUrl);
  await page.getByRole("heading", { name: "Romaji Kana" }).waitFor();
  await page.getByRole("dialog", { name: "Set up your local model" }).waitFor();
  assert.equal(await editorText(page), "restored unsaved draft.");
  await assertVisibleText(page, "Settings");

  await waitForVisibleText(page, 'Selected "gemma4:latest". Checking model availability...');
  await waitForVisibleText(page, 'Connected to Ollama. Loaded "gemma4:latest". 2 model(s) available.');
  await page.getByRole("button", { name: "Start writing" }).click();
  await page.getByRole("dialog", { name: "Set up your local model" }).waitFor({ state: "hidden" });
  assert.ok(
    await panelTogglePaintsOutsideSettingsPanel(page),
    "Settings panel toggle should paint outside the panel without being clipped.",
  );
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
  await page.keyboard.press("Control+A");
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

  conversionRequestCount = 0;
  await page.keyboard.press("Control+A");
  await page.keyboard.type("already written ashita no yotei");
  await page.getByText("already written ashita no yotei").waitFor();
  for (let index = 0; index < "ashita no yotei".length; index += 1) {
    await page.keyboard.press("Shift+ArrowLeft");
  }
  await page.keyboard.press("Control+Enter");
  await page.getByText("already written あなたは誰ですか。").waitFor();
  assert.equal(
    conversionRequestCount,
    1,
    "Manual shortcut should convert only the selected text.",
  );

  conversionRequestCount = 0;
  activeConversionRequests = 0;
  maxActiveConversionRequests = 0;
  conversionPrompts.length = 0;
  await page.keyboard.press("Control+A");
  await page.keyboard.type("ichi.");
  await page.keyboard.type("ni.");
  await page.getByText("一。二。").waitFor();
  assert.deepEqual(conversionPrompts, ["いち。", "に。"]);
  assert.equal(conversionRequestCount, 2, "Both triggers should be converted.");
  assert.equal(maxActiveConversionRequests, 1, "Conversions should run sequentially.");

  await page.keyboard.press("Control+N");
  await page.waitForFunction(() => {
    const text = document.querySelector(".cm-content")?.textContent ?? "";
    return text === "" || text === "Romaji de nihongo wo kaitte kudasai...";
  });
  assert.equal(await editorText(page), "", "New file shortcut should clear the editor.");

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

async function editorText(page) {
  const text = (await page.locator(".cm-content").textContent()) ?? "";
  return text === "Romaji de nihongo wo kaitte kudasai..." ? "" : text;
}

async function panelTogglePaintsOutsideSettingsPanel(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".settings-panel");
    const toggle = document.querySelector(".panel-toggle");
    if (!(panel instanceof HTMLElement) || !(toggle instanceof HTMLElement)) {
      return false;
    }
    const panelBox = panel.getBoundingClientRect();
    const toggleBox = toggle.getBoundingClientRect();
    const sampleX = toggleBox.left + 4;
    const sampleY = toggleBox.top + toggleBox.height / 2;
    const paintedElement = document.elementFromPoint(sampleX, sampleY);
    return (
      toggleBox.left < panelBox.left &&
      sampleX >= 0 &&
      (paintedElement === toggle || toggle.contains(paintedElement))
    );
  });
}

function conversionResponseForPrompt(prompt) {
  if (prompt === "いち。") {
    return "一。";
  }
  if (prompt === "に。") {
    return "二。";
  }
  return prompt ? "あなたは誰ですか。" : "";
}
