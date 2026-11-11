import { EditorState } from "@codemirror/state";
import { history, undo, redo, isolateHistory } from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import { pauseConversion, resumePauseConversion } from "../../../src/lib/pauseConversion";
import { rememberPauseConversion } from "../../../src/lib/editorConversionEffects";
import { retainedConversionRange, unconvertedRanges } from "../../../src/lib/unconvertedRanges";

function paused(prefix = "") {
  return EditorState.create({ doc: `${prefix}hon`, selection: { anchor: prefix.length + 3 },
    extensions: [pauseConversion, resumePauseConversion, unconvertedRanges, history()] }).update({
    changes: { from: prefix.length, to: prefix.length + 3, insert: "本" },
    effects: rememberPauseConversion.of({ from: prefix.length, to: prefix.length + 1, original: "hon" }),
    annotations: isolateHistory.of("full"), userEvent: "input.convert",
  }).state;
}

function type(state: EditorState, text: string) {
  const from = state.selection.main.head;
  return state.update({ changes: { from, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" }).state;
}

describe("continuing a pause conversion", () => {
  it.each(["", "前文。"])("reuses the whole source and preserves the committed prefix: %s", prefix => {
    let state = paused(prefix);
    for (const letter of "tou") state = type(state, letter);
    expect(state.doc.toString()).toBe(`${prefix}hontou`);
    expect(state.selection.main.head).toBe(prefix.length + 6);
    expect(retainedConversionRange(state, state.doc.length, "typing")?.text).toBe("hontou");
    expect(state.field(pauseConversion)).toBeNull();
  });

  it("supports another pause and continuation without losing the original reading", () => {
    let state = type(paused(), "to");
    state = state.update({ changes: { from: 0, to: 5, insert: "本当" },
      effects: rememberPauseConversion.of({ from: 0, to: 2, original: "honto" }), userEvent: "input.convert" }).state;
    state = type(state, "u");
    expect(state.doc.toString()).toBe("hontou");
  });

  it.each(["。", "、", " ", "\n"])("settles the spelling at a delimiter: %s", delimiter => {
    let state = type(paused(), delimiter);
    state = type(state, "tou");
    expect(state.doc.toString()).toBe(`本${delimiter}tou`);
  });

  it("does not restore the source after navigation, explicit acceptance, or undo", () => {
    for (const transaction of [
      { selection: { anchor: 1 } },
      { changes: { from: 0, to: 1, insert: "本" }, userEvent: "input.ghostAccept" },
      { changes: { from: 0, to: 1, insert: "本" }, userEvent: "undo" },
    ]) {
      expect(type(paused().update(transaction).state, "tou").doc.toString()).toBe("本tou");
    }
  });

  it("keeps source restoration and new typing together for undo and redo", () => {
    let state = type(paused(), "tou");
    const target = () => ({ state, dispatch: (transaction: { state: EditorState }) => { state = transaction.state; } });
    expect(undo(target())).toBe(true);
    expect(state.doc.toString()).toBe("本");
    expect(state.field(pauseConversion)).toBeNull();
    expect(redo(target())).toBe(true);
    expect(state.doc.toString()).toBe("hontou");
  });

  it.each(["input.type.compose", "input.paste"])("does not rewrite an IME composition or paste: %s", userEvent => {
    const state = paused().update({ changes: { from: 1, insert: "tou" }, selection: { anchor: 4 }, userEvent }).state;
    expect(state.doc.toString()).toBe("本tou");
    expect(state.field(pauseConversion)).toBeNull();
  });
});
