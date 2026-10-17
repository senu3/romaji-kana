import { invoke, isTauri } from "@tauri-apps/api/core";
import { isRemoteCompanionClient, remoteModelRequest } from "./companion";
import type { ModelProvider } from "./types";

export interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    modified_at?: string;
    size?: number;
  }>;
}

export interface LmStudioModelsResponse {
  data?: Array<{
    id?: string;
    created?: number;
    owned_by?: string;
  }>;
}

export type LocalModelsResponse = OllamaTagsResponse | LmStudioModelsResponse;

export function normalizeOllamaBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "http://localhost:11434/api";
  }
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function normalizeLmStudioBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "http://localhost:1234/v1";
  }
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export interface OllamaGenerateResponse {
  response?: string;
  message?: {
    content?: string;
  };
}

export interface LmStudioChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
}

export type LocalGenerateResponse = OllamaGenerateResponse | LmStudioChatResponse;

export interface LocalGenerateBody {
  outputSchema?: Record<string, unknown>;
  model: string;
  system: string;
  prompt: string;
  stream: false;
  think: boolean;
  options?: {
    temperature?: number;
  };
  keep_alive?: string;
}

export interface OllamaTransport {
  models(
    provider: ModelProvider,
    baseUrl: string,
    timeoutMs: number,
  ): Promise<LocalModelsResponse>;
  generate(
    provider: ModelProvider,
    baseUrl: string,
    body: LocalGenerateBody,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<LocalGenerateResponse>;
}

export const defaultOllamaTransport: OllamaTransport = {
  async models(provider, baseUrl, timeoutMs) {
    if (isRemoteCompanionClient()) {
      return remoteModelRequest<LocalModelsResponse>("models", null, timeoutMs);
    }
    if (provider === "lmstudio") {
      if (isTauri()) {
        return invoke<LmStudioModelsResponse>("lmstudio_models", {
          request: { baseUrl, timeoutMs },
        });
      }

      return fetchLocalJson<LmStudioModelsResponse>(
        normalizeLmStudioBaseUrl(baseUrl),
        "models",
        { method: "GET" },
        timeoutMs,
        "LM Studio",
      );
    }

    if (isTauri()) {
      return invoke<OllamaTagsResponse>("ollama_tags", {
        request: { baseUrl, timeoutMs },
      });
    }

    return fetchLocalJson<OllamaTagsResponse>(
      normalizeOllamaBaseUrl(baseUrl),
      "tags",
      { method: "GET" },
      timeoutMs,
      "Ollama",
    );
  },

  async generate(provider, baseUrl, body, timeoutMs, signal) {
    if (provider === "lmstudio") {
      return generateLmStudioChat(baseUrl, body, timeoutMs, signal);
    }

    return generateOllama(baseUrl, body, timeoutMs, signal);
  },
};

function toOllamaGenerateBody(body: LocalGenerateBody): Record<string, unknown> {
  const nextBody: Record<string, unknown> = {
    model: body.model,
    system: body.system,
    prompt: body.prompt,
    stream: body.stream,
    think: body.think,
    options: body.options,
    keep_alive: body.keep_alive,
    ...(body.outputSchema ? { format: body.outputSchema } : {}),
  };

  return nextBody;
}

async function generateOllama(
  baseUrl: string,
  body: LocalGenerateBody,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OllamaGenerateResponse> {
  try {
    return await requestOllamaGenerate(baseUrl, toOllamaGenerateBody(body), timeoutMs, signal);
  } catch (error) {
    if (!body.think || !isReasoningOptionError(error)) {
      throw error;
    }

    return requestOllamaGenerate(
      baseUrl,
      toOllamaGenerateBody({ ...body, think: false }),
      timeoutMs,
      signal,
    );
  }
}

async function requestOllamaGenerate(
  baseUrl: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OllamaGenerateResponse> {
  if (isRemoteCompanionClient()) {
    return remoteModelRequest<OllamaGenerateResponse>("generate", body, timeoutMs, signal);
  }
  if (isTauri()) {
    return invoke<OllamaGenerateResponse>("ollama_generate", {
      request: { baseUrl, body, timeoutMs },
    });
  }

  return fetchLocalJson<OllamaGenerateResponse>(
    normalizeOllamaBaseUrl(baseUrl),
    "generate",
    {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
    "Ollama",
  );
}

function toLmStudioChatBody(
  body: LocalGenerateBody,
  includeThinkingControls = true,
): Record<string, unknown> {
  const nextBody: Record<string, unknown> = {
    model: body.model,
    messages: [
      { role: "system", content: body.system },
      { role: "user", content: body.prompt },
    ],
    stream: false,
    temperature: body.options?.temperature,
    ...(body.outputSchema ? { response_format: { type: "json_schema", json_schema: {
      name: "conversion_candidate_order", strict: true, schema: body.outputSchema,
    } } } : {}),
  };

  if (!includeThinkingControls) {
    return nextBody;
  }

  if (body.think) {
    nextBody.reasoning_effort = "medium";
    nextBody.enable_thinking = true;
  } else {
    nextBody.reasoning_effort = "none";
    nextBody.enable_thinking = false;
  }

  return nextBody;
}

async function generateLmStudioChat(
  baseUrl: string,
  body: LocalGenerateBody,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LmStudioChatResponse> {
  try {
    return await requestLmStudioChat(baseUrl, toLmStudioChatBody(body), timeoutMs, signal);
  } catch (error) {
    if (!isReasoningOptionError(error)) {
      throw error;
    }

    if (!body.think) {
      return requestLmStudioChat(baseUrl, toLmStudioChatBody(body, false), timeoutMs, signal);
    }

    try {
      return await requestLmStudioChat(
        baseUrl,
        toLmStudioChatBody({ ...body, think: false }),
        timeoutMs,
        signal,
      );
    } catch (retryError) {
      if (!isReasoningOptionError(retryError)) {
        throw retryError;
      }

      return requestLmStudioChat(baseUrl, toLmStudioChatBody(body, false), timeoutMs, signal);
    }
  }
}

async function requestLmStudioChat(
  baseUrl: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LmStudioChatResponse> {
  if (isRemoteCompanionClient()) {
    return remoteModelRequest<LmStudioChatResponse>("generate", body, timeoutMs, signal);
  }
  if (isTauri()) {
    return invoke<LmStudioChatResponse>("lmstudio_chat_completions", {
      request: { baseUrl, body, timeoutMs },
    });
  }

  return fetchLocalJson<LmStudioChatResponse>(
    normalizeLmStudioBaseUrl(baseUrl),
    "chat/completions",
    {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
    "LM Studio",
  );
}

function isReasoningOptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/\bHTTP (\d{3})\b/i)?.[1];
  if (status && status !== "400" && status !== "422") {
    return false;
  }
  return (
    /\breasoning(?:_effort)?\b|\benable_thinking\b|\bthink(?:ing)?\b/i.test(message) &&
    /unsupported|not supported|does not support|unknown|unrecognized|invalid|not allowed|must be|expected/i.test(message)
  );
}

async function fetchLocalJson<T>(
  normalizedBaseUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  providerLabel: string,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timeout = globalThis.setTimeout(abort, timeoutMs);

  try {
    const response = await fetch(`${normalizedBaseUrl}/${path}`, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${providerLabel} request failed with HTTP ${response.status}. ${body}`);
    }

    return (await response.json()) as T;
  } finally {
    globalThis.clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}
