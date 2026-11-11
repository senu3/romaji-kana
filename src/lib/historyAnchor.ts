import type { ConversionAnchor } from "./types";
import type { ChangeDesc } from "@codemirror/state";

const SEARCH_RADIUS = 240;

export interface ResolvedConversionAnchor {
  from: number;
  to: number;
  matchedText: string;
  matchedBy: "exact" | "nearby";
}

export function resolveConversionAnchor(
  documentText: string,
  anchor: ConversionAnchor,
  currentVersion?: number,
): ResolvedConversionAnchor | null {
  if (anchor.exactOnly && currentVersion !== undefined && anchor.docVersion !== currentVersion) return null;
  const candidates = getCandidateTexts(anchor);

  for (const text of candidates) {
    const exact = resolveExact(documentText, anchor.from, text);
    if (exact) {
      return { ...exact, matchedBy: "exact" };
    }
  }

  return anchor.exactOnly ? null : resolveNearby(documentText, anchor, candidates);
}

export function mapUnchangedRange<T extends { from: number; to: number }>(range: T, changes: ChangeDesc): T | undefined {
  let touched = false;
  changes.iterChangedRanges((from, to) => { touched ||= from < range.to && to > range.from; });
  if (touched) return undefined;
  return { ...range, from: changes.mapPos(range.from, 1), to: changes.mapPos(range.to, -1) };
}

function resolveExact(
  documentText: string,
  from: number,
  text: string,
): Omit<ResolvedConversionAnchor, "matchedBy"> | null {
  if (from < 0 || from + text.length > documentText.length) {
    return null;
  }

  const currentText = documentText.slice(from, from + text.length);
  if (currentText !== text) {
    return null;
  }

  return {
    from,
    to: from + text.length,
    matchedText: text,
  };
}

function resolveNearby(
  documentText: string,
  anchor: ConversionAnchor,
  candidates: string[],
): ResolvedConversionAnchor | null {
  const windowFrom = Math.max(0, anchor.from - SEARCH_RADIUS);
  const windowTo = Math.min(documentText.length, anchor.to + SEARCH_RADIUS);
  const matches: Array<Omit<ResolvedConversionAnchor, "matchedBy">> = [];

  for (const text of candidates) {
    let index = documentText.indexOf(text, windowFrom);
    while (index !== -1 && index + text.length <= windowTo) {
      matches.push({
        from: index,
        to: index + text.length,
        matchedText: text,
      });
      index = documentText.indexOf(text, index + 1);
    }
  }

  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    return null;
  }

  return { ...matches[0], matchedBy: "nearby" };
}

function getCandidateTexts(anchor: ConversionAnchor): string[] {
  return Array.from(
    new Set(
      [anchor.appliedText, anchor.originalText].filter(
        (text): text is string => typeof text === "string" && text.length > 0,
      ),
    ),
  );
}
