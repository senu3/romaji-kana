import { excludedRanges, isNumericSeparator, isPendingNumericSeparator, isSentenceBoundary } from "./conversionBoundaries";
import type { AppSettings, ConversionRange, ConversionTrigger } from "./types";


export function triggerFromCharacter(
  character: string,
): Exclude<ConversionTrigger, "shortcut"> | null {
  if (character === " ") {
    return "space";
  }
  if (character === ".") {
    return "period";
  }
  if (character === ",") {
    return "comma";
  }
  return null;
}

export function isTriggerEnabled(
  trigger: ConversionTrigger,
  settings: AppSettings,
): boolean {
  if (trigger === "shortcut") {
    return true;
  }
  if (trigger === "typing") {
    return settings.triggers.space;
  }
  return settings.triggers[trigger];
}

export function punctuationSuffixForGhostCommit(
  character: "." | ",",
  convertedText: string,
  settings: AppSettings,
): string {
  const trimmedText = convertedText.trimEnd();
  if (character === ".") {
    if (/[。.．]$/u.test(trimmedText)) {
      return "";
    }
    return settings.punctuationConversion.periodToJapanese ? "。" : ".";
  }

  if (/[、,，]$/u.test(trimmedText)) {
    return "";
  }
  return settings.punctuationConversion.commaToJapanese ? "、" : ",";
}

export function extractConversionRange(
  doc: string,
  cursor: number,
  trigger: ConversionTrigger,
): ConversionRange | null {
  const safeCursor = Math.max(0, Math.min(cursor, doc.length));
  if (safeCursor === 0 || isInsideExcludedMarkdown(doc, safeCursor)) {
    return null;
  }

  if ((trigger === "period" || trigger === "comma" || trigger === "typing" || trigger === "space") && isPendingNumericSeparator(doc, safeCursor)) return null;

  const line = getLineAt(doc, safeCursor);
  const lineOffset = safeCursor - line.from;
  const markdownBoundary = getMarkdownLineBoundary(line.text);
  let start = line.from + markdownBoundary;

  for (let index = lineOffset - 1; index >= markdownBoundary; index -= 1) {
    if (isSentenceBoundary(line.text, index) && !isInsideExcludedMarkdown(doc, line.from + index)) {
      const isTriggerChar = line.from + index === safeCursor - 1;
      if (!isTriggerChar) {
        start = line.from + index + 1;
        break;
      }
    }
  }

  // A URL or code span earlier on the line is a hard boundary. Complete
  // single-backtick literals retain their existing fixed-replacement semantics.
  for (const range of excludedRanges(doc)) {
    if (range.kind !== "literal" && range.from < safeCursor && range.to > start) start = Math.max(start, range.to);
  }
  if (start >= safeCursor) return null;
  const adjustedStart = start + startOffsetAfterExistingJapanese(doc.slice(start, safeCursor));
  const rawText = doc.slice(adjustedStart, safeCursor);
  const text = rawText.trimStart();
  const leadingWhitespace = rawText.length - text.length;
  const from = adjustedStart + leadingWhitespace;

  if (
    from >= safeCursor ||
    !text.trim() ||
    !/[A-Za-z]/.test(text) ||
    (isJapaneseDominant(text) && !isKanjiMixedRomajiInput(text))
  ) {
    return null;
  }

  return {
    from,
    to: safeCursor,
    text,
    trigger,
  };
}

export function extractSelectedConversionRange(
  doc: string,
  selectionFrom: number,
  selectionTo: number,
  trigger: ConversionTrigger,
): ConversionRange | null {
  const safeFrom = Math.max(0, Math.min(selectionFrom, selectionTo, doc.length));
  const safeTo = Math.max(0, Math.min(Math.max(selectionFrom, selectionTo), doc.length));
  if (safeFrom >= safeTo || rangeIntersectsExcludedMarkdown(doc, safeFrom, safeTo)) {
    return null;
  }

  const selectedText = doc.slice(safeFrom, safeTo);
  const leadingWhitespace = selectedText.length - selectedText.trimStart().length;
  const trailingWhitespace = selectedText.length - selectedText.trimEnd().length;
  const from = safeFrom + leadingWhitespace;
  const to = safeTo - trailingWhitespace;
  const text = doc.slice(from, to);

  if (from >= to || !text.trim() || !/[A-Za-z]/.test(text) || (isJapaneseDominant(text) && !isKanjiMixedRomajiInput(text))) {
    return null;
  }

  return {
    from,
    to,
    text,
    trigger,
  };
}

export function normalizeInputForPrompt(
  text: string,
  settings: AppSettings,
): string {
  let normalized = text;
  if (settings.punctuationConversion.periodToJapanese) {
    normalized = normalized.replace(/\./g, (mark, index, source) => isNumericSeparator(source, index) ? mark : "。");
  }
  if (settings.punctuationConversion.commaToJapanese) {
    normalized = normalized.replace(/,/g, (mark, index, source) => isNumericSeparator(source, index) ? mark : "、");
  }
  return normalized;
}

export function isJapaneseDominant(text: string): boolean {
  const content = Array.from(text).filter((char) => /\S/.test(char));
  if (content.length === 0) {
    return false;
  }

  const japaneseCount = content.filter((char) =>
    /[\u3040-\u30ff\u3400-\u9fff。、]/u.test(char),
  ).length;

  return japaneseCount / content.length >= 0.4;
}

export function isInsideExcludedMarkdown(doc: string, position: number): boolean {
  return excludedRanges(doc).some(range =>
    position >= range.from && (position < range.to || (range.kind === "url" && position === range.to)));
}

function getLineAt(doc: string, position: number): { from: number; to: number; text: string } {
  const from = doc.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  const nextLine = doc.indexOf("\n", position);
  const to = nextLine === -1 ? doc.length : nextLine;
  return { from, to, text: doc.slice(from, to) };
}

function getMarkdownLineBoundary(line: string): number {
  const heading = /^(#{1,6}\s+)/.exec(line);
  if (heading) {
    return heading[1].length;
  }

  const list = /^(\s*(?:[-+*]|\d+[.)])\s+)/.exec(line);
  if (list) {
    return list[1].length;
  }

  return 0;
}

function startOffsetAfterExistingJapanese(text: string): number {
  const boundary = findTrailingRomajiBoundaryAfterJapaneseText(text);
  if (boundary !== -1) {
    return boundary;
  }

  return 0;
}

function findTrailingRomajiBoundaryAfterJapaneseText(text: string): number {
  let boundary = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const previous = text[index - 1] ?? "";

    if (/\s/u.test(char) && isJapaneseCharacter(previous)) {
      let end = index + 1;
      while (end < text.length && /\s/u.test(text[end] ?? "")) {
        end += 1;
      }

      if (/[A-Za-z`]/.test(text[end] ?? "") && isJapaneseDominant(text.slice(0, index))) {
        boundary = end;
      }
    }
  }

  return boundary;
}

function isJapaneseCharacter(char: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff。、]/u.test(char);
}

function isKanjiMixedRomajiInput(text: string): boolean {
  return /[A-Za-z]/.test(text) && /[\u3400-\u9fff]/u.test(text);
}

function rangeIntersectsExcludedMarkdown(doc: string, from: number, to: number): boolean {
  return excludedRanges(doc).some(range => {
    if (range.from >= to || range.to <= from) return false;
    // Complete single-backtick literals are explicitly supported by the
    // conversion pipeline; partial selections inside them are not.
    return range.kind !== "literal" || from > range.from || to < range.to;
  });
}
