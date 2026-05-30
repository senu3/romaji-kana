import { generateText } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import type { AppSettings } from "./types";
import { normalizeInputForPrompt } from "./conversion";
import { defaultConversionPrompt } from "./prompts";

export async function convertRomajiToJapanese(
  input: string,
  settings: AppSettings,
): Promise<string> {
  const normalized = normalizeInputForPrompt(input, settings);
  const ollama = createOllama({
    baseURL: normalizeOllamaBaseUrl(settings.ollamaApiUrl),
  });

  const result = await generateText({
    model: ollama(settings.modelName),
    system: settings.conversionPrompt.trim() || defaultConversionPrompt,
    prompt: normalized,
    temperature: 0.1,
    providerOptions: {
      ollama: {
        think: settings.think,
      },
    },
  });

  const text = stripThinkBlock(result.text).trim();
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
