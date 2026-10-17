import { preservesProtectedContent } from "./conversionProtection";
import { normalizeReading } from "./readingComparison";

export interface WordCompletionBoundary {
  sourceKana: string;
  completedKana: string;
  convertedText: string;
}

export type CompletionBoundaryStatus = "confirmed" | "unverified" | "rejected";

/** Generation guidance and executable limits live together. Semantic guidance
 * is deliberately separate: a character guard cannot prove intended meaning. */
export const wordCompletionRule = {
  maximumAddedKana: 12,
  startedEndings: [
    ["ま", "ます"], ["ませ", "ません"], ["まし", "ました"],
    ["で", "です"], ["でし", "でした"], ["な", "ない"], ["なかっ", "なかった"],
  ] as const,
  completesStartedEnding(source: string, candidate: string): boolean {
    return this.startedEndings.some(([prefix, ending]) => source.endsWith(prefix) &&
      /^[\p{Script=Hiragana}ー]+$/u.test(source.slice(0, -prefix.length)) &&
      candidate === source.slice(0, -prefix.length) + ending);
  },
  boundaryStatus(source: string, candidate: string, convertedText?: string, boundary?: WordCompletionBoundary): CompletionBoundaryStatus {
    if (boundary && (!convertedText || !this.matchesDeclaredWord(source, candidate, convertedText, boundary))) return "rejected";
    if (this.staysInFinalWord(source, candidate, convertedText, boundary)) return "confirmed";
    if (boundary || !source || !candidate.startsWith(source)) return "rejected";
    const suffix = candidate.slice(source.length);
    if (!/^[\p{Script=Hiragana}ー]+$/u.test(suffix)) return "rejected";
    // New politeness/tense/negation is not an ambiguous lexical completion.
    if (this.startedEndings.some(([prefix, ending]) => candidate.endsWith(ending) && !source.endsWith(prefix)) ||
        /^(?:します|しました|しません|する|ください|こと|ため|よう)/u.test(suffix)) return "rejected";
    if (typeof Intl.Segmenter !== "function") return "unverified";
    const addedWords = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(suffix)].filter(segment => segment.isWordLike);
    return addedWords.length > 1 ? "rejected" : "unverified";
  },
  additionKind(source: string, candidate: string, assessed?: CompletionBoundaryStatus): "word" | "phrase" | "unverified" {
    if (!candidate.startsWith(source)) return "unverified";
    const status = assessed ?? this.boundaryStatus(source, candidate);
    return status === "confirmed" ? "word" : status === "rejected" ? "phrase" : "unverified";
  },
  staysInFinalWord(source: string, candidate: string, convertedText?: string, boundary?: WordCompletionBoundary): boolean {
    if (source === candidate) return true;
    if (this.completesStartedEnding(source, candidate)) return true;
    if (!candidate.startsWith(source) || typeof Intl.Segmenter !== "function") return false;
    const words = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(candidate)]
      .filter(segment => segment.isWordLike);
    const last = words[words.length - 1];
    // The appended text must belong to one word already started by the user.
    if (last && last.index < source.length && last.index + last.segment.length === candidate.length) return true;
    // Kana-only segmentation can split a real word (かくにん). A declared
    // surface word is an additional check, never an unverified mode label.
    return Boolean(boundary && convertedText && this.matchesDeclaredWord(source, candidate, convertedText, boundary));
  },
  matchesDeclaredWord(source: string, candidate: string, convertedText: string, boundary: WordCompletionBoundary): boolean {
    if (!boundary.sourceKana || !boundary.convertedText ||
        !source.endsWith(boundary.sourceKana) || !boundary.completedKana.startsWith(boundary.sourceKana) ||
        candidate !== source.slice(0, -boundary.sourceKana.length) + boundary.completedKana ||
        !convertedText.endsWith(boundary.convertedText)) return false;
    if (source === candidate) return true; // No addition needs boundary proof.
    if (this.completesStartedEnding(source, candidate)) return true;
    if (typeof Intl.Segmenter !== "function") return false;
    const surfaceWords = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(boundary.convertedText)];
    const finalSurfaceWord = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(convertedText)].filter(segment => segment.isWordLike).pop();
    const sourcePrefix = source.slice(0, -boundary.sourceKana.length);
    const convertedPrefix = convertedText.slice(0, -boundary.convertedText.length);
    return surfaceWords.length === 1 && Boolean(surfaceWords[0].isWordLike) &&
      finalSurfaceWord?.segment === boundary.convertedText &&
      finalSurfaceWord.index + finalSurfaceWord.segment.length === convertedText.length &&
      Boolean(sourcePrefix) === Boolean(convertedPrefix);
  },
  guidance: [
    "Complete only an unfinished final Japanese word.",
    "Do not add new particles, predicates, politeness, tense, negation, intent, or a new phrase. You may finish an inflectional ending the user already started.",
  ],
  prompt(): string[] {
    return [this.guidance[0], `Append at most ${this.maximumAddedKana} kana immediately before terminal punctuation.`, this.guidance[1],
      `Allowed already-started endings (with a preceding stem): ${this.startedEndings.map(([prefix, ending]) => `${prefix} → ${ending}`).join("; ")}. Do not infer a negative or past ending from a shorter ambiguous prefix.`,
      "When the input clearly ends in a verbal stem plus an already-started ending, prefer finishing that ending to inventing an uncommon homophonic noun. Keep correctedKana as the unfinished input and put the completed ending in convertedText and completedKana.",
      "The entire appended suffix must complete the final word or already-started ending in correctedKana. A plausible lexical completion with uncertain segmentation may be offered as an unverified preview; this never permits a new phrase, tense or negation. If the intended word itself is unclear, leave correctedKana unchanged.",
      'When completing a word, also return wordCompletion: {"sourceKana":"かくに","completedKana":"かくにん","convertedText":"確認"}. These fields describe ONLY the final word, without terminal punctuation or preceding words. sourceKana must be a nonempty suffix of correctedKana; completedKana must retain it as a prefix; convertedText must be the final single word of the output. Do not declare a phrase as a word.'];
  },
} as const;

