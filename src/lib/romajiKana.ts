import type { RomajiKanaResult, RomajiKanaSpan, RomajiKanaToken } from "./types";

const kanaMap: Record<string, string> = {
  kkata: "かった",
  kya: "きゃ",
  kyu: "きゅ",
  kyo: "きょ",
  sha: "しゃ",
  shu: "しゅ",
  sho: "しょ",
  sya: "しゃ",
  syu: "しゅ",
  syo: "しょ",
  cha: "ちゃ",
  chu: "ちゅ",
  cho: "ちょ",
  tya: "ちゃ",
  tyu: "ちゅ",
  tyo: "ちょ",
  nya: "にゃ",
  nyu: "にゅ",
  nyo: "にょ",
  hya: "ひゃ",
  hyu: "ひゅ",
  hyo: "ひょ",
  mya: "みゃ",
  myu: "みゅ",
  myo: "みょ",
  rya: "りゃ",
  ryu: "りゅ",
  ryo: "りょ",
  gya: "ぎゃ",
  gyu: "ぎゅ",
  gyo: "ぎょ",
  ja: "じゃ",
  ju: "じゅ",
  jo: "じょ",
  jya: "じゃ",
  jyu: "じゅ",
  jyo: "じょ",
  zya: "じゃ",
  zyu: "じゅ",
  zyo: "じょ",
  bya: "びゃ",
  byu: "びゅ",
  byo: "びょ",
  pya: "ぴゃ",
  pyu: "ぴゅ",
  pyo: "ぴょ",
  shi: "し",
  chi: "ち",
  tsu: "つ",
  ltu: "っ",
  xtu: "っ",
  ka: "か",
  ki: "き",
  ku: "く",
  ke: "け",
  ko: "こ",
  sa: "さ",
  si: "し",
  su: "す",
  se: "せ",
  so: "そ",
  ta: "た",
  ti: "ち",
  tu: "つ",
  te: "て",
  to: "と",
  na: "な",
  ni: "に",
  nu: "ぬ",
  ne: "ね",
  no: "の",
  ha: "は",
  hi: "ひ",
  fu: "ふ",
  hu: "ふ",
  he: "へ",
  ho: "ほ",
  ma: "ま",
  mi: "み",
  mu: "む",
  me: "め",
  mo: "も",
  ya: "や",
  yu: "ゆ",
  yo: "よ",
  ra: "ら",
  ri: "り",
  ru: "る",
  re: "れ",
  ro: "ろ",
  wa: "わ",
  wo: "を",
  ga: "が",
  gi: "ぎ",
  gu: "ぐ",
  ge: "げ",
  go: "ご",
  za: "ざ",
  zi: "じ",
  ji: "じ",
  zu: "ず",
  ze: "ぜ",
  zo: "ぞ",
  da: "だ",
  di: "ぢ",
  du: "づ",
  de: "で",
  do: "ど",
  ba: "ば",
  bi: "び",
  bu: "ぶ",
  be: "べ",
  bo: "ぼ",
  pa: "ぱ",
  pi: "ぴ",
  pu: "ぷ",
  pe: "ぺ",
  po: "ぽ",
  a: "あ",
  i: "い",
  u: "う",
  e: "え",
  o: "お",
};

const romanKeys = Object.keys(kanaMap).sort((a, b) => b.length - a.length);
const consonants = new Set("bcdfghjklmnpqrstvwxyz".split(""));

export function romajiToKana(input: string): RomajiKanaResult {
  const lower = input.toLowerCase();
  const tokens: RomajiKanaToken[] = [];
  let index = 0;
  let kanaOffset = 0;

  while (index < input.length) {
    const char = lower[index];
    const originalChar = input[index];

    if (!/[a-z]/.test(char)) {
      const kind = /[\s。、.,!?！？]/u.test(originalChar) ? "punctuation" : "exact";
      kanaOffset = pushToken(tokens, {
        romaji: originalChar,
        kana: originalChar,
        inputFrom: index,
        inputTo: index + 1,
        kanaFrom: kanaOffset,
        confidence: 1,
        kind,
      });
      index += 1;
      continue;
    }

    const matched = matchKana(lower, index);
    if (matched) {
      kanaOffset = pushToken(tokens, {
        romaji: input.slice(index, index + matched.romaji.length),
        kana: matched.kana,
        inputFrom: index,
        inputTo: index + matched.romaji.length,
        kanaFrom: kanaOffset,
        confidence: 1,
        kind: "exact",
      });
      index += matched.romaji.length;
      continue;
    }

    const sokuon = matchSokuon(lower, index);
    if (sokuon) {
      kanaOffset = pushToken(tokens, {
        romaji: input.slice(index, sokuon.inputTo),
        kana: `っ${sokuon.kana}`,
        inputFrom: index,
        inputTo: sokuon.inputTo,
        kanaFrom: kanaOffset,
        confidence: 1,
        kind: "sokuon",
      });
      index = sokuon.inputTo;
      continue;
    }

    if (char === "n" && isStandaloneN(lower, index)) {
      const consume = getStandaloneNLength(lower, index);
      kanaOffset = pushToken(tokens, {
        romaji: input.slice(index, index + consume),
        kana: "ん",
        inputFrom: index,
        inputTo: index + consume,
        kanaFrom: kanaOffset,
        confidence: 1,
        kind: "n",
      });
      index += consume;
      continue;
    }

    kanaOffset = pushToken(tokens, {
      romaji: originalChar,
      kana: originalChar,
      inputFrom: index,
      inputTo: index + 1,
      kanaFrom: kanaOffset,
      confidence: 0,
      kind: "unknown",
    });
    index += 1;
  }

  return buildResult(tokens, input);
}

