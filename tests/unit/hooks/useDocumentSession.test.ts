// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDocumentSession, saveFileDocumentSession } from "../../../src/lib/documentStore";
import { mountHook, stateEditor } from "./testUtils";
import { useDocumentSession } from "../../../src/hooks/useDocumentSession";

describe("document session lifecycle", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });

  it("restores dirty file drafts and debounces edits into the same session", () => {
    saveFileDocumentSession("C:/draft.md", "draft", true);
    const editor = stateEditor("draft");
    const hook = mountHook(() => useDocumentSession({ remoteMode: false, editorViewRef: { current: editor.view } }));
    expect(hook.current.initialDocument).toBe("draft");
    expect(hook.current.isDirty).toBe(true);
    act(() => {
      hook.current.persistDocumentChange("first edit");
      hook.current.persistDocumentChange("latest edit");
      vi.advanceTimersByTime(249);
    });
    expect(loadDocumentSession().content).toBe("draft");
    act(() => { vi.advanceTimersByTime(1); });
    expect(loadDocumentSession()).toEqual({ kind: "file", path: "C:/draft.md", content: "latest edit", dirty: true });
    expect(hook.current.docVersionRef.current).toBe(2);
  });

  it("treats replacement as clean and remote edits as dirty, with immediate persistence", () => {
    let changed: (text: string) => void = () => { };
    const editor = stateEditor("", text => changed(text));
    const editorViewRef = { current: editor.view };
    const hook = mountHook(() => useDocumentSession({ remoteMode: false, editorViewRef }));
    changed = text => hook.current.persistDocumentChange(text);
    act(() => hook.current.replaceDocumentContent("opened document"));
    expect(editor.view.state.doc.toString()).toBe("opened document");
    expect(hook.current.isDirty).toBe(false);
    act(() => {
      hook.current.replaceDocumentContent("remote edit");
      hook.current.persistRemoteDocument("remote edit");
    });
    expect(hook.current.isDirty).toBe(true);
    expect(loadDocumentSession().content).toBe("remote edit");
  });

  it("clears debounce timers and unregisters persistence events on unmount", () => {
    const editor = stateEditor("unsaved");
    const hook = mountHook(() => useDocumentSession({ remoteMode: false, editorViewRef: { current: editor.view } }));
    act(() => hook.current.persistDocumentChange("pending"));
    expect(vi.getTimerCount()).toBe(2);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1000);
      window.dispatchEvent(new Event("beforeunload"));
    });
    expect(loadDocumentSession().content).toBe("");
  });

  it("flushes the current editor text before unload", () => {
    const editor = stateEditor("last keystroke");
    mountHook(() => useDocumentSession({ remoteMode: false, editorViewRef: { current: editor.view } }));
    window.dispatchEvent(new Event("beforeunload"));
    expect(loadDocumentSession().content).toBe("last keystroke");
  });
  it("replaces vocabulary immediately on document switch and cancels stale extraction", () => {
    const editor = stateEditor("航海");
    const hook = mountHook(() => useDocumentSession({ remoteMode: false, editorViewRef: { current: editor.view } }));
    act(() => hook.current.persistDocumentChange("航海"));
    act(() => hook.current.replaceDocumentContent("校正"));
    expect(hook.current.documentVocabularyProfile.terms).toEqual(["校正"]);
    act(() => vi.advanceTimersByTime(500));
    expect(hook.current.documentVocabularyProfile.terms).toEqual(["校正"]);
    act(() => hook.current.replaceDocumentContent(""));
    expect(hook.current.documentVocabularyProfile.terms).toEqual([]);
  });
});