export const localCorrectionRule = {
  maximumChangedKana: 2,
  inputLengthDivisor: 4,
  kana: /^[\p{Script=Hiragana}ー]*$/u,
  countedKana: /[\p{Script=Hiragana}ー]/u,
  forbiddenCharacters: /[\p{Script=Han}\p{Cc}]/u,
  negationAndTerminalMarkers: /なかった|ません|ない|ぬ|[。、.!?！？]+$/gu,
  terminalPunctuation: /^[。、.!?！？]*$/u,
  maximumChange(inputKanaLength: number): number {
    return Math.min(this.maximumChangedKana, Math.floor(inputKanaLength / this.inputLengthDivisor));
  },
  prompt(): string {
    return `In correctedKana, repair at most one contiguous kana fragment of at most ${this.maximumChangedKana} characters and at most 1/${this.inputLengthDivisor} of the input kana. Count only hiragana and ー for this limit; edit only hiragana and ー, never Latin, katakana, spaces or symbols. Never paraphrase, complete a word, change negation, or change punctuation in this stage.`;
  },
} as const;

export const fragmentRepairRule = {
  minimumMaximumLength: 2,
  kana: /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u,
  maximumLength(romaji: string): number {
    return Math.max(this.minimumMaximumLength, Array.from(romaji).length);
  },
  accepts(romaji: string, fragment: string): boolean {
    return this.kana.test(fragment) && Array.from(fragment).length <= this.maximumLength(romaji);
  },
  prompt(romaji?: string): string[] {
    return [
      "You repair only the uncertain kana fragment in a mechanical romaji-to-kana conversion.",
      "Return only the kana that should replace the uncertain fragment.",
      "Use hiragana, katakana or ー only; no numbers, punctuation, spaces, JSON or explanations.",
      romaji === undefined
        ? `Return at most max(${this.minimumMaximumLength}, number of original romaji characters) kana characters.`
        : `Return at most ${this.maximumLength(romaji)} kana characters.`,
      "Do not rewrite trusted surrounding kana.",
      "Do not explain.",
      "Prefer the closest phonetic repair over a semantic paraphrase.",
    ];
  },
} as const;

