import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveArtifactPath } from '../helpers/artifacts.mjs';

export function summarize(rows, reviews) {
  const key = r => [r.group, r.caseId, r.repeat, r.arm].join('/');
  const labels = new Map(reviews.map(r => [key(r), r]));
  if (labels.size !== reviews.length || labels.size !== rows.length || rows.some(r => !labels.has(key(r)))) throw Error('Review coverage mismatch');
  const groups = {};
  for (const row of rows) {
    const name = row.group + '/' + row.arm;
    const g = groups[name] ??= { trials: 0, usable: 0, correctAbstention: 0, incorrect: 0, unnecessaryAbstention: 0, errors: 0, critical: 0, exactMatch: 0, referenceTrials: 0, productionDeadlineExceeded: 0 };
    const review = labels.get(key(row));
    if (!['usable', 'correctAbstention', 'incorrect', 'unnecessaryAbstention', 'errors'].includes(review.verdict)) throw Error('Invalid review');
    g.trials++; g[review.verdict]++; g.critical += Number(Boolean(review.critical));
    g.exactMatch += Number(row.exactMatch === true); g.referenceTrials += Number(row.exactMatch !== null);
    g.productionDeadlineExceeded += Number(row.calls.some(c => c.exceededProductionDeadline));
  }
  return groups;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = resolveArtifactPath(process.argv[2]);
  const rows = (await readFile(resolve(out, 'trials.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const reviews = JSON.parse(await readFile(resolve(out, 'reviews.json'), 'utf8'));
  await writeFile(resolve(out, 'summary.json'), JSON.stringify(summarize(rows, reviews), null, 2), { flag: 'wx' });
}
