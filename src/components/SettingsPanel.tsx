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
  onProviderSelected?: (modelProvider: ModelProvider) => void;
}

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

export function SettingsPanel({
  settings,
  ollamaModels,
  ollamaConnection,
  collapsed,
  onToggleCollapsed,
  onChange,
  onCheckOllama,
  onProviderSelected,
}: SettingsPanelProps) {
  return (
    <aside className={`settings-panel ${collapsed ? "collapsed" : ""}`}>
      <button
        className="panel-toggle"
        type="button"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? "設定を開く" : "設定を閉じる"}
      >
        {collapsed ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
      </button>

      {collapsed ? (
        <div className="collapsed-mark" aria-hidden="true">
          <SlidersHorizontal size={19} />
          <span>設定</span>
        </div>
      ) : (
        <SettingsContent
          settings={settings}
          ollamaModels={ollamaModels}
          ollamaConnection={ollamaConnection}
          onChange={onChange}
          onCheckOllama={onCheckOllama}
          onProviderSelected={onProviderSelected}
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
  onProviderSelected,
  setupModelProvider,
  headingId,
  mode = "full",
}: SettingsContentProps) {
  const [modelListOpen, setModelListOpen] = useState(false);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutError, setShortcutError] = useState("");
  const [openAccordions, setOpenAccordions] = useState({
    triggers: false,
    punctuation: false,
  });
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
      setShortcutError("Ctrl/Cmd、Alt、Shift とキーの組み合わせ、またはファンクションキーを使ってください。");
      return;
    }
    if (isReservedAppShortcut(nextShortcut)) {
      setShortcutError("そのショートカットは File 操作用に予約されています。");
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
              <h2 id={headingId}>{setupMode ? "モデル設定" : "設定"}</h2>
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
              変換結果の適用方法と自動変換の動作は、あとから設定で変更できます。
            </p>
          ) : (
            <>
              <div className="settings-group">
                <h3>変換</h3>
                <div className="mode-field">
                  <span>変換結果の適用方法</span>
                  <div
                    className="segmented-control"
                    role="group"
                    aria-label="変換結果の適用方法"
                  >
                    <button
                      className={settings.conversionMode === "replace" ? "selected" : ""}
                      type="button"
                      aria-pressed={settings.conversionMode === "replace"}
                      onClick={() => update({ conversionMode: "replace" })}
                    >
                      直接置換
                    </button>
                    <button
                      className={settings.conversionMode === "ghost" ? "selected" : ""}
                      type="button"
                      aria-pressed={settings.conversionMode === "ghost"}
                      onClick={() => update({ conversionMode: "ghost" })}
                    >
                      候補を表示
                    </button>
                  </div>
                  <small>
                    {settings.conversionMode === "ghost"
                      ? "候補をインライン表示し、Tabで確定します。"
                      : "変換後の日本語でローマ字をすぐに置き換えます。"}
                  </small>
                </div>
              </div>

              <AccordionSection
                title="自動変換"
                summary={settings.autoConvert ? `ON · ${enabledTriggerCount}/3 トリガー` : "OFF"}
                open={openAccordions.triggers}
                onToggle={() => toggleAccordion("triggers")}
              >
                <CheckRow
                  label="自動変換"
                  checked={settings.autoConvert}
                  onChange={(checked) => update({ autoConvert: checked })}
                />
                <div className={`trigger-options ${settings.autoConvert ? "" : "disabled"}`}>
                  <CheckRow
                    label="ピリオド ."
                    checked={settings.triggers.period}
                    disabled={!settings.autoConvert}
                    onChange={(checked) => updateTriggers({ period: checked })}
                  />
                  <CheckRow
                    label="カンマ ,"
                    checked={settings.triggers.comma}
                    disabled={!settings.autoConvert}
                    onChange={(checked) => updateTriggers({ comma: checked })}
                  />
                  <CheckRow
                    label="Enter（IME 変換中は無視）"
                    checked={settings.triggers.enter}
                    disabled={!settings.autoConvert}
                    onChange={(checked) => updateTriggers({ enter: checked })}
                  />
                </div>
                <div className="shortcut-field">
                  <div>
                    <span>手動ショートカット</span>
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
                        ? "ショートカットを押してください..."
                        : formatShortcutLabel(settings.triggers.manualShortcut)}
                    </button>
                    <button
                      className="shortcut-reset"
                      type="button"
                      onClick={() =>
                        updateTriggers({ manualShortcut: defaultSettings.triggers.manualShortcut })
                      }
                      aria-label="手動ショートカットをリセット"
                      title="手動ショートカットをリセット"
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                    </button>
                  </div>
                  <p className={`shortcut-help ${shortcutError ? "error" : ""}`}>
                    {shortcutError ||
                      "自動変換がオフでも手動変換は使えます。"}
                  </p>
                </div>
              </AccordionSection>

              <AccordionSection
                title="句読点"
                summary={`${punctuationCount}/2 有効`}
                open={openAccordions.punctuation}
                onToggle={() => toggleAccordion("punctuation")}
              >
                <CheckRow
                  label=". を 。へ"
                  checked={settings.punctuationConversion.periodToJapanese}
                  onChange={(checked) => updatePunctuation({ periodToJapanese: checked })}
                />
                <CheckRow
                  label=", を 、へ"
                  checked={settings.punctuationConversion.commaToJapanese}
                  onChange={(checked) => updatePunctuation({ commaToJapanese: checked })}
                />
              </AccordionSection>
            </>
          )}
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
