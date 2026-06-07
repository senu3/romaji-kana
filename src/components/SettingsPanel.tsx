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
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { defaultSettings } from "../lib/settings";
import {
  formatShortcutLabel,
  isReservedAppShortcut,
  shortcutFromKeyboardEvent,
} from "../lib/shortcuts";
import type {
  AppSettings,
  ModelProvider,
  OllamaConnectionStatus,
  OllamaModel,
} from "../lib/types";

interface SettingsPanelProps {
  settings: AppSettings;
  ollamaModels: OllamaModel[];
  ollamaConnection: OllamaConnectionStatus;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onChange: (settings: AppSettings) => void;
  onCheckOllama: () => void;
}

export interface SettingsContentProps {
  settings: AppSettings;
  ollamaModels: OllamaModel[];
  ollamaConnection: OllamaConnectionStatus;
  onChange: (settings: AppSettings) => void;
  onCheckOllama: () => void;
  headingId?: string;
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
        <SettingsContent
          settings={settings}
          ollamaModels={ollamaModels}
          ollamaConnection={ollamaConnection}
          onChange={onChange}
          onCheckOllama={onCheckOllama}
        />
      )}
    </aside>
  );
}

export function SettingsContent({
  settings,
  ollamaModels,
  ollamaConnection,
  onChange,
  onCheckOllama,
  headingId,
}: SettingsContentProps) {
  const [modelListOpen, setModelListOpen] = useState(false);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutError, setShortcutError] = useState("");
  const [openAccordions, setOpenAccordions] = useState({
    triggers: false,
    punctuation: false,
  });
  const modelOptionsId = useId();
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
  const updateProvider = (modelProvider: ModelProvider) => {
    update({ modelProvider });
    setModelListOpen(false);
  };
  const updateCurrentApiUrl = (apiUrl: string) => {
    if (settings.modelProvider === "lmstudio") {
      update({ lmStudioApiUrl: apiUrl });
      return;
    }

    update({ ollamaApiUrl: apiUrl });
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
    if (isReservedAppShortcut(nextShortcut)) {
      setShortcutError("That shortcut is reserved for file actions.");
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
    settings.triggers.enter,
  ].filter(Boolean).length;
  const punctuationCount = [
    settings.punctuationConversion.periodToJapanese,
    settings.punctuationConversion.commaToJapanese,
  ].filter(Boolean).length;
  const providerName = providerLabel(settings.modelProvider);
  const currentApiUrl =
    settings.modelProvider === "lmstudio" ? settings.lmStudioApiUrl : settings.ollamaApiUrl;

  return (
    <div className="settings-content">
          <div className="settings-heading">
            <SlidersHorizontal size={20} aria-hidden="true" />
            <div>
              <p className="eyebrow">Local AI</p>
              <h2 id={headingId}>Settings</h2>
            </div>
          </div>

          <div className="field">
            <span>Provider</span>
            <div className="segmented-control provider-control" role="group" aria-label="Model provider">
              <button
                className={settings.modelProvider === "ollama" ? "selected" : ""}
                type="button"
                onClick={() => updateProvider("ollama")}
              >
                Ollama
              </button>
              <button
                className={settings.modelProvider === "lmstudio" ? "selected" : ""}
                type="button"
                onClick={() => updateProvider("lmstudio")}
              >
                LM Studio
              </button>
            </div>
          </div>

          <label className="field">
            <span>{providerName} API URL</span>
            <input
              value={currentApiUrl}
              onChange={(event) => updateCurrentApiUrl(event.currentTarget.value)}
              placeholder={
                settings.modelProvider === "lmstudio"
                  ? "http://localhost:1234"
                  : "http://localhost:11434"
              }
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
                aria-controls={modelOptionsId}
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
                <div className="model-options" id={modelOptionsId} role="listbox">
                  {sortedModelNames.length === 0 ? (
                    <p>No models loaded. Run Check to refresh {providerName} models.</p>
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
              label="Think mode"
              checked={settings.think}
              onChange={(checked) => update({ think: checked })}
            />
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
          </div>

          <AccordionSection
            title="Triggers"
            summary={settings.autoConvert ? `${enabledTriggerCount}/3 enabled` : "Auto off"}
            open={openAccordions.triggers}
            onToggle={() => toggleAccordion("triggers")}
          >
            <CheckRow
              label="Auto convert"
              checked={settings.autoConvert}
              onChange={(checked) => update({ autoConvert: checked })}
            />
            <div className={`trigger-options ${settings.autoConvert ? "" : "disabled"}`}>
              <CheckRow
                label="Period ."
                checked={settings.triggers.period}
                disabled={!settings.autoConvert}
                onChange={(checked) => updateTriggers({ period: checked })}
              />
              <CheckRow
                label="Comma ,"
                checked={settings.triggers.comma}
                disabled={!settings.autoConvert}
                onChange={(checked) => updateTriggers({ comma: checked })}
              />
              <CheckRow
                label="Enter (IME composing ignored)"
                checked={settings.triggers.enter}
                disabled={!settings.autoConvert}
                onChange={(checked) => updateTriggers({ enter: checked })}
              />
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
                  data-ignore-app-shortcuts="true"
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
                {shortcutError ||
                  "Manual conversion is available even when auto convert is off."}
              </p>
            </div>
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

function providerLabel(provider: ModelProvider): string {
  return provider === "lmstudio" ? "LM Studio" : "Ollama";
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
