// @vitest-environment jsdom
import { act, useCallback } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDocumentSession, saveFileDocumentSession } from "../../../src/lib/documentStore";
import { openMarkdownFile, reopenMarkdownFile, saveMarkdownFile } from "../../../src/lib/fileSystem";
import { deferred, mountHook, stateEditor } from "./testUtils";
import { useDocumentFiles } from "../../../src/hooks/useDocumentFiles";
import { useDocumentSession } from "../../../src/hooks/useDocumentSession";

vi.mock("../../../src/lib/fileSystem", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/lib/fileSystem")>(),
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
      documentEpochRef: session.documentEpochRef,
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

  it("keeps edits made during saving dirty and in the recovery session", async () => {
    const saved = deferred<string | null>();
    vi.mocked(saveMarkdownFile).mockReturnValue(saved.promise);
    const { hook, editor } = harness("before save");
    let saving!: Promise<void>;
    act(() => { saving = hook.current.handleSaveFileAs(); });
    act(() => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "new edit" } }));
    await act(async () => { saved.resolve("C:/saved.md"); await saving; });
    expect(saveMarkdownFile).toHaveBeenCalledWith("before save", null);
    expect(hook.current.session.isDirty).toBe(true);
    expect(loadDocumentSession()).toEqual({ kind: "file", path: "C:/saved.md", content: "new edit", dirty: true });
  });

  it("does not attach an old save result to a newly opened document", async () => {
    const saved = deferred<string | null>();
    vi.mocked(saveMarkdownFile).mockReturnValue(saved.promise);
    const { hook } = harness();
    let saving!: Promise<void>;
    act(() => { saving = hook.current.handleSaveFileAs(); });
    act(() => hook.current.handleNewFile());
    await act(async () => { saved.resolve("C:/old.md"); await saving; });
    expect(hook.current.session.currentFilePath).toBeNull();
    expect(loadDocumentSession()).toEqual({ kind: "new", content: "" });
  });

  it("does not mark a saved file dirty when the draft debounce fires", async () => {
    vi.mocked(saveMarkdownFile).mockResolvedValue("C:/saved.md");
    const { hook, editor } = harness();
    act(() => editor.view.dispatch({ changes: { from: 0, to: 5, insert: "saved content" } }));
    await act(async () => { await hook.current.handleSaveFileAs(); });
    act(() => { vi.advanceTimersByTime(250); });
    expect(loadDocumentSession()).toEqual({ kind: "file", path: "C:/saved.md", content: "saved content", dirty: false });
  });

  it("serializes saves so the newest contents reach disk last", async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    vi.mocked(saveMarkdownFile).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { hook, editor } = harness("first");
    act(() => { void hook.current.handleSaveFileAs(); });
    await act(async () => {});
    act(() => editor.view.dispatch({ changes: { from: 0, to: 5, insert: "second" } }));
    act(() => { void hook.current.handleSaveFileAs(); });
    await act(async () => {});
    expect(saveMarkdownFile).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve("C:/saved.md"); });
    expect(saveMarkdownFile).toHaveBeenLastCalledWith("second", null);
    await act(async () => { second.resolve("C:/saved.md"); });
    expect(hook.current.session.isDirty).toBe(false);
    expect(loadDocumentSession()).toEqual({ kind: "file", path: "C:/saved.md", content: "second", dirty: false });
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
