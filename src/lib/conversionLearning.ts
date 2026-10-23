const KEY = "romaji-kana-conversion-learning-v1";
interface Choice { reading: string; text: string; count: number; updated: number }
function load(): Choice[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((c): c is Choice => c && typeof c.reading === "string" && typeof c.text === "string" &&
      Number.isInteger(c.count) && c.count > 0 && Number.isFinite(c.updated)).slice(0, 500) : [];
  } catch { return []; }
}
export function conversionLearningSnapshot(): (reading: string, text: string) => number {
  const bonuses = new Map(load().map(choice => [JSON.stringify([choice.reading, choice.text]), Math.min(choice.count, 4) * 1500]));
  return (reading, text) => bonuses.get(JSON.stringify([reading, text])) ?? 0;
}
/** Called only on an explicit user acceptance, never on generation or automatic replacement. */
export function recordConversionChoice(reading: string, text: string): void {
  if (!reading || !text || reading.length > 500 || text.length > 1000) return;
  const choices = load();
  const old = choices.find(c => c.reading === reading && c.text === text);
  const next = [{ reading, text, count: Math.min((old?.count ?? 0) + 1, 1000), updated: Date.now() },
    ...choices.filter(c => c !== old)].slice(0, 500);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* A full/unavailable storage must not prevent typing. */ }
}
