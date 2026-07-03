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
import type {
  RomajiKanaResult,
  RomajiKanaSpan,
  RomajiKanaToken,
  UserDictionaryEntry,
} from "./types";

interface DictionaryTextPart {
  type: "text";
  value: string;
}

interface DictionaryEntryPart {
  type: "dictionary";
  output: string;
}

interface LiteralNounPart {
  type: "literal";
  output: string;
}

type DictionarySplitPart = DictionaryTextPart | DictionaryEntryPart;
type ConversionSplitPart = DictionaryTextPart | DictionaryEntryPart | LiteralNounPart;

interface DictionaryCandidate {
  normalizedReading: string;
  output: string;
}

const MAX_ALTERNATIVE_CONVERSION_ATTEMPTS = 2;
const ALTERNATIVE_CONVERSION_FAILED_MESSAGE = "別候補に変換できませんでした。";

export type ProtectedDictionaryEntry = Pick<
  UserDictionaryEntry,
  "reading" | "output" | "enabled"
>;

export interface JapaneseConversionResult {
  text: string;
  reviewKana: string;
  conversionStrategy?: "completion";
}

export interface JapaneseConversionOptions {
  avoidOutputs?: string[];
  strictAlternative?: boolean;
  alternativeAttempt?: number;
  completionMode?: boolean;
  completionSourceRomaji?: string;
  protectedDictionaryEntries?: ProtectedDictionaryEntry[];
}

export async function convertRomajiToJapanese(
  input: string,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
): Promise<string> {
  const result = await convertRomajiToJapaneseDetailed(input, settings, transport);
  return result.text;
}

export async function convertRomajiToJapaneseDetailed(
  input: string,
  settings: AppSettings,
  transport: OllamaTransport = defaultOllamaTransport,
  options: JapaneseConversionOptions = {},
): Promise<JapaneseConversionResult> {
  const result = await convertRomajiToJapaneseDetailedOnce(input, settings, transport, options);
  if (isUsableConversionResult(result, options)) {
    return result;
  }

  if (!hasAvoidOutputs(options.avoidOutputs)) {
    return result;
  }

  for (let attempt = 1; attempt <= MAX_ALTERNATIVE_CONVERSION_ATTEMPTS; attempt += 1) {
    const alternative = await convertRomajiToJapaneseDetailedOnce(input, settings, transport, {
      ...options,
      strictAlternative: true,
      alternativeAttempt: attempt,
      completionMode: false,
    });
    if (isUsableConversionResult(alternative, options)) {
      return alternative;
    }
  }

  const completion = await convertRomajiToJapaneseDetailedOnce(input, settings, transport, {
    ...options,
    strictAlternative: true,
    alternativeAttempt: 0,
    completionMode: true,
  });
  if (isUsableConversionResult(completion, options)) {
    return {
      ...completion,
      conversionStrategy: "completion",
    };
  }

  throw new Error(ALTERNATIVE_CONVERSION_FAILED_MESSAGE);
}

async function convertRomajiToJapaneseDetailedOnce(
  input: string,
  settings: AppSettings,
  transport: OllamaTransport,
  options: JapaneseConversionOptions,
): Promise<JapaneseConversionResult> {
  const normalized = normalizeInputForPrompt(input, settings);
  const parts = splitInputForConversion(normalized, [
    ...(options.protectedDictionaryEntries ?? []),
    ...settings.userDictionary,
  ]);
  const convertedParts: string[] = [];
  const reviewKanaParts: string[] = [];

  for (const part of parts) {
    if (part.type === "dictionary" || part.type === "literal") {
      convertedParts.push(part.output);
      reviewKanaParts.push(part.output);
      continue;
    }

    if (!hasConvertibleRomaji(part.value)) {
      convertedParts.push(part.value);
      reviewKanaParts.push(part.value);
      continue;
    }

    const kanaResult = romajiToKana(normalizeRomajiReadingCandidate(part.value));
    const repaired = await repairLowConfidenceKana(kanaResult, settings, transport);
    reviewKanaParts.push(repaired.kana);
    convertedParts.push(
      await kanjiizeKana(repaired.kana, settings, transport, {
        ...options,
        completionSourceRomaji: options.completionMode
          ? part.value
          : options.completionSourceRomaji,
      }),
    );
  }

  return {
    text: convertedParts.join(""),
    reviewKana: reviewKanaParts.join(""),
  };
}