export const sentenceCompletionRule = {
  minimumLengthRatio: 0.25,
  maximumLengthFloor: 32,
  maximumLengthRatio: 3,
  sharedCharacterRatio: 0.12,
  maximumSharedCharacters: 3,
  shortInputMaximum: 2,
  mediumInputMaximum: 4,
  shortInputSharedMinimum: 0,
  mediumInputSharedMinimum: 1,
  longInputSharedMinimum: 2,
  minimumSharedCharacters(length: number): number {
    return length <= this.shortInputMaximum ? this.shortInputSharedMinimum
      : length <= this.mediumInputMaximum ? this.mediumInputSharedMinimum
      : Math.min(this.maximumSharedCharacters, Math.max(this.longInputSharedMinimum, Math.ceil(length * this.sharedCharacterRatio)));
  },
  declaredAdditionFloor: 24,
  declaredAdditionRatio: 1.25,
  guidance: [
    "Act as a writing suggestion, not a literal transcription.",
    "You may add particles, inflectional endings, sentence endings, a short natural continuation, or a concise re-expression with the same intent.",
    "Lightly repair or reorder kana when it makes the suggestion substantially more natural.",
    "Keep digits, Latin terms, symbols, Markdown markers, and existing terminal punctuation unchanged.",
    "Keep the suggestion concise, preserve the central intent and tone, and never switch to an unrelated topic.",
  ],
  prompt(): string[] {
    return [...this.guidance,
      `Reading length guard (count kana only): at least max(1, ceil(input length * ${this.minimumLengthRatio})), at most max(${this.maximumLengthFloor}, input length * ${this.maximumLengthRatio}).`,
      `Retain shared kana occurrences: ${this.shortInputSharedMinimum} for input lengths 0–${this.shortInputMaximum}, ${this.mediumInputSharedMinimum} for ${this.shortInputMaximum + 1}–${this.mediumInputMaximum}, otherwise min(${this.maximumSharedCharacters}, max(${this.longInputSharedMinimum}, ceil(input length * ${this.sharedCharacterRatio}))).`,
      `Declared additions must be visible in convertedText and total at most max(${this.declaredAdditionFloor}, ceil(input length * ${this.declaredAdditionRatio})) characters; for this addition limit, input length excludes whitespace but includes non-kana characters.`,
    ];
  },
} as const;

export const declaredSuggestionAdditionRule = {
  allowedSpan: /^[\p{Script=Hiragana}ー。、！？!?]+$/u,
  guidance: "When completedKana does not demonstrate insertions, additions is only a fallback declaration: use hiragana, ー and 。、！？!? only, with spans absent from the source and visible in convertedText in the declared order. This fallback rule does not restrict insertions demonstrated by completedKana.",
} as const;

/** Shared by suggestion text/reading checks and speculative source/text checks. */
export const convertedTextLengthRule = {
  minimumRatio: 0.2,
  maximumFloor: 24,
  maximumRatio: 2,
  accepts(sourceLength: number, textLength: number): boolean {
    return textLength >= Math.max(1, Math.ceil(sourceLength * this.minimumRatio)) &&
      textLength <= Math.max(this.maximumFloor, sourceLength * this.maximumRatio);
  },
  prompt(source: "completedKana" | "input"): string {
    return `Ignoring whitespace, convertedText length must be at least max(1, ceil(${source} length * ${this.minimumRatio})) and at most max(${this.maximumFloor}, ${source} length * ${this.maximumRatio}).`;
  },
} as const;

