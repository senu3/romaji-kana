import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { createKanaEngineClient } from "../../tools/kana-engine-client.mjs";
import { artifactPath, projectRoot } from "../helpers/artifacts.mjs";

// No model call, and no reference answer is supplied to ranking. Measure whether
// the intended reading survives bounded dictionary search and candidate pruning.
const dataset = JSON.parse(await readFile(new URL("./missing-letter-recall.json", import.meta.url), "utf8"));
const out = artifactPath(`evaluation/missing-letter-recall-${randomUUID()}`);
await mkdir(out, { recursive: true });
const vite = await createServer({ root: projectRoot, configFile: false, cacheDir: artifactPath("cache/missing-letter-recall"),
  server: { middlewareMode: true, watch: null, ws: false }, appType: "custom" });
const client = createKanaEngineClient();
try {
  const current = await vite.ssrLoadModule("/src/lib/missingLetterCorrection.ts");
  const { defaultSettings } = await vite.ssrLoadModule("/src/lib/settings.ts");
  const { prepareConversionRequest } = await vite.ssrLoadModule("/src/lib/conversionRequest.ts");
  const { romajiToKana } = await vite.ssrLoadModule("/src/lib/romajiKana.ts");
  // Build and load the dictionary outside the measured trials.
  await client.request({ operation: "search", reading: "ほん", words: [], limit: 24 });
  const rows = [];
  for (const example of dataset.cases) {
    const { parts } = prepareConversionRequest(example.repaired, defaultSettings, {});
    const expectedReading = parts.map(part => part.type === "text" ? romajiToKana(part.value).kana : part.output).join("");
    for (const [name, implementation] of [["current", current]]) {
      let offered = [], metrics;
      const engine = {
        search: (reading, words) => client.request({ operation: "search", reading, words, limit: 24 }),
        verify: async () => { throw new Error("Unexpected reading verification"); },
      };
      const transport = {
        models: async () => { throw new Error("Unexpected model listing"); },
        generate: async (_provider, _url, request) => {
          offered = JSON.parse(request.prompt).candidates;
          // Returning no selection avoids treating dictionary cost as quality.
          return { response: '{"order":[]}' };
        },
      };
      await implementation.searchMissingLetter(example.input, defaultSettings, transport, {
        kanaEngine: engine, onMissingLetterSearch: value => { metrics = value; },
      });
      const row = { implementation: name, ...example, expectedReading,
        readingRetained: offered.some(candidate => candidate.reading === expectedReading),
        metrics, candidates: offered };
      rows.push(row);
      console.log(`${name}: ${row.readingRetained ? "retained" : "missed"} ${example.input}`);
    }
  }
  const summary = Object.fromEntries(["current"].map(name => {
    const trials = rows.filter(row => row.implementation === name);
    return [name, { cases: trials.length, readingsRetained: trials.filter(row => row.readingRetained).length,
      maximumEngineCalls: Math.max(...trials.map(row => row.metrics.engineCalls)) }];
  }));
  await writeFile(`${out}/results.json`, JSON.stringify({ scope: dataset.description, summary, rows }, null, 2));
  console.log(JSON.stringify({ out, summary }, null, 2));
} finally {
  client.close();
  await vite.close();
}
