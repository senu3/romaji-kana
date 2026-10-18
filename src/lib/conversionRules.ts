import { preservesProtectedContent } from "./conversionProtection";
import { normalizeReading } from "./readingComparison";

/** Generation guidance and executable limits live together. Semantic guidance
 * is deliberately separate: a character guard cannot prove intended meaning. */

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
  acceptsControls(candidate: { completedKana: string; convertedText: string }): boolean {
    return !this.forbiddenControls.test(candidate.completedKana + candidate.convertedText);
  },
  accepts(candidate: { completedKana: string; convertedText: string }, _route: "final" | "suggestion"): boolean {
    if (!candidate.completedKana || !candidate.convertedText || this.forbiddenKanji.test(candidate.completedKana)) return false;
    return this.acceptsControls(candidate) && preservesProtectedContent(candidate.completedKana, candidate.convertedText);
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
} as const;

export const typoCorrectionRule = {
  guidance: [
    "The user prompt contains both the original romaji input and the mechanical kana.",
    "Use both signals to infer a minimal romaji typo repair before kana-kanji conversion.",
    "Assume the romaji input may contain a small typing error such as one wrong consonant.",
    "For example, mododuki may be a typo of motoduki, yielding もとづき and 基づき.",
    "Repair only the minimum romaji or kana needed to produce a natural Japanese sentence.",
    "Do not paraphrase, summarize, or replace words whose reading already makes sense.",
    "Do not add new information. Keep the output close to the original wording.",
    "If the intended repair is still unclear, report no candidate rather than returning the mechanical kana or inventing meaning.",
  ],
} as const;

export const speculativeRule = {
  guidance: [
    "Infer the user's most plausible intended Japanese from both the original romaji and the mechanical kana.",
    "This is not another strict kana-to-kanji pass. It is a suggestion, so you may resolve an ambiguous reading, minimally repair a likely typing error, or use a nearby natural expression with the same intent.",
    "Keep the central intent and tone close to the input. Never invent an unrelated sentence or new facts.",
    "Use conventional natural Japanese spelling. A genuinely inferred word may be written in hiragana; never paraphrase solely to force kanji.",
    "Never return the unchanged mechanical kana as a substitute for an unavailable candidate. Report no candidate when the intent cannot be inferred.",
  ],
} as const;
