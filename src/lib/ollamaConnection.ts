import { normalizeOllamaBaseUrl } from "./ollama";
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
  const baseUrl = normalizeOllamaBaseUrl(settings.ollamaApiUrl);
  const models = await fetchOllamaModels(baseUrl, transport, timeoutMs);
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

  await warmOllamaModel(baseUrl, modelName, transport, timeoutMs);

  return {
    models,
    modelLoaded: true,
    kind: "connected",
    message: `Connected to Ollama. Loaded "${modelName}". ${models.length} model(s) available.`,
  };
}

async function fetchOllamaModels(
  baseUrl: string,
  transport: OllamaTransport,
  timeoutMs: number,
): Promise<OllamaModel[]> {
  const data = await transport.tags(baseUrl, timeoutMs);
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
  transport: OllamaTransport,
  timeoutMs: number,
): Promise<void> {
  await transport.generate(
    baseUrl,
    {
      model: modelName,
      prompt: "",
      stream: false,
      keep_alive: "5m",
    },
    timeoutMs,
  );
}

function matchesOllamaModel(availableName: string, selectedName: string): boolean {
  return availableName === selectedName || availableName === `${selectedName}:latest`;
}
