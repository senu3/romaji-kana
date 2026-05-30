import { normalizeOllamaBaseUrl } from "./ollama";
import type { AppSettings, OllamaModel } from "./types";

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    modified_at?: string;
    size?: number;
  }>;
}

export interface OllamaConnectionResult {
  models: OllamaModel[];
  modelLoaded: boolean;
  kind: "connected" | "warning";
  message: string;
}

interface CheckOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export async function checkOllamaConnection(
  settings: AppSettings,
  options: CheckOptions = {},
): Promise<OllamaConnectionResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const baseUrl = normalizeOllamaBaseUrl(settings.ollamaApiUrl);
  const models = await fetchOllamaModels(baseUrl, fetchFn, timeoutMs);
  const modelName = settings.modelName.trim();

  if (!modelName) {
    return {
      models,
      modelLoaded: false,
      kind: "warning",
      message: `Connected to Ollama. ${models.length} model(s) found, but no model is selected.`,
    };
  }

  const knownModel = models.some((model) => matchesOllamaModel(model.name, modelName));
  if (!knownModel) {
    return {
      models,
      modelLoaded: false,
      kind: "warning",
      message: `Connected to Ollama, but "${modelName}" was not found in local models.`,
    };
  }

  await warmOllamaModel(baseUrl, modelName, fetchFn, timeoutMs);

  return {
    models,
    modelLoaded: true,
    kind: "connected",
    message: `Connected to Ollama. Loaded "${modelName}". ${models.length} model(s) available.`,
  };
}

async function fetchOllamaModels(
  baseUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<OllamaModel[]> {
  const response = await fetchWithTimeout(`${baseUrl}/tags`, { method: "GET" }, fetchFn, timeoutMs);
  if (!response.ok) {
    throw new Error(`Ollama tags request failed with HTTP ${response.status}.`);
  }

  const data = (await response.json()) as OllamaTagsResponse;
  return (data.models ?? [])
    .filter((model) => Boolean(model.name))
    .map((model) => ({
      name: model.name ?? "",
      modifiedAt: model.modified_at,
      size: model.size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function warmOllamaModel(
  baseUrl: string,
  modelName: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${baseUrl}/generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        prompt: "",
        stream: false,
        keep_alive: "5m",
      }),
    },
    fetchFn,
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Ollama model load failed with HTTP ${response.status}.`);
  }
}

function matchesOllamaModel(availableName: string, selectedName: string): boolean {
  return availableName === selectedName || availableName === `${selectedName}:latest`;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchFn(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
