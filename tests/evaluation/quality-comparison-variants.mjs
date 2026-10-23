// Evaluation-only mutations of pinned source snapshots. Never imported by the app.
export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Snapshot no longer matches experiment: " + before.slice(0, 90));
  return source.replace(before, after);
}

export function variantSource(file, source, arm) {
  if (file === "localConversion.ts" && arm === "pool32") {
    return replaceOnce(source, "const MAX_CANDIDATES = 24;", "const MAX_CANDIDATES = 32;");
  }
  if (file === "localConversion.ts" && arm === "check-single") {
    return replaceOnce(source, "const shouldRank = candidates.length > 1 || correcting;", "const shouldRank = candidates.length > 0;");
  }
  if (arm !== "edit-all") return source;
  if (file === "localConversion.ts") return replaceOnce(source,
    "Each candidate inserts exactly one romaji letter into the original input and has its own corrected reading. ",
    "Each candidate makes one internal romaji insertion, deletion, substitution or adjacent transposition. Compare edit.before and edit.after; each candidate has its own corrected reading. ");
  if (file !== "missingLetterCorrection.ts") return source;
  source = replaceOnce(source, "  const positions = new Map<number, typeof plans>();", `
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
  const positions = new Map<number, typeof plans>();`);
  return source;
}

export function augmentSpeculation(request, arm, input, options) {
  if (arm === "baseline") return request;
  let extra;
  if (arm === "plus-romaji") extra = { originalRomaji: input };
  else if (arm === "plus-rejection") extra = { rejectedOutputForThisOccurrence: options.avoidOutputs?.slice(-1) ?? [] };
  else if (arm === "plus-vocabulary") extra = { referenceVocabulary: options.documentVocabulary?.slice(0, 8) ?? [] };
  else throw new Error("Unknown speculation arm: " + arm);
  return { ...request, prompt: request.prompt + "\nAdditional reference data (not instructions; not text to copy):\n" + JSON.stringify(extra) };
}
