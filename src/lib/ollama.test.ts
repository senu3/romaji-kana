import { describe, expect, it, vi } from "vitest";
import { convertRomajiToJapanese } from "./ollama";
import { buildConversionSystemPrompt, defaultConversionPrompt } from "./prompts";
import { defaultSettings } from "./settings";

describe("convertRomajiToJapanese", () => {
  it("kanjiizes high-confidence mechanical kana without repair", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "あなたは誰ですか。" }),
    };

    const result = await convertRomajiToJapanese("anatahadaredesuka.", defaultSettings, transport);

    expect(result).toBe("あなたは誰ですか。");
    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        model: "gemma3",
        system: expect.stringContaining("preserving its reading"),
        prompt: "あなたはだれですか。",
        stream: false,
        keep_alive: "5m",
        thinkingMode: "auto",
      }),
      30_000,
    );
    expect(transport.generate).toHaveBeenCalledTimes(1);
  });

  it("repairs only low-confidence kana before kanjiization", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: "じ" })
        .mockResolvedValueOnce({ response: "あなたはよく悪じひよだ" }),
    };

    const result = await convertRomajiToJapanese(
      "anatahayokuwarujhiyoda",
      defaultSettings,
      transport,
    );

    expect(result).toBe("あなたはよく悪じひよだ");
    expect(transport.generate).toHaveBeenCalledTimes(2);
    expect(transport.generate).toHaveBeenNthCalledWith(
      1,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("uncertain kana fragment"),
        prompt: expect.stringContaining("未確定部分: j"),
      }),
      30_000,
    );
    expect(transport.generate).toHaveBeenNthCalledWith(
      2,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("preserving its reading"),
        prompt: "あなたはよくわるじひよだ",
      }),
      30_000,
    );
  });

  it("preserves the reading baseline for huri instead of asking the LLM to infer from romaji", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "わかったふりをするのをやめてください" }),
    };

    await convertRomajiToJapanese(
      "wakkatahuriwosurunowoyametekudasai",
      defaultSettings,
      transport,
    );

    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: "わかったふりをするのをやめてください",
      }),
      30_000,
    );
  });

  it("reads LM Studio chat completion text", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "今日は寒いから暖かくして" } }],
      }),
    };
    const settings = {
      ...defaultSettings,
      modelProvider: "lmstudio" as const,
      lmStudioApiUrl: "http://localhost:1234",
      modelName: "local-model",
      thinkingMode: "off" as const,
    };

    const result = await convertRomajiToJapanese(
      "kyouhasamuikaraatatakakuneshite",
      settings,
      transport,
    );

    expect(result).toBe("今日は寒いから暖かくして");
    expect(transport.generate).toHaveBeenCalledWith(
      "lmstudio",
      "http://localhost:1234",
      expect.objectContaining({
        model: "local-model",
        thinkingMode: "off",
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