export const finalReadingRule = {
  forbiddenKanji: /[\p{Script=Han}々〆]/u,
  // Tabs and CR/LF are ordinary document whitespace; all other C0/C1
  // controls are forbidden in both text and readings, in every route.
  forbiddenControls: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u,
  accepts(candidate: { completedKana: string; convertedText: string }, _route: "final" | "suggestion"): boolean {
    if (!candidate.completedKana || !candidate.convertedText || this.forbiddenKanji.test(candidate.completedKana)) return false;
    const controlsValid = !this.forbiddenControls.test(candidate.completedKana + candidate.convertedText);
    return controlsValid && preservesProtectedContent(candidate.completedKana, candidate.convertedText);
  },
  controlPrompt(_route: "final" | "suggestion"): string {
    return "Neither completedKana nor convertedText may contain C0/C1 control characters other than tabs and line breaks. Preserve the original number of line breaks.";
  },
  guidance: [
    "After writing convertedText, transcribe THAT TEXT into completedKana. Read its kanji with their correct pronunciation, even if the input contained a misspelling.",
    "Include every correction, completion and re-expression in completedKana.",
    "Do not reuse the input kana when its reading differs from convertedText. Do not include explanations.",
    '{"convertedText":"本を読む。","completedKana":"ほんをよむ。"}',
    "Keep existing terminal punctuation unchanged.",
    "completedKana must not contain kanji. Use the correct reading of the final text: 学校 is がっこう, never がくこう.",
  ],
} as const;

export const faithfulConversionRule = {
  sameReading(a: string, b: string): boolean {
    return normalizeReading(a) === normalizeReading(b);
  },
  guidance: [
    "1. Preserve the phonetic reading of the input kana.",
    "2. Do not replace words with semantically plausible alternatives if their reading differs.",
    "3. Reject kanji candidates whose common reading drops, adds, or changes kana from the input. For example, しっぴつ can be 執筆 or しっぴつ, never 失費 because 失費 is read しっぴ.",
    "4. Do not paraphrase, summarize, explain, or substitute a phrase with a different wording.",
    "5. Preserve lexical items from the kana. For example, ごじまん must stay ご自慢 or ごじまん, never 持っている.",
    "6. Keep hiragana when kanji conversion is uncertain.",
    "7. Use kanji only when it is common and the reading is clear.",
    "8. Choose among same-reading kanji only when the context is clear; otherwise keep hiragana.",
    "9. Avoid contextually odd kanji even when they match the reading.",
    "10. Do not add intensifiers, modifiers, nouns, particles, or predicates that are not present in the kana.",
    "11. If the kana appears to include a typo repair, keep the closest reading rather than making a more fluent different sentence.",
    "12. Do not explain. Follow the response contract.",
  ],
} as const;

export const typoCompletionRule = {
  guidance: [
    "The user prompt contains both the original romaji input and the mechanical kana.",
    "Use both signals to infer a minimal romaji typo repair before kana-kanji conversion.",
    "Assume the romaji input may contain a small typing error such as one wrong consonant.",
    "For example, mododuki may be a typo of motoduki, yielding もとづき and 基づき.",
    "Repair only the minimum romaji or kana needed to produce a natural Japanese sentence.",
    "Do not paraphrase, summarize, or replace words whose reading already makes sense.",
    "Do not add new information. Keep the output close to the original wording.",
    "If the intended repair is still unclear, keep the uncertain part in hiragana rather than inventing meaning.",
  ],
} as const;

export const speculativeRule = {
  /** Existing fallback heuristic; this is weaker than semantic/script guidance. */
  isHiraganaOnlyCandidate(value: string): boolean {
    const hasHiragana = /[\u3041-\u3096]/u.test(value);
    const hasNonHiraganaWriting = /[\u30a1-\u30ff\u3400-\u9fff々〆ヵヶA-Za-z]/u.test(value);
    return hasHiragana && !hasNonHiraganaWriting;
  },
  guidance: [
    "Infer the user's most plausible intended Japanese from both the original romaji and the mechanical kana.",
    "This is not another strict kana-to-kanji pass. It is a suggestion, so you may resolve an ambiguous reading, minimally repair a likely typing error, or use a nearby natural expression with the same intent.",
    "When the standard spelling itself is all hiragana, prefer a concise semantic re-expression containing common kanji instead of forcing ateji.",
    "Keep the central intent and tone close to the input. Never invent an unrelated sentence or new facts.",
    "A valid result must contain at least one common kanji or katakana character.",
    "Returning only hiragana is invalid in this pass, even when all-hiragana would normally be the standard spelling.",
    "Prefer a natural candidate containing common kanji or katakana.",
    "Never force obscure ateji or unnatural kanji merely to avoid hiragana.",
  ],
} as const;
