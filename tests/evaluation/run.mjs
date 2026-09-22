import { createServer } from "vite";
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values: args } = parseArgs({ options: {
  help: { type: "boolean" }, "dry-run": { type: "boolean" },
  provider: { type: "string", default: "ollama" }, model: { type: "string" },
  url: { type: "string" }, repeats: { type: "string", default: "3" },
  seed: { type: "string", default: "20260922" }, case: { type: "string" },
  out: { type: "string" }, prompt: { type: "string" }, note: { type: "string", default: "" },
} });

if (args.help) {
  console.log(`Usage: npm run eval:run -- --model MODEL [options]
  --provider ollama|lmstudio  --url http://localhost:PORT
  --repeats 3  --seed 20260922  --case basic-01,basic-02
  --prompt FILE  --note TEXT  --out NEW_DIRECTORY  --dry-run
Dry run validates cases and writes the schedule without contacting a model.
Actual runs include one unscored warmup and stop on the first request error.`);
} else {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

async function main() {
  if (!["ollama", "lmstudio"].includes(args.provider)) throw new Error("Invalid provider");
  const repeats = Number(args.repeats), seed = Number(args.seed);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) throw new Error("repeats must be 1..100");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be uint32");
  if (!args["dry-run"] && !args.model?.trim()) throw new Error("--model is required");
  const endpoint = new URL(args.url ?? (args.provider === "ollama" ? "http://localhost:11434" : "http://localhost:1234"));
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("URL must be HTTP(S), without credentials, query or fragment");
  }
  const source = await readFile(resolve(root, "tests/evaluation/cases.json"), "utf8");
  const dataset = JSON.parse(source);
  const ids = new Set();
  for (const c of dataset.cases) {
    if (!c.id || ids.has(c.id) || !c.input || !c.category || !c.criteria?.length || !c.acceptableExamples?.length) throw new Error(`Invalid case: ${c.id}`);
    if (!["none", "word", "sentence"].includes(c.settingsOverrides?.inputCompletionLevel ?? dataset.defaults.inputCompletionLevel)) throw new Error(`Invalid mode: ${c.id}`);
    ids.add(c.id);
  }
  const selected = args.case ? args.case.split(",") : [...ids];
  if (new Set(selected).size !== selected.length || selected.some(id => !ids.has(id))) throw new Error("Unknown or duplicate case ID");
  const cases = dataset.cases.filter(c => selected.includes(c.id));
  const prompt = args.prompt ? await readFile(resolve(args.prompt), "utf8") : null;
  const vite = await createServer({ root, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: "custom" });
  const nativeFetch = globalThis.fetch;
  try {
    const { defaultSettings } = await vite.ssrLoadModule("/src/lib/settings.ts");
    const { convertRomajiToJapaneseDetailed } = await vite.ssrLoadModule("/src/lib/ollama.ts");
    const { defaultOllamaTransport } = await vite.ssrLoadModule("/src/lib/ollamaProxy.ts");
    const { documentVocabulary, ...defaults } = dataset.defaults;
    const configured = cases.map(c => ({
      ...c,
      settings: {
        ...structuredClone(defaultSettings), ...structuredClone(defaults), ...structuredClone(c.settingsOverrides ?? {}),
        modelProvider: args.provider, modelName: args.model ?? "DRY_RUN",
        [args.provider === "ollama" ? "ollamaApiUrl" : "lmStudioApiUrl"]: endpoint.href,
        useDocumentVocabulary: Boolean(c.options?.documentVocabulary?.length),
        ...(prompt === null ? {} : { conversionPrompt: prompt }),
      },
      options: structuredClone({ documentVocabulary, ...c.options }),
    }));
    let state = seed;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const schedule = [];
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const order = [...configured];
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      schedule.push(...order.map(c => ({ caseId: c.id, repeat })));
    }
    const out = resolve(args.out ?? resolve(root, "tests/evaluation/results", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`));
    await mkdir(dirname(out), { recursive: true });
    await mkdir(out); // Never overwrite an earlier experiment.
    const git = (...argv) => { try { return execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim(); } catch { return "unknown"; } };
    const metadata = {
      formatVersion: 1, datasetVersion: dataset.version, datasetSha256: hash(source),
      createdAt: new Date().toISOString(), dryRun: Boolean(args["dry-run"]),
      gitSha: git("rev-parse", "HEAD"), gitStatus: git("status", "--porcelain"),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
      cpu: os.cpus()[0]?.model ?? "unknown", ramBytes: os.totalmem(),
      gpu: "unknown", vram: "unknown", serverVersion: "unknown", modelDigest: "unknown", quantization: "unknown",
      provider: args.provider, model: args.model ?? null, endpoint: endpoint.href,
      seed, repeats, note: args.note, loadState: "unknown; no cold-start claim",
      promptSha256: hash(configured[0].settings.conversionPrompt),
      cases: configured, schedule,
    };
    await writeFile(resolve(out, "manifest.json"), JSON.stringify(metadata, null, 2));
    console.log(`Output: ${out}`);
    if (args["dry-run"]) { console.log(`Validated ${cases.length} cases / ${schedule.length} scheduled trials; no API calls.`); return; }

    let calls = [];
    // Observe actual HTTP attempts, including compatibility retries inside the production transport.
    globalThis.fetch = async (...params) => {
      const started = performance.now();
      const record = { method: params[1]?.method ?? "GET", url: String(params[0]), requestBody: params[1]?.body ?? null };
      calls.push(record);
      try {
        const response = await nativeFetch(...params);
        record.status = response.status;
        record.responseBody = await response.clone().text();
        return response;
      } catch (error) { record.error = String(error); throw error; }
      finally { record.elapsedMs = performance.now() - started; }
    };
    const results = [];
    let stopped = false;
    for (const trial of [{ caseId: configured[0].id, repeat: 0 }, ...schedule]) {
      const c = configured.find(item => item.id === trial.caseId);
      calls = [];
      const started = performance.now();
      const row = { ...trial, category: c.category, mode: c.settings.inputCompletionLevel, phase: trial.repeat === 0 ? "warmup" : "measured", startedAt: new Date().toISOString(), input: c.input, settings: c.settings, options: c.options };
      try {
        row.result = await convertRomajiToJapaneseDetailed(c.input, c.settings, defaultOllamaTransport, c.options);
        row.outcome = row.result.suggestionRejected ? "rejected" : row.result.text?.trim() ? "candidate" : "empty";
      } catch (error) { row.outcome = "error"; row.error = String(error); stopped = true; }
      row.elapsedMs = performance.now() - started;
      row.apiCalls = calls;
      row.apiCallCount = calls.length;
      row.review = { fidelity: null, naturalness: null, modeFit: null, criticalFailure: null, additionsIncorrect: null, usable: null, notes: "" };
      await appendFile(resolve(out, "trials.jsonl"), JSON.stringify(row) + "\n");
      results.push(row);
      console.log(`${row.phase} ${row.caseId} #${row.repeat}: ${row.outcome} (${Math.round(row.elapsedMs)} ms, ${calls.length} HTTP attempts)`);
      if (stopped) break; // A timed-out generation may still occupy the server.
    }
    const measured = results.filter(r => r.phase === "measured");
    const groups = {};
    for (const category of new Set(measured.map(r => r.category))) {
      const rows = measured.filter(r => r.category === category);
      const timings = rows.filter(r => r.outcome !== "error").map(r => r.elapsedMs).sort((a, b) => a - b);
      const mid = Math.floor(timings.length / 2);
      groups[category] = { trials: rows.length, candidates: rows.filter(r => r.outcome === "candidate").length, rejected: rows.filter(r => r.outcome === "rejected").length, empty: rows.filter(r => r.outcome === "empty").length, errors: rows.filter(r => r.outcome === "error").length, medianMs: timings.length ? timings.length % 2 ? timings[mid] : (timings[mid - 1] + timings[mid]) / 2 : null };
    }
    await writeFile(resolve(out, "summary.json"), JSON.stringify({ stoppedOnError: stopped, plannedTrials: schedule.length, completedTrials: measured.length, qualityStatus: "unreviewed; candidate does not mean correct", categories: groups }, null, 2));
    if (stopped) process.exitCode = 1;
  } finally { globalThis.fetch = nativeFetch; await vite.close(); }
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
