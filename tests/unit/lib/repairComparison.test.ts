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
  expect(requiresExplicitAcceptance(result)).toBe(true);
  expect(h.transport.generate).toHaveBeenCalledTimes(2);
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
