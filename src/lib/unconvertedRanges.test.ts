import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { extractSelectedConversionRange } from "./conversion";
import { rememberUnconvertedRange, retainedConversionRange, unconvertedRanges } from "./unconvertedRanges";

function remembered(doc: string, from = 0, to = doc.length) {
  return EditorState.create({ doc, extensions: [unconvertedRanges] })
    .update({ effects: rememberUnconvertedRange.of({ from, to }) }).state;
}

describe("unconverted range retention", () => {
  it("extends through decimal and grouping separators", () => {
    for (const doc of ["nedanwa1.5endesu.", "kingakuwa1,000endesu."]) {
      expect(retainedConversionRange(EditorState.create({ doc }), 3, "typing")?.text).toBe(doc);
      expect(retainedConversionRange(remembered(doc), doc.indexOf("1") + 1, "typing")?.text).toBe(doc);
    }
  });
  it("includes the suffix after fixing a typo in a previously requested sentence", () => {
    let state = remembered("ashita kaigi ni ikku.");
    state = state.update({ changes: { from: 17, to: 18 }, userEvent: "delete.backward" }).state;
    expect(state.doc.toString()).toBe("ashita kaigi ni iku.");
    expect(retainedConversionRange(state, 17, "typing")?.text).toBe("ashita kaigi ni iku.");
  });
  it("expands restored romaji even before the first request", () => {
    const state = EditorState.create({ doc: "ashita kaigi ni iku." });
    expect(retainedConversionRange(state, 8, "typing")?.text).toBe("ashita kaigi ni iku.");
    expect(retainedConversionRange(state, 0, "shortcut")?.text).toBe("ashita kaigi ni iku.");
  });
  it("maps a pending range when text is inserted before it", () => {
    let state = remembered("mae. ashita kaigi.", 5);
    state = state.update({ changes: { from: 0, insert: "前文。\n" } }).state;
    expect(retainedConversionRange(state, 14, "typing")?.text).toBe("ashita kaigi.");
  });
  it("keeps neighboring sentences and lines out of the request", () => {
    const state = remembered("ashita kaigi. tsugi.\nsonotsugi.");
    expect(retainedConversionRange(state, 7, "typing")?.text).toBe("ashita kaigi.");
    expect(retainedConversionRange(state, 16, "typing")?.text).toBe("tsugi.");
    const split = remembered("ashita kaigi ni iku.").update({ changes: { from: 7, insert: "\n" } }).state;
    expect(retainedConversionRange(split, 5, "typing")?.text).toBe("ashita ");
  });
  it("stops at newly inserted punctuation", () => {
    const state = remembered("ashita kaigi ni iku.").update({ changes: { from: 6, insert: "." } }).state;
    expect(retainedConversionRange(state, 7, "period")?.text).toBe("ashita.");
    expect(retainedConversionRange(state, 10, "typing")?.text).toBe("kaigi ni iku.");
  });
  it("removes settled text but preserves the remaining unconverted suffix", () => {
    const state = remembered("ashita kaigi ni iku.").update({
      changes: { from: 0, to: 6, insert: "明日" }, userEvent: "input.convert",
    }).state;
    expect(state.field(unconvertedRanges)).toEqual([{ from: 2, to: state.doc.length }]);
    expect(retainedConversionRange(state, 6, "typing")?.text).toBe("kaigi ni iku.");
  });
  it("clears memories after acceptance, deletion or document replacement", () => {
    for (const userEvent of ["input.convert", "input.ghostAccept", "input.historyApply", "document.open", "delete.selection"]) {
      const state = remembered("ashita.").update({ changes: { from: 0, to: 7, insert: userEvent === "delete.selection" ? "" : "明日。" }, userEvent }).state;
      if (userEvent === "delete.selection" || userEvent === "document.open" || userEvent.startsWith("input.")) {
        expect(state.field(unconvertedRanges)).toEqual([]);
      }
    }
  });
  it("does not extend into existing Japanese, Markdown code or URLs", () => {
    for (const suffix of ["確定済みです。", "`code`", "https://example.com"]) {
      const doc = `ashita ${suffix}`;
      const state = EditorState.create({ doc });
      expect(retainedConversionRange(state, 3, "typing")?.text.trim()).toBe("ashita");
    }
    const code = EditorState.create({ doc: "```\nashita kaigi\n```" });
    expect(retainedConversionRange(code, 8, "typing")).toBeNull();
  });
  it("leaves explicit selections exact", () => {
    expect(extractSelectedConversionRange("ashita kaigi ni iku.", 7, 12, "shortcut")?.text).toBe("kaigi");
  });
});
