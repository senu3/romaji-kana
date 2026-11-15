import { classifyConversionChanges } from "./conversionChanges";
import { hasConvertibleRomaji } from "./conversionInput";
import { isAvoidedConversionOutput } from "./conversionOutput";
import { preservesInputLineBreaks, preservesProtectedContent } from "./conversionProtection";
import { prepareConversionRequest, type PreparedConversionInput } from "./conversionRequest";
import { finalReadingRule } from "./conversionRules";
import { createConversionSession, type SessionCandidate } from "./conversionSession";
import { throwIfConversionAborted } from "./generationUtils";
import type { JapaneseConversionOptions, JapaneseConversionResult } from "./japaneseConversionTypes";
import type { EngineCandidate, EngineSearchResult, EngineToken } from "./kanaEngine";
import { rankConversionSession } from "./conversionRanking";
import type { OllamaTransport } from "./ollamaProxy";
import { romajiToKana } from "./romajiKana";
import type { AppSettings } from "./types";

const MAX_CANDIDATES = 24;
interface Combined { text: string; reading: string; cost: number; tokens: EngineToken[] }
function appendLiteral(candidate: Combined, literal: string): Combined {
  const from = Array.from(candidate.reading).length;
  return {
    ...candidate, text: candidate.text + literal, reading: candidate.reading + literal,
    tokens: [...candidate.tokens, {
      reading: literal, text: literal, from, to: from + Array.from(literal).length,
      source: "literal", entryId: `preserved:${from}`, lid: 0, rid: 0, wordCost: 0
    }]
  };
}

