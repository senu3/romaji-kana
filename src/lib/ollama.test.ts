import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapanese } from "./ollama";
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
        prompt: "anatahadaredesuka。",
        stream: false,
        keep_alive: "5m",
      }),
      30_000,
    );
  });
});
