import {
  ChevronRight,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => { if (ollamaConnection.kind === "error") setDetailsOpen(true); }, [ollamaConnection.kind]);
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

          <h2 id={headingId}>モデル設定</h2>
        </div>
      </div>

      <fieldset className="field provider-field">
        <legend className="sr-only">プロバイダー</legend>
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

      <div className="field model-field">
        <label htmlFor={`${modelOptionsId}-input`}>モデル</label>
        <div className="model-combobox" onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setModelListOpen(false);
        }} onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); modelInputRef.current?.focus(); setModelListOpen(false); }
          if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          setModelListOpen(true);
          const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
          if (!options.length) return;
          const index = options.indexOf(document.activeElement as HTMLButtonElement);
          options[(index + (event.key === "ArrowDown" ? 1 : options.length - 1) + options.length) % options.length]?.focus();
        }}>
          <input
            id={`${modelOptionsId}-input`}
            ref={modelInputRef}
            value={hasProvider ? settings.modelName : ""}
            disabled={!hasProvider}
            onChange={(event) => {
              update({ modelName: event.currentTarget.value });
              setModelListOpen(true);
            }}
            onFocus={() => setModelListOpen(true)}
            onClick={() => setModelListOpen(true)}
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
                    ? ollamaConnection.kind === "checking" ? "モデルを読み込み中…" : "モデルが見つかりません。接続先を確認してください。"
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
                      modelInputRef.current?.focus();
                      setModelListOpen(false);
                    }}
                  >
                    {modelName}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className={`model-connection-row ${ollamaConnection.kind}`} role="status">
        <div>
          <strong>{connectionTitle(ollamaConnection.kind)}</strong>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="接続チェック"
          title="接続チェック"
          onClick={onCheckOllama}
          disabled={!hasProvider || ollamaConnection.kind === "checking"}
        >
          <RefreshCw
            className={ollamaConnection.kind === "checking" ? "spin" : ""}
            size={15}
            aria-hidden="true"
          />
        </button>
      </div>

      {(ollamaConnection.kind === "error" || ollamaConnection.kind === "warning") &&
        <p className="model-connection-error" role="alert">{ollamaConnection.message}</p>}
      <details className="model-details" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
        <summary>接続先・詳細設定</summary>
        <label className="field">
          <span>接続先 URL</span>
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

        <CheckRow
          label="Thinkingモード"
          checked={settings.think}
          onChange={(checked) => update({ think: checked })}
        />
        <p className="settings-help">Thinkingモードは通常オフで使います。</p>
      </details>
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
