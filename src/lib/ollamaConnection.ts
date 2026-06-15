import { currentProviderApiBaseUrl, currentProviderBaseUrl, providerLabel } from "./ollama";
import { defaultOllamaTransport, type OllamaTransport } from "./ollamaProxy";
import type { AppSettings, OllamaModel } from "./types";

export interface OllamaConnectionResult {
  models: OllamaModel[];
  modelLoaded: boolean;
  kind: "connected" | "warning";
  message: string;
  suggestedModelName?: string;
}

interface CheckOptions {
  transport?: OllamaTransport;
  timeoutMs?: number;
  warmupTimeoutMs?: number;
}

interface ListOptions {
  transport?: OllamaTransport;
  timeoutMs?: number;
}

export async function listLocalModels(
  settings: AppSettings,
  options: ListOptions = {},
): Promise<OllamaModel[]> {
  const transport = options.transport ?? defaultOllamaTransport;
  const timeoutMs = options.timeoutMs ?? 12_000;
  return fetchLocalModels(settings, transport, timeoutMs);
}

export async function checkOllamaConnection(
  settings: AppSettings,
  options: CheckOptions = {},
): Promise<OllamaConnectionResult> {
  const transport = options.transport ?? defaultOllamaTransport;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const warmupTimeoutMs = options.warmupTimeoutMs ?? options.timeoutMs ?? 30_000;
  const label = providerLabel(settings);
  const models = await fetchLocalModels(settings, transport, timeoutMs);
  const modelName = settings.modelName.trim();
  const suggestedModelName = models[0]?.name;

  if (!modelName) {
    return {
      models,
      modelLoaded: false,
      kind: "warning",
      suggestedModelName,
      message: suggestedModelName
        ? `${label} に接続しました。変換を始めるにはモデルを選択してください。候補: "${suggestedModelName}".`
        : `${label} に接続しましたが、ローカルモデルが見つかりませんでした。`,
    };
  }

  const knownModel = models.some((model) => matchesLocalModel(model.name, modelName));
  if (!knownModel) {
    return {
      models,
      modelLoaded: false,
      kind: "warning",
      suggestedModelName,
      message: suggestedModelName
        ? `${label} に接続しましたが、"${modelName}" は見つかりませんでした。候補: "${suggestedModelName}".`
        : `${label} に接続しましたが、"${modelName}" は見つからず、利用できるローカルモデルもありません。`,
    };
  }

  await warmLocalModelWithRetry(settings, modelName, transport, warmupTimeoutMs);

  return {
    models,
    modelLoaded: true,
    kind: "connected",
    message: `${label} に接続しました。"${modelName}" を読み込みました。利用可能なモデル: ${models.length} 件。`,
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
      system: "You are a local model warm-up request. Reply with ok.",
      prompt: "ok",
      stream: false,
      think: settings.think,
      keep_alive: "5m",
    },
    timeoutMs,
  );
}

async function warmLocalModelWithRetry(
  settings: AppSettings,
  modelName: string,
  transport: OllamaTransport,
  timeoutMs: number,
): Promise<void> {
  try {
    await warmLocalModel(settings, modelName, transport, timeoutMs);
  } catch {
    await warmLocalModel(settings, modelName, transport, timeoutMs);
  }
}

function matchesLocalModel(availableName: string, selectedName: string): boolean {
  return availableName === selectedName || availableName === `${selectedName}:latest`;
}
