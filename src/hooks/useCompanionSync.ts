import type { EditorView } from "@codemirror/view";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CompanionSnapshot,
  type CompanionStatus,
  getCompanionState,
  getCompanionStatus,
  hasRemoteCompanionToken,
  startCompanion,
  stopCompanion,
  updateCompanionConversionSettings,
  updateCompanionDocument,
  updateCompanionSettings,
} from "../lib/companion";
import { basename } from "../lib/fileSystem";
import { createId } from "../lib/id";
import { mergeSharedConversionSettings, sharedConversionSettings } from "../lib/settings";
import type { AppSettings, ConversionStatus } from "../lib/types";

const COMPANION_SYNC_DELAY_MS = 180;

const COMPANION_POLL_INTERVAL_MS = 650;

const stoppedCompanionStatus: CompanionStatus = {
  running: false,
  port: 18_321,
  urls: [],
  pairCode: null,
  pairedClients: 0,
};

interface CompanionSyncOptions {
  remoteMode: boolean;
  settings: AppSettings;
  setStatus: Dispatch<SetStateAction<ConversionStatus>>;
  currentFilePathRef: RefObject<string | null>;
  settingsRef: RefObject<AppSettings>;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  editorViewRef: RefObject<EditorView | null>;
  applyRemoteDocument: (content: string) => void;
  getEditorDocument: () => string;
  editorReady: boolean;
}

