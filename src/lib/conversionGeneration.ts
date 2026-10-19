import { ConversionResponseError } from "./conversionDiagnostics";
import { parseConversionOutput, type ConversionOutput } from "./conversionOutput";
import { finalTargetPrompt, referenceContextInstruction, userReinterpretationPrompt, type ConversionRequest, type ReinterpretationPart } from "./conversionRequest";
import { finalReadingRule } from "./conversionRules";
import { generateWithAbort, generatedText, stripThinkBlock, throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions } from "./japaneseConversionTypes";
import { currentProviderBaseUrl } from "./modelProvider";
import { normalizeNumericReading } from "./numericReading";
import type { OllamaTransport } from "./ollamaProxy";
import { buildCorrectionSystemPrompt, buildSpeculativeConversionSystemPrompt, buildUserReinterpretationSystemPrompt, conversionOutputContract } from "./prompts";
import type { AppSettings } from "./types";

export async function generateKanaConversion(request: ConversionRequest, settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions): Promise<{ text: string; reading: string; reportedReading: string; numericReadingNormalized: boolean }> {
  const speculative = options.purpose === "speculative";
  const system = options.userRequestedSpeculation ? buildUserReinterpretationSystemPrompt(settings.conversionPrompt)
    : speculative ? buildSpeculativeConversionSystemPrompt(settings.conversionPrompt, options.avoidOutputs,
    request.reference.documentVocabulary?.slice()) : buildCorrectionSystemPrompt(settings.conversionPrompt);
  const response = await generateStructuredConversion(settings, transport, options, {
    system: [referenceContextInstruction, system, conversionOutputContract()].join("\n\n"),
    prompt: options.userRequestedSpeculation ? userReinterpretationPrompt(request, options.avoidOutputs ?? []) : finalTargetPrompt(request, true),
    outputSchema: {
      type: "object", properties: { convertedText: { type: "string" }, completedKana: { type: "string" } },
      required: ["convertedText", "completedKana"], additionalProperties: false
    },
  });
  const output = parseConversionOutput(response);
  if (!output) throw new ConversionResponseError("response-format", "変換結果の形式を読み取れませんでした。");
  return validateGeneratedOutput(output, request.target.preparedReading);
}

function validateGeneratedOutput(output: ConversionOutput, source: string) {
  const numeric = normalizeNumericReading(source, output.completedKana);
  if ((output.convertedText || output.completedKana) && !finalReadingRule.accepts({ ...output, completedKana: numeric.reading }, "final")) {
    throw new ConversionResponseError("reading-format", "変換結果の読みと本文の形式が一致しませんでした。");
  }
  return { text: output.convertedText, reading: numeric.reading, reportedReading: output.completedKana, numericReadingNormalized: numeric.normalized };
}

async function generateStructuredConversion(settings: AppSettings, transport: OllamaTransport, options: JapaneseConversionOptions,
  request: { system: string; prompt: string; outputSchema: Record<string, unknown> }): Promise<string> {
  const response = await generateWithAbort(() => transport.generate(settings.modelProvider, currentProviderBaseUrl(settings), {
    model: settings.modelName, stream: false, think: settings.think, keep_alive: "5m", ...request,
    options: { temperature: options.purpose === "correction" ? 0.35 : 0.45 },
  }, 30_000, options.signal), options.signal);
  throwIfConversionAborted(options.signal);
  return stripThinkBlock(generatedText(response)).trim();
}

export async function generateReinterpretationSegments(request: ConversionRequest, parts: readonly ReinterpretationPart[],
  sourceReadings: readonly string[], settings: AppSettings, transport: OllamaTransport, options: JapaneseConversionOptions) {
  const editable = parts.filter((part): part is Extract<ReinterpretationPart, { id: string }> => "id" in part);
  const raw = await generateStructuredConversion(settings, transport, options, {
    system: [referenceContextInstruction, buildUserReinterpretationSystemPrompt(settings.conversionPrompt, true),
      "For each editable segment, convertedText and completedKana must describe that segment only. completedKana must not contain kanji. Preserve its digits, punctuation and line breaks.",
      finalReadingRule.controlPrompt("final")].join("\n\n"),
    prompt: userReinterpretationPrompt(request, options.avoidOutputs ?? [], parts),
    outputSchema: { type: "object", properties: { segments: { type: "array", maxItems: editable.length,
      items: { type: "object", properties: { id: { type: "string", enum: editable.map(part => part.id) }, convertedText: { type: "string" }, completedKana: { type: "string" } },
        required: ["id", "convertedText", "completedKana"], additionalProperties: false } } }, required: ["segments"], additionalProperties: false },
  });
  let value;
  try { value = JSON.parse(raw); } catch { /* checked below */ }
  if (!value || Object.keys(value).length !== 1 || !Array.isArray(value.segments) ||
    (value.segments.length !== 0 && value.segments.length !== editable.length)) throw new ConversionResponseError("response-format", "見直し結果の区間が一致しませんでした。");
  return value.segments.map((segment: unknown, index: number) => {
    if (!segment || typeof segment !== "object" || Object.keys(segment).length !== 3 || !("id" in segment) || segment.id !== editable[index].id) {
      throw new ConversionResponseError("response-format", "見直し結果の区間が一致しませんでした。");
    }
    const { id: _id, ...fields } = segment;
    const output = parseConversionOutput(JSON.stringify(fields));
    if (!output || !output.convertedText || !output.completedKana) throw new ConversionResponseError("response-format", "見直し結果の区間を読み取れませんでした。");
    return validateGeneratedOutput(output, sourceReadings[index]);
  }) as Array<ReturnType<typeof validateGeneratedOutput>>;
}
