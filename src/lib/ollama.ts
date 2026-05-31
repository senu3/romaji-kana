import type { AppSettings } from "./types";
import { normalizeInputForPrompt } from "./conversion";
import { buildConversionSystemPrompt } from "./prompts";
import { defaultOllamaTransport, type OllamaTransport } from "./ollamaProxy";

export async function convertRomajiToJapanese(
  input: string,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
): Promise<string> {
  const normalized = normalizeInputForPrompt(input, settings);
  const result = await transport.generate(
    settings.ollamaApiUrl,
    {
      model: settings.modelName,
      system: buildConversionSystemPrompt(settings.conversionPrompt),
      prompt: normalized,
      stream: false,
      think: settings.think,
      options: {
        temperature: 0.1,
      },
      keep_alive: "5m",
    },
    30_000,
  );

  const rawText = result.response ?? result.message?.content ?? "";
  const text = stripThinkBlock(rawText).trim();
  if (!text) {
    throw new Error("Ollama returned an empty conversion.");
  }

  return text;
}

export function normalizeOllamaBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "http://localhost:11434/api";
  }
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function stripThinkBlock(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