export function useCompanionSync({
  remoteMode,
  settings,
  setStatus,
  currentFilePathRef,
  settingsRef,
  setSettings,
  editorViewRef,
  applyRemoteDocument,
  getEditorDocument,
  editorReady,
}: CompanionSyncOptions) {
  const [companionStatus, setCompanionStatus] = useState<CompanionStatus>(stoppedCompanionStatus);

  const [companionBusy, setCompanionBusy] = useState(false);

  const [remoteFileName, setRemoteFileName] = useState("PCの文書");

  const companionStatusRef = useRef(companionStatus);

  const companionRevisionRef = useRef(0);

  const companionPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const companionPushPendingRef = useRef(false);

  const queuedDocumentRef = useRef<{ content: string; fileName: string } | null>(null);
  const localEditRevisionRef = useRef(0);
  const activeRef = useRef(true);

  const suppressNextCompanionPushRef = useRef(false);

  const companionClientIdRef = useRef(remoteMode ? createId("mobile") : "desktop");

  const remoteSettingsReadyRef = useRef(false);

  const companionSettingsPushPendingRef = useRef(0);
  const settingsPushChainRef = useRef<Promise<void>>(Promise.resolve());
  const settingsPushRevisionRef = useRef(0);
  const settingsSyncFailedRef = useRef(false);

  const suppressNextCompanionSettingsPushRef = useRef(false);

  useEffect(() => {

    if (remoteMode) {
      if (!remoteSettingsReadyRef.current) {
        return;
      }
      if (suppressNextCompanionSettingsPushRef.current) {
        suppressNextCompanionSettingsPushRef.current = false;
        return;
      }
    } else if (!companionStatusRef.current.running) {
      return;
    }
    companionSettingsPushPendingRef.current += 1;
    const settingsRevision = ++settingsPushRevisionRef.current;
    settingsSyncFailedRef.current = false;
    settingsPushChainRef.current = settingsPushChainRef.current
      .then(async () => {
        if (!activeRef.current) return;
        if (remoteMode) {
          await updateCompanionConversionSettings(sharedConversionSettings(settings), companionClientIdRef.current);
        } else {
          await updateCompanionSettings(settings, companionClientIdRef.current);
        }
      })
      .catch((error: unknown) => {
        if (!activeRef.current) return;
        if (settingsRevision === settingsPushRevisionRef.current) settingsSyncFailedRef.current = true;
        setStatus({
          kind: "error",
          message: `${remoteMode ? "変換設定をPCへ同期できませんでした。" : "変換設定をスマホ連携へ反映できませんでした。"}${error instanceof Error ? error.message : String(error)}`,
        });
      })
      .finally(() => {
        companionSettingsPushPendingRef.current -= 1;
      });
  }, [remoteMode, settings]);

  useEffect(() => {
    companionStatusRef.current = companionStatus;
  }, [companionStatus]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (companionPushTimerRef.current) clearTimeout(companionPushTimerRef.current);
      companionPushTimerRef.current = null;
      queuedDocumentRef.current = null;
    };
  }, []);

  // Only one PUT may run at a time; retain the newest edit while that request is in flight.
  const flushDocumentPush = useCallback(async function pushNextDocument() {
    if (!activeRef.current || companionPushPendingRef.current || !queuedDocumentRef.current) return;
    const next = queuedDocumentRef.current;
    queuedDocumentRef.current = null;
    companionPushPendingRef.current = true;
    let succeeded = false;
    try {
      const snapshot = await updateCompanionDocument(
        next.content, next.fileName, companionClientIdRef.current,
      );
      companionRevisionRef.current = Math.max(companionRevisionRef.current, snapshot.document.revision);
      succeeded = true;
    } catch (error: unknown) {
      if (!activeRef.current) return;
      // Keep unsent local content protected from polling until a subsequent edit/save retries it.
      queuedDocumentRef.current ??= next;
      setStatus({
        kind: "error",
        message: `スマホ連携の同期に失敗しました。${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      companionPushPendingRef.current = false;
      if (succeeded && !companionPushTimerRef.current) void pushNextDocument();
    }
  }, [setStatus]);

  const syncDocumentChange = useCallback((documentText: string) => {
    const syncEnabled = remoteMode || companionStatusRef.current.running;
    if (!syncEnabled) {
      return;
    }
    if (suppressNextCompanionPushRef.current) {
      suppressNextCompanionPushRef.current = false;
      return;
    }
    localEditRevisionRef.current += 1;
    queuedDocumentRef.current = {
      content: documentText,
      fileName: remoteMode
        ? remoteFileName
        : currentFilePathRef.current ? basename(currentFilePathRef.current) : "Untitled.md",
    };
    if (companionPushTimerRef.current) {
      clearTimeout(companionPushTimerRef.current);
    }
    companionPushTimerRef.current = setTimeout(() => {
      companionPushTimerRef.current = null;
      void flushDocumentPush();
    }, COMPANION_SYNC_DELAY_MS);
  }, [remoteFileName, remoteMode, flushDocumentPush]);

  const applyCompanionSnapshot = useCallback((snapshot: CompanionSnapshot) => {
    if (remoteMode) {
      remoteSettingsReadyRef.current = true;
      if (
        !companionSettingsPushPendingRef.current &&
        JSON.stringify(snapshot.settings) !== JSON.stringify(settingsRef.current)
      ) {
        suppressNextCompanionSettingsPushRef.current = true;
        setSettings(snapshot.settings);
      }
    } else if (snapshot.settingsUpdatedBy !== companionClientIdRef.current) {
      const nextSettings = mergeSharedConversionSettings(
        settingsRef.current,
        sharedConversionSettings(snapshot.settings),
      );
      if (JSON.stringify(nextSettings) !== JSON.stringify(settingsRef.current)) {
        setSettings(nextSettings);
      }
    }
    if (remoteMode) {
      setRemoteFileName(snapshot.document.fileName || "PCの文書");
    }
    if (snapshot.document.revision <= companionRevisionRef.current) {
      return;
    }

    companionRevisionRef.current = snapshot.document.revision;
    const currentContent = editorViewRef.current?.state.doc.toString() ?? "";
    if (snapshot.document.content === currentContent) {
      return;
    }
    suppressNextCompanionPushRef.current = true;
    applyRemoteDocument(snapshot.document.content);
    setStatus({
      kind: "success",
      message: remoteMode
        ? "PCの文書を同期しました。"
        : "スマホからの変更を反映しました。保存するとファイルへ書き込まれます。",
    });
  }, [remoteMode, applyRemoteDocument]);

  const notifyDocumentSaved = useCallback((documentText: string, savedPath: string) => {
    if (companionStatusRef.current.running) {
      localEditRevisionRef.current += 1;
      if (companionPushTimerRef.current) clearTimeout(companionPushTimerRef.current);
      companionPushTimerRef.current = null;
      queuedDocumentRef.current = { content: documentText, fileName: basename(savedPath) };
      void flushDocumentPush();
    }
  }, [flushDocumentPush]);

  const handleStartCompanion = useCallback(async () => {
    setCompanionBusy(true);
    try {
      const nextStatus = await startCompanion(
        getEditorDocument(),
        currentFilePathRef.current ? basename(currentFilePathRef.current) : "Untitled.md",
        settingsRef.current,
      );
      companionRevisionRef.current = 0;
      setCompanionStatus(nextStatus);
      setStatus({
        kind: "success",
        message: "スマホ連携を開始しました。同じWi-Fiのスマホで接続URLを開いてください。",
      });
    } catch (error: unknown) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCompanionBusy(false);
    }
  }, [getEditorDocument]);

  const handleStopCompanion = useCallback(async () => {
    setCompanionBusy(true);
    try {
      setCompanionStatus(await stopCompanion());
      setStatus({ kind: "success", message: "スマホ連携を停止しました。" });
    } catch (error: unknown) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCompanionBusy(false);
    }
  }, []);

  useEffect(() => {
    if (remoteMode) {
      return;
    }
    const refreshStatus = () => {
      void getCompanionStatus().then(setCompanionStatus).catch(() => undefined);
    };
    refreshStatus();
    if (!companionStatus.running) {
      return;
    }
    const interval = window.setInterval(refreshStatus, 2_000);
    return () => window.clearInterval(interval);
  }, [companionStatus.running, remoteMode]);

  useEffect(() => {
    if (!editorReady || (!remoteMode && !companionStatus.running)) {
      return;
    }

    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (
        polling || companionPushPendingRef.current || companionPushTimerRef.current ||
        queuedDocumentRef.current || companionSettingsPushPendingRef.current || settingsSyncFailedRef.current
      ) {
        return;
      }
      polling = true;
      const editRevision = localEditRevisionRef.current;
      const requestedSettings = settingsRef.current;
      try {
        const snapshot = await getCompanionState();
        if (
          !disposed && editRevision === localEditRevisionRef.current &&
          requestedSettings === settingsRef.current &&
          !companionPushPendingRef.current && !companionPushTimerRef.current &&
          !queuedDocumentRef.current && !companionSettingsPushPendingRef.current && !settingsSyncFailedRef.current
        ) {
          applyCompanionSnapshot(snapshot);
        }
      } catch (error: unknown) {
        if (disposed) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ kind: "error", message: `PCとの同期が止まりました。${message}` });
        if (remoteMode && !hasRemoteCompanionToken()) {
          window.location.reload();
        }
      } finally {
        polling = false;
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), COMPANION_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [applyCompanionSnapshot, companionStatus.running, editorReady, remoteMode]);

  return {
    syncDocumentChange,
    notifyDocumentSaved,
    remoteFileName,
    companionStatus,
    companionBusy,
    handleStartCompanion,
    handleStopCompanion,
  };
}
