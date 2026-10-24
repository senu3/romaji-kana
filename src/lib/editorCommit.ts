import { isolateHistory } from "@codemirror/commands";
import type { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export interface EditorCommit {
  from: number; to: number; original: string; text: string;
  userEvent: "input.convert" | "input.historyApply" | "input.ghostAccept" | "input.autosuggest";
  cursor?: "end" | "map";
  effects?: StateEffect<unknown>[];
}

/** Validate immediately before dispatch. Every acceptance is one undo step. */
export function commitEditorText(view: EditorView, commit: EditorCommit, beforeDispatch?: () => void): boolean {
  if (commit.from < 0 || commit.to < commit.from || commit.to > view.state.doc.length ||
      view.state.doc.sliceString(commit.from, commit.to) !== commit.original) return false;
  beforeDispatch?.();
  view.dispatch({
    changes: { from: commit.from, to: commit.to, insert: commit.text },
    selection: commit.cursor === "end" ? { anchor: commit.from + commit.text.length } : undefined,
    effects: commit.effects,
    userEvent: commit.userEvent,
    annotations: isolateHistory.of("full"),
  });
  return true;
}