export async function convertLocally(input: string, settings: AppSettings, transport: OllamaTransport,
  options: JapaneseConversionOptions, plan?: { correction: { partIndex: number; value: string } },
  preparedInput: PreparedConversionInput = prepareConversionRequest(input, settings, options),
  searchCache = new Map<string, EngineSearchResult>()): Promise<JapaneseConversionResult> {
  const engine = options.kanaEngine!;
  const { parts, protection, sourceReading, learnedBonus } = preparedInput;
  const unavailable = (detail: "no-candidate" | "unresolved-reading"): JapaneseConversionResult => ({
    text: "", reviewKana: sourceReading, suggestionRejected: true, suggestionRejectedReason: "unconvertible", rejectionDetail: detail,
  });
  let combined: Combined[] = [{ text: "", reading: "", cost: 0, tokens: [] }];
  let reliable = true;
  let truncated = false;
  let revision: string | undefined;
  for (const [partIndex, originalPart] of parts.entries()) {
    const part = originalPart.type === "text" && plan?.correction?.partIndex === partIndex
      ? { ...originalPart, value: plan.correction.value } : originalPart;
    throwIfConversionAborted(options.signal);
    if (part.type !== "text" || (!hasConvertibleRomaji(part.value) && !/[ぁ-ゖ]/u.test(part.value))) {
      const literal = part.type === "text" ? part.value : part.output;
      combined = combined.map(c => appendLiteral(c, literal));
      continue;
    }
    const kana = part === originalPart ? preparedInput.readings[partIndex] : romajiToKana(part.value);
    if (kana.lowConfidenceSpans.length) return unavailable("unresolved-reading");
    reliable &&= kana.lowConfidenceSpans.length === 0;
    // Sentence boundaries keep search bounded; punctuation remains an exact literal.
    const chunks = kana.kana.split(/([A-Za-z0-9][A-Za-z0-9._:/-]*|\r\n|[。、!?！？\r\n])/gu).filter(Boolean);
    for (const chunk of chunks) {
      if (Array.from(chunk).length > 160) throw new Error("変換範囲が長すぎます。160文字以内に分けて変換してください。");
      if (/^(?:\r\n|[。、!?！？\r\n])$/u.test(chunk) || /^[A-Za-z0-9]/u.test(chunk)) {
        combined = combined.map(c => appendLiteral(c, chunk));
        continue;
      }
      let found = searchCache.get(chunk);
      if (!found) {
        const response = await engine.search(chunk, settings.personalDictionary ?? [], options.signal);
        // Cache validated dictionary segments as well as abstentions. Unchanged
        // chunks in repair plans need neither another IPC call nor revalidation.
        const valid = response.candidates.filter(c => validEngineCandidate(c, chunk));
        if (response.candidates.length && !valid.length) throw new Error("かな漢字エンジンから有効な候補が返りませんでした。");
        found = { ...response, candidates: valid.filter(c => c.tokens.some(t => t.source !== "literal") &&
          c.tokens.every(t => t.source !== "literal" || !/[ぁ-ヿー]/u.test(t.reading))) };
        searchCache.set(chunk, found);
      }
      revision = found.dictionaryRevision;
      truncated ||= found.truncated;
      // Reject synthetic kana passthrough, including partial unknown fragments.
      const dictionaryCandidates = found.candidates;
      if (!dictionaryCandidates.length) return unavailable("no-candidate");
      const next: Combined[] = [];
      for (const left of combined) for (const right of dictionaryCandidates) {
        const offset = Array.from(left.reading).length;
        next.push({
          text: left.text + right.text, reading: left.reading + right.reading,
          cost: Math.min(left.cost + right.cost, Number.MAX_SAFE_INTEGER),
          tokens: [...left.tokens, ...right.tokens.map(t => ({ ...t, from: t.from + offset, to: t.to + offset }))]
        });
      }
      const seen = new Set<string>();
      combined = next.sort((a, b) => a.cost - b.cost).filter(c => !seen.has(c.text) && Boolean(seen.add(c.text))).slice(0, MAX_CANDIDATES);
      if (next.length > combined.length) truncated = true;
    }
  }
  const reading = combined[0]?.reading ?? sourceReading;
  const candidates: SessionCandidate[] = combined.filter(c => preservesInputLineBreaks(protection, c.text) && finalReadingRule.acceptsControls({ completedKana: c.reading, convertedText: c.text }) && preservesProtectedContent(plan?.correction ? protection.source : sourceReading, c.text, protection.literalTerms) &&
    !isAvoidedConversionOutput(c.text, options.avoidOutputs)).map((c, i) => {
      const dictionaryPath = c.tokens.some(t => t.source !== "literal");
      const changes = classifyConversionChanges(sourceReading, c.reading, dictionaryPath ? "dictionary-path" : "literal",
        Boolean(plan?.correction), plan?.correction ? c.reading : undefined);
      changes.readingAssessment = {
        status: reliable ? "verified" : "unverified", origin: dictionaryPath ? "dictionary" : "literal",
        ...(reliable ? { proof: c.tokens.some(t => t.source !== "literal") ? "independent" as const : "literal" as const } : {})
      };
      return {
        id: `candidate-${i}`, kind: plan?.correction ? "correction" : "conversion", cost: c.cost, tokens: c.tokens,
        result: ({
          text: c.text, reviewKana: c.reading, changes,
          ...(plan?.correction ? { conversionStrategy: "correction" as const } : {})
        })
      };
    });
  candidates.sort((a, b) => (a.cost! - learnedBonus(reading, a.result.text)) - (b.cost! - learnedBonus(reading, b.result.text)));
  if (!candidates.length) return { text: "", reviewKana: reading, suggestionRejected: true, suggestionRejectedReason: "protected" };
  const session = createConversionSession(input, candidates, options);
  session.dictionaryRevision = revision;
  session.truncated = truncated;
  return rankConversionSession(session, settings, transport, options, learnedBonus);
}

function validEngineCandidate(candidate: EngineCandidate, reading: string): boolean {
  if (candidate.reading !== reading || !candidate.text || !Number.isFinite(candidate.cost) || !candidate.tokens?.length) return false;
  if (candidate.tokens.map(t => t.reading).join("") !== reading || candidate.tokens.map(t => t.text).join("") !== candidate.text) return false;
  let end = 0;
  for (const t of candidate.tokens) {
    if (t.from !== end || t.to !== end + Array.from(t.reading).length || t.to <= t.from ||
      !["mozc", "user", "literal"].includes(t.source)) return false;
    end = t.to;
  }
  return true;
}