export function rebuildRomajiKanaResult(
  tokens: RomajiKanaToken[],
  sourceRomaji: string,
): RomajiKanaResult {
  let kanaOffset = 0;
  const rebuilt = tokens.map((token) => {
    const next = {
      ...token,
      kanaFrom: kanaOffset,
      kanaTo: kanaOffset + token.kana.length,
    };
    kanaOffset = next.kanaTo;
    return next;
  });

  return buildResult(rebuilt, sourceRomaji);
}

function buildResult(tokens: RomajiKanaToken[], sourceRomaji: string): RomajiKanaResult {
  const kana = tokens.map((token) => token.kana).join("");
  const lowConfidenceSpans = collectLowConfidenceSpans(tokens, kana, sourceRomaji);
  return { kana, tokens, lowConfidenceSpans };
}

function collectLowConfidenceSpans(
  tokens: RomajiKanaToken[],
  kana: string,
  sourceRomaji: string,
): RomajiKanaSpan[] {
  const spans: RomajiKanaSpan[] = [];
  let start = -1;

  for (let index = 0; index <= tokens.length; index += 1) {
    const token = tokens[index];
    if (token && token.confidence < 0.5) {
      if (start === -1) {
        start = index;
      }
      continue;
    }

    if (start !== -1) {
      const group = tokens.slice(start, index);
      const first = group[0];
      const last = group[group.length - 1];
      const contextFrom = Math.max(0, first.kanaFrom - 6);
      const contextTo = Math.min(kana.length, last.kanaTo + 6);

      spans.push({
        romaji: sourceRomaji.slice(first.inputFrom, last.inputTo),
        kana: kana.slice(first.kanaFrom, last.kanaTo),
        inputFrom: first.inputFrom,
        inputTo: last.inputTo,
        kanaFrom: first.kanaFrom,
        kanaTo: last.kanaTo,
        contextKana: kana.slice(contextFrom, contextTo),
        sourceRomaji,
      });
      start = -1;
    }
  }

  return spans;
}

function pushToken(
  tokens: RomajiKanaToken[],
  token: Omit<RomajiKanaToken, "kanaTo">,
): number {
  const next = {
    ...token,
    kanaTo: token.kanaFrom + token.kana.length,
  };
  tokens.push(next);
  return next.kanaTo;
}

function matchSokuon(lower: string, index: number): { kana: string; inputTo: number } | null {
  const char = lower[index];
  if (char !== lower[index + 1] || !consonants.has(char) || char === "n") {
    return null;
  }

  const matched = matchKana(lower, index + 1);
  if (!matched) {
    return null;
  }

  return {
    kana: matched.kana,
    inputTo: index + 1 + matched.romaji.length,
  };
}

function matchKana(input: string, index: number): { romaji: string; kana: string } | null {
  for (const romaji of romanKeys) {
    if (input.startsWith(romaji, index)) {
      return { romaji, kana: kanaMap[romaji] };
    }
  }
  return null;
}

function isStandaloneN(input: string, index: number): boolean {
  const next = input[index + 1] ?? "";
  if (next === "'") {
    return true;
  }
  if (next === "n") {
    return true;
  }
  if (!next || !/[a-z]/.test(next)) {
    return true;
  }
  return !"aiueoy".includes(next);
}

function getStandaloneNLength(input: string, index: number): number {
  const next = input[index + 1] ?? "";
  const afterNext = input[index + 2] ?? "";
  if (next === "'") {
    return 2;
  }
  if (next === "n" && (!afterNext || !"aiueoy".includes(afterNext))) {
    return 2;
  }
  return 1;
}
