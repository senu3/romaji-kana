// @vitest-environment jsdom
import { act, useEffect, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCompanionState,
  updateCompanionConversionSettings,
  updateCompanionDocument,
  type CompanionSnapshot,
} from "../lib/companion";
import { defaultSettings, sharedConversionSettings } from "../lib/settings";
import { deferred, mountHook, stateEditor } from "./testUtils";
import { useCompanionSync } from "./useCompanionSync";

vi.mock("../lib/companion", () => ({
  getCompanionState: vi.fn(),
  getCompanionStatus: vi.fn(),
  hasRemoteCompanionToken: () => true,
  startCompanion: vi.fn(),
  stopCompanion: vi.fn(),
  updateCompanionConversionSettings: vi.fn(),
  updateCompanionDocument: vi.fn(),
  updateCompanionSettings: vi.fn(),
}));

function snapshot(content = "PC document", revision = 1): CompanionSnapshot {
  return {
    document: { content, revision, fileName: "draft.md", updatedBy: "desktop" },
    settings: { ...defaultSettings, inputPauseTiming: "early" },
    settingsUpdatedBy: "desktop",
  };
}

function harness() {
  const editor = stateEditor("");
  const editorViewRef = { current: editor.view };
  const currentFilePathRef = { current: null };
  const getEditorDocument = () => editor.view.state.doc.toString();
  const setStatus = vi.fn();
  let notifyChange: (content: string) => void = () => { };
  const applyRemoteDocument = vi.fn((content: string) => {
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: content } });
    notifyChange(content);
  });
  const hook = mountHook(() => {
    const [settings, setSettings] = useState({ ...defaultSettings });
    const settingsRef = useRef(settings);
    useEffect(() => { settingsRef.current = settings; }, [settings]);
    const sync = useCompanionSync({
      remoteMode: true, settings, settingsRef, setSettings, setStatus,
      currentFilePathRef, editorViewRef, applyRemoteDocument, getEditorDocument, editorReady: true,
    });
    return { ...sync, settings, setSettings };
  });
  notifyChange = content => hook.current.syncDocumentChange(content);
  return { hook, applyRemoteDocument, editor };
}

