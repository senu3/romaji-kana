export function isNumericSeparator(text: string, index: number): boolean {
  return /[.,]/u.test(text[index] ?? "") && /\d/u.test(text[index - 1] ?? "") && /\d/u.test(text[index + 1] ?? "");
}

/** A trailing separator after a digit may still become a decimal or grouping
 * separator. Automatic conversion waits for the next character. */
export function isPendingNumericSeparator(text: string, cursor: number): boolean {
  return /[.,]/u.test(text[cursor - 1] ?? "") && /\d/u.test(text[cursor - 2] ?? "");
}

export function isSentenceBoundary(text: string, index: number): boolean {
  return /[。、.,\n]/u.test(text[index] ?? "") && !isNumericSeparator(text, index);
}

interface ExcludedRange { from: number; to: number; kind: "fence" | "code" | "literal" | "url" }
let cachedDocument: string | undefined;
let cachedRanges: ExcludedRange[] = [];

/** Single-backtick spans are the application's existing protected literals.
 * Fences and multi-backtick code never become conversion targets. */
export function excludedRanges(doc: string): readonly ExcludedRange[] {
  if (doc === cachedDocument) return cachedRanges;
  const ranges: ExcludedRange[] = [];
  let fence: { from: number; marker: string; length: number } | undefined;
  let offset = 0;
  for (const line of doc.split("\n")) {
    const mark = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (mark && mark[1][0] === fence.marker && mark[1].length >= fence.length && !mark[2].trim()) {
        ranges.push({ from: fence.from, to: offset + line.length, kind: "fence" });
        fence = undefined;
      }
    } else if (mark) {
      fence = { from: offset, marker: mark[1][0], length: mark[1].length };
    } else {
      const runs = [...line.matchAll(/(?<!\\)(`+)/gu)];
      for (let i = 0; i < runs.length; i++) {
        const open = runs[i];
        const closeIndex = runs.findIndex((run, j) => j > i && run[0].length === open[0].length);
        const close = runs[closeIndex];
        ranges.push({ from: offset + open.index!, to: close ? offset + close.index! + close[0].length : offset + line.length,
          kind: open[0].length === 1 && close ? "literal" : "code" });
        if (!close) break;
        i = closeIndex;
      }
      for (const url of line.matchAll(/https?:\/\/[^\s)`]+/gu)) {
        ranges.push({ from: offset + url.index!, to: offset + url.index! + url[0].length, kind: "url" });
      }
    }
    offset += line.length + 1;
  }
  if (fence) ranges.push({ from: fence.from, to: doc.length + 1, kind: "fence" });
  cachedDocument = doc;
  cachedRanges = ranges;
  return ranges;
}
