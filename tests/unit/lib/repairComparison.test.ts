import { expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";
import { requiresExplicitAcceptance } from "../../../src/lib/readingAssessment";
import type { KanaEngine } from "../../../src/lib/kanaEngine";

function setup(repairNeeded: boolean, chooseRepair: boolean) {
  const engine: KanaEngine = { verify: vi.fn().mockResolvedValue("verified"), search: vi.fn(async reading => ({
    dictionaryRevision: "test", truncated: false,
    candidates: (reading === "よってい" ? ["よってい", "寄ってい"] : reading === "よてい" ? ["予定"] : []).map(text => ({
      text, reading, cost: 100, tokens: [{ text, reading, from: 0, to: reading.length, source: "mozc" as const, entryId: text, lid: 0, rid: 0, wordCost: 100 }],
    })),
  })) };
  const generate = vi.fn(async (_p, _u, body) => {
    const request = JSON.parse(body.prompt) as { candidates: Array<{ id: string; text: string }> };
    const baseline = request.candidates.find(c => c.id === "unchanged");
    const selected = baseline ? (chooseRepair ? request.candidates.find(c => c.text === "予定") : baseline) : request.candidates[0];
    return { response: JSON.stringify({ order: [selected!.id], repairNeeded: baseline ? false : repairNeeded }) };
  });
  return { engine, transport: { models: vi.fn(), generate } };
}
it("compares a suspected typo against an unchanged alternative and requires acceptance", async () => {
  const h = setup(true, true);
  const result = await convertRomajiToJapaneseDetailed("yottei", defaultSettings, h.transport, { kanaEngine: h.engine });
  expect(result.text).toBe("予定");
  expect(result.session?.candidates.some(c => c.id === "unchanged")).toBe(true);
  const comparison = JSON.parse(h.transport.generate.mock.calls[1][2].prompt);
  expect(comparison.candidates.find((c: { id: string }) => c.id === "unchanged").cost).toBe(100);
  expect(requiresExplicitAcceptance(result)).toBe(true);
  expect(h.transport.generate).toHaveBeenCalledTimes(2);
});
it("does not replace an option the user selected while comparison was running", async () => {
  const h = setup(true, true);
  let original: Awaited<ReturnType<typeof convertRomajiToJapaneseDetailed>> | undefined;
  const generate = h.transport.generate.getMockImplementation()!;
  h.transport.generate.mockImplementation(async (...args) => {
    if (JSON.parse(args[2].prompt).candidates.some((c: { id: string }) => c.id === "unchanged")) original!.session!.locked = true;
    return generate(...args);
  });
  const result = await convertRomajiToJapaneseDetailed("yottei", defaultSettings, h.transport, {
    kanaEngine: h.engine, onLocalCandidates: result => { original = result; },
  });
  expect(result.text).toBe("よってい");
  expect(result.session).toBe(original?.session);
});
it("keeps the unchanged option when repair evidence is insufficient", async () => {
  const h = setup(true, false);
  const result = await convertRomajiToJapaneseDetailed("yottei", defaultSettings, h.transport, { kanaEngine: h.engine });
  expect(result.text).toBe("よってい");
  expect(result.conversionStrategy).toBeUndefined();
  expect(result.repairRequested).toBeUndefined();
});
it("does not search repairs for a normal ranking decision", async () => {
  const h = setup(false, true);
  await convertRomajiToJapaneseDetailed("yottei", defaultSettings, h.transport, { kanaEngine: h.engine });
  expect(h.engine.search).toHaveBeenCalledOnce();
  expect(h.transport.generate).toHaveBeenCalledOnce();
});
it("compares a stranded small-tsu dictionary fragment even when the model misses the typo", async () => {
  const h = setup(false, true);
  const engine: KanaEngine = { ...h.engine, search: async (...args) => {
    const result = await h.engine.search(...args);
    if (args[0] === "よってい") for (const c of result.candidates) {
      c.tokens = [...c.reading].map((reading, from) => ({ ...c.tokens[0], text: [...c.text][from], reading, from, to: from + 1 }));
    }
    return result;
  } };
  const result = await convertRomajiToJapaneseDetailed("yottei", defaultSettings, h.transport, { kanaEngine: engine });
  expect(result.text).toBe("予定");
  expect(h.transport.generate).toHaveBeenCalledTimes(2);
});
