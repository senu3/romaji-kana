import baseline from "../../evaluation/baselines/speculation-adopted-requests.json";
import { expect, it, vi } from "vitest";
import { convertRomajiToJapaneseDetailed } from "../../../src/lib/ollama";
import { defaultSettings } from "../../../src/lib/settings";

it.each(baseline.cases)("matches the evaluated adopted request without an evaluation adapter: $id", async c => {
  const generate = vi.fn().mockImplementation(async (_provider, _url, request) => ({
    response: JSON.stringify(request.outputSchema.properties.segments ? { segments: [] } : { convertedText: "", completedKana: "" }),
  }));
  await convertRomajiToJapaneseDetailed(c.input, { ...defaultSettings, userDictionary: c.userDictionary }, { models: vi.fn(), generate }, {
    ...c.options, purpose: "speculative", kanaEngine: { search: vi.fn(), verify: vi.fn() },
  });
  expect(generate).toHaveBeenCalledOnce();
  const request = generate.mock.calls[0][2];
  expect({ system: request.system, prompt: request.prompt, outputSchema: request.outputSchema }).toEqual(c.expected);
});
