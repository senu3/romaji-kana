import {
  structuredSuggestionRejection, parseStructuredSuggestion,
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
import { suggestionTargetPrompt, finalTargetPrompt, referenceContextInstruction, type SuggestionRequest, type ConversionRequest } from "./conversionRequest";
import { normalizeNumericReading } from "./numericReading";
import { ConversionResponseError, type ConversionDiagnostic } from "./conversionDiagnostics";

export async function generateStructuredSuggestion(
  request: SuggestionRequest,
  level: Exclude<InputCompletionLevel, "none">,
  settings: AppSettings,
  transport: OllamaTransport,
  options: JapaneseConversionOptions,
): Promise<{ candidate: StructuredSuggestionConversion; rejection?: never } | { rejection: ConversionDiagnostic; candidate?: never }> {
  const result = await generateWithAbort(() => transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: referenceContextInstruction + "\n\n" + buildSuggestionConversionSystemPrompt(
        level,
        settings.conversionPrompt,
        options.avoidOutputs,
        request.reference.documentVocabulary?.slice(),
      ),
      prompt: suggestionTargetPrompt(request),
      stream: false,
      think: settings.think,
      options: {
        temperature: level === "word" ? 0.05 : 0.2,
      },
      keep_alive: "5m",
    },
    30_000,
    ...(options.signal ? [options.signal] as const : [] as const),
  ), options.signal);

  const parsed = parseStructuredSuggestion(generatedText(result));
  const { preparedReading, completionSeed } = request.target;
  if (!parsed) return { rejection: "response-format" };
  const numericReading = normalizeNumericReading(preparedReading, parsed.completedKana);
  const candidate: StructuredSuggestionConversion = {
    ...parsed, completedKana: numericReading.reading, reportedKana: parsed.completedKana,
    numericReadingNormalized: numericReading.normalized,
    ...(parsed.correctedKana !== undefined ? { correctedKana: normalizeNumericReading(preparedReading, parsed.correctedKana).reading } : {}),
  };
  const rejection = structuredSuggestionRejection(preparedReading, candidate, level, options);
  const provisionalBoundary = rejection === "completion-shape" && level === "word" &&
    structuredSuggestionRejection(preparedReading, candidate, level, options, true) === undefined;
  if (rejection && !provisionalBoundary) {
    return { rejection };
  }
  return { candidate: {
    ...candidate,
    ...(provisionalBoundary ? { boundaryUnverified: true } : {}),
    additions: reportedSuggestionAdditions(
      candidate.correctedKana ?? preparedReading,
      candidate.correctedKana && candidate.correctedKana !== preparedReading
        ? candidate.correctedKana : completionSeed,
      candidate,
      level,
    ),
  } };
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
): Promise<{ text: string; reading?: string; reportedReading?: string; numericReadingNormalized?: boolean; modelReading: boolean }> {
  // Compatibility entry point: internal callers supply the full request.
  return generateKanaConversion({
    target: { originalRomaji: options.completionSourceRomaji ?? "", mechanicalReading: kana, preparedReading: kana, completionSeed: kana },
    reference: { beforeTarget: "", documentVocabulary: options.documentVocabulary?.slice() },
  }, settings, transport, options);
}

export async function generateKanaConversion(
  request: ConversionRequest,
  settings: AppSettings,
  transport: OllamaTransport,
  options: JapaneseConversionOptions,
): Promise<{ text: string; reading?: string; reportedReading?: string; numericReadingNormalized?: boolean; modelReading: boolean }> {
  const kana = request.target.preparedReading;
  options = { ...options, documentVocabulary: request.reference.documentVocabulary?.slice() };
  const generation = kanaGenerationParameters(settings, options);
  const result = await generateWithAbort(() => transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: referenceContextInstruction + "\n\n" + generation.system + "\n\n" + finalConversionOutputContract,
      prompt: finalTargetPrompt(request, Boolean(options.completionMode || options.speculativeMode)),
      ...(options.requireStructuredResponse ? { outputSchema: {
        type: "object", properties: { convertedText: { type: "string" }, completedKana: { type: "string" } },
        required: ["convertedText", "completedKana"], additionalProperties: false,
      } } : {}),
      stream: false,
      think: settings.think,
      options: {
        temperature: generation.temperature,
      },
      keep_alive: "5m",
    },
    30_000,
    ...(options.signal ? [options.signal] as const : [] as const),
  ), options.signal);

  const rawText = generatedText(result);
  const text = stripThinkBlock(rawText).trim();
  if (!text) {
    throw new Error(`${providerLabel(settings)} returned an empty conversion.`);
  }

  if (text.startsWith("{")) {
    try {
      const abstention = JSON.parse(text);
      if (abstention.convertedText === "" && abstention.completedKana === "") return { text: "", reading: kana, modelReading: false };
    } catch { /* Malformed JSON is reported below as a response-format error. */ }
  }

  const structured = parseStructuredSuggestion(text);
  if (structured) {
    const numericReading = normalizeNumericReading(kana, structured.completedKana);
    if (!finalReadingRule.accepts({ ...structured, completedKana: numericReading.reading }, "final")) {
      throw new ConversionResponseError("reading-format", "変換結果の読みと本文の形式が一致しませんでした。");
    }
    return { text: structured.convertedText, reading: numericReading.reading, reportedReading: structured.completedKana,
      numericReadingNormalized: numericReading.normalized, modelReading: true };
  }
  if (options.requireStructuredResponse || /^(?:\{|```json)/u.test(text)) throw new ConversionResponseError("response-format", "変換結果の形式を読み取れませんでした。");
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
  const typoRepair = route.kind === "typo-repair";
  return {
    system: buildKanaKanjiSystemPrompt(
      settings.conversionPrompt, options.avoidOutputs ?? [],
      options.strictAlternative ?? false, options.alternativeAttempt ?? 0,
      typoRepair, typoRepair ? [] : options.documentVocabulary ?? [],
    ),
    temperature: typoRepair ? 0.35 : options.alternativeAttempt ? 0.25 : 0.1,
  };
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
    ...(signal ? [signal] as const : [] as const),
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
