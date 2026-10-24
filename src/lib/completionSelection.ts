import { Facet, type EditorState } from "@codemirror/state";

export const completionSelection = Facet.define<boolean, boolean>({ combine: values => values.some(Boolean) });
export const isSelectingCompletion = (state: EditorState) => state.facet(completionSelection);
