import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { createKanaEngineClient } from "../../tools/kana-engine-client.mjs";
import { finalRoutes, observeRoute, summarizeRoutes } from "./routes.mjs";
import { summarizeCorrectionQuality } from "./correction-quality.mjs";
import { artifactPath, resolveArtifactPath } from "../helpers/artifacts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values: args } = parseArgs({ options: {
  help: { type: "boolean" }, "dry-run": { type: "boolean" },
  provider: { type: "string", default: "ollama" }, model: { type: "string" },
  url: { type: "string" }, repeats: { type: "string", default: "3" },
  seed: { type: "string", default: "20260922" }, case: { type: "string" },
  out: { type: "string" },
  engine: { type: "string", default: "hybrid" },
  dataset: { type: "string", default: "tests/evaluation/cases.json" },
  "compare-typo-speculation": { type: "boolean" },
  "probe-all-normal": { type: "boolean" },
  "compare-repairs-early": { type: "boolean" },
  "compact-repairs": { type: "boolean" },
  "compare-short-repair-id": { type: "boolean" },
} });

if (args.help) {
  console.log(`Usage: npm run eval:run -- --model MODEL [options]
  --provider ollama|lmstudio  --url http://localhost:PORT
  --engine hybrid|local
  --compare-typo-speculation   Pair current and experimental rescue with automatic speculation enabled in both.
  --probe-all-normal          Use the broad trigger in the experimental arm of that comparison.
  --compare-repairs-early    Compare normal and one-key repairs in the first ranking request.
  --compact-repairs          Use the shorter shortlist and dictionary budget for the early comparison.
  --compare-short-repair-id  Pair compact first-pass rankings using full and short-ID responses.
  --dataset tests/evaluation/holdout.json
  --repeats 3  --seed 20260922  --case basic-01,basic-02
  --out test-results/evaluation/NEW_DIRECTORY  --dry-run
Dry run validates cases and writes the schedule without contacting a model.
Actual runs include one unscored warmup. Response validation errors are recorded;
transport and unexpected errors stop the run.`);
} else {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

async function main() {
  const out = args.out ? resolveArtifactPath(args.out) : artifactPath(
    `evaluation/runs/${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
  );
  if (!["ollama", "lmstudio"].includes(args.provider)) throw new Error("Invalid provider");
  if (!["hybrid", "local"].includes(args.engine)) throw new Error("Invalid engine");
  const shortId = Boolean(args["compare-short-repair-id"]);
  const compare = Boolean(args["compare-typo-speculation"] || args["compare-repairs-early"] || shortId);
  if (shortId && (args["compare-typo-speculation"] || args["compare-repairs-early"])) throw new Error("Select one comparison");
  if (args["probe-all-normal"] && !args["compare-typo-speculation"]) throw new Error("The broad trigger requires --compare-typo-speculation");
  if (args["compare-typo-speculation"] && args["compare-repairs-early"]) throw new Error("Select one comparison");
  if (args["compact-repairs"] && !args["compare-repairs-early"]) throw new Error("Compact repairs requires --compare-repairs-early");
  const controlVariant = shortId ? "early-compact" : "current";
  const experimentalVariant = shortId ? "early-short-id" : args["compare-repairs-early"]
    ? args["compact-repairs"] ? "early-compact" : "early-repair"
    : args["probe-all-normal"] ? "all-normal" : "experimental";
  if (compare && args.engine !== "hybrid") throw new Error("Typo speculation comparison requires the hybrid engine");
  const repeats = Number(args.repeats), seed = Number(args.seed);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) throw new Error("repeats must be 1..100");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be uint32");
  if (!args["dry-run"] && args.engine !== "local" && !args.model?.trim()) throw new Error("--model is required");
  const endpoint = new URL(args.url ?? (args.provider === "ollama" ? "http://localhost:11434" : "http://localhost:1234"));
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("URL must be HTTP(S), without credentials, query or fragment");
  }
  const source = await readFile(resolve(root, args.dataset), "utf8");
  const dataset = JSON.parse(source);
  if (!Array.isArray(dataset.cases) || !dataset.cases.length) throw new Error("Dataset must contain cases");
  const ids = new Set();
  for (const c of dataset.cases) {
    if (!c.id || ids.has(c.id) || !c.input || !c.category || !c.criteria?.length || !Array.isArray(c.acceptableExamples)) throw new Error(`Invalid case: ${c.id}`);
    if (c.expectedRoutes !== undefined && (!Array.isArray(c.expectedRoutes) || !c.expectedRoutes.length ||
        c.expectedRoutes.some(route => !finalRoutes.includes(route)))) throw new Error(`Invalid expectedRoutes: ${c.id}`);
    if (!c.acceptableExamples.length && !c.expectedRoutes) throw new Error(`Empty examples require expectedRoutes: ${c.id}`);
    const retired = ["completionMode", "speculativeMode", "alternativeMode", "speculationInformation", "missingLetterCorrection"];
    if (c.speculationAblation || c.settingsOverrides?.inputCompletionLevel || retired.some(key => key in (c.options ?? {}))) {
      throw new Error(`Retired evaluation options: ${c.id}`);
    }
    if (c.options?.userRequestedSpeculation && !c.options.speculationCandidates) {
      throw new Error(`Explicit speculation requires candidate generation: ${c.id}`);
    }
    ids.add(c.id);
  }
  const selected = args.case ? args.case.split(",") : [...ids];
  if (new Set(selected).size !== selected.length || selected.some(id => !ids.has(id))) throw new Error("Unknown or duplicate case ID");
  const cases = dataset.cases.filter(c => selected.includes(c.id));
  if (args.engine === "local" && cases.some(c => c.options?.userRequestedSpeculation || (c.options?.purpose && c.options.purpose !== "normal"))) {
    throw new Error("--engine local requires faithful conversion cases");
  }
  const { createServer } = await import("vite");
  const vite = await createServer({ root, configFile: false, cacheDir: artifactPath("cache/evaluation"), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, ws: false }, appType: "custom" });
  const nativeFetch = globalThis.fetch;
  let engineClient;
  try {
    const { defaultSettings } = await vite.ssrLoadModule("/src/lib/settings.ts");
    const { documentVocabulary, ...defaults } = dataset.defaults;
    for (const settings of [defaults, ...cases.map(c => c.settingsOverrides ?? {})]) {
      const unknown = Object.keys(settings).filter(key => !(key in defaultSettings));
      if (unknown.length) throw new Error(`Unsupported settings: ${unknown.join(", ")}`);
    }
    const configured = cases.map(c => ({
      ...c,
      settings: {
        ...structuredClone(defaultSettings), ...structuredClone(defaults), ...structuredClone(c.settingsOverrides ?? {}),
        modelProvider: args.provider, modelName: args.model ?? "DRY_RUN",
        [args.provider === "ollama" ? "ollamaApiUrl" : "lmStudioApiUrl"]: endpoint.href,
        useDocumentVocabulary: Boolean(c.options?.documentVocabulary?.length),
      },
      options: structuredClone({ documentVocabulary, ...c.options }),
    }));
    let state = seed;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const schedule = [];
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const order = [...configured];
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      for (const c of order) {
        if (!compare) { schedule.push({ caseId: c.id, repeat }); continue; }
        const variants = random() < 0.5 ? [controlVariant, experimentalVariant] : [experimentalVariant, controlVariant];
        for (const variant of variants) schedule.push({ caseId: c.id, repeat, variant });
      }
    }
    await mkdir(dirname(out), { recursive: true });
    await mkdir(out); // Never overwrite an earlier experiment.
    const git = (...argv) => { try { return execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim(); } catch { return "unknown"; } };
    const metadata = {
      formatVersion: 1, datasetPath: args.dataset, datasetVersion: dataset.version, datasetSha256: hash(source),
      createdAt: new Date().toISOString(), dryRun: Boolean(args["dry-run"]),
      gitSha: git("rev-parse", "HEAD"), gitStatus: git("status", "--porcelain"),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
      cpu: os.cpus()[0]?.model ?? "unknown", ramBytes: os.totalmem(),
      gpu: "unknown", vram: "unknown", serverVersion: "unknown", modelDigest: "unknown", quantization: "unknown",
      provider: args.provider, model: args.model ?? null, endpoint: endpoint.href,
      engine: args.engine,
      dictionary: JSON.parse(await readFile(resolve(root, "src-engine/data/manifest.json"), "utf8")),
      seed, repeats, loadState: "unknown; no cold-start claim",
      promptSha256: hash(configured[0].settings.conversionPrompt),
      cases: configured, schedule,
    };
    await writeFile(resolve(out, "manifest.json"), JSON.stringify(metadata, null, 2));
    console.log(`Output: ${out}`);
    if (args["dry-run"]) { console.log(`Validated ${cases.length} cases / ${schedule.length} scheduled trials; no API calls.`); return; }

    // Data checks need settings only. Load converters and build a dictionary
    // process only when an actual trial requires them.
    const { convertRomajiToJapaneseDetailed: convert } = await vite.ssrLoadModule("/src/lib/ollama.ts");
    const { defaultOllamaTransport } = await vite.ssrLoadModule("/src/lib/ollamaProxy.ts");
    const { ConversionResponseError } = await vite.ssrLoadModule("/src/lib/conversionDiagnostics.ts");
    engineClient = createKanaEngineClient();
    let calls = [];
    let engineCalls = [];
    const engineRequest = async body => {
      const started = performance.now();
      const record = { request: body };
      engineCalls.push(record);
      try { const result = await engineClient.request(body); record.response = result; return result; }
      finally { record.elapsedMs = performance.now() - started; }
    };
    const kanaEngine = {
      search: (reading, words) => engineRequest({ operation: "search", reading, words: words.filter(w => w.enabled), limit: 24 }),
      verify: async (text, reading, words) => (await engineRequest({ operation: "verify", text, reading, words: words.filter(w => w.enabled) })).status,
    };
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
      engineCalls = [];
      const started = performance.now();
      const options = compare ? { ...c.options, autoSpeculation: true,
        typoSpeculation: trial.variant === "all-normal" ? "all-normal" : trial.variant === "experimental" ? "suspected" : undefined,
        compareRepairsEarly: trial.variant === "early-compact" || trial.variant === "early-short-id" ? "compact" : trial.variant === "early-repair" ? "full" : undefined,
        shortRepairId: trial.variant === "early-short-id",
      } : c.options;
      const row = { ...trial, category: c.category, phase: trial.repeat === 0 ? "warmup" : "measured", startedAt: new Date().toISOString(), input: c.input, settings: c.settings, options };
      row.firstDictionaryCandidateMs = null;
      row.rescueStartedMs = null;
      row.missingLetterSearches = [];
      try {
        row.implementation = "production";
        row.result = await convert(c.input, c.settings, defaultOllamaTransport, {
          ...options, kanaEngine, rerank: args.engine === "hybrid", autoRescue: args.engine !== "local",
          onLocalCandidates: () => { row.firstDictionaryCandidateMs ??= performance.now() - started; },
          onRescueStart: () => { row.rescueStartedMs = performance.now() - started; },
          onMissingLetterSearch: metrics => { row.missingLetterSearches.push(metrics); },
        });
        row.outcome = row.result.suggestionRejected ? "rejected" : row.result.text?.trim() ? "candidate" : "empty";
        row.route = observeRoute(row.result, c.expectedRoutes);
      } catch (error) {
        row.outcome = "error"; row.error = String(error) + (error.cause ? ` (${error.cause})` : "");
        if (error?.diagnostic) row.errorDiagnostic = error.diagnostic;
        // A completed but invalid response is a quality failure, not evidence of
        // an in-flight server generation. Keep it in the denominator and continue.
        row.errorKind = error instanceof ConversionResponseError ? "response-validation" : "request-or-unexpected";
        stopped = row.errorKind !== "response-validation";
      }
      row.elapsedMs = performance.now() - started;
      row.rankingCompletionMs = args.engine === "hybrid" && row.firstDictionaryCandidateMs !== null ? row.rescueStartedMs ?? row.elapsedMs : null;
      row.apiCalls = calls;
      row.apiCallCount = calls.length;
      row.exactReferenceMatch = {
        top: c.acceptableExamples.length ? c.acceptableExamples.includes(row.result?.text) : null,
        pool: c.acceptableExamples.length && row.result?.session ? row.result.session.candidates.some(candidate => c.acceptableExamples.includes(candidate.result.text)) : null,
      };
      row.engineCalls = engineCalls;
      // A timed-out model generation may still be occupying the server even if
      // production successfully fell back to the retained local candidate.
      if (calls.some(call => call.error || call.status >= 500)) stopped = true;
      row.review = { fidelity: null, naturalness: null, modeFit: null, criticalFailure: null, additionsIncorrect: null, usable: null, notes: "" };
      await appendFile(resolve(out, "trials.jsonl"), JSON.stringify(row) + "\n");
      results.push(row);
      console.log(`${row.phase} ${row.caseId} #${row.repeat}${row.variant ? ` ${row.variant}` : ""}: ${row.outcome} (${Math.round(row.elapsedMs)} ms, ${calls.length} HTTP attempts)${row.error ? `: ${row.error}` : ""}`);
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
    await writeFile(resolve(out, "summary.json"), JSON.stringify({ stoppedOnError: stopped, plannedTrials: schedule.length, completedTrials: measured.length,
      ...(dataset.qualityProfile === "correction-v1" ? { correctionQuality: summarizeCorrectionQuality(measured) } : {}),
      routes: summarizeRoutes(measured),
      exactReferenceMatch: { top: measured.filter(r => r.exactReferenceMatch.top).length,
        topEvaluated: measured.filter(r => r.exactReferenceMatch.top !== null).length,
        pool: measured.filter(r => r.exactReferenceMatch.pool === true).length, poolEvaluated: measured.filter(r => r.exactReferenceMatch.pool !== null).length },
      qualityStatus: "unreviewed; candidate or exact example match does not mean correct", categories: groups }, null, 2));
    if (stopped) process.exitCode = 1;
  } finally { globalThis.fetch = nativeFetch; engineClient?.close(); await vite.close(); }
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
