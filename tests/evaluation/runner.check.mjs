import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolveArtifactPath, temporaryArtifactDirectory } from "../helpers/artifacts.mjs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Runner timed out: ${output}`)); }, 30000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

test("dry run validates data, deterministic order, and refuses overwrite", async () => {
  const dir = await temporaryArtifactDirectory("kana-eval-");
  try {
    for (const name of ["a", "b"]) {
      const result = await run(["--dry-run", "--out", join(dir, name)]);
      assert.equal(result.code, 0, result.output);
    }
    const a = JSON.parse(await readFile(join(dir, "a/manifest.json"), "utf8"));
    const b = JSON.parse(await readFile(join(dir, "b/manifest.json"), "utf8"));
    assert.equal(a.schedule.length, 132);
    assert.deepEqual(a.schedule, b.schedule);
    assert.equal(a.cases.find(c => c.id === "vocabulary-01").settings.useDocumentVocabulary, true);
    assert.equal(a.cases.find(c => c.id === "basic-01").settings.userDictionary.length, 0);
    assert.equal((await run(["--dry-run", "--out", join(dir, "a")])).code, 1);
    assert.equal((await run(["--dry-run", "--case", "missing"])).code, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("keeps default and custom evaluation output inside test-results", async () => {
  for (const out of ["tests/evaluation/generated", "docs/evaluation/generated", "test-results/../escaped"]) {
    const result = await run(["--dry-run", "--out", out]);
    assert.equal(result.code, 1);
    assert.match(result.output, /inside test-results/);
  }
  const result = await run(["--dry-run", "--case", "basic-02"]);
  assert.equal(result.code, 0, result.output);
  const out = result.output.match(/^Output: (.+)$/m)?.[1].trim();
  assert.ok(out, result.output);
  assert.equal(resolveArtifactPath(out), out);
  try {
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.dryRun, true);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("keeps the unused comparison set separate from the regression set", async () => {
  const dir = await temporaryArtifactDirectory("kana-holdout-");
  try {
    const result = await run(["--dry-run", "--dataset", "tests/evaluation/holdout.json", "--out", join(dir, "run")]);
    assert.equal(result.code, 0, result.output);
    const manifest = JSON.parse(await readFile(join(dir, "run/manifest.json"), "utf8"));
    assert.equal(manifest.datasetPath, "tests/evaluation/holdout.json");
    assert.equal(manifest.cases.length, 10);
    assert.equal(manifest.schedule.length, 30);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("validates rescue cases with unspecified acceptable text and route expectations", async () => {
  const dir = await temporaryArtifactDirectory("kana-rescue-");
  try {
    const result = await run(["--dry-run", "--dataset", "tests/evaluation/rescue-holdout.json", "--out", join(dir, "run")]);
    assert.equal(result.code, 0, result.output);
    const manifest = JSON.parse(await readFile(join(dir, "run/manifest.json"), "utf8"));
    assert.equal(manifest.cases.length, 12);
    assert.equal(manifest.schedule.length, 36);
    assert.deepEqual(manifest.cases.find(c => c.id === "rescue-11").acceptableExamples, []);
    assert.deepEqual(manifest.cases.find(c => c.id === "rescue-11").expectedRoutes, ["rejected"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("records the experimental missing-letter switch and comparison set", async () => {
  const dir = await temporaryArtifactDirectory("kana-missing-letter-");
  try {
    for (const mode of ["on", "off"]) {
      const result = await run(["--dry-run", "--dataset", "tests/evaluation/missing-letter.json", "--missing-letter", mode, "--out", join(dir, mode)]);
      assert.equal(result.code, 0, result.output);
      const manifest = JSON.parse(await readFile(join(dir, mode, "manifest.json"), "utf8"));
      assert.equal(manifest.cases.length, 12);
      assert.ok(manifest.cases.every(c => c.options.missingLetterCorrection === (mode === "on")));
    }
    assert.equal((await run(["--dry-run", "--missing-letter", "invalid"])).code, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("production reinterpretation records validation failures and continues, without leaking reference answers", async () => {
  const dir = await temporaryArtifactDirectory("kana-intent-");
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader("Content-Type", "application/json");
    // Invalid response contract: this must count as an error, not end the run.
    res.end(JSON.stringify({ response: "{}" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const dataset = join(dir, "cases.json");
    const source = JSON.parse(await readFile(new URL("./intent-quality.json", import.meta.url), "utf8"));
    source.cases = [source.cases.find(c => c.id === "intent-10")];
    source.cases[0].acceptableExamples = ["REFERENCE_ANSWER_DO_NOT_SEND"];
    source.cases[0].criteria = ["EVALUATOR_CRITERION_DO_NOT_SEND"];
    source.cases[0].notes = "EVALUATOR_NOTES_DO_NOT_SEND";
    await writeFile(dataset, JSON.stringify(source));
    const base = ["--dataset", dataset, "--repeats", "2", "--model", "mock", "--url", `http://127.0.0.1:${server.address().port}`];
    const result = await run([...base, "--out", join(dir, "run")]);
    assert.equal(result.code, 0, result.output);
    const rows = (await readFile(join(dir, "run/trials.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 3);
    assert.ok(rows.every(r => r.implementation === "production" && r.outcome === "error" && r.errorKind === "response-validation"));
    const summary = JSON.parse(await readFile(join(dir, "run/summary.json"), "utf8"));
    assert.equal(summary.completedTrials, 2);
    assert.equal(summary.stoppedOnError, false);
    assert.equal(summary.categories["user-reinterpretation"].errors, 2);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(r => !JSON.stringify(r).includes("DO_NOT_SEND")));
    assert.ok(requests.every(r => r.system.includes("記事を予約してください。")));
    assert.equal((await run([...base, "--engine", "local", "--dry-run", "--out", join(dir, "invalid")])).code, 1);
    source.cases[0].options = { purpose: "correction" };
    await writeFile(dataset, JSON.stringify(source));
    assert.equal((await run([...base, "--engine", "local", "--dry-run", "--out", join(dir, "invalid-purpose")])).code, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

for (const format of ["plain", "structured"]) {
  for (const provider of ["ollama", "lmstudio"]) {
    test(`${provider}/${format}: real pipeline records HTTP attempts and stops on 503`, async () => {
      const dir = await temporaryArtifactDirectory("kana-eval-");
      const requests = [];
      let fail = false;
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        requests.push({ path: req.url, body: parsed });
        res.setHeader("Content-Type", "application/json");
        if (fail) { res.writeHead(503); res.end('{"error":"unavailable"}'); return; }
        if (provider === "lmstudio" && "enable_thinking" in parsed) {
          res.writeHead(400); res.end('{"error":"unsupported enable_thinking"}'); return;
        }
        const generated = format === "structured"
          ? JSON.stringify({ convertedText: "本を読む。", completedKana: "ほんをよむ。" })
          : "本を読む。";
        res.end(JSON.stringify(provider === "ollama" ? { response: generated } : { choices: [{ message: { content: generated } }] }));
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const base = ["--engine", "llm", "--provider", provider, "--model", "mock-model", "--url", `http://127.0.0.1:${server.address().port}`, "--case", "basic-02", "--repeats", "2"];
        const ok = await run([...base, "--out", join(dir, "ok")]);
        assert.equal(ok.code, 0, ok.output);
        const rows = (await readFile(join(dir, "ok/trials.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(rows.length, 3);
        assert.equal(rows[0].phase, "warmup");
        assert.equal(rows[1].result.text, "本を読む。");
        assert.ok(rows.every(row => row.outcome === "candidate"));
        assert.ok(rows.every(row => row.implementation === "legacy-evaluation"));
        assert.equal(rows[1].result.changes.kind, format === "structured" ? "notation" : "unknown");
        assert.equal(rows[1].review.usable, null);
        assert.equal(rows[1].firstDictionaryCandidateMs, null);
        assert.equal(rows[1].rankingCompletionMs, null);
        assert.deepEqual(rows[1].route, { finalRoute: "normal", expectedRoutes: null, matchesExpectation: null });
        assert.equal(rows[1].apiCallCount, provider === "ollama" ? 1 : 2);
        assert.equal(requests[0].path, provider === "ollama" ? "/api/generate" : "/v1/chat/completions");
        assert.equal(requests[0].body.stream, false);
        if (provider === "lmstudio") assert.equal(requests[0].body.messages[0].role, "system");
        fail = true;
        requests.length = 0;
        const failed = await run([...base, "--out", join(dir, "failed")]);
        assert.equal(failed.code, 1, failed.output);
        assert.equal(requests.length, 1);
        const summary = JSON.parse(await readFile(join(dir, "failed/summary.json"), "utf8"));
        assert.equal(summary.stoppedOnError, true);
        assert.equal(summary.completedTrials, 0);
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
    });
  }
}
