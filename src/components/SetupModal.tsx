import { RotateCcw, X } from "lucide-react";
import type { AppSettings, ModelProvider, OllamaConnectionStatus, OllamaModel } from "../lib/types";

export function SetupModal({
  mode = "setup",
  settings,
  ollamaModels,
  ollamaConnection,
  setupModelProvider,
  onChange,
  onCheckOllama,
  onProviderSelected,
  onComplete,
  onSkip,
}: {
  mode?: "setup" | "settings";
  settings: AppSettings;
  ollamaModels: OllamaModel[];
  ollamaConnection: OllamaConnectionStatus;
  setupModelProvider: ModelProvider | null;
  onChange: (settings: AppSettings) => void;
  onCheckOllama: () => void;
  onProviderSelected: (modelProvider: ModelProvider) => void;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const isSetupMode = mode === "setup";
  const activeModelProvider = isSetupMode ? setupModelProvider : settings.modelProvider;
  const hasProvider = Boolean(activeModelProvider);
  const currentApiUrl =
    activeModelProvider === "lmstudio"
      ? settings.lmStudioApiUrl
      : activeModelProvider === "ollama"
        ? settings.ollamaApiUrl
        : "";
  const sortedModelNames = ollamaModels
    .map((model) => model.name)
    .sort((a, b) => a.localeCompare(b));

  const updateProvider = (modelProvider: ModelProvider) => {
    onChange({ ...settings, modelProvider });
    onProviderSelected(modelProvider);
  };

  const updateApiUrl = (apiUrl: string) => {
    if (activeModelProvider === "lmstudio") {
      onChange({ ...settings, lmStudioApiUrl: apiUrl });
      return;
    }
    if (activeModelProvider === "ollama") {
      onChange({ ...settings, ollamaApiUrl: apiUrl });
    }
  };

  return (
    <div className="settings-overlay setup-overlay">
      <section
        className="setup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-modal-title"
      >
        <header className="setup-modal-header">
          <div>
            <h2 id="setup-modal-title">
              {isSetupMode ? "最初のモデル設定" : "モデル設定"}
            </h2>
            <p>ローカル LLM の接続先とモデルを設定します。</p>
          </div>
          <button className="icon-button" type="button" onClick={onSkip} aria-label="モデル設定を閉じる">
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="setup-form">
          <fieldset className="field provider-field">
            <legend>プロバイダー</legend>
            <div className="segmented-control provider-control" role="radiogroup" aria-label="モデルプロバイダー">
              <label className={activeModelProvider === "ollama" ? "selected" : ""}>
                <input
                  type="radio"
                  name={`${mode}-provider`}
                  value="ollama"
                  checked={activeModelProvider === "ollama"}
                  onChange={() => updateProvider("ollama")}
                />
                <span>Ollama</span>
              </label>
              <label className={activeModelProvider === "lmstudio" ? "selected" : ""}>
                <input
                  type="radio"
                  name={`${mode}-provider`}
                  value="lmstudio"
                  checked={activeModelProvider === "lmstudio"}
                  onChange={() => updateProvider("lmstudio")}
                />
                <span>LM Studio</span>
              </label>
            </div>
          </fieldset>

          <label className="field">
            <span>API URL</span>
            <div className="setup-inline-control">
              <input
                value={currentApiUrl}
                disabled={!hasProvider}
                onChange={(event) => updateApiUrl(event.currentTarget.value)}
                placeholder={
                  activeModelProvider === "lmstudio"
                    ? "http://localhost:1234"
                    : activeModelProvider === "ollama"
                      ? "http://localhost:11434"
                      : "プロバイダーを選択してください"
                }
              />
              <button
                className="secondary-button"
                type="button"
                onClick={onCheckOllama}
                disabled={!hasProvider || ollamaConnection.kind === "checking"}
              >
                接続チェック
              </button>
            </div>
            <small>通常は localhost の既定URLのままで問題ありません。</small>
          </label>

          <label className="field">
            <span>モデル</span>
            <div className="setup-inline-control setup-model-row">
              <select
                value={hasProvider ? settings.modelName : ""}
                disabled={!hasProvider}
                onChange={(event) => onChange({ ...settings, modelName: event.currentTarget.value })}
              >
                <option value="">モデルを選択...</option>
                {sortedModelNames.map((modelName) => (
                  <option value={modelName} key={modelName}>{modelName}</option>
                ))}
              </select>
              <button
                className="icon-button setup-refresh"
                type="button"
                onClick={onCheckOllama}
                disabled={!hasProvider || ollamaConnection.kind === "checking"}
                aria-label="モデル一覧を更新"
              >
                <RotateCcw size={18} aria-hidden="true" />
              </button>
            </div>
          </label>

          <p className={`setup-connection-line ${ollamaConnection.kind}`}>
            <span aria-hidden="true" />
            {hasProvider ? ollamaConnection.message : "未接続"}
          </p>
        </div>
        <div className="setup-actions">
          <button className="secondary-button" type="button" onClick={onSkip}>
            {isSetupMode ? "あとで設定" : "キャンセル"}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={onComplete}
          >
            {isSetupMode ? "書き始める" : "完了"}
          </button>
        </div>
      </section>
    </div>
  );
}
