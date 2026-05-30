import { invoke, isTauri } from "@tauri-apps/api/core";

export interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    modified_at?: string;
    size?: number;
  }>;
}

function normalizeOllamaBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "http://localhost:11434/api";
  }
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export interface OllamaGenerateResponse {
  response?: string;
  message?: {
    content?: string;
  };
}

export interface OllamaTransport {
  tags(baseUrl: string, timeoutMs: number): Promise<OllamaTagsResponse>;
  generate(
    baseUrl: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<OllamaGenerateResponse>;
}

export const defaultOllamaTransport: OllamaTransport = {
  async tags(baseUrl, timeoutMs) {
    if (isTauri()) {
      return invoke<OllamaTagsResponse>("ollama_tags", {
        request: { baseUrl, timeoutMs },
      });
    }

    return fetchOllamaJson<OllamaTagsResponse>(baseUrl, "tags", { method: "GET" }, timeoutMs);
  },

  async generate(baseUrl, body, timeoutMs) {
    if (isTauri()) {
      return invoke<OllamaGenerateResponse>("ollama_generate", {
        request: { baseUrl, body, timeoutMs },
      });
    }

    return fetchOllamaJson<OllamaGenerateResponse>(
      baseUrl,
      "generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  },
};

async function fetchOllamaJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${normalizeOllamaBaseUrl(baseUrl)}/${path}`, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama request failed with HTTP ${response.status}. ${body}`);
    }

    return (await response.json()) as T;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
