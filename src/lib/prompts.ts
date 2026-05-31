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
