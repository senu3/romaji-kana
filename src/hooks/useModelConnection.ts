import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatOllamaConnectionError } from "../lib/appErrors";
import { providerLabel } from "../lib/ollama";
import { checkOllamaConnection, listLocalModels } from "../lib/ollamaConnection";
import { defaultSettings } from "../lib/settings";
import type {
  AppSettings,
  ConversionStatus,
  ModelProvider,
  OllamaConnectionStatus,
  OllamaModel,
} from "../lib/types";

const AUTO_CONNECTION_CHECK_DELAY_MS = 550;

interface ModelConnectionOptions {
  setupComplete: boolean;
  setupCompleteRef: RefObject<boolean>;
  settings: AppSettings;
  settingsRef: RefObject<AppSettings>;
  setStatus: Dispatch<SetStateAction<ConversionStatus>>;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  remoteMode: boolean;
}

export function useModelConnection({
  setupComplete,
  setupCompleteRef,
  settings,
  settingsRef,
  setStatus,
  setSettings,
  remoteMode,
}: ModelConnectionOptions) {
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);

  const [ollamaConnection, setOllamaConnection] = useState<OllamaConnectionStatus>({
    kind: "idle",
    message: "ローカルモデルプロバイダーはまだ確認されていません。",
  });

  const [setupModelProvider, setSetupModelProvider] = useState<ModelProvider | null>(() => null);

  const connectionCheckIdRef = useRef(0);

  const startupCheckStartedRef = useRef(false);

  const previousModelProviderRef = useRef(settings.modelProvider);

  const handleCheckOllama = useCallback(async () => {
    const checkId = connectionCheckIdRef.current + 1;
    connectionCheckIdRef.current = checkId;
    const modelName = settingsRef.current.modelName.trim() || "選択中のモデル";
    const label = providerLabel(settingsRef.current);

    setOllamaConnection({
      kind: "checking",
      message: `${label} を確認し、${modelName} を読み込んでいます...`,
    });
    setStatus({
      kind: "loading",
      message: `${label} を確認し、${modelName} を読み込んでいます...`,
    });

    try {
      const result = await checkOllamaConnection(settingsRef.current);
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      setOllamaModels(result.models);
      const currentModelName = settingsRef.current.modelName.trim();
      const shouldAutoSelectModel =
        setupCompleteRef.current &&
        Boolean(result.suggestedModelName) &&
        result.kind === "warning" &&
        (!currentModelName || currentModelName === defaultSettings.modelName);

      if (shouldAutoSelectModel) {
        setSettings((value) => ({
          ...value,
          modelName: result.suggestedModelName ?? value.modelName,
        }));
        setOllamaConnection({
          kind: "checking",
          message: `"${result.suggestedModelName}" を選択しました。モデルを確認しています...`,
        });
        setStatus({
          kind: "loading",
          message: `"${result.suggestedModelName}" を選択しました。モデルを確認しています...`,
        });
        return;
      }

      setOllamaConnection({
        kind: result.kind,
        message: result.message,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: result.kind === "connected" ? "success" : "warning",
        message: result.message,
      });
    } catch (error: unknown) {
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      const message = formatOllamaConnectionError(error, providerLabel(settingsRef.current));
      setOllamaModels([]);
      setOllamaConnection({
        kind: "error",
        message,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: "error",
        message,
      });
    }
  }, []);

  const handleSetupProviderSelected = useCallback(async (modelProvider: ModelProvider) => {
    if (setupCompleteRef.current) {
      return;
    }

    setSetupModelProvider(modelProvider);
    const checkId = connectionCheckIdRef.current + 1;
    connectionCheckIdRef.current = checkId;
    const nextSettings = { ...settingsRef.current, modelProvider };
    const label = providerLabel(nextSettings);

    setOllamaModels([]);
    setOllamaConnection({
      kind: "checking",
      message: `${label} のモデルを読み込んでいます...`,
    });
    setStatus({
      kind: "loading",
      message: `${label} のモデルを読み込んでいます...`,
    });

    try {
      const models = await listLocalModels(nextSettings);
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      setOllamaModels(models);
      setOllamaConnection({
        kind: models.length > 0 ? "warning" : "idle",
        message:
          models.length > 0
            ? `${label} のモデルを ${models.length} 件読み込みました。モデルを選んで接続チェックしてください。`
            : `${label} に接続しましたが、ローカルモデルが見つかりませんでした。`,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: models.length > 0 ? "warning" : "idle",
        message:
          models.length > 0
            ? "モデルを選択し、接続チェックを実行するとセットアップが完了します。"
            : `${label} のモデルが見つかりませんでした。`,
      });
    } catch (error: unknown) {
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      const message = formatOllamaConnectionError(error, label);
      setOllamaModels([]);
      setOllamaConnection({
        kind: "error",
        message,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: "error",
        message,
      });
    }
  }, []);

  const handleModelSettingsProviderSelected = useCallback(async (modelProvider: ModelProvider) => {
    const checkId = connectionCheckIdRef.current + 1;
    connectionCheckIdRef.current = checkId;
    const nextSettings = { ...settingsRef.current, modelProvider };
    const label = providerLabel(nextSettings);

    setOllamaModels([]);
    setOllamaConnection({
      kind: "checking",
      message: `${label} のモデルを読み込んでいます...`,
    });
    setStatus({
      kind: "loading",
      message: `${label} のモデルを読み込んでいます...`,
    });

    try {
      const models = await listLocalModels(nextSettings);
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      setOllamaModels(models);
      setOllamaConnection({
        kind: models.length > 0 ? "warning" : "idle",
        message:
          models.length > 0
            ? `${label} のモデルを ${models.length} 件読み込みました。モデルを選んで接続チェックしてください。`
            : `${label} に接続しましたが、ローカルモデルが見つかりませんでした。`,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: models.length > 0 ? "warning" : "idle",
        message:
          models.length > 0
            ? "モデルを選択し、接続チェックを実行すると設定を確認できます。"
            : `${label} のモデルが見つかりませんでした。`,
      });
    } catch (error: unknown) {
      if (connectionCheckIdRef.current !== checkId) {
        return;
      }

      const message = formatOllamaConnectionError(error, label);
      setOllamaModels([]);
      setOllamaConnection({
        kind: "error",
        message,
        checkedAt: Date.now(),
      });
      setStatus({
        kind: "error",
        message,
      });
    }
  }, []);

  useEffect(() => {
    if (remoteMode) {
      startupCheckStartedRef.current = true;
      setOllamaConnection({
        kind: "connected",
        message: "PC経由でローカルモデルに接続しています。",
        checkedAt: Date.now(),
      });
      return;
    }

    const providerChanged = previousModelProviderRef.current !== settings.modelProvider;
    previousModelProviderRef.current = settings.modelProvider;

    if (providerChanged) {
      setOllamaModels([]);
    }

    if (!setupComplete) {
      startupCheckStartedRef.current = false;
      if (setupModelProvider) {
        return;
      }

      setOllamaConnection({
        kind: "idle",
        message: "プロバイダーを選択するとローカルモデル一覧を読み込みます。",
      });
      setStatus({
        kind: "idle",
        message: "プロバイダーを選ぶとモデル一覧を読み込みます。入力は今すぐ可能です。",
      });
      return;
    }

    if (!startupCheckStartedRef.current && ollamaConnection.kind === "connected") {
      startupCheckStartedRef.current = true;
      return;
    }

    if (startupCheckStartedRef.current) {
      const timeout = window.setTimeout(
        () => void handleCheckOllama(),
        providerChanged ? 0 : AUTO_CONNECTION_CHECK_DELAY_MS,
      );
      return () => window.clearTimeout(timeout);
    }

    startupCheckStartedRef.current = true;
    void handleCheckOllama();
  }, [
    settings.modelProvider,
    settings.modelName,
    settings.ollamaApiUrl,
    settings.lmStudioApiUrl,
    setupComplete,
    setupModelProvider,
    handleCheckOllama,
    remoteMode,
  ]);

  return {
    ollamaConnection,
    setupModelProvider,
    ollamaModels,
    handleCheckOllama,
    handleModelSettingsProviderSelected,
    handleSetupProviderSelected,
  };
}
