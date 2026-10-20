import { Type, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  applyEditorAppearance, defaultEditorAppearance, EDITOR_APPEARANCE_KEY,
  loadEditorAppearance, normalizeEditorAppearance, saveEditorAppearance,
  type EditorAppearance,
} from "../lib/editorAppearance";

const fontSuggestions = ["BIZ UDPゴシック", "Yu Gothic", "Meiryo", "Hiragino Sans", "Noto Sans JP", "Consolas", "Cascadia Code"];

export function EditorAppearanceControl() {
  const [settings, setSettings] = useState(loadEditorAppearance);
  const [open, setOpen] = useState(false);
  const [sizeInput, setSizeInput] = useState(() => String(settings.fontSize));
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const fontListId = useId();
  const helpId = useId();
  const headingId = useId();

  const update = (patch: Partial<EditorAppearance>) => {
    const next = normalizeEditorAppearance({ ...settings, ...patch });
    setSettings({ ...next, fontName: patch.fontName ?? settings.fontName });
    saveEditorAppearance(next);
  };

  useEffect(() => { applyEditorAppearance(settings); }, [settings]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === EDITOR_APPEARANCE_KEY || event.key === null) {
        const next = loadEditorAppearance();
        setSettings(next);
        setSizeInput(String(next.fontSize));
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return (
    <div className="editor-appearance-control" ref={rootRef}>
      <button ref={buttonRef} type="button" className="editor-appearance-trigger"
        aria-label="エディターの表示設定" title="エディターの表示設定" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen(!open)}>
        <Type size={18} aria-hidden="true" />
      </button>
      {open ? <section id={panelId} className="editor-appearance-panel" role="dialog" aria-modal="false" aria-labelledby={headingId}>
        <header>
          <h2 id={headingId}>エディターの表示</h2>
          <button type="button" className="icon-button" aria-label="表示設定を閉じる" onClick={() => { setOpen(false); buttonRef.current?.focus(); }}><X size={16} aria-hidden="true" /></button>
        </header>
        <label className="editor-appearance-field">
          <span>フォント名</span>
          <input ref={inputRef} list={fontListId} value={settings.fontName} maxLength={100}
            placeholder="標準（等幅フォント）" aria-describedby={helpId}
            onChange={event => update({ fontName: event.target.value })} />
          <datalist id={fontListId}>{fontSuggestions.map(name => <option key={name} value={name} />)}</datalist>
        </label>
        <p id={helpId} className="editor-appearance-help">端末にあるフォント名を指定します。空欄や未インストールのフォントは、標準のフォントで表示します。</p>
        <label className="editor-appearance-field editor-font-size-field">
          <span>文字サイズ</span>
          <span><input type="number" aria-label="文字サイズ" min={12} max={32} step={0.5} value={sizeInput}
            onChange={event => {
              setSizeInput(event.target.value);
              const size = event.target.valueAsNumber;
              if (Number.isFinite(size) && size >= 12 && size <= 32) update({ fontSize: size });
            }}
            onBlur={() => {
              const next = normalizeEditorAppearance({ ...settings, fontSize: sizeInput ? Number(sizeInput) : settings.fontSize });
              update({ fontSize: next.fontSize });
              setSizeInput(String(next.fontSize));
            }} /> px</span>
        </label>
        <p className="editor-font-preview" aria-label="フォントのプレビュー">あいうえお 漢字 ABC 123</p>
        <footer>
          <button type="button" className="candidate-action" onClick={() => { update(defaultEditorAppearance); setSizeInput(String(defaultEditorAppearance.fontSize)); }}>標準に戻す</button>
          <span className="editor-appearance-help">この端末に自動保存</span>
        </footer>
      </section> : null}
    </div>
  );
}
