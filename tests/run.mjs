import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { artifactPath, projectRoot } from "./helpers/artifacts.mjs";

const [suite, ...args] = process.argv.slice(2);
const commands = {
  unit: [process.execPath, "node_modules/vitest/vitest.mjs", "run"],
  legacy: [process.execPath, "node_modules/vitest/vitest.mjs", "run", "--config", "tests/evaluation/legacy.vitest.config.ts"],
  evaluation: [process.execPath, "--test", "tests/evaluation/runner.check.mjs", "tests/evaluation/routes.check.mjs", "tests/evaluation/isolation.check.mjs", "tests/evaluation/correction-quality.check.mjs", "tests/evaluation/speculation-ablation.check.mjs"],
  "evaluation:legacy": [process.execPath, "--test", "tests/evaluation/legacy-runner.check.mjs"],
  eval: [process.execPath, "tests/evaluation/run.mjs"],
  e2e: [process.execPath, "tests/e2e/app.e2e.mjs"],
  "e2e:appearance": [process.execPath, "tests/e2e/editor-appearance.e2e.mjs"],
  "e2e:local": [process.execPath, "tests/e2e/local-engine.e2e.mjs"],
  "e2e:triggers": [process.execPath, "tests/e2e/conversion-triggers.e2e.mjs"],
  engine: ["cargo", "test", "--manifest-path", "src-engine/Cargo.toml", "--lib"],
  companion: ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "companion::tests"],
};
if (!Object.hasOwn(commands, suite)) throw new Error(`Unknown test suite: ${suite}`);

const temp = artifactPath("tmp");
await mkdir(temp, { recursive: true });
const [command, ...commandArgs] = commands[suite];
const child = spawn(command, [...commandArgs, ...args], {
  cwd: projectRoot,
  env: {
    ...process.env,
    TMP: temp,
    TEMP: temp,
    TMPDIR: temp,
    NODE_COMPILE_CACHE: artifactPath("cache/node"),
  },
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
