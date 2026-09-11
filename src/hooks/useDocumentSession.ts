import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadDocumentSession,
  saveFileDocumentSession,
  saveNewDocumentSession,
} from "../lib/documentStore";
import {
  buildDocumentVocabularyProfile,
  type DocumentVocabularyProfile,
} from "../lib/documentVocabulary";

interface DocumentSessionOptions {
  remoteMode: boolean;
  editorViewRef: RefObject<EditorView | null>;
}

export function useDocumentSession({ remoteMode, editorViewRef }: DocumentSessionOptions) {
  const [initialSession] = useState(() => {
    if (remoteMode) {
      return { kind: "new" as const, content: "" };
    }
    if (typeof localStorage === "undefined") {
      return { kind: "new" as const, content: "" };
    }
    return loadDocumentSession();
  });

  const [currentFilePath, setCurrentFilePath] = useState<string | null>(
    initialSession.kind === "file" ? initialSession.path : null,
  );

  const [isDirty, setIsDirty] = useState(
    initialSession.kind === "new"
      ? initialSession.content.length > 0
      : initialSession.dirty,
  );

  const [initialDocument] = useState(() => initialSession.content);

  const [documentVocabularyProfile, setDocumentVocabularyProfile] =
    useState<DocumentVocabularyProfile>(() =>
      buildDocumentVocabularyProfile(initialSession.content),
    );

  const currentFilePathRef = useRef<string | null>(
    initialSession.kind === "file" ? initialSession.path : null,
  );

  const isDirtyRef = useRef(
    initialSession.kind === "new" ? initialSession.content.length > 0 : initialSession.dirty,
  );

  const docVersionRef = useRef(0);
  const documentEpochRef = useRef(0);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const vocabularyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const suppressNextDirtyRef = useRef(false);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (vocabularyTimerRef.current) clearTimeout(vocabularyTimerRef.current);
  }, []);

  const persistDocumentChange = useCallback((documentText: string) => {
    docVersionRef.current += 1;
    if (suppressNextDirtyRef.current) {
      suppressNextDirtyRef.current = false;
    } else {
      isDirtyRef.current = true;
      setIsDirty(true);
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      const filePath = currentFilePathRef.current;
      if (filePath) {
        saveFileDocumentSession(filePath, documentText, isDirtyRef.current);
      } else {
        saveNewDocumentSession(documentText);
      }
      saveTimerRef.current = null;
    }, 250);

    if (vocabularyTimerRef.current) {
      clearTimeout(vocabularyTimerRef.current);
    }
    vocabularyTimerRef.current = setTimeout(() => {
      const profile = buildDocumentVocabularyProfile(documentText);
      setDocumentVocabularyProfile(profile);
      vocabularyTimerRef.current = null;
    }, 350);

  }, []);

  const getEditorDocument = useCallback(() => {
    return editorViewRef.current?.state.doc.toString() ?? "";
  }, []);

  const replaceDocumentContent = useCallback((content: string) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    documentEpochRef.current += 1;
    suppressNextDirtyRef.current = true;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
      selection: { anchor: 0 },
      userEvent: "document.open",
      annotations: Transaction.addToHistory.of(false),
    });
  }, []);

  const markDocumentClean = useCallback(() => {
    isDirtyRef.current = false;
    setIsDirty(false);
  }, []);

  const confirmDiscardUnsavedChanges = useCallback(() => {
    if (!isDirtyRef.current) {
      return true;
    }

    return window.confirm("未保存の変更があります。破棄しますか？");
  }, []);

  const saveCurrentDocumentSession = useCallback((documentText: string) => {
    const filePath = currentFilePathRef.current;
    if (filePath) {
      saveFileDocumentSession(filePath, documentText, isDirtyRef.current);
      return;
    }

    saveNewDocumentSession(documentText);
  }, []);

  const persistRemoteDocument = useCallback((documentText: string) => {
    isDirtyRef.current = true;
    setIsDirty(true);
    saveCurrentDocumentSession(documentText);
  }, [saveCurrentDocumentSession]);

  useEffect(() => {
    const persistCurrentDraft = () => {
      saveCurrentDocumentSession(getEditorDocument());
    };
    const persistWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        persistCurrentDraft();
      }
    };

    window.addEventListener("beforeunload", persistCurrentDraft);
    document.addEventListener("visibilitychange", persistWhenHidden);
    return () => {
      window.removeEventListener("beforeunload", persistCurrentDraft);
      document.removeEventListener("visibilitychange", persistWhenHidden);
    };
  }, [getEditorDocument, saveCurrentDocumentSession]);

  return {
    documentEpochRef,
    docVersionRef,
    saveCurrentDocumentSession,
    initialDocument,
    currentFilePathRef,
    setDocumentVocabularyProfile,
    replaceDocumentContent,
    persistDocumentChange,
    persistRemoteDocument,
    getEditorDocument,
    confirmDiscardUnsavedChanges,
    setCurrentFilePath,
    markDocumentClean,
    initialSession,
    currentFilePath,
    isDirty,
    documentVocabularyProfile,
  };
}
