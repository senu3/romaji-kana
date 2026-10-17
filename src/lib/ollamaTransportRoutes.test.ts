import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRemoteCompanionClient, remoteModelRequest } from "./companion";
import { defaultOllamaTransport } from "./ollamaProxy";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("./companion", () => ({ isRemoteCompanionClient: vi.fn(), remoteModelRequest: vi.fn() }));

const body = { model: "local-model", system: "rules", prompt: "input", stream: false as const, think: false };

describe("model transport routing", () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(false);
    vi.mocked(isRemoteCompanionClient).mockReturnValue(false);
    vi.mocked(invoke).mockReset().mockResolvedValue({});
    vi.mocked(remoteModelRequest).mockReset().mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["ollama", "http://localhost:11434/api/", "http://localhost:11434/api/tags", "http://localhost:11434/api/generate"],
    ["lmstudio", "http://localhost:1234/v1/", "http://localhost:1234/v1/models", "http://localhost:1234/v1/chat/completions"],
  ] as const)("uses the %s HTTP endpoints without duplicating the API prefix", async (provider, baseUrl, modelsUrl, generateUrl) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await defaultOllamaTransport.models(provider, baseUrl, 12000);
    await defaultOllamaTransport.generate(provider, baseUrl, body, 30000);
    expect(fetchMock.mock.calls[0]).toEqual([modelsUrl, expect.objectContaining({ method: "GET" })]);
    expect(fetchMock.mock.calls[1][0]).toBe(generateUrl);
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
    if (provider === "ollama") {
      expect(sent).toMatchObject({ model: body.model, system: body.system, prompt: body.prompt, stream: false });
      expect(sent).not.toHaveProperty("messages");
    } else {
      expect(sent).toMatchObject({ model: body.model, stream: false, messages: [
        { role: "system", content: body.system }, { role: "user", content: body.prompt },
      ] });
      expect(sent).not.toHaveProperty("prompt");
    }
  });

  it.each([
    ["ollama", "ollama_tags", "ollama_generate"],
    ["lmstudio", "lmstudio_models", "lmstudio_chat_completions"],
  ] as const)("uses matching Rust commands and request envelopes for %s", async (provider, modelsCommand, generateCommand) => {
    vi.mocked(isTauri).mockReturnValue(true);
    await defaultOllamaTransport.models(provider, "http://localhost:1234", 12000);
    await defaultOllamaTransport.generate(provider, "http://localhost:1234", body, 30000);
    expect(invoke).toHaveBeenNthCalledWith(1, modelsCommand, { request: { baseUrl: "http://localhost:1234", timeoutMs: 12000 } });
    expect(invoke).toHaveBeenNthCalledWith(2, generateCommand, { request: {
      baseUrl: "http://localhost:1234", timeoutMs: 30000, body: expect.objectContaining({ model: body.model, stream: false }),
    } });
  });

  it.each(["ollama", "lmstudio"] as const)("routes remote %s requests through the paired PC", async (provider) => {
    vi.mocked(isRemoteCompanionClient).mockReturnValue(true);
    const controller = new AbortController();
    await defaultOllamaTransport.models(provider, "http://localhost:1234", 12000);
    await defaultOllamaTransport.generate(provider, "http://localhost:1234", body, 30000, controller.signal);
    expect(remoteModelRequest).toHaveBeenNthCalledWith(1, "models", null, 12000);
    expect(remoteModelRequest).toHaveBeenNthCalledWith(2, "generate", expect.objectContaining({ model: body.model, stream: false }), 30000, controller.signal);
    expect(invoke).not.toHaveBeenCalled();
  });
});
