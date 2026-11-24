import { analyzeInput } from "./inputAnalysis";
import { romajiToKana } from "./romajiKana";

/** Normalize only lowercase fullwidth letters, preserving offsets and uppercase literals. */
export function normalizeRepairLetters(value: string): string {
  return value.replace(/[ａ-ｚ]/gu, letter => String.fromCharCode(letter.charCodeAt(0) - 0xfee0));
}

export function strandedConsonant(value: string, offset: number): boolean {
  return /^[bcdfghjklmpqrstvwxyz]$/u.test(value[offset] ?? "") &&
    !/[a-zA-ZＡ-Ｚａ-ｚ0-9_]/u.test(value[offset - 1] ?? "") &&
    /[ぁ-ゖ]/u.test(value[offset + 1] ?? "");
}

export function mixedKanaTarget(doc: string, cursor: number) {
  if (/[\p{L}\p{N}]/u.test(doc[cursor] ?? "")) return null;
  const span = analyzeInput(doc).find(s => s.kind === "text" && s.from < cursor && cursor <= s.to);
  if (!span) return null;
  const before = doc.slice(span.from, cursor);
  const normalized = normalizeRepairLetters(before);
  const match = /([ぁ-ゖ]{0,12})([a-z])([ぁ-ゖ]{1,12})([\p{P}\p{Zs}]*)$/u.exec(normalized);
  if (!match) return null;
  const [, left, letter, right] = match;
  const offset = span.from + match.index + left.length;
  // Include the preceding character even when it belongs to a protected span (e.g. IDdんわ).
  const neighborhood = normalizeRepairLetters(doc.slice(Math.max(0, offset - 1), offset + 2));
  if (!strandedConsonant(neighborhood, Math.min(offset, 1))) return null;
  return { before, cursor, start: match.index, left, right, letter };
}

export async function findMixedKanaRepair(doc: string, cursor: number,
  lookup: (words: string[]) => Promise<(number | null)[]>) {
  const target = mixedKanaTarget(doc, cursor);
  if (!target) return null;
  const { before, left, letter, right } = target;
  const syllables = Array.from("aiueo", vowel => romajiToKana(letter + vowel).kana)
    .filter(kana => /^[ぁ-ゖ]$/u.test(kana));
  // Compare overlapping dictionary words around the typo. A shorter word may
  // leave a particle or another word untouched after its right boundary.
  const plans = [];
  for (let start = 0; start <= left.length; start++) {
    for (let end = right.length; end > 0; end--) {
      const length = left.length - start + 1 + end;
      if (length < 3 && !(start < left.length && end === right.length)) continue;
      for (const kana of syllables) {
        plans.push({ start: target.start + start, length, word: left.slice(start) + kana + right.slice(0, end) });
      }
    }
  }
  if (!plans.length) return null;
  const costs = await lookup(plans.map(plan => plan.word));
  const ranked = plans.flatMap((plan, i) => costs[i] == null ? [] : [{ ...plan, cost: costs[i] }])
    .sort((a, b) => b.length - a.length || a.cost - b.cost);
  const best = ranked[0];
  if (!best) return null;
  const original = before.slice(best.start);
  const suffix = original.slice(best.length);
  return { kind: "correction" as const, target: { from: cursor - original.length, to: cursor, original },
    text: best.word + suffix };
}
