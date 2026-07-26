import type { ConversionPreset, InputCompletionLevel } from "./types";

export const defaultConversionPrompt = [
  "You are an advanced Japanese kana-to-kanji conversion engine.",
  "",
  "The input string is Japanese kana text produced from romaji typing.",
  "It may include typos, missing characters, extra characters, or uncertain kana repairs.",
  "",
  "Your role is to convert the kana into natural Japanese writing while staying faithful to the input reading.",
  "",
  "Conversion rules:",
  "1. Preserve the input wording and reading. Do not replace it with a semantic paraphrase.",
  "2. Convert to common kanji only when the reading is clear.",
  "3. Keep hiragana when kanji conversion is uncertain.",
  "4. If multiple interpretations are possible, prefer the one closest to the input reading.",
  "5. Do not explain. Output only the converted Japanese text.",
  "6. When part of the input is difficult to convert, keep the closest readable form instead of inventing missing meaning.",
].join("\n");

export const kanaKanjiFewShotExamples = [
  "入力:",
  "あなたのえがおがすきです",
  "",
  "出力:",
  "あなたの笑顔が好きです",
  "",
  "入力:",
  "しっぴつのてすとです",
  "",
  "出力:",
  "執筆のテストです",
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

export const completionKanaKanjiFewShotExamples = [
  "入力:",
  "Original romaji input:",
  "gaidorainnimododukihenkansitekudasai",
  "",
  "Mechanical kana:",
  "がいどらいんにもどづきへんかんしてください",
  "",
  "出力:",
  "ガイドラインに基づき変換してください",
  "",
  "入力:",
  "Original romaji input:",
  "あなたのえがおがすきです",
  "",
  "Mechanical kana:",
  "あなたのえがおがすきです",
  "",
  "出力:",
  "あなたの笑顔が好きです",
  "",
  "入力:",
  "Original romaji input:",
  "しっぴつのてすとです",
  "",
  "Mechanical kana:",
  "しっぴつのてすとです",
  "",
  "出力:",
  "執筆のテストです",
  "",
  "入力:",
  "Original romaji input:",
  "おじいさんごじまんのとけいさ",
  "",
  "Mechanical kana:",
  "おじいさんごじまんのとけいさ",
  "",
  "出力:",
  "おじいさんご自慢の時計さ",
].join("\n");

export const conversionPresetLabels: Record<ConversionPreset, string> = {
  none: "指定なし",
  conversation: "会話",
  businessEmail: "ビジネスメール",
};

export const inputCompletionLabels: Record<InputCompletionLevel, string> = {
  none: "なし",
  word: "単語",
  sentence: "文章",
};

export function buildInputCompletionSystemPrompt(
  level: Exclude<InputCompletionLevel, "none">,
): string {
  const levelRules =
    level === "word"
      ? [
          "Complete only an unfinished final Japanese word.",
          "You may append at most a few kana immediately before terminal punctuation.",
          "Do not add particles, predicates, politeness, or a new phrase.",
        ]
      : [
          "Turn rough notes into the smallest complete Japanese sentence supported by the input.",
          "You may insert missing particles, inflectional endings, punctuation, and a minimal sentence ending.",
          "You may add a neutral です or ます ending only when it is the minimum completion needed.",
          "Do not add content words, claims, intentions, requests, honorific wording, dates, times, places, people, or objects that are not present in the input.",
        ];

  return [
    "You restore omitted kana in rough romaji typing before kana-to-kanji conversion.",
    "Return only completed Japanese kana text. Do not explain and do not use kanji.",
    "The read-only context is not part of the target. Use it only to understand the target, and never repeat or rewrite it.",
    "Preserve every existing kana, digit, Latin term, symbol, Markdown marker, and punctuation mark in the same order.",
    "Never delete, replace, reorder, or reinterpret existing content.",
    "Never invent facts or resolve an ambiguity by adding new meaning.",
    ...levelRules,
    "If no safe completion is clear, return the mechanical kana unchanged.",
  ].join("\n");
}

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
  avoidOutputs: string[] = [],
  strictAlternative = false,
  alternativeAttempt = 0,
  completionMode = false,
): string {
  const prompt = userPrompt.trim() || defaultConversionPrompt;
  const alternativeInstructions = formatAlternativeConversionInstructions(
    avoidOutputs,
    strictAlternative,
    alternativeAttempt,
    completionMode,
  );
  const completionInstructions = formatCompletionConversionInstructions(
    completionMode,
    avoidOutputs,
  );

  return [
    "You convert Japanese kana text into natural Japanese writing while preserving its reading.",
    "Highest priority rules:",
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
    "12. Return only the converted Japanese text. Do not explain.",
    "",
    "Alternative conversion request:",
    alternativeInstructions || "None.",
    "",
    "Typo completion request:",
    completionInstructions || "None.",
    "",
    "Purpose preset:",
    conversionPresetInstructions[preset],
    "",
    "Context few-shot examples:",
    completionMode ? completionKanaKanjiFewShotExamples : kanaKanjiFewShotExamples,
    "",
    "Additional user preference:",
    prompt,
  ].join("\n");
}

