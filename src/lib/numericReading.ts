/** Only normalize an integer's pronunciation when all surrounding reading
 * matches the target. Text protection remains exact and independent. */
const DIGITS = ["", "いち", "に", "さん", "よん", "ご", "ろく", "なな", "はち", "きゅう"];

export const numericReadingRule = {
  maximumInteger: 9999,
  prompt(): string {
    return `Preserve numeric signs, decimal points, separators, dates and percentages exactly. Keep digits unchanged in convertedText. Prefer copying digits into completedKana (10時 reads 10じ). A plain unsigned integer from 0 to ${this.maximumInteger} may be pronounced in kana only when all surrounding reading is unchanged; signs, formatted numbers and identifiers must stay literal.`;
  },
} as const;

function integerReadings(token: string): string[] {
  if (!/^(?:0|[1-9]\d*)$/u.test(token) || Number(token) > numericReadingRule.maximumInteger) return [];
  if (token === "0") return ["ぜろ", "れい"];
  const value = Number(token);
  const thousands = Math.floor(value / 1000), hundreds = Math.floor(value / 100) % 10;
  const tens = Math.floor(value / 10) % 10, ones = value % 10;
  const prefix = (thousands ? thousands === 3 ? "さんぜん" : thousands === 8 ? "はっせん" : (thousands === 1 ? "" : DIGITS[thousands]) + "せん" : "") +
    (hundreds ? hundreds === 3 ? "さんびゃく" : hundreds === 6 ? "ろっぴゃく" : hundreds === 8 ? "はっぴゃく" : (hundreds === 1 ? "" : DIGITS[hundreds]) + "ひゃく" : "") +
    (tens ? (tens === 1 ? "" : DIGITS[tens]) + "じゅう" : "");
  const endings = ones === 4 ? ["よん", "し"] : ones === 7 ? ["なな", "しち"] : ones === 9 ? ["きゅう", "く"] : [DIGITS[ones]];
  return endings.map(ending => prefix + ending);
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalize = (value: string) => value.normalize("NFKC").replace(/[ァ-ヶ]/gu,
  char => String.fromCharCode(char.charCodeAt(0) - 0x60)).replace(/[ \t]/gu, "");

export function normalizeNumericReading(targetReading: string, reportedReading: string): { reading: string; normalized: boolean } {
  const matches = [...targetReading.matchAll(/\d+/gu)];
  if (!matches.length) return { reading: reportedReading, normalized: false };
  let cursor = 0, pattern = "^";
  for (const match of matches) {
    const index = match.index!;
    // Identifiers, signs, decimals, separators, dates and percentages keep
    // their exact representation. Do not reinterpret these as plain integers.
    if (/[A-Za-z0-9+\-−－＋.,:/%％]/u.test(targetReading[index - 1] ?? "") ||
        /[A-Za-z0-9.,:/%％]/u.test(targetReading[index + match[0].length] ?? "")) return { reading: reportedReading, normalized: false };
    const readings = integerReadings(match[0]);
    if (!readings.length) return { reading: reportedReading, normalized: false };
    pattern += escape(normalize(targetReading.slice(cursor, index))) + `(${[match[0], ...readings].map(escape).join("|")})`;
    cursor = index + match[0].length;
  }
  pattern += escape(normalize(targetReading.slice(cursor))) + "(?![\\s\\S])";
  const result = normalize(reportedReading).match(new RegExp(pattern, "u"));
  const changed = result !== null && matches.some((match, index) => result[index + 1] !== match[0]);
  return changed ? { reading: targetReading, normalized: true } : { reading: reportedReading, normalized: false };
}
