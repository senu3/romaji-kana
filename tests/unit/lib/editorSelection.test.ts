import { describe, expect, it, vi } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { dispatchPreviewSelection } from "../../../src/lib/editorSelection";
import { commitEditorText } from "../../../src/lib/editorCommit";

function editor(focused = true) {
  let state = EditorState.create({ doc: "abc remainder", selection: { anchor: 10, head: 6 } });
  const restore = vi.fn(), focus = vi.fn(() => { focused = true; });
  const node = {};
  const view = {
    get state() { return state; }, get hasFocus() { return focused; }, focus,
    dispatch(spec: TransactionSpec) { state = state.update(spec).state; },
    domAtPos(offset: number) { return { node, offset }; },
    dom: { ownerDocument: { getSelection: () => ({ setBaseAndExtent: restore }) } },
  } as unknown as EditorView;
  return { view, restore, focus, node };
}

describe("editor selection policy", () => {
  it("preserves a reversed selection when preview DOM changes", () => {
    const { view, restore, focus, node } = editor();
    dispatchPreviewSelection(view, "preserve");
    expect(view.state.selection.main.anchor).toBe(10);
    expect(view.state.selection.main.head).toBe(6);
    expect(restore).toHaveBeenCalledWith(node, 10, node, 6);
    expect(focus).not.toHaveBeenCalled();
  });
  it("does not steal native selection from another focused control", () => {
    const { view, restore, focus } = editor(false);
    dispatchPreviewSelection(view, "preserve");
    expect(restore).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
  it("explicit navigation focuses and synchronizes the requested position", () => {
    const { view, restore, focus, node } = editor(false);
    dispatchPreviewSelection(view, 3);
    expect(view.state.selection.main.head).toBe(3);
    expect(focus).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledWith(node, 3, node, 3);
  });
  it.each(["map", "end"] as const)("uses %s policy when replacing text away from the selection", cursor => {
    const { view } = editor();
    commitEditorText(view, { from: 0, to: 3, original: "abc", text: "案", cursor, userEvent: "input.convert" });
    expect(view.state.selection.main.anchor).toBe(cursor === "map" ? 8 : 1);
    expect(view.state.selection.main.head).toBe(cursor === "map" ? 4 : 1);
  });
});
