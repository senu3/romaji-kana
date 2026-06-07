import type { HomophoneReviewSuggestion, UserHomophonePreference } from "./types";

const HOMOPHONE_BOUNDARY_CHARS = new Set([
  " ",
  "\n",
  "\t",
  "。",
  "、",
  ".",
  ",",
  "！",
  "？",
  "!",
  "?",
  "「",
  "」",
  "『",
  "』",
  "（",
  "）",
  "(",
  ")",
  "[",
  "]",
]);
const HOMOPHONE_PARTICLE_BOUNDARY_CHARS = new Set([
  "は",
  "が",
  "を",
  "に",
  "で",
  "と",
  "も",
  "の",
  "へ",
  "や",
  "か",
  "だ",
]);

export function buildHomophoneReviewSuggestions(
  sourceKana: string,
  convertedText: string,
  entries: UserHomophonePreference[],
): HomophoneReviewSuggestion[] {
  const seen = new Set<string>();
  const suggestions: HomophoneReviewSuggestion[] = [];

  for (const entry of entries) {
    const reading = entry.reading.trim();
    const preferred = entry.preferred.trim();
    if (
      !entry.enabled ||
      !reading ||
      !preferred ||
      !isHiraganaReading(reading) ||
      !hasStandaloneReading(sourceKana, reading) ||
      convertedText.includes(preferred)
    ) {
      continue;
    }

    for (const target of normalizeReplaceTargets(entry.replaceFrom)) {
      if (target === preferred) {
        continue;
      }

      const from = convertedText.indexOf(target);
      if (from === -1) {
        continue;
      }

      const key = `${entry.id}\t${target}\t${from}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      suggestions.push({
        id: `${entry.id}:${from}:${target}`,
        entryId: entry.id,
        reading,
        preferred,
        target,
        from,
        to: from + target.length,
      });
      break;
    }
  }

  return suggestions;
}

export function normalizeReplaceTargets(targets: string[]): string[] {
  const seen = new Set<string>();

  return targets.flatMap((target): string[] => {
    const value = target.trim();
    if (!value || seen.has(value)) {
      return [];
    }

    seen.add(value);
    return [value];
  });
}

export function parseReplaceTargets(value: string): string[] {
  return normalizeReplaceTargets(value.split(/[,\n、]/u));
}

export function formatReplaceTargets(targets: string[]): string {
  return normalizeReplaceTargets(targets).join(", ");
}

function hasStandaloneReading(sourceKana: string, reading: string): boolean {
  let index = sourceKana.indexOf(reading);
  while (index !== -1) {
    const before = sourceKana[index - 1] ?? "";
    const after = sourceKana[index + reading.length] ?? "";
    if (isHomophoneBoundary(before) && isHomophoneBoundary(after)) {
      return true;
    }

    index = sourceKana.indexOf(reading, index + 1);
  }

  return false;
}

function isHomophoneBoundary(char: string): boolean {
  return (
    char.length === 0 ||
    HOMOPHONE_BOUNDARY_CHARS.has(char) ||
    HOMOPHONE_PARTICLE_BOUNDARY_CHARS.has(char)
  );
}

function isHiraganaReading(value: string): boolean {
  return /^[\u3041-\u3096ー]+$/u.test(value);
}
