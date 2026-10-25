import { X } from "lucide-react";
import { SettingsContent } from "./SettingsPanel";
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
          </div>
          <button className="icon-button" type="button" onClick={onSkip} aria-label="モデル設定を閉じる">
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <SettingsContent settings={settings} ollamaModels={ollamaModels} ollamaConnection={ollamaConnection}
          setupModelProvider={setupModelProvider} mode={isSetupMode ? "setup" : "full"}
          onChange={onChange} onCheckOllama={onCheckOllama} onProviderSelected={onProviderSelected} />
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
