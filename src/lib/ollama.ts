import type { AppSettings } from "./types";
import { normalizeInputForPrompt } from "./conversion";
import { buildKanaKanjiSystemPrompt, buildKanaRepairSystemPrompt } from "./prompts";
import {
  defaultOllamaTransport,
  normalizeLmStudioBaseUrl,
  normalizeOllamaBaseUrl as normalizeOllamaBaseUrlFromProxy,
  type LocalGenerateResponse,
  type OllamaTransport,
} from "./ollamaProxy";
import { rebuildRomajiKanaResult, romajiToKana } from "./romajiKana";
import type { RomajiKanaResult, RomajiKanaSpan, RomajiKanaToken } from "./types";

export async function convertRomajiToJapanese(
  input: string,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
): Promise<string> {
  const normalized = normalizeInputForPrompt(input, settings);
  const kanaResult = romajiToKana(normalized);
  const repaired = await repairLowConfidenceKana(kanaResult, settings, transport);
  return kanjiizeKana(repaired.kana, settings, transport);
}

export async function repairLowConfidenceKana(
  result: RomajiKanaResult,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
): Promise<RomajiKanaResult> {
  if (result.lowConfidenceSpans.length === 0) {
    return result;
  }

  let tokens = result.tokens;

  for (const span of result.lowConfidenceSpans) {
    const repairedKana = await repairKanaSpan(span, result.kana, settings, transport);
    if (!repairedKana) {
      continue;
    }

    tokens = replaceSpanWithRepair(tokens, span, repairedKana);
  }

  return rebuildRomajiKanaResult(tokens, result.lowConfidenceSpans[0]?.sourceRomaji ?? "");
}

export async function kanjiizeKana(
  kana: string,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
): Promise<string> {
  const result = await transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: buildKanaKanjiSystemPrompt(settings.conversionPrompt),
      prompt: kana,
      stream: false,
      thinkingMode: settings.thinkingMode,
      options: {
        temperature: 0.1,
      },
      keep_alive: "5m",
    },
    30_000,
  );

  const rawText = generatedText(result);
  const text = stripThinkBlock(rawText).trim();
  if (!text) {
    throw new Error(`${providerLabel(settings)} returned an empty conversion.`);
  }

  return text;
}

async function repairKanaSpan(
  span: RomajiKanaSpan,
  mechanicalKana: string,
  settings: AppSettings,
  transport: OllamaTransport,
): Promise<string> {
  const result = await transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: buildKanaRepairSystemPrompt(),
      prompt: [
        `未確定部分: ${span.kana}`,
        `周辺: ${span.contextKana}`,
        `元入力: ${span.romaji}`,
        `機械変換全文: ${mechanicalKana}`,
      ].join("\n"),
      stream: false,
      thinkingMode: settings.thinkingMode,
      options: {
        temperature: 0,
      },
      keep_alive: "5m",
    },
    30_000,
  );

  return cleanKanaFragment(generatedText(result));
}

function replaceSpanWithRepair(
  tokens: RomajiKanaToken[],
  span: RomajiKanaSpan,
  repairedKana: string,
): RomajiKanaToken[] {
  const start = tokens.findIndex((token) => token.inputFrom === span.inputFrom);
  const end = tokens.findIndex((token) => token.inputTo === span.inputTo);
  if (start === -1 || end === -1 || end < start) {
    return tokens;
  }

  const first = tokens[start];
  const last = tokens[end];
  const repairedToken: RomajiKanaToken = {
    romaji: span.romaji,
    kana: repairedKana,
    inputFrom: first.inputFrom,
    inputTo: last.inputTo,
    kanaFrom: first.kanaFrom,
    kanaTo: first.kanaFrom + repairedKana.length,
    confidence: 0.8,
    kind: "repaired",
  };

  return [...tokens.slice(0, start), repairedToken, ...tokens.slice(end + 1)];
}

function cleanKanaFragment(text: string): string {
  return stripThinkBlock(text)
    .trim()
    .replace(/^["'「『]|["'」』]$/g, "")
    .trim();
}

export function normalizeOllamaBaseUrl(url: string): string {
  return normalizeOllamaBaseUrlFromProxy(url);
}

export function currentProviderBaseUrl(settings: AppSettings): string {
  if (settings.modelProvider === "lmstudio") {
    return settings.lmStudioApiUrl;
  }

  return settings.ollamaApiUrl;
}

export function currentProviderApiBaseUrl(settings: AppSettings): string {
  if (settings.modelProvider === "lmstudio") {
    return normalizeLmStudioBaseUrl(settings.lmStudioApiUrl);
  }

  return normalizeOllamaBaseUrl(settings.ollamaApiUrl);
}

export function providerLabel(settings: AppSettings): string {
  return settings.modelProvider === "lmstudio" ? "LM Studio" : "Ollama";
}

function generatedText(result: LocalGenerateResponse): string {
  if ("response" in result && result.response) {
    return result.response;
  }
  if ("message" in result && result.message?.content) {
    return result.message.content;
  }
  if ("choices" in result) {
    return result.choices?.[0]?.message?.content ?? "";
  }

  return "";
}

function stripThinkBlock(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
