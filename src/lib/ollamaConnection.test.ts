import { describe, expect, it, vi } from "vitest";
import { checkOllamaConnection } from "./ollamaConnection";
import { defaultSettings } from "./settings";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("checkOllamaConnection", () => {
  it("fetches local models and warms the selected model", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            { name: "llama3.2:latest", modified_at: "2026-01-01T00:00:00Z", size: 123 },
            { name: "gemma3:latest", modified_at: "2026-01-02T00:00:00Z", size: 456 },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ done: true }));

    const result = await checkOllamaConnection(defaultSettings, {
      fetchFn,
      timeoutMs: 100,
    });

    expect(result.kind).toBe("connected");
    expect(result.modelLoaded).toBe(true);
    expect(result.models.map((model) => model.name)).toEqual(["gemma3:latest", "llama3.2:latest"]);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "http://localhost:11434/api/tags",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "http://localhost:11434/api/generate",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"model":"gemma3"'),
      }),
    );
  });

  it("returns a warning when the selected model is absent", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        models: [{ name: "llama3.2:latest" }],
      }),
    );

    const result = await checkOllamaConnection(defaultSettings, {
      fetchFn,
      timeoutMs: 100,
    });

    expect(result.kind).toBe("warning");
    expect(result.modelLoaded).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
