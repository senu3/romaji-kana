// @vitest-environment jsdom
import { act, useCallback } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDocumentSession, saveFileDocumentSession } from "../lib/documentStore";
import { openMarkdownFile, reopenMarkdownFile, saveMarkdownFile } from "../lib/fileSystem";
import { mountHook, stateEditor } from "./testUtils";
import { useDocumentFiles } from "./useDocumentFiles";
import { useDocumentSession } from "./useDocumentSession";

vi.mock("../lib/fileSystem", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/fileSystem")>(),
  openMarkdownFile: vi.fn(), reopenMarkdownFile: vi.fn(), saveMarkdownFile: vi.fn(),
}));

function harness(content = "draft") {
  let changed: (text: string) => void = () => { };
  const editor = stateEditor(content, text => changed(text));
  const editorViewRef = { current: editor.view };
  const notifyDocumentSaved = vi.fn();
  const setStatus = vi.fn();
  const hook = mountHook(() => {
    const session = useDocumentSession({ remoteMode: false, editorViewRef });
    const replaceEditorDocument = useCallback((text: string) => session.replaceDocumentContent(text), [session.replaceDocumentContent]);
    const files = useDocumentFiles({
      confirmDiscardUnsavedChanges: session.confirmDiscardUnsavedChanges,
      currentFilePathRef: session.currentFilePathRef,
      replaceEditorDocument,
      setCurrentFilePath: session.setCurrentFilePath,
      markDocumentClean: session.markDocumentClean,
      setStatus,
      getEditorDocument: session.getEditorDocument,
      notifyDocumentSaved,
      editorReady: true,
      initialSession: session.initialSession,
      remoteMode: false,
    });
    return { ...files, session };
  });
  changed = text => hook.current.session.persistDocumentChange(text);
  return { hook, editor, notifyDocumentSaved };
}

describe("desktop file commands with a mocked file system", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.mocked(openMarkdownFile).mockReset();
    vi.mocked(reopenMarkdownFile).mockReset();
    vi.mocked(saveMarkdownFile).mockReset();
  });

  it("keeps a dirty restored draft instead of rereading disk", () => {
    saveFileDocumentSession("C:/draft.md", "unsaved draft", true);
    const { hook } = harness("unsaved draft");
    expect(hook.current.session.initialDocument).toBe("unsaved draft");
    expect(reopenMarkdownFile).not.toHaveBeenCalled();
  });

  it("opens a file and notifies synchronization only after a successful save", async () => {
    vi.mocked(openMarkdownFile).mockResolvedValue({ path: "C:/opened.md", content: "opened" });
    vi.mocked(saveMarkdownFile).mockResolvedValue("C:/copy.md");
    const { hook, editor, notifyDocumentSaved } = harness();
    await act(async () => { await hook.current.handleOpenFile(); });
    expect(editor.view.state.doc.toString()).toBe("opened");
    expect(hook.current.session.currentFilePath).toBe("C:/opened.md");
    expect(hook.current.session.isDirty).toBe(false);
    await act(async () => { await hook.current.handleSaveFileAs(); });
    expect(saveMarkdownFile).toHaveBeenCalledExactlyOnceWith("opened", null);
    expect(notifyDocumentSaved).toHaveBeenCalledExactlyOnceWith("opened", "C:/copy.md");
    expect(loadDocumentSession()).toEqual({ kind: "file", path: "C:/copy.md", content: "opened", dirty: false });
    vi.mocked(saveMarkdownFile).mockResolvedValue(null);
    await act(async () => { await hook.current.handleSaveFile(); });
    expect(notifyDocumentSaved).toHaveBeenCalledTimes(1);
    expect(hook.current.session.currentFilePath).toBe("C:/copy.md");
  });

  it("preserves the document when discarding unsaved changes is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { hook, editor } = harness();
    act(() => hook.current.session.persistDocumentChange("draft"));
    act(() => hook.current.handleNewFile());
    await act(async () => { await hook.current.handleOpenFile(); });
    expect(editor.view.state.doc.toString()).toBe("draft");
    expect(openMarkdownFile).not.toHaveBeenCalled();
  });
});
