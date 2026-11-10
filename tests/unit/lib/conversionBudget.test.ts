import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCandidate } from "../../../src/lib/kanaEngine";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";
import { BOUNDARY_DECISION_MS, deferConversionDecision } from "../../../src/lib/conversionBudget";

function harness(candidates: EngineCandidate[] = []) {
  const engine = { search: vi.fn().mockResolvedValue({ candidates, dictionaryRevision: "test", truncated: false }),
    verify: vi.fn().mockResolvedValue("verified") };
  const transport = { models: vi.fn(), generate: vi.fn() };
  return { engine, transport };
}
function candidate(text: string): EngineCandidate {
  return { text, reading: "ほん", cost: 100, tokens: [{ text, reading: "ほん", from: 0, to: 2,
    source: "mozc", entryId: text, lid: 0, rid: 0, wordCost: 100 }] };
}

describe("whole conversion budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("bounds an unresponsive dictionary and does not start rescue after timeout", async () => {
    const h = harness();
    h.engine.search.mockImplementation(() => new Promise(() => {}));
    const result = convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, { kanaEngine: h.engine, timeoutMs: 100 });
    const assertion = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(h.engine.search.mock.calls[0][2].aborted).toBe(true);
    expect(h.transport.generate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one budget across correction and speculation instead of resetting per stage", async () => {
    const h = harness();
    h.transport.generate.mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => resolve({ response: '{"convertedText":"","completedKana":""}' }), 60);
    })).mockImplementation(() => new Promise(() => {}));
    const result = convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, {
      kanaEngine: h.engine, autoSpeculation: true, missingLetterCorrection: false, timeoutMs: 100,
    });
    const assertion = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(60);
    expect(h.transport.generate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(40);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["skip", "expire"] as const)("cleans up deferred ranking on %s", async action => {
    const h = harness([candidate("本"), candidate("奔")]);
    let rank!: () => Promise<void>;
    let skip!: () => void;
    const result = await convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, {
      kanaEngine: h.engine, timeoutMs: 100, deferRanking: (run, discard) => { rank = run; skip = discard; },
    });
    expect(result.text).toBe("本");
    expect(vi.getTimerCount()).toBe(1);
    if (action === "skip") skip();
    else { await vi.advanceTimersByTimeAsync(100); await rank(); }
    expect(result.session?.rerankStatus).toBe("skipped");
    expect(h.transport.generate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still observes caller cancellation during ranking and removes the deadline timer", async () => {
    const h = harness([candidate("本"), candidate("奔")]);
    h.transport.generate.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = convertRomajiToJapaneseDetailed("hon", defaultSettings, h.transport, {
      kanaEngine: h.engine, signal: controller.signal, timeoutMs: 100,
    });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.generate).toHaveBeenCalledOnce();
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("boundary decision", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("includes the ranking queue in the deadline and skips an expired comparison", async () => {
    const normal = { text: "本", reviewKana: "ほん" };
    const compare = vi.fn();
    const decide = vi.fn();
    let queued!: () => Promise<void>;
    await deferConversionDecision(async () => normal, { text: "", reviewKana: "ほん" }, compare, {
      decisionDeadline: Date.now() + BOUNDARY_DECISION_MS,
      deferRanking: run => { queued = run; },
      onRankedCandidates: decide,
    });
    await vi.advanceTimersByTimeAsync(BOUNDARY_DECISION_MS);
    expect(decide).toHaveBeenCalledExactlyOnceWith(normal);
    await queued();
    expect(compare).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves the original at the deadline if the dictionary has not returned", async () => {
    const unavailable = { text: "", reviewKana: "ほん", suggestionRejected: true };
    const normal = { text: "本", reviewKana: "ほん" };
    let ready!: (result: typeof normal) => void;
    const prepare = new Promise<typeof normal>(resolve => { ready = resolve; });
    const decide = vi.fn();
    const late = vi.fn();
    const compare = vi.fn();
    const result = deferConversionDecision(() => prepare, unavailable, compare, {
      decisionDeadline: Date.now() + BOUNDARY_DECISION_MS,
      deferRanking: vi.fn(),
      onRankedCandidates: decide,
      onLateCandidates: late,
    });
    await vi.advanceTimersByTimeAsync(BOUNDARY_DECISION_MS);
    expect(decide).toHaveBeenCalledExactlyOnceWith(unavailable);
    ready(normal);
    await result;
    expect(compare).not.toHaveBeenCalled();
    expect(late).toHaveBeenCalledExactlyOnceWith(normal);
  });

  it("uses the remembered normal candidate if a local correction is still pending at the deadline", async () => {
    const normal = { text: "尾根がします", reviewKana: "おねがします" };
    const correction = { text: "お願いします", reviewKana: "おねがいします", conversionStrategy: "correction" as const };
    let finish!: (result: typeof correction) => void;
    const prepare = new Promise<typeof correction>(resolve => { finish = resolve; });
    const decide = vi.fn();
    const late = vi.fn();
    const queue = vi.fn();
    const result = deferConversionDecision(remember => { remember(normal); return prepare; },
      { text: "", reviewKana: "", suggestionRejected: true }, vi.fn(), {
        decisionDeadline: Date.now() + BOUNDARY_DECISION_MS, deferRanking: queue,
        onRankedCandidates: decide, onLateCandidates: late,
      });
    await vi.advanceTimersByTimeAsync(BOUNDARY_DECISION_MS);
    expect(decide).toHaveBeenCalledExactlyOnceWith(normal);
    finish(correction);
    await result;
    expect(late).toHaveBeenCalledExactlyOnceWith(correction);
    expect(queue).not.toHaveBeenCalled();
  });
});
