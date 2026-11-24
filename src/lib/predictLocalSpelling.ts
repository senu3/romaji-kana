import { defaultKanaEngine } from "./kanaEngine";
import { convertLocally } from "./localConversion";
import { defaultOllamaTransport } from "./ollamaProxy";
import type { AppSettings } from "./types";

export async function predictLocalSpelling(reading: string, settings: AppSettings, signal?: AbortSignal) {
  const result = await convertLocally(reading, settings, defaultOllamaTransport, {
    purpose: "normal", kanaEngine: defaultKanaEngine, rerank: false, signal,
  });
  return result.suggestionRejected || !result.text ? reading : result.text;
}
