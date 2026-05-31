import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapanese } from "./ollama";
import { buildConversionSystemPrompt, defaultConversionPrompt } from "./prompts";
import { defaultSettings } from "./settings";

describe("convertRomajiToJapanese", () => {
  it("uses the Ollama transport and returns generated text", async () => {
    const transport = {
      tags: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "あなたは誰ですか。" }),
    };

    const result = await convertRomajiToJapanese("anatahadaredesuka.", defaultSettings, transport);

    expect(result).toBe("あなたは誰ですか。");
    expect(transport.generate).toHaveBeenCalledWith(
      "http://localhost:11434",
      expect.objectContaining({
        model: "gemma3",
        system: expect.stringContaining("【ローマ字→ひらがな対応表】"),
        prompt: "anatahadaredesuka。",
        stream: false,
        keep_alive: "5m",
      }),
      30_000,
    );
  });

  it("adds the fixed romaji reference and few-shot examples to the editable prompt", () => {
    const prompt = buildConversionSystemPrompt(defaultConversionPrompt);

    expect(prompt).toContain("You are an advanced Japanese conversion engine.");
    expect(prompt).toContain("shi/si=し");
    expect(prompt).toContain("anatahayokuwaraujhitoda");
    expect(prompt).toContain("あなたはよく笑う人だ");
  });
});
