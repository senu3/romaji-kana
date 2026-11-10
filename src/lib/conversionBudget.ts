import { generateWithAbort, throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { defaultKanaEngine } from "./kanaEngine";
import type { OllamaTransport } from "./ollamaProxy";

const DEFAULT_CONVERSION_TIMEOUT_MS = 60_000;
export const BOUNDARY_DECISION_MS = 500;

/** A queued comparison can improve the decision up to the deadline. Only
 * work already running at the deadline can produce a late review candidate. */
export async function deferConversionDecision(prepare: (remember: (result: JapaneseConversionResult) => void) => Promise<JapaneseConversionResult>,
  unavailable: JapaneseConversionResult,
  compare: (baseline: JapaneseConversionResult) => Promise<JapaneseConversionResult>, options: JapaneseConversionOptions): Promise<JapaneseConversionResult> {
  const { decisionDeadline, deferRanking, onRankedCandidates, onLateCandidates, signal } = options;
  if (decisionDeadline === undefined || !deferRanking || !onRankedCandidates) return compare(await prepare(() => {}));
  let baseline = unavailable;
  let decision: JapaneseConversionResult | undefined;
  const publish = (result: JapaneseConversionResult) => {
    if (decision || signal?.aborted) return;
    decision = result;
    void onRankedCandidates(result);
  };
  const review = (result: JapaneseConversionResult) => {
    if (!signal?.aborted && !result.suggestionRejected && result.text.trim() && result.text !== decision?.text) onLateCandidates?.(result);
  };
  const fallback = () => publish(baseline);
  const timer = setTimeout(fallback, Math.max(0, decisionDeadline - Date.now()));
  const clear = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", clear);
  };
  signal?.addEventListener("abort", clear, { once: true });
  if (Date.now() >= decisionDeadline) fallback();
  try {
    const prepared = await prepare(result => {
      if (Date.now() < decisionDeadline) baseline = result;
    });
    if (Date.now() >= decisionDeadline) fallback();
    baseline = prepared;
    if (decision || signal?.aborted) {
      review(baseline);
      clear();
      return baseline;
    }
  } catch (error) {
    clear();
    if (signal?.aborted || !decision) throw error;
    return baseline;
  }
  if (baseline.conversionStrategy === "correction") {
    clear();
    publish(baseline);
    return baseline;
  }
  deferRanking(async () => {
    try {
      if (decision || Date.now() >= decisionDeadline || signal?.aborted) { fallback(); return; }
      const result = await compare(baseline);
      if (signal?.aborted) return;
      if (Date.now() >= decisionDeadline) fallback();
      if (!decision) publish(result);
      else review(result);
    } catch {
      if (!signal?.aborted) fallback();
    } finally { clear(); }
  }, () => { clear(); fallback(); });
  return baseline;
}

/** One deadline for dictionary work, ranking and rescue, including deferred
 * ranking. Each request owns its timer; no global deadline or shared abort. */
export async function withConversionBudget(
  transport: OllamaTransport,
  options: JapaneseConversionOptions,
  run: (transport: OllamaTransport, options: JapaneseConversionOptions) => Promise<JapaneseConversionResult>,
): Promise<JapaneseConversionResult> {
  throwIfConversionAborted(options.signal);
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
    ? Math.min(options.timeoutMs!, 2_147_483_647) : DEFAULT_CONVERSION_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new DOMException(
    "変換の制限時間を超えました。範囲を短くするか、モデルの応答を確認して再実行してください。", "TimeoutError",
  )), timeoutMs);
  let returned = false;
  let deferred = 0;
  const dispose = () => {
    if (!returned || deferred) return;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  };
  const engine = options.kanaEngine ?? defaultKanaEngine;
  const boundedOptions: JapaneseConversionOptions = {
    ...options, signal,
    kanaEngine: {
      search: (reading, words) => generateWithAbort(() => engine.search(reading, words, signal), signal),
      verify: (text, reading, words) => generateWithAbort(() => engine.verify(text, reading, words, signal), signal),
    },
    deferRanking: options.deferRanking ? (rank, skip) => {
      deferred++;
      let finished = false;
      const finish = () => { if (!finished) { finished = true; deferred--; dispose(); } };
      try {
        options.deferRanking!(async () => { try { await rank(); } finally { finish(); } },
          () => { try { skip(); } finally { finish(); } });
      } catch (error) { finish(); throw error; }
    } : undefined,
  };
  const boundedTransport: OllamaTransport = {
    models: (...args) => transport.models(...args),
    generate: (provider, url, body, timeout) => generateWithAbort(
      () => transport.generate(provider, url, body, timeout, signal), signal),
  };
  try { return await generateWithAbort(() => run(boundedTransport, boundedOptions), signal); }
  finally { returned = true; dispose(); }
}
