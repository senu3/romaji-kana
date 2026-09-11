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

  const suppressNextCompanionPushRef = useRef(false);

  const companionClientIdRef = useRef(remoteMode ? createId("mobile") : "desktop");

  const remoteSettingsReadyRef = useRef(false);

  const companionSettingsPushPendingRef = useRef(false);

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
      companionSettingsPushPendingRef.current = true;
      void updateCompanionConversionSettings(
        sharedConversionSettings(settings),
        companionClientIdRef.current,
      )
        .catch((error: unknown) => {
          setStatus({
            kind: "error",
            message: `変換設定をPCへ同期できませんでした。${error instanceof Error ? error.message : String(error)}`,
          });
        })
        .finally(() => {
          companionSettingsPushPendingRef.current = false;
        });
      return;
    }
    if (companionStatusRef.current.running) {
      void updateCompanionSettings(settings, companionClientIdRef.current);
    }
  }, [remoteMode, settings]);

  useEffect(() => {
    companionStatusRef.current = companionStatus;
  }, [companionStatus]);

  useEffect(() => () => {
    if (companionPushTimerRef.current) clearTimeout(companionPushTimerRef.current);
  }, []);

  const syncDocumentChange = useCallback((documentText: string) => {
    const syncEnabled = remoteMode || companionStatusRef.current.running;
    if (!syncEnabled) {
      return;
    }
    if (suppressNextCompanionPushRef.current) {
      suppressNextCompanionPushRef.current = false;
      return;
    }
    if (companionPushTimerRef.current) {
      clearTimeout(companionPushTimerRef.current);
    }
    companionPushTimerRef.current = setTimeout(async () => {
      companionPushPendingRef.current = true;
      try {
        const snapshot = await updateCompanionDocument(
          documentText,
          remoteMode
            ? remoteFileName
            : currentFilePathRef.current
              ? basename(currentFilePathRef.current)
              : "Untitled.md",
          companionClientIdRef.current,
        );
        companionRevisionRef.current = Math.max(
          companionRevisionRef.current,
          snapshot.document.revision,
        );
      } catch (error: unknown) {
        setStatus({
          kind: "error",
          message: `スマホ連携の同期に失敗しました。${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        companionPushPendingRef.current = false;
        companionPushTimerRef.current = null;
      }
    }, COMPANION_SYNC_DELAY_MS);
  }, [remoteFileName, remoteMode]);

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
      void updateCompanionDocument(
        documentText,
        basename(savedPath),
        companionClientIdRef.current,
      ).then((snapshot) => {
        companionRevisionRef.current = Math.max(
          companionRevisionRef.current,
          snapshot.document.revision,
        );
      }).catch(() => undefined);
    }
  }, []);

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
    const poll = async () => {
      if (companionPushPendingRef.current || companionPushTimerRef.current) {
        return;
      }
      try {
        const snapshot = await getCompanionState();
        if (!disposed) {
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
