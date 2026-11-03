export type InputKind = "text" | "literal" | "path" | "abbreviation" | "url" | "code" | "fence";
export interface InputSpan {
  from: number;
  to: number;
  kind: InputKind;
  /** Original UTF-16 offsets; delimiters are excluded only for explicit literals. */
  contentFrom: number;
  contentTo: number;
  open?: boolean;
}

let cachedInput: string | undefined;
let cachedSpans: readonly InputSpan[] = [];

export function isFixedInput(span: InputSpan): boolean { return span.kind !== "text"; }
export function isExcludedInput(span: InputSpan): boolean {
  return span.kind === "code" || span.kind === "fence" || span.kind === "url";
}
export function containsInputPosition(span: InputSpan, position: number): boolean {
  return position >= span.from && (position < span.to ||
    (position === span.to && (span.open || span.kind === "url" || span.kind === "path" || span.kind === "abbreviation")));
}

/** One lexical interpretation for range extraction, normalization, conversion and completion. */
export function analyzeInput(input: string): readonly InputSpan[] {
  if (input === cachedInput) return cachedSpans;
  const spans: InputSpan[] = [];
  const append = (from: number, to: number, kind: InputKind, contentFrom = from, contentTo = to, open = false) => {
    if (from === to) return;
    const previous = spans[spans.length - 1];
    if (kind === "text" && previous?.kind === "text" && previous.to === from) {
      previous.to = to; previous.contentTo = to;
    } else spans.push({ from, to, kind, contentFrom, contentTo, ...(open ? { open } : {}) });
  };
  let index = 0;
  while (index < input.length) {
    if (index === 0 || input[index - 1] === "\n") {
      const lineEnd = input.indexOf("\n", index);
      const end = lineEnd < 0 ? input.length : lineEnd;
      const fence = /^\s*(`{3,}|~{3,})(.*)$/u.exec(input.slice(index, end));
      if (fence) {
        let next = lineEnd < 0 ? input.length : lineEnd + 1;
        let closed = false;
        while (next < input.length) {
          const newline = input.indexOf("\n", next);
          const stop = newline < 0 ? input.length : newline;
          const close = /^\s*(`{3,}|~{3,})(.*)$/u.exec(input.slice(next, stop));
          if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length && !close[2].trim()) {
            append(index, stop, "fence"); index = stop; closed = true; break;
          }
          next = newline < 0 ? input.length : newline + 1;
        }
        if (!closed) { append(index, input.length, "fence", index, input.length, true); index = input.length; }
        continue;
      }
    }
    if (input[index] === "`") {
      let slashes = 0;
      for (let i = index - 1; i >= 0 && input[i] === "\\"; i--) slashes++;
      if (slashes % 2 === 0) {
        const run = /^`+/u.exec(input.slice(index))![0];
        const newline = input.indexOf("\n", index);
        const end = newline < 0 ? input.length : newline;
        const rest = input.slice(index + run.length, end);
        const close = [...rest.matchAll(/`+/gu)].find(match => match[0].length === run.length);
        if (close) {
          const contentEnd = index + run.length + close.index;
          append(index, contentEnd + run.length, run.length === 1 ? "literal" : "code", index + run.length, contentEnd);
          index = contentEnd + run.length;
        } else { append(index, end, "code", index, end, true); index = end; }
        continue;
      }
    }
    const url = /^https?:\/\/[^\s)`]+/u.exec(input.slice(index));
    if (url) { append(index, index + url[0].length, "url"); index += url[0].length; continue; }
    if (!/[A-Za-z0-9_./\\:-]/u.test(input[index - 1] ?? "")) {
      const token = /^[^\s`"'<>()[\]{}。、!?！？]+/u.exec(input.slice(index))?.[0] ?? "";
      const path = token.replace(/[.,]+$/u, "");
      if (/^(?:[A-Za-z]:[\\/]|\\\\|[.~]?[\\/]|[^\\/:]+[\\/])/u.test(path) &&
          /[A-Za-z\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(path) &&
          !/^\d+(?:[\\/]\d+)+/u.test(path) && !path.includes("://")) {
        append(index, index + path.length, "path"); index += path.length; continue;
      }
      const capitals = /^[A-Z]+/u.exec(input.slice(index))?.[0];
      if (capitals && (capitals.length >= 2 || !/[a-z]/u.test(input[index + capitals.length] ?? ""))) {
        append(index, index + capitals.length, "abbreviation"); index += capitals.length; continue;
      }
    }
    append(index, index + 1, "text"); index++;
  }
  cachedInput = input; cachedSpans = spans;
  return spans;
}

export function hasEditableRomaji(input: string): boolean {
  return analyzeInput(input).some(span => span.kind === "text" && /[a-z]/iu.test(input.slice(span.from, span.to)));
}

export function cutsFixedInput(input: string, from: number, to: number): boolean {
  return analyzeInput(input).some(span => isFixedInput(span) && span.from < to && span.to > from &&
    (isExcludedInput(span) || from > span.from || to < span.to));
}
