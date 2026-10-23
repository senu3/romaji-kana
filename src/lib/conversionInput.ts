import type { UserDictionaryEntry } from "./types";

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

interface FixedParticlePart {
  type: "particle";
  output: string;
}

type ConversionSplitPart = DictionaryTextPart | DictionaryEntryPart | LiteralNounPart | FixedParticlePart;

interface DictionaryCandidate {
  normalizedReading: string;
  output: string;
}

export type ProtectedDictionaryEntry = Pick<
  UserDictionaryEntry,
  "reading" | "output" | "enabled"
>;

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

export function splitInputForConversion(
  input: string,
  entries: ProtectedDictionaryEntry[],
): ConversionSplitPart[] {
  const literalParts = splitInputByLiteralNouns(input).flatMap((part) => {
    if (part.type === "literal") {
      return [part];
    }

    return splitInputByInlineKanjiTerms(part.value);
  });

  const dictionaryParts = literalParts.flatMap((part): ConversionSplitPart[] => {
    if (part.type === "literal") {
      return [part];
    }

    return splitInputByDictionary(part.value, entries);
  });

  const hasProtectedLiteral = dictionaryParts.some((part) => part.type !== "text");
  if (!hasProtectedLiteral) {
    return dictionaryParts.map((part) =>
      part.type === "text"
        ? { type: "text" as const, value: normalizeSpacedRomajiParticles(part.value) }
        : part,
    );
  }

  return dictionaryParts.flatMap((part): ConversionSplitPart[] => {
    if (part.type !== "text") {
      return [part];
    }

    return splitInputByProtectedSpacedRomajiParticles(part.value);
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

function normalizeSpacedRomajiParticles(input: string): string {
  // Share tokenization and whitespace preservation with protected inputs. Only
  // the rendering differs: ordinary particles remain in the dictionary phrase.
  return splitInputByProtectedSpacedRomajiParticles(input)
    .map(part => part.type === "text" ? part.value : part.output).join("");
}

function splitInputByProtectedSpacedRomajiParticles(input: string): ConversionSplitPart[] {
  const matches = Array.from(
    input.matchAll(/(?<!\S)(no|ni|wo|o|ha|wa|ga|to|de|e|he|mo|kara|made|yori)(?!\S)/gi),
  );
  if (matches.length === 0) {
    return [{ type: "text", value: input }];
  }

  const parts: ConversionSplitPart[] = [];
  let lastCopiedIndex = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const leadingText = input.slice(lastCopiedIndex, start).replace(/[^\S\r\n]+$/u, "");
    if (leadingText.length > 0) {
      parts.push({ type: "text", value: leadingText });
    }
    parts.push({ type: "particle", output: romajiParticleToKana(match[0]) });
    lastCopiedIndex = end;
    while (lastCopiedIndex < input.length && /[^\S\r\n]/u.test(input[lastCopiedIndex] ?? "")) {
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

export function hasConvertibleRomaji(value: string): boolean {
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
