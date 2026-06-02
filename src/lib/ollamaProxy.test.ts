import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultOllamaTransport } from "./ollamaProxy";

describe("defaultOllamaTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries Ollama generation without thinking when thinking is rejected", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          ok: false,
          status: 400,
          text: async () => "thinking is unsupported",
        };
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          ok: true,
          json: async () => ({ response: "ok" }),
        };
      });

    vi.stubGlobal("fetch", fetchMock);

    const result = await defaultOllamaTransport.generate(
      "ollama",
      "http://localhost:11434",
      {
        model: "gemma3",
        system: "system",
        prompt: "prompt",
        stream: false,
        think: true,
      },
      100,
    );

    expect(result).toEqual({ response: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies).toEqual([
      expect.objectContaining({ think: true }),
      expect.objectContaining({ think: false }),
    ]);
  });

  it("retries LM Studio chat without thinking when reasoning options are rejected", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          ok: false,
          status: 400,
          text: async () => "reasoning_effort is unsupported",
        };
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        };
      });

    vi.stubGlobal("fetch", fetchMock);

    const result = await defaultOllamaTransport.generate(
      "lmstudio",
      "http://localhost:1234",
      {
        model: "qwen3",
        system: "system",
        prompt: "prompt",
        stream: false,
        think: true,
      },
      100,
    );

    expect(result).toEqual({ choices: [{ message: { content: "ok" } }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies).toEqual([
      expect.objectContaining({ reasoning_effort: "medium", enable_thinking: true }),
      expect.objectContaining({ reasoning_effort: "none", enable_thinking: false }),
    ]);
  });

  it("sends explicit LM Studio thinking-off controls when thinking is off", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn().mockImplementationOnce(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      };
    });

    vi.stubGlobal("fetch", fetchMock);

    await defaultOllamaTransport.generate(
      "lmstudio",
      "http://localhost:1234",
      {
        model: "qwen3",
        system: "system",
        prompt: "prompt",
        stream: false,
        think: false,
      },
      100,
    );

    expect(bodies).toEqual([
      expect.objectContaining({ reasoning_effort: "none", enable_thinking: false }),
    ]);
  });

  it("retries LM Studio chat without thinking controls if explicit off controls are rejected", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          ok: false,
          status: 400,
          text: async () => "enable_thinking is unsupported",
        };
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        };
      });

    vi.stubGlobal("fetch", fetchMock);

    await defaultOllamaTransport.generate(
      "lmstudio",
      "http://localhost:1234",
      {
        model: "local-model",
        system: "system",
        prompt: "prompt",
        stream: false,
        think: false,
      },
      100,
    );

    expect(bodies).toEqual([
      expect.objectContaining({ reasoning_effort: "none", enable_thinking: false }),
      expect.not.objectContaining({ reasoning_effort: expect.anything() }),
    ]);
  });
});
