import { ConversionResponseError } from "./conversionDiagnostics";
import { parseConversionOutput } from "./conversionOutput";
import { finalTargetPrompt, referenceContextInstruction, userReinterpretationPrompt, type ConversionRequest } from "./conversionRequest";
import { finalReadingRule } from "./conversionRules";
import { generateWithAbort, generatedText, stripThinkBlock } from "./generationUtils";
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
  const response = await generateWithAbort(() => transport.generate(settings.modelProvider, currentProviderBaseUrl(settings), {
    model: settings.modelName, stream: false, think: settings.think, keep_alive: "5m",
    system: [referenceContextInstruction, system, conversionOutputContract(Boolean(request.target.protectedLiterals?.length))].join("\n\n"),
    prompt: options.userRequestedSpeculation ? userReinterpretationPrompt(request, options.avoidOutputs ?? []) : finalTargetPrompt(request, true),
    options: { temperature: speculative ? 0.45 : 0.35 },
    outputSchema: {
      type: "object", properties: { convertedText: { type: "string" }, completedKana: { type: "string" } },
      required: ["convertedText", "completedKana"], additionalProperties: false
    },
  }, 30_000, options.signal), options.signal);
  const output = parseConversionOutput(stripThinkBlock(generatedText(response)).trim());
  if (!output) throw new ConversionResponseError("response-format", "変換結果の形式を読み取れませんでした。");
  const numeric = normalizeNumericReading(request.target.preparedReading, output.completedKana);
  const literals = request.target.protectedLiterals ?? [];
  const withoutLiterals = (value: string) => {
    const terms = [...new Set(literals)].filter(Boolean).sort((a, b) => b.length - a.length)
      .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return terms.length ? value.replace(new RegExp(terms.join("|"), "gu"), "") : value;
  };
  if ((output.convertedText || output.completedKana) && (!finalReadingRule.acceptsControls(output) || !finalReadingRule.accepts({
    convertedText: withoutLiterals(output.convertedText), completedKana: withoutLiterals(numeric.reading),
  }, "final"))) {
    throw new ConversionResponseError("reading-format", "変換結果の読みと本文の形式が一致しませんでした。");
  }
  return { text: output.convertedText, reading: numeric.reading, reportedReading: output.completedKana, numericReadingNormalized: numeric.normalized };
}
