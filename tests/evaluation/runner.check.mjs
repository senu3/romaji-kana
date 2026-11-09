import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolveArtifactPath, temporaryArtifactDirectory } from "../helpers/artifacts.mjs";
import { join } from "node:path";
import { run } from "../helpers/evaluation-runner.mjs";

test("dry run validates data, deterministic order, and refuses overwrite", async () => {
  const dir = await temporaryArtifactDirectory("kana-eval-");
  try {
    for (const name of ["a", "b"]) {
      const result = await run(["--dry-run", "--out", join(dir, name)]);
      assert.equal(result.code, 0, result.output);
    }
    const a = JSON.parse(await readFile(join(dir, "a/manifest.json"), "utf8"));
    const b = JSON.parse(await readFile(join(dir, "b/manifest.json"), "utf8"));
    assert.equal(a.schedule.length, a.cases.length * 3);
    assert.ok(a.cases.every(c => !("inputCompletionLevel" in c.settings)));
    assert.deepEqual(a.schedule, b.schedule);
    assert.equal(a.cases.find(c => c.id === "vocabulary-01").settings.useDocumentVocabulary, true);
    assert.equal(a.cases.find(c => c.id === "basic-01").settings.personalDictionary.length, 0);
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

test("pairs the two typo speculation variants for every case and repeat", async () => {
  const dir = await temporaryArtifactDirectory("kana-typo-speculation-");
  try {
    const out = join(dir, "run");
    const result = await run(["--dry-run", "--compare-typo-speculation", "--dataset",
      "tests/evaluation/typo-speculation.json", "--repeats", "2", "--out", out]);
    assert.equal(result.code, 0, result.output);
    const { cases, schedule } = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    assert.equal(schedule.length, cases.length * 2 * 2);
    for (let i = 0; i < schedule.length; i += 2) {
      const [a, b] = schedule.slice(i, i + 2);
      assert.equal(a.caseId, b.caseId);
      assert.equal(a.repeat, b.repeat);
      assert.deepEqual([a.variant, b.variant].sort(), ["current", "experimental"]);
    }
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

test("retired CLI switches are rejected instead of silently changing production evaluation", async () => {
  for (const args of [["--engine", "llm"], ["--missing-letter", "off"], ["--prompt", "old.txt"], ["--note", "old"]]) {
    const result = await run(["--dry-run", ...args]);
    assert.equal(result.code, 1, result.output);
  }
});

test("production reinterpretation continues after validation errors, stops on 503, and keeps reference answers private", async () => {
  const dir = await temporaryArtifactDirectory("kana-intent-");
  const requests = [];
  let fail = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader("Content-Type", "application/json");
    if (fail) { res.writeHead(503); res.end('{"error":"unavailable"}'); return; }
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
    assert.ok(requests.every(r => !r.prompt.includes("記事を予約してください。")));
    assert.ok(requests.every(r => !r.system.includes("記事を予約してください。")));
    source.cases[0].options.speculationInformation = "reduced-with-rejections";
    await writeFile(dataset, JSON.stringify(source));
    requests.length = 0;
    const full = await run([...base, "--dry-run", "--out", join(dir, "full")]);
    assert.equal(full.code, 1, full.output);
    assert.equal(requests.length, 0);
    assert.match(full.output, /Retired evaluation options/);
    delete source.cases[0].options.speculationInformation;
    await writeFile(dataset, JSON.stringify(source));
    fail = true;
    requests.length = 0;
    const failed = await run([...base, "--out", join(dir, "failed")]);
    assert.equal(failed.code, 1, failed.output);
    assert.equal(requests.length, 1);
    const stopped = JSON.parse(await readFile(join(dir, "failed/summary.json"), "utf8"));
    assert.equal(stopped.stoppedOnError, true);
    assert.equal(stopped.completedTrials, 0);
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


test("all retained datasets use supported production settings and candidate routes", async () => {
  const dir = await temporaryArtifactDirectory("kana-datasets-");
  try {
    const files = (await readdir(new URL("./", import.meta.url))).filter(name => name.endsWith(".json"));
    for (const file of files) {
      const dataset = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
      if (!dataset.defaults) continue; // Candidate recall and manual intent review have their own runners.
      const result = await run(["--dry-run", "--dataset", "tests/evaluation/" + file, "--out", join(dir, file)]);
      assert.equal(result.code, 0, file + ": " + result.output);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
