import type { PreparedConversionInput } from "./conversionRequest";
import { politeRequestReadings } from "./conversionRules";
import { sessionResult, type SessionCandidate } from "./conversionSession";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import { convertLocally } from "./localConversion";
import type { OllamaTransport } from "./ollamaProxy";
import { normalizeComparableReading } from "./readingComparison";
import { romajiSpellingsForKana, romajiToKana } from "./romajiKana";
import type { AppSettings } from "./types";

export function standaloneRequestPlan(prepared: PreparedConversionInput) {
  const [part] = prepared.parts;
  if (prepared.parts.length !== 1 || part.type !== "text" || !/^[a-z]+[ \t。、,.!?！？]*$/u.test(part.value)) return;
  const source = normalizeComparableReading(prepared.sourceReading);
  if (politeRequestReadings.some(reading => reading === source)) return;
  // Reinsert exactly one internal kana at a boundary in the original keystrokes.
  const plans = politeRequestReadings.flatMap(reading => {
    if (source.length + 1 !== reading.length) return [];
    for (const token of prepared.readings[0].tokens) {
      const i = token.kanaFrom;
      if (i === 0 || i >= source.length || reading.slice(0, i) + reading.slice(i + 1) !== source) continue;
      const offset = token.inputFrom;
      for (const inserted of romajiSpellingsForKana(reading[i])) {
        const value = part.value.slice(0, offset) + inserted + part.value.slice(offset);
        const repaired = romajiToKana(value);
        if (!repaired.lowConfidenceSpans.length && normalizeComparableReading(repaired.kana) === reading) {
          return [{ value, reading, offset, inserted, before: part.value }];
        }
      }
    }
    return [];
  });
  return plans.length === 1 ? plans[0] : undefined;
}

function wholeDictionaryEntry(candidate: SessionCandidate) {
  const words = candidate.tokens?.filter(token => token.source !== "literal");
  return words?.length === 1 ? words[0] : undefined;
}

export async function repairStandaloneRequest(prepared: PreparedConversionInput, plan: NonNullable<ReturnType<typeof standaloneRequestPlan>>,
  baseline: JapaneseConversionResult, settings: AppSettings, transport: OllamaTransport, options: JapaneseConversionOptions): Promise<JapaneseConversionResult> {
  // A whole dictionary entry can be intentional, e.g. くさい near ください.
  if (baseline.suggestionRejectedReason === "protected" ||
      baseline.session?.candidates.some(candidate => wholeDictionaryEntry(candidate) ||
        candidate.tokens?.some(token => token.source === "user"))) return baseline;
  const result = await convertLocally(prepared.originalInput, settings, transport, options,
    { correction: { partIndex: 0, value: plan.value } }, prepared);
  const session = result.session;
  const candidate = session?.candidates.find(candidate => {
    const word = wholeDictionaryEntry(candidate);
    return word?.source === "mozc" && word.reading === plan.reading &&
      candidate.result.changes?.readingAssessment?.status === "verified";
  });
  if (!session || !candidate) return baseline;
  candidate.result.romajiCorrection = {
    partIndex: 0, offset: plan.offset, inserted: plan.inserted, before: plan.before, after: plan.value,
  };
  session.selectedId = candidate.id;
  return sessionResult(session);
}
