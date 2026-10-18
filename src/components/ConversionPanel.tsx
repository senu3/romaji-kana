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
    punctuation: false,
  });
  const resultHeadingId = useId();

  const update = (patch: Partial<AppSettings>) => {
    onChange({ ...settings, ...patch, inputCompletionLevel: "none" });
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

  const enabledTriggerCount = [
    settings.triggers.typing ?? settings.triggers.space,
    settings.triggers.space,
    settings.triggers.period,
    settings.triggers.comma,
    settings.triggers.enter,
  ].filter(Boolean).length;
  const punctuationCount = [
    settings.punctuationConversion.periodToJapanese,
    settings.punctuationConversion.commaToJapanese,
  ].filter(Boolean).length;

  return (
    <section className="floating-panel prompt-panel conversion-panel" aria-label="変換設定">
      <div className="conversion-panel-content">
        <label className="field"><span>通常変換の方式</span>
          <select aria-label="通常変換の方式" value={settings.conversionEngine ?? "local"}
            onChange={event => update({ conversionEngine: event.currentTarget.value as "local" | "llm" })}>
            <option value="local">辞書候補をAIが選択</option>
            <option value="llm">AIが候補を生成（比較用）</option>
          </select>
        </label>
        <section className="settings-group conversion-result-settings" aria-labelledby={resultHeadingId}>
          <h3 id={resultHeadingId}>変換結果</h3>
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
                候補を表示
              </button>
            </div>
            <small>
              {settings.conversionMode === "ghost"
                ? "候補をインライン表示し、Tabで確定します。"
                : "変換後の日本語ですぐに置き換えます。"}
            </small>
          </div>
        </section>

        <AccordionSection
          title="変換タイミング"
          summary={settings.autoConvert ? `自動 · ${enabledTriggerCount}/5 条件` : "手動のみ"}
          open={openAccordions.triggers}
          onToggle={() => toggleAccordion("triggers")}
        >
          <CheckRow
            label="入力中に自動変換"
            checked={settings.autoConvert}
            onChange={(checked) => update({ autoConvert: checked })}
          />
          <div className={`trigger-options ${settings.autoConvert ? "" : "disabled"}`}>
            <CheckRow
              label="入力停止後に候補を生成"
              checked={settings.triggers.typing ?? settings.triggers.space}
              disabled={!settings.autoConvert}
              onChange={(checked) => updateTriggers({ typing: checked })}
            />
            <div
              className={`mode-field compact-mode-field input-pause-field ${
                settings.autoConvert && (settings.triggers.typing ?? settings.triggers.space) ? "" : "disabled"
              }`}
            >
              <span>入力停止の判定</span>
              <div
                className="segmented-control"
                role="radiogroup"
                aria-label="入力停止の判定"
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
            <CheckRow
              label="Spaceで候補を生成"
              checked={settings.triggers.space}
              disabled={!settings.autoConvert}
              onChange={(checked) => updateTriggers({ space: checked })}
            />
            <CheckRow
              label="ピリオドで変換"
              checked={settings.triggers.period}
              disabled={!settings.autoConvert}
              onChange={(checked) => updateTriggers({ period: checked })}
            />
            <CheckRow
              label="カンマで変換"
              checked={settings.triggers.comma}
              disabled={!settings.autoConvert}
              onChange={(checked) => updateTriggers({ comma: checked })}
            />
            <CheckRow
              label="Enterで変換（IME 変換中は無視）"
              checked={settings.triggers.enter}
              disabled={!settings.autoConvert}
              onChange={(checked) => updateTriggers({ enter: checked })}
            />
          </div>
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
          title="句読点変換"
          summary={`${punctuationCount}/2 有効`}
          open={openAccordions.punctuation}
          onToggle={() => toggleAccordion("punctuation")}
        >
          <CheckRow
            label=". を 。に変換"
            checked={settings.punctuationConversion.periodToJapanese}
            onChange={(checked) => updatePunctuation({ periodToJapanese: checked })}
          />
          <CheckRow
            label=", を 、に変換"
            checked={settings.punctuationConversion.commaToJapanese}
            onChange={(checked) => updatePunctuation({ commaToJapanese: checked })}
          />
        </AccordionSection>

        <p className="panel-note">
          通常変換は入力の読みを保ちます。誤字修正・推測の候補は、内容を確認してTabで採用します。
        </p>

        <details className="advanced-prompt">
          <summary>詳細な変換指示</summary>
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
          <p className="panel-note">変更は自動保存されます。</p>
        </details>
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
