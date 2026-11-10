import type { PreparedConversionInput } from "./conversionRequest";
import { politeRequestReadings } from "./conversionRules";
import { sessionResult } from "./conversionSession";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { convertLocally } from "./localConversion";
import type { OllamaTransport } from "./ollamaProxy";
import { normalizeComparableReading } from "./readingComparison";
import { missingLetterReadings } from "./romajiRepairPlans";
import type { AppSettings } from "./types";

export function standaloneRequestPlan(prepared: PreparedConversionInput) {
  const [part] = prepared.parts;
  if (prepared.parts.length !== 1 || part.type !== "text" || !/^[a-z]+[ \t。、,.!?！？]*$/u.test(part.value)) return;
  const source = normalizeComparableReading(prepared.sourceReading);
  if (politeRequestReadings.some(reading => reading === source)) return;
  // Only consider a complete expression with one missing vowel inside it.
  const matchingReadings = politeRequestReadings.filter(reading => source.length + 1 === reading.length &&
    Array.from(reading).some((kana, i) => i > 0 && i < reading.length - 1 && /^[あいうえお]$/u.test(kana) &&
      reading.slice(0, i) + reading.slice(i + 1) === source));
  if (!matchingReadings.length) return;
  const plans = missingLetterReadings(part.value).plans.filter(plan =>
    plan.value.length === part.value.length + 1 && /^[aiueo]$/u.test(plan.inserted) &&
    matchingReadings.some(reading => reading === normalizeComparableReading(plan.reading)));
  return plans.length === 1 ? { ...plans[0], before: part.value } : undefined;
}

export async function repairStandaloneRequest(prepared: PreparedConversionInput, plan: NonNullable<ReturnType<typeof standaloneRequestPlan>>,
  baseline: JapaneseConversionResult, settings: AppSettings, transport: OllamaTransport, options: JapaneseConversionOptions): Promise<JapaneseConversionResult> {
  if (baseline.suggestionRejectedReason === "protected" ||
      baseline.session?.candidates.some(candidate => candidate.tokens?.some(token => token.source === "user"))) return baseline;
  const result = await convertLocally(prepared.originalInput, settings, transport, options,
    { correction: { partIndex: 0, value: plan.value } }, prepared);
  const session = result.session;
  const candidate = session?.candidates.find(candidate => {
    const words = candidate.tokens?.filter(token => token.source !== "literal");
    return words?.length === 1 && words[0].source === "mozc" &&
      words[0].reading === normalizeComparableReading(plan.reading) &&
      candidate.result.changes?.readingAssessment?.status === "verified";
  });
  if (!session || !candidate) return baseline;
  candidate.result.romajiCorrection = {
    partIndex: 0, offset: plan.offset, inserted: plan.inserted, before: plan.before, after: plan.value,
  };
  session.selectedId = candidate.id;
  return sessionResult(session);
}
