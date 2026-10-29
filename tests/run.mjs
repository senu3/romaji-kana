import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { artifactPath, projectRoot } from "./helpers/artifacts.mjs";

let [suite, ...args] = process.argv.slice(2);
const commands = {
  intent: [process.execPath, "tests/evaluation/intent-smoke.mjs"],
  unit: [process.execPath, "node_modules/vitest/vitest.mjs", "run"],
  evaluation: [process.execPath, "--test", ...(await readdir(new URL("./evaluation/", import.meta.url))).filter(name => name.endsWith(".check.mjs")).sort().map(name => "tests/evaluation/" + name)],
  eval: [process.execPath, "tests/evaluation/run.mjs"],
  "e2e:app": [process.execPath, "tests/e2e/app.e2e.mjs"],
  "e2e:appearance": [process.execPath, "tests/e2e/editor-appearance.e2e.mjs"],
  "e2e:local": [process.execPath, "tests/e2e/local-engine.e2e.mjs"],
  "e2e:triggers": [process.execPath, "tests/e2e/conversion-triggers.e2e.mjs"],
  "e2e:settings": [process.execPath, "tests/e2e/settings-layout.e2e.mjs"],
  "e2e:dictionary": [process.execPath, "tests/e2e/dictionary.e2e.mjs"],
  "e2e:autosuggest": [process.execPath, "tests/e2e/autosuggest.e2e.mjs"],
  "e2e:speculation": [process.execPath, "tests/e2e/speculation-menu.e2e.mjs"],
  engine: ["cargo", "test", "--manifest-path", "src-engine/Cargo.toml", "--lib"],
  companion: ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "companion::tests"],
};
const groups = {
  check: ["unit", "evaluation"],
  e2e: ["e2e:app", "e2e:appearance", "e2e:local", "e2e:triggers", "e2e:settings", "e2e:dictionary", "e2e:autosuggest", "e2e:speculation"],
};
if (suite === "e2e" && args.length) {
  if (args.length !== 1 || !groups.e2e.includes(`e2e:${args[0]}`)) throw new Error("Choose one E2E: app, appearance, local, triggers, settings, dictionary, autosuggest, speculation");
  suite = `e2e:${args[0]}`;
  args = [];
}
if (!Object.hasOwn(commands, suite) && !Object.hasOwn(groups, suite)) throw new Error(`Unknown test suite: ${suite}`);
if (groups[suite] && args.length) throw new Error("Pass arguments to an individual suite, such as npm run test:unit -- --watch");

const temp = artifactPath("tmp");
await mkdir(temp, { recursive: true });
let failed = false;
for (const name of groups[suite] ?? [suite]) {
  console.log(`\nRunning ${name}`);
  const [command, ...commandArgs] = commands[name];
  const child = spawn(command, [...commandArgs, ...args], {
    cwd: projectRoot,
    env: { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp, NODE_COMPILE_CACHE: artifactPath("cache/node") },
    stdio: "inherit", windowsHide: true,
  });
  try {
    const [code] = await once(child, "exit");
    if (code !== 0) failed = true;
  } catch (error) { console.error(error); failed = true; }
}
process.exitCode = failed ? 1 : 0;
