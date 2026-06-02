import { describe, expect, it, vi } from "vitest";
import { checkOllamaConnection } from "./ollamaConnection";
import { defaultSettings } from "./settings";

describe("checkOllamaConnection", () => {
  it("fetches local models and warms the selected model", async () => {
    const transport = {
      models: vi.fn().mockResolvedValue(
        {
          models: [
            { name: "llama3.2:latest", modified_at: "2026-01-01T00:00:00Z", size: 123 },
            { name: "gemma3:latest", modified_at: "2026-01-02T00:00:00Z", size: 456 },
          ],
        },
      ),
      generate: vi.fn().mockResolvedValue({ done: true }),
    };

    const result = await checkOllamaConnection(defaultSettings, {
      transport,
      timeoutMs: 100,
    });

    expect(result.kind).toBe("connected");
    expect(result.modelLoaded).toBe(true);
    expect(result.models.map((model) => model.name)).toEqual(["gemma3:latest", "llama3.2:latest"]);
    expect(transport.models).toHaveBeenCalledWith("ollama", "http://localhost:11434/api", 100);
    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({ model: "gemma3", stream: false, think: false }),
      100,
    );
  });

  it("fetches LM Studio models and warms the selected model", async () => {
    const transport = {
      models: vi.fn().mockResolvedValue({
        data: [{ id: "qwen/qwen3-8b", created: 1_767_225_600 }],
      }),
      generate: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "" } }],
      }),
    };

    const result = await checkOllamaConnection(
      {
        ...defaultSettings,
        modelProvider: "lmstudio",
        lmStudioApiUrl: "http://localhost:1234",
        modelName: "qwen/qwen3-8b",
        think: true,
      },
      {
        transport,
        timeoutMs: 100,
      },
    );

    expect(result.kind).toBe("connected");
    expect(result.modelLoaded).toBe(true);
    expect(result.models.map((model) => model.name)).toEqual(["qwen/qwen3-8b"]);
    expect(result.message).toContain("LM Studio");
    expect(transport.models).toHaveBeenCalledWith("lmstudio", "http://localhost:1234/v1", 100);
    expect(transport.generate).toHaveBeenCalledWith(
      "lmstudio",
      "http://localhost:1234",
      expect.objectContaining({
        model: "qwen/qwen3-8b",
        stream: false,
        think: true,
      }),
      100,
    );
  });

  it("returns a warning when the selected model is absent", async () => {
    const transport = {
      models: vi.fn().mockResolvedValue({
        models: [{ name: "llama3.2:latest" }],
      }),
      generate: vi.fn(),
    };

    const result = await checkOllamaConnection(defaultSettings, {
      transport,
      timeoutMs: 100,
    });

    expect(result.kind).toBe("warning");
    expect(result.modelLoaded).toBe(false);
    expect(transport.models).toHaveBeenCalledTimes(1);
    expect(transport.generate).not.toHaveBeenCalled();
  });
});
