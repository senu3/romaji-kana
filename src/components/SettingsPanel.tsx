import { ChevronLeft, ChevronRight, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { AppSettings, OllamaConnectionStatus, OllamaModel } from "../lib/types";

interface SettingsPanelProps {
  settings: AppSettings;
  ollamaModels: OllamaModel[];
  ollamaConnection: OllamaConnectionStatus;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onChange: (settings: AppSettings) => void;
  onCheckOllama: () => void;
}

export function SettingsPanel({
  settings,
  ollamaModels,
  ollamaConnection,
  collapsed,
  onToggleCollapsed,
  onChange,
  onCheckOllama,
}: SettingsPanelProps) {
  const [modelListOpen, setModelListOpen] = useState(false);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const sortedModelNames = useMemo(
    () => ollamaModels.map((model) => model.name).sort((a, b) => a.localeCompare(b)),
    [ollamaModels],
  );

  const update = (patch: Partial<AppSettings>) => {
    onChange({ ...settings, ...patch });
  };

  const updateTriggers = (patch: Partial<AppSettings["triggers"]>) => {
    update({ triggers: { ...settings.triggers, ...patch } });
  };

  const updatePunctuation = (patch: Partial<AppSettings["punctuationConversion"]>) => {
    update({
      punctuationConversion: {
        ...settings.punctuationConversion,
        ...patch,
      },
    });
  };

  return (
    <aside className={`settings-panel ${collapsed ? "collapsed" : ""}`}>
      <button
        className="panel-toggle"
        type="button"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? "Open settings" : "Close settings"}
      >
        {collapsed ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
      </button>

      {collapsed ? (
        <div className="collapsed-mark" aria-hidden="true">
          <SlidersHorizontal size={19} />
          <span>Settings</span>
        </div>
      ) : (
        <div className="settings-content">
          <div className="settings-heading">
            <SlidersHorizontal size={20} aria-hidden="true" />
            <div>
              <p className="eyebrow">Local AI</p>
              <h2>Settings</h2>
            </div>
          </div>

          <label className="field">
            <span>Ollama API URL</span>
            <input
              value={settings.ollamaApiUrl}
              onChange={(event) => update({ ollamaApiUrl: event.currentTarget.value })}
              placeholder="http://localhost:11434"
            />
          </label>

          <div className="field model-field">
            <span>Model</span>
            <div className="model-combobox">
              <input
                ref={modelInputRef}
                value={settings.modelName}
                onChange={(event) => {
                  update({ modelName: event.currentTarget.value });
                  setModelListOpen(true);
                }}
                onFocus={() => setModelListOpen(true)}
                onClick={() => setModelListOpen(true)}
                onBlur={() => window.setTimeout(() => setModelListOpen(false), 120)}
                placeholder="gemma3"
                role="combobox"
                aria-expanded={modelListOpen}
                aria-controls="ollama-model-options"
                aria-autocomplete="list"
              />
              <button
                className="model-list-toggle"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setModelListOpen((open) => !open);
                  modelInputRef.current?.focus();
                }}
                aria-label="Show local models"
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              {modelListOpen ? (
                <div className="model-options" id="ollama-model-options" role="listbox">
                  {sortedModelNames.length === 0 ? (
                    <p>No models loaded. Run Check to refresh Ollama models.</p>
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
          </div>

          <div className={`connection-card ${ollamaConnection.kind}`}>
            <div>
              <strong>{connectionTitle(ollamaConnection.kind)}</strong>
              <p>{ollamaConnection.message}</p>
              {ollamaModels.length > 0 ? (
                <span>{ollamaModels.length} local model(s) found</span>
              ) : null}
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={onCheckOllama}
              disabled={ollamaConnection.kind === "checking"}
            >
              <RefreshCw
                className={ollamaConnection.kind === "checking" ? "spin" : ""}
                size={15}
                aria-hidden="true"
              />
              Check
            </button>
          </div>

          <div className="settings-group">
            <h3>Conversion</h3>
            <CheckRow
              label="Auto convert"
              checked={settings.autoConvert}
              onChange={(checked) => update({ autoConvert: checked })}
            />
            <CheckRow
              label="Think mode"
              checked={settings.think}
              onChange={(checked) => update({ think: checked })}
            />
          </div>

          <div className="settings-group">
            <h3>Triggers</h3>
            <CheckRow
              label="Period ."
              checked={settings.triggers.period}
              onChange={(checked) => updateTriggers({ period: checked })}
            />
            <CheckRow
              label="Comma ,"
              checked={settings.triggers.comma}
              onChange={(checked) => updateTriggers({ comma: checked })}
            />
            <CheckRow
              label="Japanese period 。"
              checked={settings.triggers.japanesePeriod}
              onChange={(checked) => updateTriggers({ japanesePeriod: checked })}
            />
            <CheckRow
              label="Japanese comma 、"
              checked={settings.triggers.japaneseComma}
              onChange={(checked) => updateTriggers({ japaneseComma: checked })}
            />
          </div>

          <div className="settings-group">
            <h3>Punctuation</h3>
            <CheckRow
              label=". to 。"
              checked={settings.punctuationConversion.periodToJapanese}
              onChange={(checked) => updatePunctuation({ periodToJapanese: checked })}
            />
            <CheckRow
              label=", to 、"
              checked={settings.punctuationConversion.commaToJapanese}
              onChange={(checked) => updatePunctuation({ commaToJapanese: checked })}
            />
          </div>

          <p className="shortcut-note">Manual conversion: Ctrl+Enter / Cmd+Enter</p>
        </div>
      )}
    </aside>
  );
}

function connectionTitle(kind: OllamaConnectionStatus["kind"]): string {
  if (kind === "checking") {
    return "Checking";
  }
  if (kind === "connected") {
    return "Connected";
  }
  if (kind === "warning") {
    return "Needs attention";
  }
  if (kind === "error") {
    return "Unavailable";
  }
  return "Not checked";
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check-row">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}
