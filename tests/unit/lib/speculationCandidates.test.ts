import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";

function setup(candidates: unknown[]) {
  const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ candidates }) });
  const options = { userRequestedSpeculation: true, speculationCandidates: true,
    kanaEngine: { search: vi.fn(), verify: vi.fn().mockResolvedValue("verified") } };
  return { generate, options, transport: { generate, models: vi.fn() } };
}
const proposal = (convertedText: string, completedKana: string) => ({ convertedText, completedKana });

describe("explicit speculative candidate session", () => {
  it("keeps different readings in order, deduplicates punctuation variants, and makes one generation", async () => {
    const h = setup([proposal("案をお願いします", "あんをおねがいします"), proposal("企画案をお願いします", "きかくあんをおねがいします"), proposal("案をお願いします。", "あんをおねがいします。")]);
    const result = await convertRomajiToJapaneseDetailed("annwoonegasimasu", defaultSettings, h.transport, h.options);
    expect(result.session?.candidates.map(c => c.result.text)).toEqual(["案をお願いします", "企画案をお願いします"]);
    expect(result.session?.readingPlans).toHaveLength(2);
    expect(h.generate).toHaveBeenCalledOnce();
    expect(h.generate.mock.calls[0][2].prompt).toContain("annwoonegasimasu");
    expect(h.generate.mock.calls[0][2].prompt).toContain("あんをおねがします");
    expect(result.session?.candidates.every(c => c.result.conversionStrategy === "speculative")).toBe(true);
  });
  it("retains a valid alternative when earlier candidates have invalid readings or are avoided", async () => {
    const h = setup([proposal("案をお願いします", "案をお願いします"), proposal("前の候補", "まえのこうほ"), proposal("企画案をお願いします", "きかくあんをおねがいします")]);
    const result = await convertRomajiToJapaneseDetailed("annwoonegasimasu", defaultSettings, h.transport, { ...h.options, avoidOutputs: ["前の候補"] });
    expect(result.text).toBe("企画案をお願いします");
    expect(result.session?.candidates).toHaveLength(1);
  });
  it("reassembles protected literals and discards malformed segment IDs individually", async () => {
    const h = setup([
      { segments: [{ id: "edit-0", ...proposal("の案", "のあん") }] },
      { segments: [{ id: "edit-1", ...proposal("の確認をお願いします", "のかくにんをおねがいします") }] },
    ]);
    const result = await convertRomajiToJapaneseDetailed("`MR-62`nokakunioonegasimasu", defaultSettings, h.transport, h.options);
    expect(result.text).toBe("MR-62の確認をお願いします");
    expect(result.session?.candidates).toHaveLength(1);
  });
  it("returns a rejected result when there are no usable candidates", async () => {
    const h = setup([]);
    const result = await convertRomajiToJapaneseDetailed("annwoonegasimasu", defaultSettings, h.transport, h.options);
    expect(result.suggestionRejected).toBe(true);
    expect(result.text).toBe("");
  });
});
