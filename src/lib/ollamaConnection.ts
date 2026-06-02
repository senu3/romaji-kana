import { currentProviderApiBaseUrl, currentProviderBaseUrl, providerLabel } from "./ollama";
import { defaultOllamaTransport, type OllamaTransport } from "./ollamaProxy";
import type { AppSettings, OllamaModel } from "./types";

export interface OllamaConnectionResult {
  models: OllamaModel[];
  modelLoaded: boolean;
  kind: "connected" | "warning";
  message: string;
}

interface CheckOptions {
  transport?: OllamaTransport;
  timeoutMs?: number;
}

export async function checkOllamaConnection(
  settings: AppSettings,
  options: CheckOptions = {},
): Promise<OllamaConnectionResult> {
  const transport = options.transport ?? defaultOllamaTransport;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const label = providerLabel(settings);
  const models = await fetchLocalModels(settings, transport, timeoutMs);
  const modelName = settings.modelName.trim();

  if (!modelName) {
    return {
      models,
      modelLoaded: false,
      kind: "warning",
      message: `Connected to ${label}. ${models.length} model(s) found, but no model is selected.`,
    };
  }

  const knownModel = models.some((model) => matchesLocalModel(model.name, modelName));
  if (!knownModel) {
    return {
      models,
      modelLoaded: false,
      kind: "warning",
      message: `Connected to ${label}, but "${modelName}" was not found in local models.`,
    };
  }

  await warmLocalModel(settings, modelName, transport, timeoutMs);

  return {
    models,
    modelLoaded: true,
    kind: "connected",
    message: `Connected to ${label}. Loaded "${modelName}". ${models.length} model(s) available.`,
  };
}

async function fetchLocalModels(
  settings: AppSettings,
  transport: OllamaTransport,
  timeoutMs: number,
): Promise<OllamaModel[]> {
  const data = await transport.models(
    settings.modelProvider,
    currentProviderApiBaseUrl(settings),
    timeoutMs,
  );
  if ("data" in data && Array.isArray(data.data)) {
    return (data.data ?? [])
      .filter((model) => Boolean(model.id))
      .map((model) => ({
        name: model.id ?? "",
        modifiedAt: model.created ? new Date(model.created * 1000).toISOString() : undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  if (!("models" in data)) {
    return [];
  }

  return (data.models ?? [])
    .filter((model) => Boolean(model.name))
    .map((model) => ({
      name: model.name ?? "",
      modifiedAt: model.modified_at,
      size: model.size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function warmLocalModel(
  settings: AppSettings,
  modelName: string,
  transport: OllamaTransport,
  timeoutMs: number,
): Promise<void> {
  await transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: modelName,
      system: "You are a local model warm-up request. Return nothing.",
      prompt: "",
      stream: false,
      thinkingMode: settings.thinkingMode,
      keep_alive: "5m",
    },
    timeoutMs,
  );
}

function matchesLocalModel(availableName: string, selectedName: string): boolean {
  return availableName === selectedName || availableName === `${selectedName}:latest`;
}
