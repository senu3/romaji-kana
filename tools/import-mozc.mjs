// Reproducible import of the public base dictionary, not the Mozc runtime.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const revision = '0136c35782536cb43d710575c311cd4185982738';
const base = `https://raw.githubusercontent.com/google/mozc/${revision}/src/data/dictionary_oss/`;
const output = new URL('../src-engine/data/', import.meta.url);
await mkdir(output, { recursive: true });
const names = [...Array.from({ length: 10 }, (_, i) => `dictionary0${i}.txt`),
  'connection_single_column.txt', 'id.def', 'dictionary_filter.tsv'];
const manifest = { revision, source: base, files: [] };
for (const name of names) {
  const response = await fetch(base + name);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(new URL(name + '.gz', output), gzipSync(bytes, { level: 9 }));
  manifest.files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  console.log(`${name}: ${bytes.length} bytes`);
}
await writeFile(new URL('manifest.json', output), JSON.stringify(manifest, null, 2) + '\n');
