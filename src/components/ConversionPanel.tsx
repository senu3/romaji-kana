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
    details: false,
  });
  const resultHeadingId = useId();
  const startHeadingId = useId();
  const candidatesHeadingId = useId();
  const shortcutId = useId();
  const previewMode = settings.conversionMode === "ghost";

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

  const punctuationSummary = [
    settings.punctuationConversion.periodToJapanese && ". → 。",
    settings.punctuationConversion.commaToJapanese && ", → 、",
  ].filter(Boolean).join(" / ") || "句読点の置換なし";

  return (
    <section className="floating-panel prompt-panel conversion-panel" aria-label="変換設定">
      <div className="conversion-panel-content">
        <section className="settings-group conversion-result-settings" aria-labelledby={resultHeadingId}>
          <h3 id={resultHeadingId}>変換の適用</h3>
          <CheckRow label="入力中からひらがなで表示" checked={settings.inputMode !== "romaji"}
            onChange={checked => update({ inputMode: checked ? "kana" : "romaji" })} />
          <div className="segmented-control" role="group" aria-label="変換結果の適用方法">
            <button className={!previewMode ? "selected" : ""} type="button"
              aria-pressed={!previewMode} onClick={() => update({ conversionMode: "replace" })}>
              直接置換
            </button>
            <button className={previewMode ? "selected" : ""} type="button"
              aria-pressed={previewMode} onClick={() => update({ conversionMode: "ghost" })}>
              確認して確定
            </button>
          </div>
          {previewMode ? <div className="conversion-key-reference"><span>候補を採用</span><kbd>Tab / Alt + Enter</kbd></div>
            : <p className="settings-help">直前の変換は Esc で見直せます。推測・読み未確認の候補は、確認して確定します。</p>}
          {!remoteMode ? (
            <div className="shortcut-field conversion-manual-shortcut">
              <span id={shortcutId}>手動変換</span>
              <div className="shortcut-controls">
                <button type="button" className={`shortcut-recorder ${capturingShortcut ? "recording" : ""}`}
                  aria-labelledby={shortcutId} aria-describedby={`${shortcutId}-value`}
                  onClick={() => { setCapturingShortcut(true); setShortcutError(""); }}
                  onKeyDown={handleShortcutKeyDown} onBlur={() => setCapturingShortcut(false)}
                  data-ignore-app-shortcuts="true">
                  <Keyboard size={15} aria-hidden="true" />
                  <span id={`${shortcutId}-value`}>{capturingShortcut ? "キーを押してください…" : formatShortcutLabel(settings.triggers.manualShortcut)}</span>
                </button>
                <button className="shortcut-reset" type="button"
                  onClick={() => updateTriggers({ manualShortcut: defaultSettings.triggers.manualShortcut })}
                  aria-label="手動ショートカットをリセット" title="初期設定に戻す">
                  <RotateCcw size={15} aria-hidden="true" />
                </button>
              </div>
              {shortcutError ? <p className="shortcut-help error" role="alert">{shortcutError}</p> : null}
            </div>
          ) : null}
        </section>

        <section className="settings-group conversion-start-settings" aria-labelledby={startHeadingId}>
          <h3 id={startHeadingId} className="sr-only">自動開始</h3>
          <CheckRow label={previewMode ? "候補の自動表示" : "自動変換"} checked={settings.autoConvert}
            onChange={checked => update({ autoConvert: checked })} />
          <fieldset className="conversion-auto-options" disabled={!settings.autoConvert}>
            <legend className="sr-only">{previewMode ? "候補を表示するタイミング" : "変換するタイミング"}</legend>
            <CheckRow label="入力が止まったら" checked={settings.triggers.typing}
              onChange={checked => updateTriggers({ typing: checked })} />
            <fieldset className="conversion-pause-options" disabled={!settings.autoConvert || !settings.triggers.typing}>
              <legend className="sr-only">入力停止後の待ち時間</legend>
              <div className="segmented-control" role="radiogroup" aria-label="入力停止後の待ち時間">
                {INPUT_PAUSE_TIMING_OPTIONS.map(option => (
                  <label className={settings.inputPauseTiming === option ? "selected" : ""} key={option}>
                    <input type="radio" name="input-pause-timing" value={option}
                      checked={settings.inputPauseTiming === option}
                      onChange={() => update({ inputPauseTiming: option })} />
                    <span>{INPUT_PAUSE_TIMING_LABELS[option]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="conversion-trigger-grid">
              <CheckRow label="Space" checked={settings.triggers.space} onChange={checked => updateTriggers({ space: checked })} />
              <CheckRow label="Enter" checked={settings.triggers.enter} onChange={checked => updateTriggers({ enter: checked })} />
              <CheckRow label="ピリオド（.）" checked={settings.triggers.period} onChange={checked => updateTriggers({ period: checked })} />
              <CheckRow label="カンマ（,）" checked={settings.triggers.comma} onChange={checked => updateTriggers({ comma: checked })} />
            </div>
          </fieldset>
        </section>

        <section className="settings-group conversion-candidate-settings" aria-labelledby={candidatesHeadingId}>
          <h3 id={candidatesHeadingId}>候補</h3>
          <CheckRow label="候補がないときは自動で推測" checked={settings.autoSpeculation}
            onChange={checked => update({ autoSpeculation: checked })} />
          <CheckRow label="オートサジェスト" checked={settings.autoSuggest} onChange={checked => update({ autoSuggest: checked })} />
          <p className="settings-help">入力行に補完を1件表示します。Tab で確定します。</p>
        </section>
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
      </div>
    </section>
  );
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
