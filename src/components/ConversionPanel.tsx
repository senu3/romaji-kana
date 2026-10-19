import { ChevronDown, Keyboard, RotateCcw } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useId,
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
  InputPauseTiming,
} from "../lib/types";

const INPUT_PAUSE_TIMING_OPTIONS: InputPauseTiming[] = [
  "early",
  "auto",
  "deliberate",
];
const INPUT_PAUSE_TIMING_LABELS: Record<InputPauseTiming, string> = {
  early: "早め",
  auto: "自動",
  deliberate: "長め",
};

interface ConversionPanelProps {
  settings: AppSettings;
  remoteMode: boolean;
  onChange: (settings: AppSettings) => void;
  onResetPrompt: () => void;
}

export function ConversionPanel({
  settings,
  remoteMode,
  onChange,
  onResetPrompt,
}: ConversionPanelProps) {
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutError, setShortcutError] = useState("");
  const [openAccordions, setOpenAccordions] = useState({
    triggers: false,
    details: false,
  });
  const resultHeadingId = useId();
  const startHeadingId = useId();

  const update = (patch: Partial<AppSettings>) => {
    onChange({ ...settings, ...patch, });
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

  const toggleAccordion = (section: keyof typeof openAccordions) => {
    setOpenAccordions((current) => ({
      ...current,
      [section]: !current[section],
    }));
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
      setShortcutError("そのショートカットはファイル操作に予約されています。");
      return;
    }

    updateTriggers({ manualShortcut: nextShortcut });
    setCapturingShortcut(false);
    setShortcutError("");
  };

  const enabledKeys = [
    settings.triggers.space && "Space",
    settings.triggers.period && "ピリオド",
    settings.triggers.comma && "カンマ",
    settings.triggers.enter && "Enter",
  ].filter(Boolean).join("・");
  const punctuationSummary = [
    settings.punctuationConversion.periodToJapanese && ". → 。",
    settings.punctuationConversion.commaToJapanese && ", → 、",
  ].filter(Boolean).join(" / ") || "句読点の置換なし";

  return (
    <section className="floating-panel prompt-panel conversion-panel" aria-label="変換設定">
      <div className="conversion-panel-content">
        <section className="settings-group conversion-start-settings" aria-labelledby={startHeadingId}>
          <h3 id={startHeadingId}>変換の開始</h3>
          <CheckRow
            label="自動変換"
            checked={settings.autoConvert}
            onChange={(checked) => update({ autoConvert: checked })}
          />
          <div className={`trigger-options ${settings.autoConvert ? "" : "disabled"}`}>
            <CheckRow
              label="入力が止まったら変換"
              checked={settings.triggers.typing ?? settings.triggers.space}
              disabled={!settings.autoConvert}
              onChange={(checked) => updateTriggers({ typing: checked })}
            />
            <div
              className={`mode-field compact-mode-field input-pause-field ${settings.autoConvert && (settings.triggers.typing ?? settings.triggers.space) ? "" : "disabled"
                }`}
            >
              <span>入力停止後の待ち時間</span>
              <div
                className="segmented-control"
                role="radiogroup"
                aria-label="入力停止後の待ち時間"
              >
                {INPUT_PAUSE_TIMING_OPTIONS.map((option) => (
                  <label
                    className={settings.inputPauseTiming === option ? "selected" : ""}
                    key={option}
                  >
                    <input
                      type="radio"
                      name="input-pause-timing"
                      value={option}
                      checked={settings.inputPauseTiming === option}
                      disabled={!settings.autoConvert || !(settings.triggers.typing ?? settings.triggers.space)}
                      onChange={() => update({ inputPauseTiming: option })}
                    />
                    <span>{INPUT_PAUSE_TIMING_LABELS[option]}</span>
                  </label>
                ))}
              </div>
              <small>{inputPauseTimingDescription(settings.inputPauseTiming)}</small>
            </div>
          </div>
        </section>

        <section className="settings-group conversion-result-settings" aria-labelledby={resultHeadingId}>
          <h3 id={resultHeadingId}>結果の適用</h3>
          <div className="mode-field">
            <span>適用方法</span>
            <div className="segmented-control" role="group" aria-label="変換結果の適用方法">
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
                確認して確定
              </button>
            </div>
            <small>
              {settings.conversionMode === "ghost"
                ? "候補パネルで確認し、Tabまたは確定ボタンで本文に反映します。"
                : "変換後の日本語ですぐに置き換えます。"}
            </small>
          </div>
          <p className="panel-note">誤字修正・推測・読み未確認の候補は、どちらの設定でも確認して確定します。</p>
        </section>

        <AccordionSection
          title="キー操作"
          summary={settings.autoConvert ? enabledKeys || "手動ショートカットのみ" : "自動変換はオフ"}
          open={openAccordions.triggers}
          onToggle={() => toggleAccordion("triggers")}
        >
          <div className={`trigger-options ${settings.autoConvert ? "" : "disabled"}`}>
            <CheckRow
              label="Spaceで変換"
              checked={settings.triggers.space}
              disabled={!settings.autoConvert}
              onChange={(checked) => updateTriggers({ space: checked })}
            />
            <CheckRow
              label="ピリオド（.）で変換"
              checked={settings.triggers.period}
              disabled={!settings.autoConvert}
              onChange={(checked) => updateTriggers({ period: checked })}
            />
            <CheckRow
              label="カンマ（,）で変換"
              checked={settings.triggers.comma}
              disabled={!settings.autoConvert}
              onChange={(checked) => updateTriggers({ comma: checked })}
            />
            <CheckRow
              label="Enterで変換"
              checked={settings.triggers.enter}
              disabled={!settings.autoConvert}
              onChange={(checked) => updateTriggers({ enter: checked })}
            />
          </div>
          <p className="panel-note">日本語IMEで文字を変換している間は、Enterによる変換を行いません。</p>
          {!remoteMode ? (
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
                {shortcutError || "自動変換がオフでも手動変換は使えます。"}
              </p>
            </div>
          ) : null}
        </AccordionSection>

        <AccordionSection
          title="詳細設定"
          summary={punctuationSummary}
          open={openAccordions.details}
          onToggle={() => toggleAccordion("details")}
        >
          <h4 className="conversion-detail-heading">句読点の置換</h4>
          <CheckRow
            label=". を 。に置き換える"
            checked={settings.punctuationConversion.periodToJapanese}
            onChange={(checked) => updatePunctuation({ periodToJapanese: checked })}
          />
          <CheckRow
            label=", を 、に置き換える"
            checked={settings.punctuationConversion.commaToJapanese}
            onChange={(checked) => updatePunctuation({ commaToJapanese: checked })}
          />
          <details className="advanced-prompt">
            <summary>変換指示の編集</summary>
            <label className="prompt-editor">
              <span>日本語変換の指示</span>
              <textarea
                value={settings.conversionPrompt}
                onChange={(event) => update({ conversionPrompt: event.currentTarget.value })}
                spellCheck={false}
              />
            </label>
            <div className="panel-actions">
              <button className="secondary-button" type="button" onClick={onResetPrompt}>
                デフォルトに戻す
              </button>
            </div>
          </details>
        </AccordionSection>
        <p className="panel-note">設定は自動保存されます。</p>
      </div>
    </section>
  );
}

function inputPauseTimingDescription(timing: InputPauseTiming): string {
  if (timing === "early") {
    return "短い停止を入力の区切りとして、早めに生成します。";
  }
  if (timing === "deliberate") {
    return "長めの停止を待ち、入力途中の生成を抑えます。";
  }
  return "入力速度に合わせて、連続入力が終わるまでの待ち時間を調整します。";
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
      <button className="accordion-trigger" type="button" onClick={onToggle} aria-expanded={open}>
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
