import { convertInputOnce } from "./conversionPipeline";
import { isUsableConversionResult } from "./conversionPolicy";
import type { PreparedConversionInput } from "./conversionRequest";
import { faithfulConversionRule } from "./conversionRules";
import { createConversionSession, sessionResult } from "./conversionSession";
import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { convertLocally } from "./localConversion";
import type { OllamaTransport } from "./ollamaProxy";
import { missingLetterReadings } from "./romajiRepairPlans";
import type { AppSettings } from "./types";

export async function speculateAfterRepair(input: string, settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions, prepared: PreparedConversionInput, retained: JapaneseConversionResult): Promise<JapaneseConversionResult> {
  const original = options.repairBaseline?.session;
  if (original?.state !== "open" || original.locked) return retained;
  try {
    const guess = await convertInputOnce(input, settings, transport, {
      ...options, purpose: "speculative", speculationCandidates: false,
    }, prepared);
    if (original.state !== "open" || original.locked) return retained;
    if (!isUsableConversionResult(guess, options) || faithfulConversionRule.sameReading(retained.reviewKana, guess.reviewKana)) return retained;

    // Search just the reading proposed by the model if one editable romaji edit
    // can account for it. Other parts keep their original readings and literals.
    const readings = prepared.parts.map((part, i) => part.type === "text" ? prepared.readings[i].kana : part.output);
    for (const [partIndex, part] of prepared.parts.entries()) {
      if (part.type !== "text") continue;
      const before = readings.slice(0, partIndex).join("");
      const after = readings.slice(partIndex + 1).join("");
      const plan = missingLetterReadings(part.value).plans.find(candidate =>
        faithfulConversionRule.sameReading(before + candidate.reading + after, guess.reviewKana));
      if (!plan) continue;
      const local = await convertLocally(input, settings, transport, {
        ...options, deferRanking: undefined, onLocalCandidates: undefined, onRankedCandidates: undefined,
      },
        { correction: { partIndex, value: plan.value } }, prepared);
      if (original.state !== "open" || original.locked) return retained;
      if (!isUsableConversionResult(local, options) || !local.session) continue;

      // The model proposed a reading change. Keep explicit acceptance even
      // when the dictionary can supply the spelling for that reading.
      return sessionResult(createConversionSession(input, local.session.candidates.map(candidate => ({
        ...candidate, kind: "proposal", result: {
          ...candidate.result, conversionStrategy: "speculative",
          romajiCorrection: { partIndex, offset: plan.offset, inserted: plan.inserted, before: part.value, after: plan.value },
        },
      })), options));
    }
    return sessionResult(createConversionSession(input, [{
      id: "proposal-0", kind: "proposal", result: guess,
    }], options));
  } catch {
    throwIfConversionAborted(options.signal);
    return retained;
  }
}
