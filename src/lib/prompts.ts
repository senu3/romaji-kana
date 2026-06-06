import type { ConversionPreset, UserDictionaryEntry } from "./types";

export const legacyDefaultConversionPrompt = [
  "You convert rough romaji Japanese input into natural Japanese.",
  "Correct typos, missing characters, extra characters, and inconsistent spelling.",
  "Return only the converted Japanese text.",
  "Do not explain.",
  "Preserve Markdown syntax when present.",
].join("\n");

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
  "Your role is to infer and restore the Japanese sentence from the input string.",
  "",
  "Conversion rules:",
  "1. Automatically correct typos, omissions, and typing mistakes.",
  "2. Output Japanese, not an awkward literal transliteration.",
  "3. If multiple interpretations are possible, choose the most common one.",
  "4. Do not explain. Output only the converted Japanese text.",
  "5. Even when part of the input is difficult to convert, infer as much as possible from context.",
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

export const conversionPresetLabels: Record<ConversionPreset, string> = {
  none: "指定なし",
  conversation: "会話",
  businessEmail: "ビジネスメール",
};

const conversionPresetInstructions: Record<ConversionPreset, string> = {
  none: [
    "Purpose preset: none.",
    "Prefer the most common written Japanese for the kana input.",
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
  userDictionary: UserDictionaryEntry[] = [],
): string {
  const prompt = userPrompt.trim() || defaultConversionPrompt;
  const dictionaryBlock = buildUserDictionaryPromptBlock(userDictionary);

  return [
    "You convert Japanese kana text into natural Japanese writing while preserving its reading.",
    "Highest priority rules:",
    "1. Preserve the phonetic reading of the input kana.",
    "2. Do not replace words with semantically plausible alternatives if their reading differs.",
    "3. Do not paraphrase.",
    "4. Use kanji only when it is common and the reading is clear.",
    "5. Keep hiragana when kanji conversion is uncertain.",
    "6. Return only the converted Japanese text. Do not explain.",
    "",
    "Purpose preset:",
    conversionPresetInstructions[preset],
    "",
    ...dictionaryBlock,
    ...(dictionaryBlock.length > 0 ? [""] : []),
    "Additional user preference:",
    prompt,
  ].join("\n");
}

function buildUserDictionaryPromptBlock(entries: UserDictionaryEntry[]): string[] {
  const enabledEntries = entries
    .filter((entry) => entry.enabled && entry.reading.trim() && entry.output.trim())
    .slice(0, 50);

  if (enabledEntries.length === 0) {
    return [];
  }

  return [
    "User dictionary:",
    "These entries are strong hints. When the input reading clearly matches an entry, prefer the registered spelling.",
    "Do not force an entry when the reading or surrounding context does not support it.",
    ...enabledEntries.map((entry) => {
      const note = compactDictionaryText(entry.note);
      const suffix = note ? ` (${note})` : "";
      return `- ${compactDictionaryText(entry.reading)} => ${compactDictionaryText(entry.output)}${suffix}`;
    }),
  ];
}

function compactDictionaryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
