import type { KeyBinding, EditorView } from "@codemirror/view";

/** All candidate producers share this contract; Enter remains an editor key. */
export const candidateHelp = "Tabで採用 · ↑↓で選択 · Escで閉じる";
export const candidateAcceptLabel = "採用 Tab";
export function moveCandidateIndex(index: number, count: number, direction: number) {
  return count ? (index + direction + count) % count : 0;
}
export function candidateBindings(actions: {
  accept: (view: EditorView) => boolean;
  acceptTab?: (view: EditorView) => boolean;
  dismiss?: (view: EditorView) => boolean;
  move?: (view: EditorView, direction: number) => boolean;
}): KeyBinding[] {
  return [
    ...["Tab", "Alt-Enter"].map(key => ({ key, run: (view: EditorView) => !view.composing && (key === "Tab" && actions.acceptTab ? actions.acceptTab(view) : actions.accept(view)) })),
    ...(actions.move ? [
      { key: "ArrowDown", run: (view: EditorView) => !view.composing && actions.move!(view, 1) },
      { key: "ArrowUp", run: (view: EditorView) => !view.composing && actions.move!(view, -1) },
    ] : []),
    ...(actions.dismiss ? [{ key: "Escape", run: (view: EditorView) => !view.composing && actions.dismiss!(view) }] : []),
  ];
}

export function isCandidateAcceptKey(event: Pick<KeyboardEvent, "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">) {
  return !event.shiftKey && !event.ctrlKey && !event.metaKey &&
    ((event.key === "Tab" && !event.altKey) || (event.key === "Enter" && event.altKey));
}