describe("companion synchronization lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getCompanionState).mockReset();
    vi.mocked(updateCompanionConversionSettings).mockReset().mockResolvedValue(snapshot());
    vi.mocked(updateCompanionDocument).mockReset().mockResolvedValue(snapshot("local edit", 2));
  });

  it("ignores a poll response if typing started while it was in flight", async () => {
    const poll = deferred<CompanionSnapshot>();
    vi.mocked(getCompanionState).mockReturnValue(poll.promise);
    const { hook, editor, applyRemoteDocument } = harness();
    act(() => {
      editor.view.dispatch({ changes: { from: 0, insert: "local typing" } });
      hook.current.syncDocumentChange("local typing");
    });
    await act(async () => { poll.resolve(snapshot("stale PC document")); });
    expect(applyRemoteDocument).not.toHaveBeenCalled();
    expect(editor.view.state.doc.toString()).toBe("local typing");
  });

  it("serializes document writes and sends the latest queued edit last", async () => {
    vi.mocked(getCompanionState).mockResolvedValue(snapshot());
    const first = deferred<CompanionSnapshot>();
    const second = deferred<CompanionSnapshot>();
    vi.mocked(updateCompanionDocument).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { hook } = harness();
    await act(async () => { });
    act(() => hook.current.syncDocumentChange("first"));
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    act(() => hook.current.syncDocumentChange("second"));
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    expect(updateCompanionDocument).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(snapshot("first", 2)); });
    expect(updateCompanionDocument).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateCompanionDocument).mock.calls[1][0]).toBe("second");
    await act(async () => { second.resolve(snapshot("second", 3)); });
  });

  it("serializes settings writes and ignores snapshots until all settings are sent", async () => {
    vi.mocked(getCompanionState).mockResolvedValue(snapshot());
    const first = deferred<CompanionSnapshot>();
    const second = deferred<CompanionSnapshot>();
    vi.mocked(updateCompanionConversionSettings).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { hook } = harness();
    await act(async () => { });
    await act(async () => hook.current.setSettings(value => ({ ...value, inputPauseTiming: "deliberate" })));
    await act(async () => hook.current.setSettings(value => ({ ...value, inputPauseTiming: "early" })));
    expect(updateCompanionConversionSettings).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(snapshot()); });
    expect(updateCompanionConversionSettings).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(hook.current.settings.inputPauseTiming).toBe("early");
    await act(async () => { second.resolve(snapshot()); });
  });

  it("keeps the newer debounce timer when the preceding write completes", async () => {
    vi.mocked(getCompanionState).mockResolvedValue(snapshot());
    const first = deferred<CompanionSnapshot>();
    vi.mocked(updateCompanionDocument).mockReturnValueOnce(first.promise);
    const { hook } = harness();
    await act(async () => { });
    act(() => hook.current.syncDocumentChange("first"));
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    act(() => hook.current.syncDocumentChange("newer"));
    await act(async () => { first.resolve(snapshot("first", 2)); });
    expect(updateCompanionDocument).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    expect(updateCompanionDocument).toHaveBeenCalledTimes(1);
  });

  it("does not send queued settings after unmount", async () => {
    vi.mocked(getCompanionState).mockResolvedValue(snapshot());
    const first = deferred<CompanionSnapshot>();
    vi.mocked(updateCompanionConversionSettings).mockReturnValueOnce(first.promise);
    const { hook } = harness();
    await act(async () => { });
    await act(async () => hook.current.setSettings(value => ({ ...value, inputPauseTiming: "deliberate" })));
    await act(async () => hook.current.setSettings(value => ({ ...value, inputPauseTiming: "early" })));
    hook.unmount();
    await act(async () => { first.resolve(snapshot()); });
    expect(updateCompanionConversionSettings).toHaveBeenCalledTimes(1);
  });

  it("preserves an unsent document after a write failure instead of polling over it", async () => {
    vi.mocked(getCompanionState).mockResolvedValue(snapshot());
    vi.mocked(updateCompanionDocument).mockRejectedValueOnce(new Error("offline"));
    const { hook, editor, applyRemoteDocument } = harness();
    await act(async () => { });
    act(() => {
      editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "unsent" } });
      hook.current.syncDocumentChange("unsent");
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(editor.view.state.doc.toString()).toBe("unsent");
    expect(applyRemoteDocument).toHaveBeenCalledTimes(1);
    expect(getCompanionState).toHaveBeenCalledTimes(1);
    expect(updateCompanionDocument).toHaveBeenCalledTimes(1);
  });

  it("does not revert local settings after the last write fails", async () => {
    vi.mocked(getCompanionState).mockResolvedValue(snapshot());
    vi.mocked(updateCompanionConversionSettings).mockRejectedValueOnce(new Error("offline"));
    const { hook } = harness();
    await act(async () => { });
    await act(async () => hook.current.setSettings(value => ({ ...value, inputPauseTiming: "deliberate" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(hook.current.settings.inputPauseTiming).toBe("deliberate");
    expect(getCompanionState).toHaveBeenCalledTimes(1);
  });

  it("does not echo incoming documents or settings, but sends subsequent local edits", async () => {
    vi.mocked(getCompanionState).mockResolvedValue(snapshot());
    const { hook, applyRemoteDocument } = harness();
    await act(async () => { });
    expect(applyRemoteDocument).toHaveBeenCalledExactlyOnceWith("PC document");
    expect(hook.current.settings.inputPauseTiming).toBe("early");
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(applyRemoteDocument).toHaveBeenCalledTimes(1);
    expect(updateCompanionDocument).not.toHaveBeenCalled();
    expect(updateCompanionConversionSettings).not.toHaveBeenCalled();

    act(() => hook.current.syncDocumentChange("local edit"));
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    expect(updateCompanionDocument).toHaveBeenCalledExactlyOnceWith("local edit", "draft.md", expect.any(String));
    await act(async () => hook.current.setSettings(value => ({ ...value, inputPauseTiming: "deliberate" })));
    expect(updateCompanionConversionSettings).toHaveBeenCalledExactlyOnceWith(
      sharedConversionSettings(hook.current.settings), expect.any(String),
    );
  });

  it("pauses polling while a local document push is pending", async () => {
    vi.mocked(getCompanionState).mockResolvedValue(snapshot());
    const push = deferred<CompanionSnapshot>();
    vi.mocked(updateCompanionDocument).mockReturnValue(push.promise);
    const { hook } = harness();
    await act(async () => { });
    act(() => hook.current.syncDocumentChange("local edit"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(getCompanionState).toHaveBeenCalledTimes(1);
    await act(async () => { push.resolve(snapshot("local edit", 2)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(getCompanionState).toHaveBeenCalledTimes(2);
  });

  it("clears polling and push timers and ignores responses after unmount", async () => {
    const poll = deferred<CompanionSnapshot>();
    vi.mocked(getCompanionState).mockReturnValue(poll.promise);
    const { hook, applyRemoteDocument } = harness();
    act(() => hook.current.syncDocumentChange("pending edit"));
    expect(vi.getTimerCount()).toBe(2);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      poll.resolve(snapshot());
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(applyRemoteDocument).not.toHaveBeenCalled();
    expect(updateCompanionDocument).not.toHaveBeenCalled();
    expect(getCompanionState).toHaveBeenCalledTimes(1);
  });
});
