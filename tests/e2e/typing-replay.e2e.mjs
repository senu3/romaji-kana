import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { artifactPath, temporaryArtifactDirectory } from '../helpers/artifacts.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--real'),
  'Usage: npm run test:typing [-- --real]');
const real = args.includes('--real');
const output = await temporaryArtifactDirectory(real ? 'typing-real-' : 'typing-controlled-');
const server = await createServer({
  cacheDir: artifactPath('cache/e2e-typing'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
const reports = [];
let browser;

try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  if (real) {
    // Exclude dictionary startup from the replay's measured intervals.
    const response = await fetch(new URL('/api/kana-engine', server.resolvedUrls.local[0]), {
      method: 'POST',
      body: JSON.stringify({ operation: 'search', reading: 'ほん', words: [], limit: 1 }),
      signal: AbortSignal.timeout(120_000),
    });
    assert.ok(response.ok, `Kana engine warmup failed: ${await response.text()}`);
  }

  for (const [name, interval] of [['fast', 75], ['slow', 200]]) {
    await scenario(name, { autoSuggest: false }, async ({ page, ghost, wait, replay, documentText }) => {
      await replay('honwoyomu', interval);
      if (!real) {
        await wait(275);
        assert.equal(await ghost.count(), 0, 'No preview during the initial pause');
        await wait(105);
        if (name === 'fast') await waitForPreview(page, ghost);
        else {
          assert.equal(await ghost.count(), 0, 'Slow typing still has no preview at 380 ms');
          await wait(90);
          assert.equal(await ghost.count(), 0, 'Slow typing still has no preview at 470 ms');
          await wait(130);
        }
      }
      await waitForPreview(page, ghost);
      assert.equal(await ghost.textContent(), '本を読む');
      assert.equal(await documentText(), 'honwoyomu');
      await page.keyboard.press('Alt+Enter');
      assert.equal(await documentText(), '本を読む');
      assert.equal(await ghost.count(), 0);
    });
  }

  if (real) {
    await scenario('completion', { autoConvert: false }, async ({ page, completion, replay, documentText }) => {
      await replay('kouka', 75);
      await completion.waitFor({ state: 'visible' });
      const text = (await completion.locator('.candidate-completion-text').textContent()).replace(/^ → /, '');
      await page.keyboard.press('Tab');
      assert.equal(await documentText(), text);
      assert.equal(await completion.count(), 0);
    });
  } else {
    for (const [name, suffix, reading] of [['completion-three-keys', 'kai', 'こうかい'], ['completion-idle', 'ka', 'こうか']]) {
      await scenario(name, { autoConvert: false }, async ({ page, completion, wait, replay, requests, documentText }) => {
        await replay('kou', 75);
        const initial = page.waitForResponse(response => response.url().endsWith('/api/kana-engine'));
        await wait(120);
        await initial;
        await wait(40);
        assert.equal(await completion.locator('.candidate-completion-text').textContent(), ' → 航海士');
        await replay('k');
        await wait(75);
        assert.equal(await completion.count(), 0, 'Hide while the reading is incomplete');
        await replay('a');
        await wait(75);
        assert.deepEqual(requests.map(request => request.reading), ['こう']);
        const updated = page.waitForResponse(response => response.url().endsWith('/api/kana-engine'));
        if (suffix.length === 3) {
          await replay('i');
          await wait(1);
        } else {
          await wait(424);
          assert.deepEqual(requests.map(request => request.reading), ['こう']);
          await wait(1);
        }
        await updated;
        await wait(40);
        assert.deepEqual(requests.map(request => request.reading), ['こう', reading]);
        assert.equal(await completion.locator('.candidate-completion-text').textContent(), ' → 航海士');
        await page.keyboard.press('Tab');
        assert.equal(await documentText(), '航海士');
        assert.equal(await completion.count(), 0);
      });
    }
  }

  await scenario('resume-after-backspace', { autoSuggest: false }, async ({ page, ghost, wait, replay, documentText, releaseOriginal }) => {
    const requested = engineRequest(page, 'ほんをよむ');
    await replay('honwoyomu', 75);
    await wait(380);
    await requested;
    if (real) await waitForPreview(page, ghost);
    await page.keyboard.press('Backspace');
    await wait(75);
    await page.keyboard.press('Backspace');
    assert.equal(await ghost.count(), 0);
    await wait(75);
    await replay('nda', 75);
    await wait(380);
    await waitForPreview(page, ghost);
    assert.equal(await ghost.textContent(), '本を読んだ');
    assert.equal(await documentText(), 'honwoyonda');
    if (!real) {
      await releaseOriginal();
      await wait(1_000);
      assert.equal(await ghost.textContent(), '本を読んだ');
      assert.equal(await documentText(), 'honwoyonda');
    }
    await page.keyboard.press('Alt+Enter');
    assert.equal(await documentText(), '本を読んだ');
    assert.equal(await ghost.count(), 0);
  }, { holdOriginal: !real });

  console.log(`Typing replay passed (${real ? 'real engine' : 'controlled clock'}).`);
} finally {
  await browser?.close();
  await server.close();
  const report = join(output, 'timeline.json');
  await writeFile(report, JSON.stringify({ mode: real ? 'real' : 'controlled', scenarios: reports }, null, 2) + '\n');
  console.log(`Typing replay report: ${report}`);
}

function isOriginalSearch(request) {
  return request.url().endsWith('/api/kana-engine') &&
    request.postDataJSON().operation === 'search' && request.postDataJSON().reading === 'ほんをよむ';
}

function engineRequest(page, reading) {
  return page.waitForRequest(request => request.url().endsWith('/api/kana-engine') &&
    request.postDataJSON().operation === 'search' && request.postDataJSON().reading === reading);
}

async function scenario(name, settings, run, { holdOriginal = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.setDefaultNavigationTimeout(30_000);
  const report = { name, status: 'failed', requests: [], events: [] };
  reports.push(report);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let releaseOriginal;
  let finishOriginal;
  const pendingOriginal = new Promise(resolve => { releaseOriginal = resolve; });
  const originalSettled = new Promise(resolve => { finishOriginal = resolve; });
  await context.addInitScript(settings => {
    localStorage.setItem('romaji-kana-settings', JSON.stringify({
      autoConvert: true, autoSuggest: true, conversionMode: 'ghost', inputPauseTiming: 'auto',
      triggers: { typing: true }, ...settings,
    }));
    localStorage.setItem('romaji-kana-document-session', JSON.stringify({ kind: 'new', content: '' }));
  }, settings);
  for (const path of ['tags', 'generate']) {
    await page.route(`**/api/${path}`, route => route.abort('connectionrefused'));
  }
  page.on('request', request => {
    if (request.url().endsWith('/api/kana-engine')) {
      const { operation, reading } = request.postDataJSON();
      report.requests.push({ operation, reading });
    }
  });
  if (!real) {
    await page.route('**/api/kana-engine', async route => {
      const { operation, reading } = route.request().postDataJSON();
      if (operation === 'suggest') {
        const entries = reading === 'こう' ? ['航海士'] : ['航海士', '航海日誌'];
        return route.fulfill({ json: { candidates: entries.map((text, index) => ({
          text, reading: index ? 'こうかいにっし' : 'こうかいし', cost: index * 100, source: 'mozc',
        })) } });
      }
      const text = { 'ほんをよむ': '本を読む', 'ほんをよんだ': '本を読んだ' }[reading] ?? reading;
      const reply = () => route.fulfill({ json: { candidates: [{
        text, reading, cost: 0, tokens: [{
          text, reading, from: 0, to: reading.length, source: 'mozc', entryId: 'test', lid: 0, rid: 0, wordCost: 0,
        }],
      }], dictionaryRevision: 'test', truncated: false } });
      if (!holdOriginal || !isOriginalSearch(route.request())) return reply();
      await pendingOriginal;
      try {
        await reply();
      } catch (error) {
        // A superseded request can already have been aborted by the editor.
        if (route.request().failure()?.errorText !== 'net::ERR_ABORTED') errors.push(error.message);
      } finally {
        finishOriginal();
      }
    });
  }
  try {
    await page.goto(server.resolvedUrls.local[0]);
    const editor = page.locator('.cm-content');
    await editor.click();
    if (!real) {
      await page.clock.install();
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    }
    await page.evaluate(recordTimeline);
    const wait = real ? delay : ms => page.clock.runFor(ms);
    const replay = async (text, interval = 0) => {
      for (const [index, key] of [...text].entries()) {
        if (index && interval) await wait(interval);
        await page.keyboard.press(key);
      }
    };
    const documentText = () => editor.evaluate(content => [...content.querySelectorAll('.cm-line')].map(line => {
      const copy = line.cloneNode(true);
      copy.querySelectorAll('[contenteditable="false"]').forEach(widget => widget.remove());
      return copy.textContent;
    }).join('\n'));
    await run({
      page, replay, wait, documentText, requests: report.requests,
      ghost: page.locator('.cm-ghost-text-suggestion'),
      completion: page.locator('.cm-autosuggest-ghost:visible'),
      releaseOriginal: async () => {
        releaseOriginal();
        await Promise.race([
          originalSettled,
          delay(8_000, undefined, { ref: false }).then(() => assert.fail('Held search did not settle')),
        ]);
      },
    });
    report.document = await documentText();
    assert.deepEqual(errors, []);
    report.status = 'passed';
  } catch (error) {
    report.error = error.message;
    await page.screenshot({ path: join(output, `${name}.png`), timeout: 3_000 }).catch(() => {});
    throw new Error(`${name}: ${error.message}`, { cause: error });
  } finally {
    releaseOriginal();
    report.events = await page.evaluate(() => window.typingReplayEvents ?? []).catch(() => []);
    const lastKeyIndex = report.events.findLastIndex(event => event.key?.length === 1 || event.key === 'Backspace');
    for (const field of ['conversion', 'suggestions']) {
      const appeared = lastKeyIndex >= 0 && report.events.slice(lastKeyIndex + 1)
        .find(event => event[field]?.length);
      if (appeared) (report.lastInputToCandidateMs ??= {})[field] = appeared.ms - report.events[lastKeyIndex].ms;
    }
    await context.close();
  }
}

function recordTimeline() {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const events = window.typingReplayEvents = [];
  const editor = document.querySelector('.cm-editor');
  let previous = {};
  editor.addEventListener('keydown', event => events.push({ ms: elapsed(), key: event.key, alt: event.altKey }), true);
  new MutationObserver(() => {
    const state = {
      conversion: editor.querySelector('.cm-ghost-text-suggestion')?.textContent ?? null,
      suggestions: [...editor.querySelectorAll('.cm-autosuggest-ghost:not([hidden])')].map(button => button.getAttribute('aria-label')),
    };
    const changes = Object.fromEntries(Object.entries(state).filter(([key, value]) =>
      JSON.stringify(previous[key]) !== JSON.stringify(value)));
    if (Object.keys(changes).length) events.push({ ms: elapsed(), ...changes });
    previous = state;
  }).observe(editor, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-label'] });
}

async function waitForPreview(page, ghost) {
  await ghost.waitFor({ state: 'attached' });
  if (!real) await page.clock.runFor(40);
  await ghost.waitFor({ state: 'visible' });
}
