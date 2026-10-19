import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./artifacts.mjs";

const runner = fileURLToPath(new URL("../evaluation/run.mjs", import.meta.url));
export function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Runner timed out: ${output}`)); }, 30000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