function formatAlternativeConversionInstructions(
  avoidOutputs: string[],
  strictAlternative: boolean,
  alternativeAttempt: number,
  completionMode: boolean,
): string {
  if (completionMode) {
    return "";
  }

  const uniqueOutputs = Array.from(
    new Set(avoidOutputs.map((output) => output.trim()).filter(Boolean)),
  );
  if (uniqueOutputs.length === 0) {
    return "";
  }

  return [
    "Generate a different valid conversion candidate for the same kana input.",
    alternativeAttempt > 0
      ? `Alternative attempt ${alternativeAttempt}: re-evaluate the reading and try another natural kana-kanji spelling. Do not fall back to all-hiragana just to avoid a previous output.`
      : "",
    "Avoid returning these previous outputs exactly:",
    ...uniqueOutputs.map((output) => `- ${output}`),
    strictAlternative
      ? "Returning any listed output exactly is invalid. Try a different natural kanji or kana-kanji spelling that preserves the same reading."
      : "If possible, return a candidate that differs from the listed outputs by at least one character.",
    "When replacing an avoided output, first check whether it omitted kana from the input reading; choose a candidate that preserves every kana sound.",
    "Do not return the entire input in hiragana unless every kana-kanji candidate would be clearly wrong.",
    "Keep the same reading and do not paraphrase just to be different.",
    "If no clearly better candidate exists, still avoid all-hiragana output solely as a fallback; the application will try a separate typo-completion pass.",
  ].filter(Boolean).join("\n");
}

function formatCompletionConversionInstructions(
  completionMode: boolean,
  avoidOutputs: string[],
): string {
  if (!completionMode) {
    return "";
  }

  const uniqueOutputs = Array.from(
    new Set(avoidOutputs.map((output) => output.trim()).filter(Boolean)),
  );

  return [
    "The previous attempts produced the same or unusable output.",
    uniqueOutputs.length > 0 ? "Avoid returning these previous outputs exactly:" : "",
    ...uniqueOutputs.map((output) => `- ${output}`),
    "The user prompt contains both the original romaji input and the mechanical kana.",
    "Use both signals to infer a minimal romaji typo repair before kana-kanji conversion.",
    "Assume the romaji input may contain a small typing error such as one wrong consonant.",
    "For example, mododuki may be a typo of motoduki, yielding もとづき and 基づき.",
    "Repair only the minimum romaji or kana needed to produce a natural Japanese sentence.",
    "Do not paraphrase, summarize, or replace words whose reading already makes sense.",
    "Do not add new information. Keep the output close to the original wording.",
    "If the intended repair is still unclear, keep the uncertain part in hiragana rather than inventing meaning.",
  ].join("\n");
}
