import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import { formatFileError } from "../lib/appErrors";
import {
  type DocumentSession,
  saveFileDocumentSession,
  saveNewDocumentSession,
} from "../lib/documentStore";
import {
  basename,
  openMarkdownFile,
  reopenMarkdownFile,
  saveMarkdownFile,
} from "../lib/fileSystem";
import { appShortcutFromKeyboardEvent } from "../lib/shortcuts";
import type { ConversionStatus } from "../lib/types";

interface DocumentFilesOptions {
  confirmDiscardUnsavedChanges: () => boolean;
  currentFilePathRef: RefObject<string | null>;
  replaceEditorDocument: (content: string) => void;
  setCurrentFilePath: Dispatch<SetStateAction<string | null>>;
  markDocumentClean: () => void;
  setStatus: Dispatch<SetStateAction<ConversionStatus>>;
  getEditorDocument: () => string;
  notifyDocumentSaved: (documentText: string, savedPath: string) => void;
  editorReady: boolean;
  initialSession: DocumentSession;
  remoteMode: boolean;
}

export function useDocumentFiles({
  confirmDiscardUnsavedChanges,
  currentFilePathRef,
  replaceEditorDocument,
  setCurrentFilePath,
  markDocumentClean,
  setStatus,
  getEditorDocument,
  notifyDocumentSaved,
  editorReady,
  initialSession,
  remoteMode,
}: DocumentFilesOptions) {
  const initialFileRestoreStartedRef = useRef(false);

  const handleNewFile = useCallback(() => {
    if (!confirmDiscardUnsavedChanges()) {
      return;
    }

    currentFilePathRef.current = null;
    replaceEditorDocument("");
    setCurrentFilePath(null);
    markDocumentClean();
    saveNewDocumentSession("");
    setStatus({ kind: "success", message: "新しいファイルを作成しました。" });
  }, [confirmDiscardUnsavedChanges, markDocumentClean, replaceEditorDocument]);

  const handleOpenFile = useCallback(async () => {
    if (!confirmDiscardUnsavedChanges()) {
      return;
    }

    try {
      const file = await openMarkdownFile();
      if (!file) {
        return;
      }

      currentFilePathRef.current = file.path;
      replaceEditorDocument(file.content);
      setCurrentFilePath(file.path);
      markDocumentClean();
      saveFileDocumentSession(file.path, file.content, false);
      setStatus({ kind: "success", message: `${basename(file.path)} を開きました。` });
    } catch (error: unknown) {
      setStatus({ kind: "error", message: formatFileError(error) });
    }
  }, [confirmDiscardUnsavedChanges, markDocumentClean, replaceEditorDocument]);

  const handleSaveFile = useCallback(async () => {
    try {
      const savedPath = await saveMarkdownFile(getEditorDocument(), currentFilePathRef.current);
      if (!savedPath) {
        return;
      }

      currentFilePathRef.current = savedPath;
      setCurrentFilePath(savedPath);
      markDocumentClean();
      saveFileDocumentSession(savedPath, getEditorDocument(), false);
      notifyDocumentSaved(getEditorDocument(), savedPath);
      setStatus({ kind: "success", message: `${basename(savedPath)} を保存しました。` });
    } catch (error: unknown) {
      setStatus({ kind: "error", message: formatFileError(error) });
    }
  }, [getEditorDocument, markDocumentClean, notifyDocumentSaved]);

  const handleSaveFileAs = useCallback(async () => {
    try {
      const savedPath = await saveMarkdownFile(getEditorDocument(), null);
      if (!savedPath) {
        return;
      }

      currentFilePathRef.current = savedPath;
      setCurrentFilePath(savedPath);
      markDocumentClean();
      saveFileDocumentSession(savedPath, getEditorDocument(), false);
      notifyDocumentSaved(getEditorDocument(), savedPath);
      setStatus({ kind: "success", message: `${basename(savedPath)} を保存しました。` });
    } catch (error: unknown) {
      setStatus({ kind: "error", message: formatFileError(error) });
    }
  }, [getEditorDocument, markDocumentClean, notifyDocumentSaved]);

  useEffect(() => {
    if (!editorReady || initialSession.kind !== "file" || initialFileRestoreStartedRef.current) {
      return;
    }

    if (initialSession.dirty) {
      initialFileRestoreStartedRef.current = true;
      setStatus({ kind: "warning", message: `${basename(initialSession.path)} の未保存の編集内容を復元しました。` });
      return;
    }

    initialFileRestoreStartedRef.current = true;
    setStatus({ kind: "loading", message: `${basename(initialSession.path)} を再度開いています...` });

    reopenMarkdownFile(initialSession.path)
      .then((file) => {
        currentFilePathRef.current = file.path;
        replaceEditorDocument(file.content);
        setCurrentFilePath(file.path);
        markDocumentClean();
        saveFileDocumentSession(file.path, file.content, false);
        setStatus({ kind: "success", message: `${basename(file.path)} を再度開きました。` });
      })
      .catch((error: unknown) => {
        currentFilePathRef.current = null;
        replaceEditorDocument("");
        setCurrentFilePath(null);
        markDocumentClean();
        saveNewDocumentSession("");
        setStatus({ kind: "error", message: formatFileError(error) });
      });
  }, [editorReady, initialSession, markDocumentClean, replaceEditorDocument]);

  useEffect(() => {
    if (remoteMode) {
      return;
    }
    const handleAppShortcut = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-ignore-app-shortcuts='true']")
      ) {
        return;
      }

      const action = appShortcutFromKeyboardEvent(event);
      if (!action) {
        return;
      }

      event.preventDefault();
      if (action === "new") {
        handleNewFile();
        return;
      }
      if (action === "open") {
        void handleOpenFile();
        return;
      }
      if (action === "saveAs") {
        void handleSaveFileAs();
        return;
      }
      void handleSaveFile();
    };

    document.addEventListener("keydown", handleAppShortcut);
    return () => document.removeEventListener("keydown", handleAppShortcut);
  }, [handleNewFile, handleOpenFile, handleSaveFile, handleSaveFileAs, remoteMode]);

  return { handleNewFile, handleOpenFile, handleSaveFile, handleSaveFileAs };
}
