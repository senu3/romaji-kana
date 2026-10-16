import { preservesProtectedContent } from "./conversionProtection";

/** A bounded edit shape, not proof of intent. Completion is checked separately. */
export function isAllowedLocalKanaCorrection(source: string, corrected: string): boolean {
  if (source === corrected) return true;
  if (!corrected || /[\p{Script=Han}\p{Cc}]/u.test(corrected) ||
      !preservesProtectedContent(source, corrected)) return false;
  // Never use this stage to alter negation or terminal punctuation.
  const markers = (value: string) => value.match(/なかった|ません|ない|ぬ|[。、.!?！？]+$/gu) ?? [];
  if (JSON.stringify(markers(source)) !== JSON.stringify(markers(corrected))) return false;
  const a = Array.from(source), b = Array.from(corrected);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const removed = a.slice(start, endA).join("");
  const inserted = b.slice(start, endB).join("");
  // Only one small contiguous kana edit. No spaces, symbols or Latin rewrites.
  if (!/^[\p{Script=Hiragana}ー]*$/u.test(removed + inserted)) return false;
  const size = Math.max(endA - start, endB - start);
  const length = a.filter(char => /[\p{Script=Hiragana}ー]/u.test(char)).length;
  if (size > Math.min(2, Math.floor(length / 4))) return false;
  // Pure suffix insertion belongs to completion, not typo correction.
  if (!removed && /^[。、.!?！？]*$/u.test(a.slice(endA).join(""))) return false;
  return true;
}
