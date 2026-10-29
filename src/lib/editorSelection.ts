import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type ReplacementCursor = "end" | "map";

/** Omit an explicit selection to let CodeMirror map all ranges through the edit. */
export function replacementSelection(from: number, text: string, cursor: ReplacementCursor = "map") {
  return cursor === "end" ? { anchor: from + text.length } : undefined;
}

/** Update preview UI without allowing detached widget DOM to move the native caret.
 * `preserve` keeps the current selection and never takes focus; a position is an
 * explicit navigation action and returns focus to the editor.
 * Only use for transactions without document changes.
 */
export function dispatchPreviewSelection(view: EditorView, target: "preserve" | number,
  effects?: TransactionSpec["effects"]) {
  view.dispatch({ selection: target === "preserve" ? view.state.selection : { anchor: target }, effects });
  if (target !== "preserve") view.focus();
  if (!view.hasFocus) return;
  // Chromium can lose its native caret when an inline widget becomes a mark,
  // although CodeMirror's logical selection is still correct.
  const selection = view.state.selection.main;
  const anchor = view.domAtPos(selection.anchor), head = view.domAtPos(selection.head);
  view.dom.ownerDocument.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
}
