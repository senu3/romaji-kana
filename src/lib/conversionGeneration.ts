import { ConversionResponseError } from "./conversionDiagnostics";
import { parseConversionOutput } from "./conversionOutput";
import { finalTargetPrompt, referenceContextInstruction, type ConversionRequest } from "./conversionRequest";
import { finalReadingRule } from "./conversionRules";
import { generateWithAbort, generatedText, stripThinkBlock } from "./generationUtils";
import type { JapaneseConversionOptions } from "./japaneseConversionTypes";
import { currentProviderBaseUrl } from "./modelProvider";
import { normalizeNumericReading } from "./numericReading";
import type { OllamaTransport } from "./ollamaProxy";
import { buildCorrectionSystemPrompt, buildSpeculativeConversionSystemPrompt, finalConversionOutputContract } from "./prompts";
import type { AppSettings } from "./types";

export async function generateKanaConversion(request: ConversionRequest, settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions): Promise<{ text: string; reading: string; reportedReading: string; numericReadingNormalized: boolean }> {
  const speculative = options.purpose === "speculative";
  const system = speculative ? buildSpeculativeConversionSystemPrompt(settings.conversionPrompt, options.avoidOutputs,
    request.reference.documentVocabulary?.slice(), options.userRequestedSpeculation) : buildCorrectionSystemPrompt(settings.conversionPrompt);
  const response = await generateWithAbort(() => transport.generate(settings.modelProvider, currentProviderBaseUrl(settings), {
    model: settings.modelName, stream: false, think: settings.think, keep_alive: "5m",
    system: [referenceContextInstruction, system, finalConversionOutputContract].join("\n\n"),
    prompt: finalTargetPrompt(request, true), options: { temperature: speculative ? 0.45 : 0.35 },
    outputSchema: {
      type: "object", properties: { convertedText: { type: "string" }, completedKana: { type: "string" } },
      required: ["convertedText", "completedKana"], additionalProperties: false
    },
  }, 30_000, options.signal), options.signal);
  const output = parseConversionOutput(stripThinkBlock(generatedText(response)).trim());
  if (!output) throw new ConversionResponseError("response-format", "変換結果の形式を読み取れませんでした。");
  const numeric = normalizeNumericReading(request.target.preparedReading, output.completedKana);
  if ((output.convertedText || output.completedKana) && !finalReadingRule.accepts({ ...output, completedKana: numeric.reading }, "final")) {
    throw new ConversionResponseError("reading-format", "変換結果の読みと本文の形式が一致しませんでした。");
  }
  return { text: output.convertedText, reading: numeric.reading, reportedReading: output.completedKana, numericReadingNormalized: numeric.normalized };
}
