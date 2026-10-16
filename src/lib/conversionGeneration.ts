import {
  isAllowedStructuredSuggestion, parseStructuredSuggestion,
  reportedSuggestionAdditions, type StructuredSuggestionConversion,
} from "./completionValidation";
import { literalCandidateReading } from "./conversionChanges";
import {
  generatedText,
  generateWithAbort,
  stripThinkBlock,
  throwIfConversionAborted,
} from "./generationUtils";
import type { JapaneseConversionOptions } from "./japaneseConversionTypes";
import { currentProviderBaseUrl, providerLabel } from "./modelProvider";
import { defaultOllamaTransport, type OllamaTransport } from "./ollamaProxy";
import {
  buildKanaKanjiSystemPrompt, buildKanaRepairSystemPrompt,
  buildSpeculativeConversionSystemPrompt, buildSuggestionConversionSystemPrompt,
  finalConversionOutputContract,
} from "./prompts";
import { rebuildRomajiKanaResult } from "./romajiKana";
import type { AppSettings, InputCompletionLevel, RomajiKanaResult, RomajiKanaSpan, RomajiKanaToken } from "./types";
import { selectSegmentRoute } from "./conversionPolicy";
import { finalReadingRule, fragmentRepairRule } from "./conversionRules";

export async function generateStructuredSuggestion(
  originalRomaji: string,
  mechanicalKana: string,
  completionSeed: string,
  level: Exclude<InputCompletionLevel, "none">,
  contextBefore: string,
  settings: AppSettings,
  transport: OllamaTransport,
  options: JapaneseConversionOptions,
): Promise<StructuredSuggestionConversion | null> {
  const result = await generateWithAbort(() => transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: buildSuggestionConversionSystemPrompt(
        level,
        settings.conversionPrompt,
        options.avoidOutputs,
        options.documentVocabulary,
      ),
      prompt: [
        "Read-only context before the target:",
        contextBefore.trim() || "(none)",
        "",
        "Original romaji input:",
        originalRomaji,
        "",
        "Mechanical kana:",
        mechanicalKana,
        "",
        "Application completion seed:",
        completionSeed,
      ].join("\n"),
      stream: false,
      think: settings.think,
      options: {
        temperature: level === "word" ? 0.05 : 0.2,
      },
      keep_alive: "5m",
    },
    30_000,
  ), options.signal);

  const candidate = parseStructuredSuggestion(generatedText(result));
  if (!candidate || !isAllowedStructuredSuggestion(mechanicalKana, candidate, level, options)) {
    return null;
  }
  return {
    ...candidate,
    additions: reportedSuggestionAdditions(
      candidate.correctedKana ?? mechanicalKana,
      candidate.correctedKana && candidate.correctedKana !== mechanicalKana
        ? candidate.correctedKana : completionSeed,
      candidate,
      level,
    ),
  };
}

export async function repairLowConfidenceKana(
  result: RomajiKanaResult,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
  signal?: AbortSignal,
): Promise<RomajiKanaResult> {
  if (result.lowConfidenceSpans.length === 0) {
    return result;
  }

  let tokens = result.tokens;

  for (const span of result.lowConfidenceSpans) {
    throwIfConversionAborted(signal);
    const repairedKana = await repairKanaSpan(
      span,
      result.kana,
      settings,
      transport,
      signal,
    );
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
  options: JapaneseConversionOptions = {},
): Promise<string> {
  return (await kanjiizeKanaDetailed(kana, settings, transport, options)).text;
}

export async function kanjiizeKanaDetailed(
  kana: string,
  settings: AppSettings,
  transport: OllamaTransport,
  options: JapaneseConversionOptions,
): Promise<{ text: string; reading?: string; modelReading: boolean }> {
  const generation = kanaGenerationParameters(settings, options);
  const result = await generateWithAbort(() => transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: generation.system + "\n\n" + finalConversionOutputContract,
      prompt: buildKanaKanjiUserPrompt(kana, options),
      stream: false,
      think: settings.think,
      options: {
        temperature: generation.temperature,
      },
      keep_alive: "5m",
    },
    30_000,
  ), options.signal);

  const rawText = generatedText(result);
  const text = stripThinkBlock(rawText).trim();
  if (!text) {
    throw new Error(`${providerLabel(settings)} returned an empty conversion.`);
  }

  const structured = parseStructuredSuggestion(text);
  if (structured) {
    if (!finalReadingRule.accepts(structured, "final")) {
      throw new Error("変換結果の読みと本文の形式が一致しませんでした。");
    }
    return { text: structured.convertedText, reading: structured.completedKana, modelReading: true };
  }
  if (/^(?:\{|```json)/u.test(text)) throw new Error("変換結果の形式を読み取れませんでした。");
  // Older/custom providers can still return plain text. Do not invent a
  // reading for Kanji output from that response.
  return { text, reading: literalCandidateReading(text), modelReading: false };
}

function kanaGenerationParameters(settings: AppSettings, options: JapaneseConversionOptions) {
  const route = selectSegmentRoute("none", options);
  if (route.kind === "speculative") {
    return {
      system: buildSpeculativeConversionSystemPrompt(
        settings.conversionPrompt, options.avoidOutputs ?? [], options.documentVocabulary ?? [],
      ),
      temperature: 0.45,
    };
  }
  const typoCompletion = route.kind === "typo-completion";
  return {
    system: buildKanaKanjiSystemPrompt(
      settings.conversionPrompt, options.avoidOutputs ?? [],
      options.strictAlternative ?? false, options.alternativeAttempt ?? 0,
      typoCompletion, typoCompletion ? [] : options.documentVocabulary ?? [],
    ),
    temperature: typoCompletion ? 0.35 : options.alternativeAttempt ? 0.25 : 0.1,
  };
}

function buildKanaKanjiUserPrompt(kana: string, options: JapaneseConversionOptions): string {
  if (!options.completionMode && !options.speculativeMode) {
    return kana;
  }

  return [
    "Original romaji input:",
    options.completionSourceRomaji?.trim() || "(not available)",
    "",
    "Mechanical kana:",
    kana,
  ].join("\n");
}

async function repairKanaSpan(
  span: RomajiKanaSpan,
  mechanicalKana: string,
  settings: AppSettings,
  transport: OllamaTransport,
  signal?: AbortSignal,
): Promise<string> {
  const result = await generateWithAbort(() => transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: buildKanaRepairSystemPrompt(span.romaji),
      prompt: [
        `未確定部分: ${span.kana}`,
        `周辺: ${span.contextKana}`,
        `元入力: ${span.romaji}`,
        `機械変換全文: ${mechanicalKana}`,
      ].join("\n"),
      stream: false,
      think: settings.think,
      options: {
        temperature: 0,
      },
      keep_alive: "5m",
    },
    30_000,
  ), signal);

  const fragment = cleanKanaFragment(generatedText(result));
  // A fragment repair must not smuggle in a full sentence, symbols or JSON.
  return fragmentRepairRule.accepts(span.romaji, fragment) ? fragment : "";
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
