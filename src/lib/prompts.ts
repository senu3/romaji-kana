import type { ConversionPreset, UserHomophonePreference } from "./types";

export const defaultConversionPrompt = [
  "You are an advanced Japanese conversion engine.",
  "",
  "The input string is Japanese typed in romaji, but it may include the following problems:",
  "1. Typos or missing characters.",
  "2. Keyboard input mistakes.",
  "3. Mixed romaji styles such as Hepburn and Kunrei-shiki.",
  "4. Spelling variants such as shi/si and chi/ti.",
  "5. Extra or missing characters.",
  "6. Inaccurate dakuten, yoon, or sokuon representations.",
  "",
  "Your role is to restore the Japanese sentence while staying faithful to the input reading.",
  "",
  "Conversion rules:",
  "1. Correct only clear typos, omissions, and typing mistakes.",
  "2. Output Japanese, not an awkward literal transliteration.",
  "3. Preserve the input wording and reading. Do not replace it with a semantic paraphrase.",
  "4. If multiple interpretations are possible, prefer the one closest to the input reading.",
  "5. Do not explain. Output only the converted Japanese text.",
  "6. When part of the input is difficult to convert, keep the closest readable form instead of inventing missing meaning.",
].join("\n");

export const romajiHiraganaReference = [
  "a=あ, i=い, u=う, e=え, o=お",
  "ka=か, ki=き, ku=く, ke=け, ko=こ",
  "sa=さ, shi/si=し, su=す, se=せ, so=そ",
  "ta=た, chi/ti=ち, tsu/tu=つ, te=て, to=と",
  "na=な, ni=に, nu=ぬ, ne=ね, no=の",
  "ha=は, hi=ひ, fu/hu=ふ, he=へ, ho=ほ",
  "ma=ま, mi=み, mu=む, me=め, mo=も",
  "ya=や, yu=ゆ, yo=よ",
  "ra=ら, ri=り, ru=る, re=れ, ro=ろ",
  "wa=わ, wo=を, nn=ん",
  "ga=が, gi=ぎ, gu=ぐ, ge=げ, go=ご",
  "za=ざ, ji/zi=じ, zu=ず, ze=ぜ, zo=ぞ",
  "da=だ, di=ぢ, du=づ, de=で, do=ど",
  "ba=ば, bi=び, bu=ぶ, be=べ, bo=ぼ",
  "pa=ぱ, pi=ぴ, pu=ぷ, pe=ぺ, po=ぽ",
  "kya=きゃ, kyu=きゅ, kyo=きょ",
  "sha/sya=しゃ, shu/syu=しゅ, sho/syo=しょ",
  "cha/tya=ちゃ, chu/tyu=ちゅ, cho/tyo=ちょ",
  "nya=にゃ, nyu=にゅ, nyo=にょ",
  "hya=ひゃ, hyu=ひゅ, hyo=ひょ",
  "mya=みゃ, myu=みゅ, myo=みょ",
  "rya=りゃ, ryu=りゅ, ryo=りょ",
  "gya=ぎゃ, gyu=ぎゅ, gyo=ぎょ",
  "ja/jya/zya=じゃ, ju/jyu/zyu=じゅ, jo/jyo/zyo=じょ",
  "bya=びゃ, byu=びゅ, byo=びょ",
  "pya=ぴゃ, pyu=ぴゅ, pyo=ぴょ",
  "ltu=っ",
  "tta=った,tti=っち,ttu=っつ,tte=って,tto=っと",
  "kka=っか,kki=っき,kku=っく,kke=っけ,kko=っこ",
].join("\n");

export const conversionFewShotExamples = [
  "入力:",
  "anatahayokuwaraujhitoda",
  "",
  "出力:",
  "あなたはよく笑う人だ",
  "",
  "入力:",
  "kyouhatotemosamuikaraatatakakuneshite",
  "",
  "出力:",
  "今日はとても寒いから暖かくして",
  "",
  "入力:",
  "watashihanihongoobenkyousiteimasu",
  "",
  "出力:",
  "私は日本語を勉強しています",
].join("\n");

