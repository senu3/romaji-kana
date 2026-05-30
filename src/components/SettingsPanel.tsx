import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import type { AppSettings } from "../lib/types";

interface SettingsPanelProps {
  settings: AppSettings;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onChange: (settings: AppSettings) => void;
}

export function SettingsPanel({
  settings,
  collapsed,
  onToggleCollapsed,
  onChange,
}: SettingsPanelProps) {
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

          <label className="field">
            <span>Model</span>
            <input
              value={settings.modelName}
              onChange={(event) => update({ modelName: event.currentTarget.value })}
              placeholder="gemma3"
            />
          </label>

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
