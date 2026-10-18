import {
  ChevronRight,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  ModelProvider,
  OllamaConnectionStatus,
  OllamaModel,
} from "../lib/types";

type SettingsContentMode = "full" | "setup";

export interface SettingsContentProps {
  settings: AppSettings;
  ollamaModels: OllamaModel[];
  ollamaConnection: OllamaConnectionStatus;
  onChange: (settings: AppSettings) => void;
  onCheckOllama: () => void;
  onProviderSelected?: (modelProvider: ModelProvider) => void;
  setupModelProvider?: ModelProvider | null;
  headingId?: string;
  mode?: SettingsContentMode;
}

export function SettingsContent({
  settings,
  ollamaModels,
  ollamaConnection,
  onChange,
  onCheckOllama,
  onProviderSelected,
  setupModelProvider,
  headingId,
  mode = "full",
}: SettingsContentProps) {
  const [modelListOpen, setModelListOpen] = useState(false);
  const modelOptionsId = useId();
  const providerRadioName = `${useId()}-provider`;
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const sortedModelNames = useMemo(
    () => ollamaModels.map((model) => model.name).sort((a, b) => a.localeCompare(b)),
    [ollamaModels],
  );

  const update = (patch: Partial<AppSettings>) => {
    onChange({ ...settings, ...patch });
  };

  const updateProvider = (modelProvider: ModelProvider) => {
    update({ modelProvider });
    onProviderSelected?.(modelProvider);
    setModelListOpen(false);
  };
  const setupMode = mode === "setup";
  const activeProvider = setupMode ? setupModelProvider : settings.modelProvider;
  const hasProvider = Boolean(activeProvider);

  const updateCurrentApiUrl = (apiUrl: string) => {
    if (!activeProvider) {
      return;
    }

    if (activeProvider === "lmstudio") {
      update({ lmStudioApiUrl: apiUrl });
      return;
    }

    update({ ollamaApiUrl: apiUrl });
  };

  const providerName = activeProvider ? providerLabel(activeProvider) : "プロバイダー";
  const currentApiUrl =
    activeProvider === "lmstudio"
      ? settings.lmStudioApiUrl
      : activeProvider === "ollama"
        ? settings.ollamaApiUrl
        : "";

  return (
    <div className="settings-content">
      <div className="settings-heading">
        <SlidersHorizontal size={20} aria-hidden="true" />
        <div>
          <p className="eyebrow">ローカルAI</p>
          <h2 id={headingId}>モデル設定</h2>
        </div>
      </div>

      <fieldset className="field provider-field">
        <legend>プロバイダー</legend>
        <div className="segmented-control provider-control" role="radiogroup" aria-label="モデルプロバイダー">
          <label className={activeProvider === "ollama" ? "selected" : ""}>
            <input
              type="radio"
              name={providerRadioName}
              value="ollama"
              checked={activeProvider === "ollama"}
              onChange={() => updateProvider("ollama")}
            />
            <span>Ollama</span>
          </label>
          <label className={activeProvider === "lmstudio" ? "selected" : ""}>
            <input
              type="radio"
              name={providerRadioName}
              value="lmstudio"
              checked={activeProvider === "lmstudio"}
              onChange={() => updateProvider("lmstudio")}
            />
            <span>LM Studio</span>
          </label>
        </div>
      </fieldset>

      <label className="field">
        <span>{providerName} API URL</span>
        <input
          value={currentApiUrl}
          disabled={!hasProvider}
          onChange={(event) => updateCurrentApiUrl(event.currentTarget.value)}
          placeholder={
            activeProvider === "lmstudio"
              ? "http://localhost:1234"
              : activeProvider === "ollama"
                ? "http://localhost:11434"
                : "プロバイダーを選択してください"
          }
        />
      </label>

      <div className="field model-field">
        <span>モデル</span>
        <div className="model-combobox">
          <input
            ref={modelInputRef}
            value={hasProvider ? settings.modelName : ""}
            disabled={!hasProvider}
            onChange={(event) => {
              update({ modelName: event.currentTarget.value });
              setModelListOpen(true);
            }}
            onFocus={() => setModelListOpen(true)}
            onClick={() => setModelListOpen(true)}
            onBlur={() => window.setTimeout(() => setModelListOpen(false), 120)}
            placeholder={hasProvider ? "gemma3" : "プロバイダーを選択してください"}
            role="combobox"
            aria-expanded={modelListOpen}
            aria-controls={modelOptionsId}
            aria-autocomplete="list"
          />
          <button
            className="model-list-toggle"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            disabled={!hasProvider}
            onClick={() => {
              setModelListOpen((open) => !open);
              modelInputRef.current?.focus();
            }}
            aria-label="ローカルモデルを表示"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          {modelListOpen ? (
            <div className="model-options" id={modelOptionsId} role="listbox">
              {sortedModelNames.length === 0 ? (
                <p>
                  {hasProvider
                    ? `${providerName} のモデルを読み込んでいます。見つからない場合は接続チェックで再確認できます。`
                    : "プロバイダーを選択するとモデル一覧を読み込みます。"}
                </p>
              ) : (
                sortedModelNames.map((modelName) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={settings.modelName === modelName}
                    className={settings.modelName === modelName ? "selected" : ""}
                    key={modelName}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      update({ modelName });
                      setModelListOpen(false);
                      modelInputRef.current?.focus();
                    }}
                  >
                    {modelName}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
        <CheckRow
          label={settings.think ? "Thinkingモード" : "Thinkingモード（OFF推奨）"}
          checked={settings.think}
          onChange={(checked) => update({ think: checked })}
        />
      </div>

      <div className={`connection-card ${ollamaConnection.kind}`}>
        <div>
          <strong>{connectionTitle(ollamaConnection.kind)}</strong>
          <p>{ollamaConnection.message}</p>
          {ollamaModels.length > 0 ? (
            <span>{ollamaModels.length} 件のローカルモデル</span>
          ) : null}
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={onCheckOllama}
          disabled={!hasProvider || ollamaConnection.kind === "checking"}
        >
          <RefreshCw
            className={ollamaConnection.kind === "checking" ? "spin" : ""}
            size={15}
            aria-hidden="true"
          />
          接続チェック
        </button>
      </div>

      {setupMode ? (
        <p className="setup-settings-note">
          変換結果の適用方法や自動変換は、あとから「変換」で変更できます。
        </p>
      ) : null}
    </div>
  );
}

function connectionTitle(kind: OllamaConnectionStatus["kind"]): string {
  if (kind === "checking") {
    return "確認中";
  }
  if (kind === "connected") {
    return "接続済み";
  }
  if (kind === "warning") {
    return "確認が必要";
  }
  if (kind === "error") {
    return "利用不可";
  }
  return "未確認";
}

function providerLabel(provider: ModelProvider): string {
  return provider === "lmstudio" ? "LM Studio" : "Ollama";
}

function CheckRow({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`check-row ${disabled ? "disabled" : ""}`}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}
