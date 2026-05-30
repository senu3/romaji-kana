import { describe, expect, it, vi } from "vitest";
import { checkOllamaConnection } from "./ollamaConnection";
import { defaultSettings } from "./settings";

describe("checkOllamaConnection", () => {
  it("fetches local models and warms the selected model", async () => {
    const transport = {
      tags: vi.fn().mockResolvedValue(
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
    expect(transport.tags).toHaveBeenCalledWith("http://localhost:11434/api", 100);
    expect(transport.generate).toHaveBeenCalledWith(
      "http://localhost:11434/api",
      expect.objectContaining({ model: "gemma3", stream: false }),
      100,
    );
  });

  it("returns a warning when the selected model is absent", async () => {
    const transport = {
      tags: vi.fn().mockResolvedValue({
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
    expect(transport.tags).toHaveBeenCalledTimes(1);
    expect(transport.generate).not.toHaveBeenCalled();
  });
});
