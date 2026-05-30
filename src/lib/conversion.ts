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
  if (character === "。") {
    return "japanesePeriod";
  }
  if (character === "、") {
    return "japaneseComma";
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

  const text = doc.slice(start, safeCursor).trimStart();
  const leadingWhitespace = doc.slice(start, safeCursor).length - doc.slice(start, safeCursor).trimStart().length;
  const from = start + leadingWhitespace;

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
