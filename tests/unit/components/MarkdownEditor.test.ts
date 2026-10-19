import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { applySessionRanking, createConversionSession } from "../../../src/lib/conversionSession";
import type { GhostConversionSuggestion } from "../../../src/lib/types";
import { clearGhostSuggestion, ghostSuggestionField, showGhostSuggestion } from "../../../src/components/MarkdownEditor";

function setup() {
  const session = createConversionSession("hon", [
    { id: "first", kind: "conversion", result: { text: "本", reviewKana: "ほん" } },
    { id: "second", kind: "conversion", result: { text: "奔", reviewKana: "ほん" } },
  ]);
  const candidate: GhostConversionSuggestion = {
    id: "request", from: 0, to: 3, originalText: "hon", inputText: "hon",
    convertedText: "本", source: "editor", session,
  };
  const state = EditorState.create({ doc: "hon ato", extensions: [ghostSuggestionField] })
    .update({ effects: showGhostSuggestion.of(candidate) }).state;
  return { state, session, candidate };
}

describe("ghost candidate lifecycle", () => {
  it.each(["request", null])("dismisses the session when clearing %s and rejects late display", id => {
    const { state, session, candidate } = setup();
    const cleared = state.update({ effects: clearGhostSuggestion.of(id) }).state;
    expect(cleared.field(ghostSuggestionField).decorations.size).toBe(0);
    expect(session.state).toBe("dismissed");
    expect(applySessionRanking(session, ["second", "first"])).toBe(false);
    expect(cleared.update({ effects: showGhostSuggestion.of(candidate) }).state
      .field(ghostSuggestionField).suggestion).toBeNull();
  });

  it("keeps an unrelated candidate when a stale request is cleared", () => {
    const { state, session } = setup();
    expect(state.update({ effects: clearGhostSuggestion.of("old") }).state
      .field(ghostSuggestionField).suggestion?.id).toBe("request");
    expect(session.state).toBe("open");
  });

  it("dismisses a candidate on document replacement even when the text is identical", () => {
    const { state, session } = setup();
    const updated = state.update({ changes: { from: 0, to: 7, insert: "hon ato" }, userEvent: "document.open" }).state;
    expect(updated.field(ghostSuggestionField).suggestion).toBeNull();
    expect(session.state).toBe("dismissed");
  });

  it.each([{ anchor: 7 }, { anchor: 0, head: 3 }])("dismisses when the selection leaves the candidate: %j", selection => {
    const { state, session } = setup();
    expect(state.update({ selection }).state.field(ghostSuggestionField).suggestion).toBeNull();
    expect(session.state).toBe("dismissed");
  });

  it("preserves a valid candidate when text is inserted before or after it", () => {
    const { state, session } = setup();
    const shifted = state.update({ changes: { from: 0, insert: "mae " } }).state;
    expect(shifted.field(ghostSuggestionField).suggestion?.from).toBe(4);
    const appended = shifted.update({ changes: { from: 7, insert: "wo" } }).state;
    expect(appended.field(ghostSuggestionField).suggestion?.originalText).toBe("hon");
    expect(session.state).toBe("open");
  });

  it("dismisses after deleting the source", () => {
    const { state, session } = setup();
    expect(state.update({ changes: { from: 0, to: 3 } }).state.field(ghostSuggestionField).suggestion).toBeNull();
    expect(session.state).toBe("dismissed");
  });

  it("ignores invalid late targets without replacing the current candidate", () => {
    const { state, candidate, session } = setup();
    for (const target of [{ from: -1 }, { to: 99 }, { to: 0 }, { originalText: "changed" }]) {
      expect(state.update({ effects: showGhostSuggestion.of({ ...candidate, ...target }) }).state
        .field(ghostSuggestionField).suggestion).toBe(candidate);
    }
    expect(session.state).toBe("open");
  });

  it("does not change an accepted session into a dismissed one", () => {
    const { state, session } = setup();
    session.state = "accepted";
    state.update({ effects: clearGhostSuggestion.of(null) });
    expect(session.state).toBe("accepted");
  });
});
