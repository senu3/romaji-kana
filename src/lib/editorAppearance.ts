export interface EditorAppearance {
  fontName: string;
  fontSize: number;
}

export const EDITOR_APPEARANCE_EVENT = "editor-appearance-change";
export const EDITOR_APPEARANCE_KEY = "romaji-kana-editor-appearance";
export const defaultEditorAppearance: EditorAppearance = { fontName: "", fontSize: 16 };
const fallbackFonts = 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

export function normalizeEditorAppearance(value: unknown): EditorAppearance {
  const input = value && typeof value === "object" ? value as Partial<EditorAppearance> : {};
  return {
    fontName: typeof input.fontName === "string" ? input.fontName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) : "",
    fontSize: typeof input.fontSize === "number" && Number.isFinite(input.fontSize)
      ? Math.min(32, Math.max(12, Math.round(input.fontSize * 2) / 2))
      : defaultEditorAppearance.fontSize,
  };
}

export function loadEditorAppearance(): EditorAppearance {
  try { return normalizeEditorAppearance(JSON.parse(localStorage.getItem(EDITOR_APPEARANCE_KEY) ?? "null")); }
  catch { return { ...defaultEditorAppearance }; }
}

export function saveEditorAppearance(value: EditorAppearance) {
  try { localStorage.setItem(EDITOR_APPEARANCE_KEY, JSON.stringify(normalizeEditorAppearance(value))); }
  catch { /* Apply locally even when storage is unavailable. */ }
}

export function applyEditorAppearance(value: EditorAppearance) {
  const settings = normalizeEditorAppearance(value);
  // Treat the entered name as one font family, never as a CSS declaration or a remote URL.
  const name = settings.fontName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  document.documentElement.style.setProperty("--editor-font-family", name ? `"${name}", ${fallbackFonts}` : fallbackFonts);
  document.documentElement.style.setProperty("--editor-font-size", `${settings.fontSize}px`);
  window.dispatchEvent(new Event(EDITOR_APPEARANCE_EVENT));
}

export function initializeEditorAppearance() { applyEditorAppearance(loadEditorAppearance()); }
