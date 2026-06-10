import type { AppSettings, ConversionRange, ConversionTrigger } from "./types";

const END_DELIMITERS = new Set(["。", "、", ".", ","]);
const URL_RE = /https?:\/\/[^\s)]+/g;

export function triggerFromCharacter(
  character: string,
): Exclude<ConversionTrigger, "shortcut"> | null {
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
  return settings.triggers[trigger];
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

  const line = getLineAt(doc, safeCursor);
  const lineOffset = safeCursor - line.from;
  const markdownBoundary = getMarkdownLineBoundary(line.text);
  let start = line.from + markdownBoundary;

  for (let index = lineOffset - 1; index >= markdownBoundary; index -= 1) {
    const char = line.text[index];
    if (END_DELIMITERS.has(char)) {
      const isTriggerChar = line.from + index === safeCursor - 1;
      if (!isTriggerChar) {
        start = line.from + index + 1;
        break;
      }
    }
  }

  const adjustedStart = start + startOffsetAfterExistingJapanese(doc.slice(start, safeCursor));
  const rawText = doc.slice(adjustedStart, safeCursor);
  const text = rawText.trimStart();
  const leadingWhitespace = rawText.length - text.length;
  const from = adjustedStart + leadingWhitespace;

  if (from >= safeCursor || !text.trim() || isJapaneseDominant(text)) {
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

  if (from >= to || !text.trim() || isJapaneseDominant(text)) {
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
    normalized = normalized.replace(/\./g, "。");
  }
  if (settings.punctuationConversion.commaToJapanese) {
    normalized = normalized.replace(/,/g, "、");
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
  return (
    isInsideFencedCode(doc, position) ||
    isInsideInlineCode(doc, position) ||
    isInsideUrl(doc, position)
  );
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
  let lastJapaneseIndex = -1;

  for (let index = 0; index < text.length; index += 1) {
    if (isJapaneseCharacter(text[index] ?? "")) {
      lastJapaneseIndex = index;
    }
  }

  if (lastJapaneseIndex === -1) {
    return 0;
  }

  const trailing = text.slice(lastJapaneseIndex + 1);
  if (!/[A-Za-z]/.test(trailing)) {
    return 0;
  }

  const leadingWhitespace = trailing.length - trailing.trimStart().length;
  return lastJapaneseIndex + 1 + leadingWhitespace;
}

function isJapaneseCharacter(char: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff。、]/u.test(char);
}

function isInsideFencedCode(doc: string, position: number): boolean {
  const before = doc.slice(0, position).split("\n");
  let open = false;

  for (const line of before) {
    if (/^\s*(```|~~~)/.test(line)) {
      open = !open;
    }
  }

  return open;
}

function isInsideInlineCode(doc: string, position: number): boolean {
  const line = getLineAt(doc, position);
  const before = line.text.slice(0, position - line.from);
  const unescapedBackticks = [...before.matchAll(/(?<!\\)`/g)].length;
  return unescapedBackticks % 2 === 1;
}

function isInsideUrl(doc: string, position: number): boolean {
  const line = getLineAt(doc, position);
  URL_RE.lastIndex = 0;

  for (const match of line.text.matchAll(URL_RE)) {
    const start = line.from + (match.index ?? 0);
    const end = start + match[0].length;
    if (position >= start && position <= end) {
      return true;
    }
  }

  return false;
}

function rangeIntersectsExcludedMarkdown(doc: string, from: number, to: number): boolean {
  const lastPosition = Math.max(from, to - 1);
  if (isInsideExcludedMarkdown(doc, from) || isInsideExcludedMarkdown(doc, lastPosition)) {
    return true;
  }

  const selectedText = doc.slice(from, to);
  for (const match of selectedText.matchAll(URL_RE)) {
    const start = from + (match.index ?? 0);
    const end = start + match[0].length;
    if (start < to && end > from) {
      return true;
    }
  }

  return false;
}
