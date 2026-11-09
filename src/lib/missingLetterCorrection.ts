import { preservesProtectedContent } from "./conversionProtection";
import { prepareConversionRequest, type PreparedConversionInput } from "./conversionRequest";
import { missingLetterReadings } from "./romajiRepairPlans";
export { missingLetterReadings } from "./romajiRepairPlans";
import { createConversionSession, type SessionCandidate } from "./conversionSession";
import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { convertLocally } from "./localConversion";
import { rankConversionSession } from "./conversionRanking";
import type { OllamaTransport } from "./ollamaProxy";
import type { AppSettings } from "./types";

// Missing n and vowels are common one-key omissions. Visit every edit position
// before exploring its less likely alternatives, rather than spending the
// entire search budget near the beginning of a sentence.
const MAX_PLANS = 128;
const MAX_ENGINE_CALLS = 128;
const MAX_CANDIDATES = 24;
const INSERTION_PENALTY = 3000; // Experimental scale; not a calibrated confidence.

export async function searchMissingLetter(input: string, settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions, preparedInput: PreparedConversionInput = prepareConversionRequest(input, settings, options)): Promise<JapaneseConversionResult | undefined> {
  if (!options.kanaEngine) return undefined;
  throwIfConversionAborted(options.signal);
  const started = performance.now();
  const { parts, protection } = preparedInput;
  const comparison = options.compareRepairsEarly;
  const compact = comparison === "compact" && Boolean(options.repairBaseline);
  const planLimit = compact ? 48 : MAX_PLANS;
  const engineLimit = compact ? 48 : MAX_ENGINE_CALLS;
  const metrics = { generated: 0, searched: 0, engineCalls: 0, candidates: 0, truncated: false, searchMs: 0, elapsedMs: 0 };
  const pool: SessionCandidate[] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof options.kanaEngine.search>>>();
  const engine = {
    ...options.kanaEngine, search: async (reading: string) => {
      throwIfConversionAborted(options.signal);
      if (metrics.engineCalls >= engineLimit) { metrics.truncated = true; return { candidates: [], truncated: true, dictionaryRevision: "" }; }
      metrics.engineCalls++;
      const result = await options.kanaEngine!.search(reading, settings.personalDictionary ?? [], options.signal);
      metrics.truncated ||= result.truncated;
      return result;
    }
  };
  let revision: string | undefined;
  try {
    const queues = parts.flatMap((part, partIndex) => {
      if (part.type !== "text") return [];
      const generated = missingLetterReadings(part.value);
      metrics.generated += generated.plans.length;
      metrics.truncated ||= generated.truncated;
      return [{ partIndex, part, plans: generated.plans }];
    });
    // Protected literals split the input into parts. Give later editable parts
    // the same opportunity to use the bounded dictionary budget.
    const scheduled = queues.flatMap(({ partIndex, part, plans }) => plans.map((plan, round) => {
      const inserts = plan.value.length > part.value.length;
      const vowelOrN = /^[aiueon]$/u.test(plan.inserted);
      // Try doubled keys and likely omissions before exhausting the short search.
      let priority = comparison === "full" && inserts && !vowelOrN ? 1 : 0;
      if (compact) {
        const key = part.value[plan.offset];
        const previousKey = part.value[plan.offset - 1];
        const doubled = !plan.inserted && (key === previousKey || key === part.value[plan.offset + 1]);
        const omitted = inserts && vowelOrN && /[aiueo]/u.test(previousKey ?? "") && /[b-df-hj-np-tv-z]/u.test(key);
        priority = doubled ? 0 : omitted ? 1 : inserts && !vowelOrN ? 3 : 2;
      }
      return { partIndex, part, plan, round, priority };
    })).sort((a, b) => a.plan.distance - b.plan.distance || a.priority - b.priority ||
      a.round - b.round || a.partIndex - b.partIndex);
    for (const { partIndex, part, plan } of scheduled) {
      throwIfConversionAborted(options.signal);
      if (metrics.searched >= planLimit || metrics.engineCalls >= engineLimit) { metrics.truncated = true; break; }
      metrics.searched++;
      const result = await convertLocally(input, settings, transport, {
        ...options, kanaEngine: engine, rerank: false,
        onLocalCandidates: undefined, onRankedCandidates: undefined, deferRanking: undefined
      }, { correction: { partIndex, value: plan.value } }, preparedInput, cache);
      revision = result.session?.dictionaryRevision ?? revision;
      for (const candidate of result.session?.candidates.slice(0, 3) ?? []) {
        if (!preservesProtectedContent(protection.source, candidate.result.text, protection.literalTerms)) continue;
        pool.push({
          ...candidate, id: `repair-${pool.length}`, kind: "correction", cost: candidate.cost! + INSERTION_PENALTY,
          result: { ...candidate.result, romajiCorrection: { partIndex, offset: plan.offset, inserted: plan.inserted, before: part.value, after: plan.value } }
        });
      }
    }
    pool.sort((a, b) => a.cost! - b.cost!);
    const seen = new Set<string>();
    const candidates = pool.filter(candidate => {
      const key = `${candidate.result.reviewKana}\n${candidate.result.text}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    // Costs describe dictionary paths, not comparable intent probabilities
    // across repaired readings. Reserve a slot per reading before adding more
    // homophones for a reading already represented in the ranking request.
    const readings = new Set<string>();
    const first: SessionCandidate[] = [], alternatives: SessionCandidate[] = [];
    for (const candidate of candidates) {
      const reading = candidate.result.reviewKana;
      if (readings.has(reading)) alternatives.push(candidate);
      else { readings.add(reading); first.push(candidate); }
    }
    const baseline = options.repairBaseline;
    const baselineCandidate = baseline?.session?.candidates.find(c => c.id === baseline.session?.selectedId);
    const unchanged: SessionCandidate[] = baseline ? [{ id: "unchanged", kind: "conversion", cost: baselineCandidate?.cost,
      tokens: baselineCandidate?.tokens, result: { ...baseline, session: undefined, repairRequested: undefined } }] : [];
    const comparisonLimit = compact ? 3 : 6;
    const retained = comparison && baseline?.session
      ? [...baseline.session.candidates.slice(0, comparisonLimit), ...first.slice(0, comparisonLimit)]
      : [...unchanged, ...first, ...alternatives].slice(0, MAX_CANDIDATES);
    // Reserve the unchanged option without falsely labeling it the best local path.
    if (baseline) retained.sort((a, b) => (a.cost ?? Number.MAX_SAFE_INTEGER) - (b.cost ?? Number.MAX_SAFE_INTEGER));
    metrics.candidates = retained.length;
    metrics.searchMs = performance.now() - started;
    metrics.truncated ||= seen.size > MAX_CANDIDATES;
    if (!retained.length) return undefined;
    const session = createConversionSession(input, retained, options);
    session.dictionaryRevision = revision;
    session.truncated = metrics.truncated;
    return await rankConversionSession(session, settings, transport, {
      ...options,
      onLocalCandidates: undefined, onRankedCandidates: undefined, deferRanking: undefined
    }, preparedInput.learnedBonus);
  } finally {
    metrics.elapsedMs = performance.now() - started;
    options.onMissingLetterSearch?.(metrics);
  }
}
