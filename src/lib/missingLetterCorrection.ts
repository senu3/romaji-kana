import { preservesProtectedContent } from "./conversionProtection";
import { prepareConversionRequest } from "./conversionRequest";
import { localCorrectionRule } from "./conversionRules";
import { createConversionSession, type SessionCandidate } from "./conversionSession";
import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { convertLocally, rankConversionSession } from "./localConversion";
import type { OllamaTransport } from "./ollamaProxy";
import { romajiToKana } from "./romajiKana";
import type { AppSettings } from "./types";

// Missing n and vowels are common one-key omissions. Visit every edit position
// before exploring its less likely alternatives, rather than spending the
// entire search budget near the beginning of a sentence.
const ALPHABET = "naeioubcdfghjklmpqrstvwxyz";
const MAX_ROMAJI = 96;
const MAX_PLANS = 128;
const MAX_ENGINE_CALLS = 128;
const MAX_CANDIDATES = 24;
const INSERTION_PENALTY = 3000; // Experimental scale; not a calibrated confidence.

export function missingLetterReadings(value: string) {
  const original = romajiToKana(value);
  const plans: Array<{ value: string; reading: string; offset: number; inserted: string; distance: number }> = [];
  if (value.length > MAX_ROMAJI) return { plans, truncated: true };
  const markers = (reading: string) => JSON.stringify(reading.match(localCorrectionRule.negationAndTerminalMarkers) ?? []);
  for (const run of value.matchAll(/[a-z]+/g)) {
    // Do not edit fragments embedded in ASCII identifiers, numbers or URLs.
    const start = run.index;
    const end = start + run[0].length;
    if (/[A-Za-z_:/.-]/.test(value[start - 1] ?? "") || /[A-Za-z_:/-]/.test(value[end] ?? "")) continue;
    // Appending a suffix is completion, not missing-letter correction.
    for (let offset = start;offset < end;offset++) for (const inserted of ALPHABET) {
      const repaired = value.slice(0, offset) + inserted + value.slice(offset);
      const kana = romajiToKana(repaired);
      if (kana.lowConfidenceSpans.length || kana.kana === original.kana || markers(original.kana) !== markers(kana.kana)) continue;
      const distance = original.lowConfidenceSpans.length ? Math.min(...original.lowConfidenceSpans.map(span =>
        Math.min(Math.abs(offset - span.inputFrom), Math.abs(offset - span.inputTo)))) : 0;
      plans.push({ value: repaired, reading: kana.kana, offset, inserted, distance });
    }
  }
  const positions = new Map<number, typeof plans>();
  for (const plan of plans) {
    const queue = positions.get(plan.offset) ?? [];
    queue.push(plan);
    positions.set(plan.offset, queue);
  }
  const scheduled = [...positions.values()].flatMap(queue => queue.map((plan, round) => ({ plan, round })))
    .sort((a, b) => a.plan.distance - b.plan.distance || a.round - b.round || a.plan.offset - b.plan.offset);
  // Deduplicate after scheduling: equivalent spellings must not give an early
  // edit position extra turns or displace a repair closer to an unknown token.
  const seen = new Set<string>();
  return { plans: scheduled.map(item => item.plan).filter(plan => {
    if (seen.has(plan.reading)) return false;
    seen.add(plan.reading); return true;
  }), truncated: false };
}

export async function searchMissingLetter(input: string, settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions): Promise<JapaneseConversionResult | undefined> {
  if (!options.kanaEngine) return undefined;
  throwIfConversionAborted(options.signal);
  const started = performance.now();
  const { parts, protection } = prepareConversionRequest(input, settings, options);
  const metrics = { generated: 0, searched: 0, engineCalls: 0, candidates: 0, truncated: false, searchMs: 0, elapsedMs: 0 };
  const pool: SessionCandidate[] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof options.kanaEngine.search>>>();
  const engine = {
    ...options.kanaEngine, search: async (reading: string) => {
      throwIfConversionAborted(options.signal);
      if (cache.has(reading)) return cache.get(reading)!;
      if (metrics.engineCalls >= MAX_ENGINE_CALLS) { metrics.truncated = true; return { candidates: [], truncated: true, dictionaryRevision: "" }; }
      metrics.engineCalls++;
      const result = await options.kanaEngine!.search(reading, settings.personalDictionary ?? [], options.signal);
      metrics.truncated ||= result.truncated;
      cache.set(reading, result);
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
    const scheduled = queues.flatMap(({ partIndex, part, plans }) => plans.map((plan, round) => ({ partIndex, part, plan, round })))
      .sort((a, b) => a.plan.distance - b.plan.distance || a.round - b.round || a.partIndex - b.partIndex);
    for (const { partIndex, part, plan } of scheduled) {
      throwIfConversionAborted(options.signal);
      if (metrics.searched >= MAX_PLANS || metrics.engineCalls >= MAX_ENGINE_CALLS) { metrics.truncated = true; break; }
      metrics.searched++;
      const result = await convertLocally(input, settings, transport, {
        ...options, kanaEngine: engine, rerank: false,
        onLocalCandidates: undefined, onRankedCandidates: undefined, deferRanking: undefined
      }, { correction: { partIndex, value: plan.value } });
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
    const retained = [...first, ...alternatives].slice(0, MAX_CANDIDATES);
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
    });
  } finally {
    metrics.elapsedMs = performance.now() - started;
    options.onMissingLetterSearch?.(metrics);
  }
}
