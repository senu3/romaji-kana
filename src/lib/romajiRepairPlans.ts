import { localCorrectionRule, faithfulConversionRule } from "./conversionRules";
import { romajiToKana } from "./romajiKana";

const ALPHABET = "naeioubcdfghjklmpqrstvwxyz";
const MAX_ROMAJI = 96;

export function missingLetterReadings(value: string) {
  const original = romajiToKana(value);
  const plans: Array<{ value: string; reading: string; offset: number; inserted: string; distance: number }> = [];
  if (value.length > MAX_ROMAJI) return { plans, truncated: true };
  const markers = (reading: string) => JSON.stringify(reading.match(localCorrectionRule.negationAndTerminalMarkers) ?? []);
  for (const run of value.matchAll(/[a-z]+/g)) {
    // Do not edit fragments embedded in ASCII identifiers, numbers or URLs.
    const start = run.index;
    const end = start + run[0].length;
    if (/[A-Za-z_:/.-]/.test(value[start - 1] ?? "") || /[A-Za-z_:/-]/.test(value[end] ?? "")) continue;
    // Appending a suffix is completion, not missing-letter correction.
    for (let offset = start;offset < end;offset++) for (const inserted of ALPHABET) {
      const repaired = value.slice(0, offset) + inserted + value.slice(offset);
      const kana = romajiToKana(repaired);
      if (kana.lowConfidenceSpans.length || kana.kana === original.kana || markers(original.kana) !== markers(kana.kana)) continue;
      const distance = original.lowConfidenceSpans.length ? Math.min(...original.lowConfidenceSpans.map(span =>
        Math.min(Math.abs(offset - span.inputFrom), Math.abs(offset - span.inputTo)))) : 0;
      plans.push({ value: repaired, reading: kana.kana, offset, inserted, distance });
    }
  }

  // Reserve exploration for deletion, adjacent transposition and keyboard-neighbor
  // replacement. Keep the same total 128-plan / engine-call budget as production.
  const neighbors: Record<string, string> = {
    q: "wa", w: "qesa", e: "wrsd", r: "etdf", t: "ryfg", y: "tugh", u: "yihj", i: "uojk", o: "ipkl", p: "ol",
    a: "qwsz", s: "awedxz", d: "serfcx", f: "drtgvc", g: "ftyhbv", h: "gyujnb", j: "huikmn", k: "jiolm", l: "kop",
    z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk"
  };
  const extra: typeof plans = [];
  for (const run of value.matchAll(/[a-z]+/g)) {
    const start = run.index, end = start + run[0].length;
    if (/[A-Za-z_:/.-]/.test(value[start - 1] ?? "") || /[A-Za-z_:/-]/.test(value[end] ?? "")) continue;
    for (let offset = start; offset < end; offset++) {
      const edits = [
        { value: value.slice(0, offset) + value.slice(offset + 1), inserted: "" },
        ...(offset + 1 < end && value[offset] !== value[offset + 1] ? [{ value: value.slice(0, offset) + value[offset + 1] + value[offset] + value.slice(offset + 2), inserted: value[offset + 1] + value[offset] }] : []),
        ...[...(neighbors[value[offset]] ?? "")].map(inserted => ({ value: value.slice(0, offset) + inserted + value.slice(offset + 1), inserted }))
      ];
      for (const edit of edits) {
        const kana = romajiToKana(edit.value);
        if (!kana.kana || kana.lowConfidenceSpans.length || kana.kana === original.kana || markers(original.kana) !== markers(kana.kana)) continue;
        const distance = original.lowConfidenceSpans.length ? Math.min(...original.lowConfidenceSpans.map(span => Math.min(Math.abs(offset - span.inputFrom), Math.abs(offset - span.inputTo)))) : 0;
        extra.push({ ...edit, reading: kana.kana, offset, distance });
      }
    }
  }
  // Alternate original insertion plans and new edits at each position.
  const insertionPlans = plans.splice(0);
  const offsets = new Set([...insertionPlans, ...extra].map(plan => plan.offset));
  for (const offset of offsets) {
    const a = insertionPlans.filter(plan => plan.offset === offset), b = extra.filter(plan => plan.offset === offset);
    for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) plans.push(a[i]); if (b[i]) plans.push(b[i]); }
  }
  const positions = new Map<number, typeof plans>();
  for (const plan of plans) {
    const queue = positions.get(plan.offset) ?? [];
    queue.push(plan);
    positions.set(plan.offset, queue);
  }
  const scheduled = [...positions.values()].flatMap(queue => queue.map((plan, round) => ({ plan, round })))
    .sort((a, b) => a.plan.distance - b.plan.distance || a.round - b.round || a.plan.offset - b.plan.offset);
  // Deduplicate after scheduling: equivalent spellings must not give an early
  // edit position extra turns or displace a repair closer to an unknown token.
  const seen = new Set<string>();
  return { plans: scheduled.map(item => item.plan).filter(plan => {
    if (seen.has(plan.reading)) return false;
    seen.add(plan.reading); return true;
  }), truncated: false };
}

/** Both dictionary and model repair must fit the same one-edit reading plans. */
export function acceptsRomajiRepair(input: string, reading: string): boolean {
  return faithfulConversionRule.sameReading(romajiToKana(input).kana, reading) ||
    missingLetterReadings(input).plans.some(plan => faithfulConversionRule.sameReading(plan.reading, reading));
}
