import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function createKanaEngineClient() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  let child;
  let building;
  let closed = false;
  const waiting = [];
  const failAll = error => { while (waiting.length) waiting.shift().reject(error); };
  async function start() {
    if (closed) throw new Error('Kana engine client is closed');
    if (!building) building = new Promise((resolveBuild, reject) => {
      const build = spawn('cargo', ['build', '--release', '--manifest-path', 'src-engine/Cargo.toml'],
        { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let diagnostics = '';
      build.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4000); });
      build.on('error', reject);
      build.on('exit', code => code === 0 ? resolveBuild() : reject(new Error(diagnostics)));
    });
    await building;
    if (closed) throw new Error('Kana engine client is closed');
    if (child) return;
    const process = spawn(resolve(root, 'src-engine/target/release/kana-engine' + (globalThis.process.platform === 'win32' ? '.exe' : '')),
      [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child = process;
    createInterface({ input: process.stdout }).on('line', line => {
      const pending = waiting.shift();
      if (!pending) return;
      try {
        const value = JSON.parse(line);
        if (value.error) pending.reject(new Error(value.error)); else pending.resolve(value);
      } catch (error) { pending.reject(error); }
    });
    process.on('error', error => { failAll(error); if (child === process) child = undefined; });
    process.on('exit', () => { failAll(new Error('Kana engine exited')); if (child === process) child = undefined; });
  }
  return {
    async request(body) {
      await start();
      return new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => { failAll(new Error('Kana engine timed out')); child?.kill(); }, 30_000);
        waiting.push({ resolve: value => { clearTimeout(timer); resolveResult(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        child.stdin.write(JSON.stringify(body) + '\n');
      });
    },
    close() { closed = true; failAll(new Error('Kana engine client closed')); child?.kill(); },
  };
}
