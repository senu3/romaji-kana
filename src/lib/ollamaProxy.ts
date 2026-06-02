import { invoke, isTauri } from "@tauri-apps/api/core";
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
  model: string;
  system: string;
  prompt: string;
  stream: false;
  thinkingMode: "auto" | "on" | "off";
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
  ): Promise<LocalGenerateResponse>;
}

export const defaultOllamaTransport: OllamaTransport = {
  async models(provider, baseUrl, timeoutMs) {
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

  async generate(provider, baseUrl, body, timeoutMs) {
    if (provider === "lmstudio") {
      return generateLmStudioChat(baseUrl, body, timeoutMs);
    }

    const ollamaBody = toOllamaGenerateBody(body);
    if (isTauri()) {
      return invoke<OllamaGenerateResponse>("ollama_generate", {
        request: { baseUrl, body: ollamaBody, timeoutMs },
      });
    }

    return fetchLocalJson<OllamaGenerateResponse>(
      normalizeOllamaBaseUrl(baseUrl),
      "generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(ollamaBody),
      },
      timeoutMs,
      "Ollama",
    );
  },
};

function toOllamaGenerateBody(body: LocalGenerateBody): Record<string, unknown> {
  const nextBody: Record<string, unknown> = {
    model: body.model,
    system: body.system,
    prompt: body.prompt,
    stream: body.stream,
    options: body.options,
    keep_alive: body.keep_alive,
  };

  if (body.thinkingMode !== "auto") {
    nextBody.think = body.thinkingMode === "on";
  }

  return nextBody;
}

function toLmStudioChatBody(body: LocalGenerateBody): Record<string, unknown> {
  const nextBody: Record<string, unknown> = {
    model: body.model,
    messages: [
      { role: "system", content: body.system },
      { role: "user", content: body.prompt },
    ],
    stream: false,
    temperature: body.options?.temperature,
  };

  if (body.thinkingMode === "on") {
    nextBody.reasoning_effort = "medium";
    nextBody.enable_thinking = true;
  } else if (body.thinkingMode === "off") {
    nextBody.reasoning_effort = "none";
    nextBody.enable_thinking = false;
  }

  return nextBody;
}

async function generateLmStudioChat(
  baseUrl: string,
  body: LocalGenerateBody,
  timeoutMs: number,
): Promise<LmStudioChatResponse> {
  try {
    return await requestLmStudioChat(baseUrl, toLmStudioChatBody(body), timeoutMs);
  } catch (error) {
    if (body.thinkingMode === "auto" || !isReasoningOptionError(error)) {
      throw error;
    }

    return requestLmStudioChat(
      baseUrl,
      toLmStudioChatBody({ ...body, thinkingMode: "auto" }),
      timeoutMs,
    );
  }
}

async function requestLmStudioChat(
  baseUrl: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<LmStudioChatResponse> {
  if (isTauri()) {
    return invoke<LmStudioChatResponse>("lmstudio_chat_completions", {
      request: { baseUrl, body, timeoutMs },
    });
  }

  return fetchLocalJson<LmStudioChatResponse>(
    normalizeLmStudioBaseUrl(baseUrl),
    "chat/completions",
    {
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
  return /reasoning|enable_thinking|thinking|unsupported|unknown|invalid/i.test(message);
}

async function fetchLocalJson<T>(
  normalizedBaseUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  providerLabel: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

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
  }
}
