// Human/agent-reviewed semantic labels are separate from generated results.
// No reference-string match or model self-rating is counted as semantic success.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolveArtifactPath } from '../helpers/artifacts.mjs';
const { values: args } = parseArgs({ options: {
  runs: { type: 'string' }, review: { type: 'string' }, out: { type: 'string' }, prepare: { type: 'boolean' },
} });
if (!args.runs || !args.review) throw Error('--runs and --review required');
const reviewPath = resolveArtifactPath(args.review);
const norm = text => text.replace(/[\s。、,.！？!?？]/gu, '');
const rows = [];
const cases = new Map();
for (const directory of args.runs.split(',')) {
  const dir = resolveArtifactPath(directory);
  const manifest = JSON.parse(await readFile(dir + '/manifest.json', 'utf8'));
  for (const c of manifest.cases) cases.set(c.id, c);
  const runRows = (await readFile(dir + '/results.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
  if (runRows.length !== manifest.schedule.length) throw Error('Incomplete run ' + directory);
  for (const row of runRows) {
    row.run = directory;
    // Editable-only surfaces suffice for semantic review; exact literal
    // restoration is checked separately by the real production replay.
    for (const c of row.candidates) c.surface = c.generated.convertedText ?? c.generated.segments.map(s => s.convertedText).join('');
    rows.push(row);
  }
}
if (args.prepare) {
  const unique = new Map();
  for (const r of rows) for (const c of r.candidates) {
    const key = r.caseId + '\n' + norm(c.surface);
    if (!unique.has(key)) unique.set(key, { caseId: r.caseId, text: norm(c.surface), criterion: cases.get(r.caseId).criterion, score: null, note: '' });
  }
  await writeFile(reviewPath, JSON.stringify({ rubric: { 2: '意図に合う。表記・敬語・句読点の差は許容。', 1: '大まかに有用だが語句の修正や調整が必要。', 0: '意図を失う・誤解・創作・未修正で実用にならない。' },
    reviewer: 'UNREVIEWED', labels: [...unique.values()] }, null, 2), { flag: 'wx' });
} else {
  if (!args.out) throw Error('--out required');
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  if (!review.reviewer || review.reviewer === 'UNREVIEWED') throw Error('Missing reviewer');
  const labels = new Map(review.labels.map(l => [l.caseId + '\n' + l.text, l]));
  const score = (r, c) => {
    const label = labels.get(r.caseId + '\n' + norm(c.surface));
    if (!label || ![0, 1, 2].includes(label.score)) throw Error('Unreviewed output: ' + r.caseId + ' ' + c.surface);
    return label.score;
  };
  const summary = [];
  for (const arm of new Set(rows.map(r => r.arm))) {
    const group = rows.filter(r => r.arm === arm);
    const metrics = { arm, trials: group.length, rawUsefulTop1: 0, rawUsefulAny: 0, rawIntentAny: 0,
      acceptedUsefulTop1: 0, acceptedUsefulAny: 0, acceptedIntentAny: 0, softReadingUsefulAny: 0,
      multipleReturned: 0, candidates: 0, rejected: {}, errors: 0 };
    for (const r of group) {
      const useful = c => score(r, c) >= 1, intent = c => score(r, c) === 2;
      const accepted = c => Boolean(c.strict?.text && !c.strict?.suggestionRejected);
      metrics.rawUsefulTop1 += Number(Boolean(r.candidates[0] && useful(r.candidates[0])));
      metrics.rawUsefulAny += Number(r.candidates.some(useful));
      metrics.rawIntentAny += Number(r.candidates.some(intent));
      const visible = r.candidates.filter(accepted);
      metrics.acceptedUsefulTop1 += Number(Boolean(visible[0] && useful(visible[0])));
      metrics.acceptedUsefulAny += Number(visible.some(useful));
      metrics.acceptedIntentAny += Number(visible.some(intent));
      metrics.softReadingUsefulAny += Number(r.candidates.some(c => c.softReading?.text && !c.softReading?.suggestionRejected && useful(c)));
      metrics.multipleReturned += Number(r.candidates.length > 1);
      metrics.candidates += r.candidates.length;
      metrics.errors += Number(Boolean(r.error));
      for (const c of r.candidates) { const reason = c.error ?? c.strict?.rejectionDetail; if (reason) metrics.rejected[reason] = (metrics.rejected[reason] ?? 0) + 1; }
    }
    const times = group.map(r => r.elapsedMs).sort((a, b) => a - b);
    metrics.medianElapsedMs = Math.round((times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2);
    summary.push(metrics);
  }
  const detail = rows.map(r => ({ run: r.run, caseId: r.caseId, arm: r.arm, repeat: r.repeat, error: r.error,
    candidates: r.candidates.map(c => ({ text: c.surface, score: score(r, c), accepted: Boolean(c.strict?.text && !c.strict?.suggestionRejected), reason: c.error ?? c.strict?.rejectionDetail })) }));
  await writeFile(resolveArtifactPath(args.out), JSON.stringify({ reviewer: review.reviewer, rubric: review.rubric, summary, detail }, null, 2));
  console.table(summary.map(({ arm, trials, rawUsefulTop1, acceptedUsefulAny, acceptedIntentAny, softReadingUsefulAny, multipleReturned, medianElapsedMs }) => ({ arm, trials, rawUsefulTop1, acceptedUsefulAny, acceptedIntentAny, softReadingUsefulAny, multipleReturned, medianElapsedMs })));
}
