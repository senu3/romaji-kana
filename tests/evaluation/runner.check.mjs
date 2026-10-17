import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  const dir = await mkdtemp(join(tmpdir(), "kana-eval-"));
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

for (const format of ["plain", "structured"]) {
  for (const provider of ["ollama", "lmstudio"]) {
    test(`${provider}/${format}: real pipeline records HTTP attempts and stops on 503`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "kana-eval-"));
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
        assert.equal(rows[1].result.changes.kind, format === "structured" ? "notation" : "unknown");
        assert.equal(rows[1].review.usable, null);
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