function isAvoidedConversionOutput(output: string, avoidOutputs: string[] | undefined): boolean {
  const normalizedOutput = output.trim();
  return Boolean(
    normalizedOutput &&
      avoidOutputs?.some((avoidOutput) => avoidOutput.trim() === normalizedOutput),
  );
}

function hasAvoidOutputs(avoidOutputs: string[] | undefined): boolean {
  return Boolean(avoidOutputs?.some((output) => output.trim()));
}

function isUsableConversionResult(
  result: JapaneseConversionResult,
  options: JapaneseConversionOptions,
): boolean {
  if (isAvoidedConversionOutput(result.text, options.avoidOutputs)) {
    return false;
  }

  if (
    hasAvoidOutputs(options.avoidOutputs) &&
    result.text.trim() &&
    result.text.trim() === result.reviewKana.trim()
  ) {
    return false;
  }

  return true;
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
  options: JapaneseConversionOptions = {},
): Promise<string> {
  const result = await transport.generate(
    settings.modelProvider,
    currentProviderBaseUrl(settings),
    {
      model: settings.modelName,
      system: buildKanaKanjiSystemPrompt(
        settings.conversionPrompt,
        settings.conversionPreset,
        options.avoidOutputs ?? [],
        options.strictAlternative ?? false,
        options.alternativeAttempt ?? 0,
        options.completionMode ?? false,
      ),
      prompt: buildKanaKanjiUserPrompt(kana, options),
      stream: false,
      think: settings.think,
      options: {
        temperature: options.completionMode ? 0.35 : options.alternativeAttempt ? 0.25 : 0.1,
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

function buildKanaKanjiUserPrompt(kana: string, options: JapaneseConversionOptions): string {
  if (!options.completionMode) {
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

export function buildProtectedDictionaryEntries(
  input: string,
  currentText: string,
  entries: UserDictionaryEntry[],
): ProtectedDictionaryEntry[] {
  const protectedEntries: ProtectedDictionaryEntry[] = [];
  const seen = new Set<string>();

  const addEntry = (reading: string, output: string) => {
    const normalizedReading = normalizeDictionaryReading(reading);
    const trimmedOutput = output.trim();
    const key = `${normalizedReading}\t${trimmedOutput}`;
    if (
      !normalizedReading ||
      !trimmedOutput ||
      seen.has(key) ||
      !isRomajiDictionaryReading(normalizedReading) ||
      !hasDictionaryReadingMatch(input, normalizedReading)
    ) {
      return;
    }

    seen.add(key);
    protectedEntries.push({
      reading: normalizedReading,
      output: trimmedOutput,
      enabled: true,
    });
  };

  for (const entry of entries) {
    if (!entry.enabled || !entry.output.trim() || !currentText.includes(entry.output.trim())) {
      continue;
    }
    addEntry(entry.reading, entry.output);
  }

  for (const term of extractAsciiProtectedTerms(currentText)) {
    addEntry(term, term);
  }

  return protectedEntries;
}

function splitInputForConversion(
  input: string,
  entries: ProtectedDictionaryEntry[],
): ConversionSplitPart[] {
  const literalParts = splitInputByLiteralNouns(input).flatMap((part) => {
    if (part.type === "literal") {
      return [part];
    }

    return splitInputByInlineKanjiTerms(part.value);
  });

  const boundaryParts = literalParts.flatMap((part) => {
    if (part.type === "literal") {
      return [part];
    }

    return splitInputBySpacedRomajiParticles(part.value);
  });

  return boundaryParts.flatMap((part): ConversionSplitPart[] => {
    if (part.type === "literal") {
      return [part];
    }

    return splitInputByDictionary(part.value, entries);
  });
}

function splitInputByLiteralNouns(input: string): Array<DictionaryTextPart | LiteralNounPart> {
  const parts: Array<DictionaryTextPart | LiteralNounPart> = [];
  let index = 0;
  let lastCopiedIndex = 0;

  while (index < input.length) {
    if (input[index] !== "`" || isEscapedBacktick(input, index)) {
      index += 1;
      continue;
    }

    const end = findClosingBacktick(input, index + 1);
    if (end === -1) {
      index += 1;
      continue;
    }

    if (lastCopiedIndex < index) {
      parts.push({ type: "text", value: input.slice(lastCopiedIndex, index) });
    }

    parts.push({ type: "literal", output: input.slice(index + 1, end) });
    index = end + 1;
    lastCopiedIndex = index;
  }

  if (parts.length === 0) {
    return [{ type: "text", value: input }];
  }

  if (lastCopiedIndex < input.length) {
    parts.push({ type: "text", value: input.slice(lastCopiedIndex) });
  }

  return parts;
}

function splitInputByInlineKanjiTerms(input: string): Array<DictionaryTextPart | LiteralNounPart> {
  const parts: Array<DictionaryTextPart | LiteralNounPart> = [];
  let index = 0;
  let lastCopiedIndex = 0;

  while (index < input.length) {
    if (!isJapaneseTermCharacter(input[index] ?? "")) {
      index += 1;
      continue;
    }

    const start = index;
    let hasKanji = false;
    while (index < input.length && isJapaneseTermCharacter(input[index] ?? "")) {
      if (isKanjiCharacter(input[index] ?? "")) {
        hasKanji = true;
      }
      index += 1;
    }

    if (!hasKanji) {
      continue;
    }

    if (lastCopiedIndex < start) {
      parts.push({ type: "text", value: input.slice(lastCopiedIndex, start) });
    }
    parts.push({ type: "literal", output: input.slice(start, index) });
    lastCopiedIndex = index;
  }

  if (parts.length === 0) {
    return [{ type: "text", value: input }];
  }

  if (lastCopiedIndex < input.length) {
    parts.push({ type: "text", value: input.slice(lastCopiedIndex) });
  }

  return parts;
}

function splitInputBySpacedRomajiParticles(
  input: string,
): Array<DictionaryTextPart | LiteralNounPart> {
  const matches = Array.from(
    input.matchAll(/(?<!\S)(no|ni|wo|o|ha|wa|ga|to|de|e|he|mo|kara|made|yori)(?!\S)/gi),
  );
  if (matches.length === 0) {
    return [{ type: "text", value: input }];
  }

  const parts: Array<DictionaryTextPart | LiteralNounPart> = [];
  let lastCopiedIndex = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const leadingText = input.slice(lastCopiedIndex, start).trimEnd();
    const particle = match[0];
    if (leadingText.length > 0) {
      parts.push({ type: "text", value: leadingText });
    }
    parts.push({ type: "literal", output: romajiParticleToKana(particle) });
    lastCopiedIndex = end;
    while (lastCopiedIndex < input.length && /\s/.test(input[lastCopiedIndex] ?? "")) {
      lastCopiedIndex += 1;
    }
  }

  if (lastCopiedIndex < input.length) {
    parts.push({ type: "text", value: input.slice(lastCopiedIndex) });
  }

  return parts;
}

function romajiParticleToKana(particle: string): string {
  switch (particle.toLowerCase()) {
    case "no":
      return "の";
    case "ni":
      return "に";
    case "wo":
    case "o":
      return "を";
    case "ha":
    case "wa":
      return "は";
    case "ga":
      return "が";
    case "to":
      return "と";
    case "de":
      return "で";
    case "e":
    case "he":
      return "へ";
    case "mo":
      return "も";
    case "kara":
      return "から";
    case "made":
      return "まで";
    case "yori":
      return "より";
    default:
      return particle;
  }
}

function isJapaneseTermCharacter(character: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff々〆ヵヶ]/u.test(character);
}

function isKanjiCharacter(character: string): boolean {
  return /[\u3400-\u9fff々〆]/u.test(character);
}

function findClosingBacktick(input: string, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === "`" && !isEscapedBacktick(input, index)) {
      return index;
    }
  }
  return -1;
}

function isEscapedBacktick(input: string, index: number): boolean {
  let slashCount = 0;
  for (let position = index - 1; position >= 0 && input[position] === "\\"; position -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function splitInputByDictionary(
  input: string,
  entries: ProtectedDictionaryEntry[],
): DictionarySplitPart[] {
  const candidates = buildDictionaryCandidates(entries);

  if (candidates.length === 0) {
    return [{ type: "text", value: input }];
  }

  const lowerInput = input.toLowerCase();
  const parts: DictionarySplitPart[] = [];
  let index = 0;
  let lastCopiedIndex = 0;

  while (index < input.length) {
    const match = candidates.find(
      (candidate) =>
        lowerInput.startsWith(candidate.normalizedReading, index) &&
        canMatchDictionaryCandidate(lowerInput, index, candidate),
    );

    if (!match) {
      index += 1;
      continue;
    }

    if (lastCopiedIndex < index) {
      parts.push({ type: "text", value: input.slice(lastCopiedIndex, index) });
    }
    parts.push({ type: "dictionary", output: match.output });
    index += match.normalizedReading.length;
    lastCopiedIndex = index;
  }

  if (parts.length === 0) {
    return [{ type: "text", value: input }];
  }

  if (lastCopiedIndex < input.length) {
    parts.push({ type: "text", value: input.slice(lastCopiedIndex) });
  }
  return parts;
}

function buildDictionaryCandidates(entries: ProtectedDictionaryEntry[]): DictionaryCandidate[] {
  return entries
    .map((entry) => ({
      normalizedReading: normalizeDictionaryReading(entry.reading),
      output: entry.output.trim(),
      enabled: entry.enabled,
    }))
    .filter(
      (entry) =>
        entry.enabled &&
        entry.normalizedReading.length > 0 &&
        entry.output.length > 0 &&
        isRomajiDictionaryReading(entry.normalizedReading),
    )
    .sort((a, b) => b.normalizedReading.length - a.normalizedReading.length);
}

function normalizeDictionaryReading(reading: string): string {
  return reading.toLowerCase().replace(/[\s'-]+/g, "");
}

function canMatchDictionaryCandidate(
  input: string,
  start: number,
  candidate: DictionaryCandidate,
): boolean {
  const length = candidate.normalizedReading.length;
  if (length <= 4) {
    return hasDictionaryWordBoundary(input, start, length);
  }

  return hasAllowedLongDictionarySuffix(input, start + length);
}

function hasDictionaryReadingMatch(input: string, normalizedReading: string): boolean {
  const normalizedInput = input.toLowerCase();
  const candidate: DictionaryCandidate = {
    normalizedReading,
    output: normalizedReading,
  };
  let index = normalizedInput.indexOf(normalizedReading);
  while (index !== -1) {
    if (canMatchDictionaryCandidate(normalizedInput, index, candidate)) {
      return true;
    }
    index = normalizedInput.indexOf(normalizedReading, index + 1);
  }
  return false;
}

function isRomajiDictionaryReading(reading: string): boolean {
  return /^[a-z0-9][a-z0-9' -]*[a-z0-9]$/i.test(reading) || /^[a-z0-9]$/i.test(reading);
}

function extractAsciiProtectedTerms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*/g)) {
    const term = match[0].trim();
    const key = term.toLowerCase();
    if (term.length < 3 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function hasDictionaryWordBoundary(input: string, start: number, length: number): boolean {
  const before = input[start - 1] ?? "";
  const after = input[start + length] ?? "";
  return !isAsciiWordCharacter(before) && !isAsciiWordCharacter(after);
}

function hasAllowedLongDictionarySuffix(input: string, suffixStart: number): boolean {
  const next = input[suffixStart] ?? "";
  if (!isAsciiWordCharacter(next)) {
    return true;
  }

  return ROMAJI_DICTIONARY_SUFFIXES.some((suffix) => input.startsWith(suffix, suffixStart));
}

function isAsciiWordCharacter(character: string): boolean {
  return /[a-z0-9]/i.test(character);
}

function hasConvertibleRomaji(value: string): boolean {
  return /[a-z]/i.test(value);
}

export function normalizeRomajiReadingCandidate(input: string): string {
  return normalizeAmbiguousParticleWo(normalizeCommonRomajiTypos(input));
}

function normalizeCommonRomajiTypos(input: string): string {
  return input
    .replace(/dseu/gi, preserveCaseReplacement("desu"))
    .replace(/deus/gi, preserveCaseReplacement("desu"))
    .replace(/dsu/gi, preserveCaseReplacement("desu"));
}

function normalizeAmbiguousParticleWo(input: string): string {
  return input.replace(/wo(?=ga|ha|wa|wo|ni|de|to|mo|e|he|kara|made|yori)/gi, (match, offset) => {
    const previous = input[offset - 1] ?? "";
    if (!/[a-z]/i.test(previous)) {
      return match;
    }

    return match[0] === "W" ? "O" : "o";
  });
}

function preserveCaseReplacement(replacement: string): (match: string) => string {
  return (match) => (match.toUpperCase() === match ? replacement.toUpperCase() : replacement);
}

const ROMAJI_DICTIONARY_SUFFIXES = [
  "nitsuite",
  "ni",
  "de",
  "no",
  "wo",
  "o",
  "ha",
  "wa",
  "ga",
  "to",
  "e",
  "he",
  "mo",
  "kara",
  "made",
  "yori",
];

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
      think: settings.think,
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
