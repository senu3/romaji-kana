// Diagnostic only: bypass application acceptance to isolate text+reading output
// work from interpreting the same input. Never count these as accepted outputs.
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveArtifactPath } from "../helpers/artifacts.mjs";

const source = resolveArtifactPath(process.argv[2]);
const out = resolveArtifactPath(process.argv[3]);
const rows = (await readFile(source, "utf8")).trim().split("\n").map(JSON.parse);
const ids = ["context-01", "context-03", "context-04", "context-05", "context-06", "context-11"];
const task = "Generate one natural Japanese suggestion from the original input and surrounding context. Infer through input typos if needed. Avoid unsupported facts or reversing meaning; return no candidate if unsupported.";
const system = task + "\nReturn only the Japanese target text. For no candidate return an empty string.";
await mkdir(out); // Refuse to overwrite an earlier probe.
await writeFile(resolve(out, "manifest.json"), JSON.stringify({ source, ids, repeats: 2, system,
  limitation: "Raw text diagnosis only; independent reading and production acceptance are not evaluated." }, null, 2));
for (let repeat = 1; repeat <= 2; repeat++) {
  for (const id of ids) {
    const reference = rows.find(row => row.caseId === id + "--minimal-en--text" && row.repeat === 1);
    if (!reference) throw new Error("Missing reference: " + id);
    const original = reference.apiCalls[0];
    const request = { ...JSON.parse(original.requestBody), system };
    delete request.format;
    const started = performance.now();
    const response = await fetch(original.url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    await appendFile(resolve(out, "trials.jsonl"), JSON.stringify({ caseId: id, repeat, request,
      status: response.status, response: result, elapsedMs: performance.now() - started }) + "\n");
    if (!response.ok) throw new Error("Probe request failed: " + response.status);
    console.log(id + " #" + repeat + ": " + JSON.stringify(result.response));
  }
}
