import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { liveKanaInput } from "../../../src/lib/liveKanaInput";
import { liveKanaRange } from "../../../src/lib/liveKanaState";
import { pauseConversion } from "../../../src/lib/pauseConversion";
import { rememberPauseConversion } from "../../../src/lib/editorConversionEffects";

function editor(doc = "") {
  return EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [pauseConversion, liveKanaInput(() => true)] });
}
function type(state: EditorState, text: string) {
  for (const char of text) state = state.update({
    changes: { from: state.selection.main.from, to: state.selection.main.to, insert: char },
    selection: { anchor: state.selection.main.from + char.length }, userEvent: "input.type",
  }).state;
  return state;
}
describe("live kana document input", () => {
  it.each([["konnichiha", "こんにちは"], ["gakkou", "がっこう"], ["kyou", "きょう"], ["kanpai", "かんぱい"], ["shinnai", "しんない"]])("renders %s while preserving its source", (source, expected) => {
    const state = type(editor(), source);
    expect(state.doc.toString()).toBe(expected);
    expect(state.selection.main.head).toBe(expected.length);
    expect(liveKanaRange(state, expected.length, "typing")?.inputText).toBe(source);
  });
  it("keeps an unfinished syllable visible and resolves it on the next key", () => {
    const state = type(editor(), "kak");
    expect(state.doc.toString()).toBe("かk");
    expect(type(state, "u").doc.toString()).toBe("かく");
  });
  it.each(["https://example.com", "`kakikata`", "API", "C:/tools/file"])('preserves protected input %s', source => {
    expect(type(editor(), source).doc.toString()).toBe(source);
  });
  it("preserves numeric punctuation and Markdown prefixes in conversion targets", () => {
    const numeric = type(editor(), "nedanwa1.5en");
    expect(liveKanaRange(numeric, numeric.doc.length, "typing")?.inputText).toBe("nedanwa1.5en");
    const heading = type(editor(), "# kana");
    expect(liveKanaRange(heading, heading.doc.length, "typing")).toMatchObject({ from: 2, text: "かな", inputText: "kana" });
    const mixed = type(editor(), "konoPDFfairu");
    expect(liveKanaRange(mixed, mixed.doc.length, "typing")?.inputText).toBe("konoPDFfairu");
  });
  it("leaves paste and native IME composition unchanged", () => {
    for (const userEvent of ["input.paste", "input.type.compose", "document.replace"]) {
      expect(editor().update({ changes: { from: 0, insert: "kana" }, userEvent }).state.doc.toString()).toBe("kana");
    }
  });
  it("resumes a pause conversion as kana and retains the source", () => {
    let state = type(editor(), "hon");
    state = state.update({ changes: { from: 0, to: 2, insert: "本" }, selection: { anchor: 1 },
      effects: rememberPauseConversion.of({ from: 0, to: 1, original: "hon" }), userEvent: "input.convert" }).state;
    state = type(state, "tou");
    expect(state.doc.toString()).toBe("ほんとう");
    expect(liveKanaRange(state, 4, "typing")?.inputText).toBe("hontou");
  });
  it("starts a fresh conversion range after punctuation or committed text", () => {
    const state = type(editor("確定文"), "hon.kana");
    expect(state.doc.toString()).toBe("確定文ほん.かな");
    expect(liveKanaRange(state, state.doc.length, "typing")).toMatchObject({ from: 6, text: "かな", inputText: "kana" });
  });
  it("supports deleting and editing part of a kana syllable", () => {
    let state = type(editor(), "kya");
    state = state.update({ changes: { from: 1, to: 2 }, selection: { anchor: 1 }, userEvent: "delete.backward" }).state;
    expect(type(state, "ku").doc.toString()).toBe("きく");
    state = type(editor(), "kana");
    state = state.update({ selection: { anchor: 1 } }).state;
    expect(type(state, "ki").doc.toString()).toBe("かきな");
  });
});
