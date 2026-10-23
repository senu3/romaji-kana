import { normalizeReading } from "./readingComparison";

// Deliberately narrow: compare recognized predicates, not occurrences of ない
// inside arbitrary nouns. Unknown paraphrases remain unproven and require acceptance.
function predicate(reading: string) {
  const value = normalizeReading(reading).replace(/[。.!?！？\s]+$/u, "");
  const attendance = value.match(/(いく|いきます|いった|いきました|いかない|いきません|いかなかった|いきませんでした|いけません|(?:さんか|しゅっせき|けっせき)(?:する|します|した|しました|しない|しません|しなかった|しませんでした|できません))$/u);
  const state = value.match(/(かくにん|かんりょう|おわ)(?:していない|していません|している|しています|した|しました|っていない|っていません|った|りました|らなかった|りませんでした)$/u);
  if (!attendance && !state) return undefined;
  const token = attendance?.[0] ?? state![0];
  const negative = /(?:ない|ません|なかった|ませんでした)$/u.test(token);
  return {
    family: attendance ? "attendance" : state![1] === "かくにん" ? "confirmation" : "completion",
    positive: attendance && token.startsWith("けっせき") ? negative : !negative,
    past: /(?:いった|した|だった|なかった|でした|おわった)$/u.test(token),
  };
}

/** Returns known contradictions only; absence of a conflict is NOT semantic verification. */
export function hasSemanticConflict(source: string, output: string): boolean {
  const a = predicate(source), b = predicate(output);
  if (a && b && a.family === b.family && (a.positive !== b.positive || a.past !== b.past)) return true;
  const request = (s: string) => /(?:ください|おねがいします|おねがいいたします)[。.!?！？\s]*$/u.test(normalizeReading(s));
  return request(source) && !request(output);
}
