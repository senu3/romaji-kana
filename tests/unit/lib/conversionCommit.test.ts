import { describe, expect, it } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { commitConversion, type ConversionCommitReason } from "../../../src/lib/conversionCommit";
import { commitEditorText } from "../../../src/lib/editorCommit";
import { createConversionSession } from "../../../src/lib/conversionSession";
import { ghostSuggestionField } from "../../../src/components/MarkdownEditor";
import type { GhostConversionSuggestion } from "../../../src/lib/types";

function editor() {
  let state = EditorState.create({ doc: "kouka", selection: { anchor: 5 }, extensions: [history(), ghostSuggestionField] });
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } } as EditorView;
  return view;
}
function suggestion(): GhostConversionSuggestion {
  return { id: "one", from: 0, to: 5, originalText: "kouka", inputText: "kouka", convertedText: "効果", reviewKana: "こうか", source: "editor",
    session: createConversionSession("kouka", [{ id: "one", kind: "conversion", result: { text: "効果", reviewKana: "こうか" } }]) };
}
describe("shared acceptance", () => {
  it.each<ConversionCommitReason>(["explicit", "automatic", "history"])("isolates %s acceptance from preceding typing and rejects duplicates", reason => {
    const view = editor(), value = suggestion();
    view.dispatch({ changes: { from: 5, insert: "i" }, userEvent: "input.type" });
    value.to = 6; value.originalText = "koukai";
    expect(commitConversion(view, value, reason)).toBe(true);
    expect(value.session?.state).toBe("accepted");
    expect(commitConversion(view, value, reason)).toBe(false);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("koukai");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("kouka");
  });
  it("does not accept a session or edit text when the source changed", () => {
    const view = editor(), value = suggestion(); value.originalText = "other";
    expect(commitConversion(view, value, "explicit")).toBe(false);
    expect(value.session?.state).toBe("open");
    expect(view.state.doc.toString()).toBe("kouka");
  });
  it("shares editing with completion without creating a conversion session", () => {
    const view = editor();
    expect(commitEditorText(view, { from: 0, to: 5, original: "kouka", text: "航海", cursor: "end", userEvent: "input.autosuggest" })).toBe(true);
    expect(view.state.selection.main.head).toBe(2);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("kouka");
  });
});
