import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { defaultSettings } from "../lib/settings";
import { formatShortcutLabel, shortcutFromKeyboardEvent } from "../lib/shortcuts";
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
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutError, setShortcutError] = useState("");
  const [openAccordions, setOpenAccordions] = useState({
    triggers: false,
    punctuation: false,
  });
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

  const handleShortcutKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!capturingShortcut) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      setCapturingShortcut(false);
      setShortcutError("");
      return;
    }

    const nextShortcut = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!nextShortcut) {
      setShortcutError("Use Ctrl/Cmd, Alt, Shift with a key, or a function key.");
      return;
    }

    updateTriggers({ manualShortcut: nextShortcut });
    setCapturingShortcut(false);
    setShortcutError("");
  };

  const toggleAccordion = (section: keyof typeof openAccordions) => {
    setOpenAccordions((current) => ({
      ...current,
      [section]: !current[section],
    }));
  };

  const enabledTriggerCount = [
    settings.triggers.period,
    settings.triggers.comma,
    settings.triggers.japanesePeriod,
    settings.triggers.japaneseComma,
  ].filter(Boolean).length;
  const punctuationCount = [
    settings.punctuationConversion.periodToJapanese,
    settings.punctuationConversion.commaToJapanese,
  ].filter(Boolean).length;

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
            <div className="mode-field">
              <span>Conversion mode</span>
              <div className="segmented-control" role="group" aria-label="Conversion mode">
                <button
                  className={settings.conversionMode === "replace" ? "selected" : ""}
                  type="button"
                  onClick={() => update({ conversionMode: "replace" })}
                >
                  Auto replace
                </button>
                <button
                  className={settings.conversionMode === "ghost" ? "selected" : ""}
                  type="button"
                  onClick={() => update({ conversionMode: "ghost" })}
                >
                  Ghost + Tab
                </button>
              </div>
            </div>
            <div className="shortcut-field">
              <div>
                <span>Manual shortcut</span>
                <small>{formatShortcutLabel(settings.triggers.manualShortcut)}</small>
              </div>
              <div className="shortcut-controls">
                <button
                  className={`shortcut-recorder ${capturingShortcut ? "recording" : ""}`}
                  type="button"
                  onClick={() => {
                    setCapturingShortcut(true);
                    setShortcutError("");
                  }}
                  onKeyDown={handleShortcutKeyDown}
                  onBlur={() => setCapturingShortcut(false)}
                >
                  <Keyboard size={15} aria-hidden="true" />
                  {capturingShortcut
                    ? "Press shortcut..."
                    : formatShortcutLabel(settings.triggers.manualShortcut)}
                </button>
                <button
                  className="shortcut-reset"
                  type="button"
                  onClick={() =>
                    updateTriggers({ manualShortcut: defaultSettings.triggers.manualShortcut })
                  }
                  aria-label="Reset manual shortcut"
                  title="Reset manual shortcut"
                >
                  <RotateCcw size={15} aria-hidden="true" />
                </button>
              </div>
              <p className={`shortcut-help ${shortcutError ? "error" : ""}`}>
                {shortcutError || "Click the shortcut button, then press the keys to register."}
              </p>
            </div>
          </div>

          <AccordionSection
            title="Triggers"
            summary={`${enabledTriggerCount}/4 enabled`}
            open={openAccordions.triggers}
            onToggle={() => toggleAccordion("triggers")}
          >
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
          </AccordionSection>

          <AccordionSection
            title="Punctuation"
            summary={`${punctuationCount}/2 enabled`}
            open={openAccordions.punctuation}
            onToggle={() => toggleAccordion("punctuation")}
          >
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
          </AccordionSection>
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

function AccordionSection({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`settings-accordion ${open ? "open" : ""}`}>
      <button
        className="accordion-trigger"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span>
          <strong>{title}</strong>
          <small>{summary}</small>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? <div className="accordion-content">{children}</div> : null}
    </section>
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
