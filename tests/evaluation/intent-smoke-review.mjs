export function summarizeIntentReview(report) {
  if (report.dryRun || !report.complete || !report.caseIds?.length || report.rows?.length !== report.caseIds.length) throw Error('A complete live run of all cases is required');
  const ids = new Set(report.caseIds);
  if (ids.size !== report.caseIds.length || new Set(report.rows.map(row => row.id)).size !== ids.size || report.rows.some(row => !ids.has(row.id))) throw Error('Missing, duplicate or unknown case ID');
  if (!report.reviewer?.trim()) throw Error('Set reviewer before scoring');
  const summary = { total: report.rows.length, usefulTop1: 0, usefulAny: 0, intentAny: 0, errors: 0, failures: [], intentFailures: [] };
  for (const row of report.rows) {
    if (row.candidates.some(c => ![0, 1, 2].includes(c.score))) throw Error('Unreviewed candidate: ' + row.id);
    const scores = row.error ? [] : row.candidates.map(c => c.score);
    summary.errors += Number(Boolean(row.error));
    summary.usefulTop1 += Number(scores[0] >= 1);
    summary.usefulAny += Number(scores.some(s => s >= 1));
    summary.intentAny += Number(scores.includes(2));
    if (!scores.some(s => s >= 1)) summary.failures.push(row.id);
    if (!scores.includes(2)) summary.intentFailures.push(row.id);
  }
  return summary;
}