export const kanaKanjiFewShotExamples = [
  "入力:",
  "あなたのえがおがすきです",
  "",
  "出力:",
  "あなたの笑顔が好きです",
  "",
  "入力:",
  "おじいさんごじまんのとけいさ",
  "",
  "出力:",
  "おじいさんご自慢の時計さ",
  "",
  "入力:",
  "ごじだつじはおそろしいものだ",
  "",
  "出力:",
  "誤字脱字は恐ろしいものだ",
  "",
  "入力:",
  "ごじにけーきをたべよう",
  "",
  "出力:",
  "五時にケーキを食べよう",
  "",
  "入力:",
  "ぎじにさんかしよう",
  "",
  "出力:",
  "議事に参加しよう",
  "",
  "入力:",
  "みちのえいごについてはごじのかのうせいもあるため",
  "",
  "出力:",
  "未知の英語については誤字の可能性もあるため",
  "",
  "入力:",
  "みちのたんごはひらがなのままでもかまわない",
  "",
  "出力:",
  "みちの単語はひらがなのままでも構わない",
  "",
  "入力:",
  "へんかんがふあんなところはひらがなのままにしてください",
  "",
  "出力:",
  "変換が不安なところはひらがなのままにしてください",
].join("\n");

export const conversionPresetLabels: Record<ConversionPreset, string> = {
  none: "指定なし",
  conversation: "会話",
  businessEmail: "ビジネスメール",
};

const conversionPresetInstructions: Record<ConversionPreset, string> = {
  none: [
    "Purpose preset: none.",
    "Prefer faithful kana-to-kanji conversion for the kana input.",
    "Do not add casualness or politeness that is not already present in the reading.",
  ].join("\n"),
  conversation: [
    "Purpose preset: conversation or chat.",
    "Prefer natural conversational notation, common everyday kanji, and readable hiragana.",
    "Do not force slang, do not add new meaning, and preserve the input reading.",
  ].join("\n"),
  businessEmail: [
    "Purpose preset: business email or work message.",
    "Prefer stable business notation, common kanji, and standard work-message expressions when the reading supports them.",
    "Preserve the kana reading strictly. Do not add, remove, or change readings to make the sentence more polite.",
    "Do not rewrite します or しました to いたします or いたしました unless いた is present in the input.",
    "Do not rewrite お願いします to お願いいたします unless いたします is present in the input.",
    "When the input is よろしくおねがいします, prefer よろしくお願いします.",
  ].join("\n"),
};

export function buildConversionSystemPrompt(userPrompt: string): string {
  const prompt = userPrompt.trim() || defaultConversionPrompt;

  return [
    prompt,
    "",
    "【ローマ字→ひらがな対応表】",
    romajiHiraganaReference,
    "",
    "【few-shot】",
    conversionFewShotExamples,
  ].join("\n");
}

export function buildKanaRepairSystemPrompt(): string {
  return [
    "You repair only the uncertain kana fragment in a mechanical romaji-to-kana conversion.",
    "Return only the kana that should replace the uncertain fragment.",
    "Do not rewrite trusted surrounding kana.",
    "Do not explain.",
    "Prefer the closest phonetic repair over a semantic paraphrase.",
  ].join("\n");
}

export function buildKanaKanjiSystemPrompt(
  userPrompt: string,
  preset: ConversionPreset = "none",
  homophones: UserHomophonePreference[] = [],
  targetKana = "",
  avoidOutputs: string[] = [],
  strictAlternative = false,
  fixedTerms: string[] = [],
): string {
  const prompt = userPrompt.trim() || defaultConversionPrompt;
  const matchingHomophones = formatMatchingHomophonePreferences(targetKana, homophones);
  const alternativeInstructions = formatAlternativeConversionInstructions(
    avoidOutputs,
    strictAlternative,
  );
  const fixedTermInstructions = formatFixedTermInstructions(fixedTerms);

  return [
    "You convert Japanese kana text into natural Japanese writing while preserving its reading.",
    "Highest priority rules:",
    "1. Preserve the phonetic reading of the input kana.",
    "2. Do not replace words with semantically plausible alternatives if their reading differs.",
    "3. Do not paraphrase, summarize, explain, or substitute a phrase with a different wording.",
    "4. Preserve lexical items from the kana. For example, ごじまん must stay ご自慢 or ごじまん, never 持っている.",
    "5. Keep hiragana when kanji conversion is uncertain.",
    "6. Use kanji only when it is common and the reading is clear.",
    "7. Choose among same-reading kanji only when the context is clear; otherwise keep hiragana.",
    "8. Avoid contextually odd kanji even when they match the reading.",
    "9. Do not add intensifiers, modifiers, nouns, particles, or predicates that are not present in the kana.",
    "10. If the kana appears to include a typo repair, keep the closest reading rather than making a more fluent different sentence.",
    "11. User-side review handles homophone cleanup, so do not over-correct homophones by guessing hidden intent.",
    "12. Return only the converted Japanese text. Do not explain.",
    "",
    "Alternative conversion request:",
    alternativeInstructions || "None.",
    "",
    "Fixed terms from user review:",
    fixedTermInstructions || "None.",
    "",
    "Purpose preset:",
    conversionPresetInstructions[preset],
    "",
    "User homophone preferences:",
    matchingHomophones || "None.",
    "",
    "Context few-shot examples:",
    kanaKanjiFewShotExamples,
    "",
    "Additional user preference:",
    prompt,
  ].join("\n");
}

function formatFixedTermInstructions(fixedTerms: string[]): string {
  const uniqueTerms = Array.from(new Set(fixedTerms.map((term) => term.trim()).filter(Boolean)));
  if (uniqueTerms.length === 0) {
    return "";
  }

  return [
    "Preserve these user-confirmed terms exactly when the reading/context allows:",
    ...uniqueTerms.map((term) => `- ${term}`),
    "Do not replace these terms with another homophone unless the input clearly requires a different word.",
  ].join("\n");
}

function formatAlternativeConversionInstructions(
  avoidOutputs: string[],
  strictAlternative: boolean,
): string {
  const uniqueOutputs = Array.from(
    new Set(avoidOutputs.map((output) => output.trim()).filter(Boolean)),
  );
  if (uniqueOutputs.length === 0) {
    return "";
  }

  return [
    "Generate a different valid conversion candidate for the same kana input.",
    "Avoid returning these previous outputs exactly:",
    ...uniqueOutputs.map((output) => `- ${output}`),
    strictAlternative
      ? "Returning any listed output exactly is invalid. If needed, return a conservative hiragana-heavy spelling instead."
      : "If possible, return a candidate that differs from the listed outputs by at least one character.",
    "Keep the same reading and do not paraphrase just to be different.",
    "If no clearly better candidate exists, prefer a conservative kana or hiragana-heavy spelling over repeating the previous output.",
  ].join("\n");
}

export function formatMatchingHomophonePreferences(
  targetKana: string,
  homophones: UserHomophonePreference[],
): string {
  const seen = new Set<string>();
  const lines = homophones.flatMap((entry): string[] => {
    const reading = entry.reading.trim();
    const preferred = entry.preferred.trim();
    const key = `${reading}\t${preferred}`;
    if (
      !entry.enabled ||
      !reading ||
      !preferred ||
      !isHiraganaReading(reading) ||
      seen.has(key) ||
      !targetKana ||
      !targetKana.includes(reading)
    ) {
      return [];
    }

    seen.add(key);
    const note = entry.note.trim() ? ` (${entry.note.trim()})` : "";
    return [`- ${reading}: prefer ${preferred}${note}`];
  });

  if (lines.length === 0) {
    return "";
  }

  return [
    "Use these only as kana-to-kanji preferences for matching readings.",
    "They are not fixed replacements. If a preference clearly conflicts with context, preserve the reading and choose the natural spelling.",
    ...lines,
  ].join("\n");
}

function isHiraganaReading(value: string): boolean {
  return /^[\u3041-\u3096ー]+$/u.test(value);
}
