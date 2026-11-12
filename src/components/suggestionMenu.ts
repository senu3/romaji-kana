import { EditorView } from "@codemirror/view";

export const suggestionMenuTheme = EditorView.baseTheme({
  ".candidate-surface.word-suggestions": { width: "max-content", maxWidth: "min(420px, calc(100vw - 16px))", overflowY: "auto", padding: "6px", background: "var(--surface, white)", color: "var(--ink, #16343b)", border: "1px solid var(--line, #cbd8dc)" },
  ".word-suggestions-heading": { padding: "6px", fontSize: "11px" },
  ".word-suggestions button": { display: "flex", justifyContent: "space-between", gap: "16px", width: "100%", padding: "8px", background: "transparent", color: "inherit", border: "0", textAlign: "left", cursor: "pointer", overflowWrap: "anywhere", whiteSpace: "normal" },
  ".word-suggestions button.selected, .word-suggestions button:hover": { background: "var(--accent-soft, #e4f5f0)" },
  ".word-suggestions button:focus-visible, .word-suggestions summary:focus-visible": { outline: "2px solid var(--accent, #007f83)" },
  ".speculation-suggestions strong": { fontWeight: "500", lineHeight: "1.6", whiteSpace: "pre-wrap" },
  ".speculation-suggestions details": { borderTop: "1px solid var(--line, #cbd8dc)", marginTop: "6px", padding: "6px", fontSize: "12px", overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
  ".speculation-suggestions summary": { cursor: "pointer" },
  ".speculation-suggestions p": { margin: "8px 0 0" },
  ".cm-speculation-source": { background: "var(--accent-soft, #e4f5f0)", textDecoration: "underline", textDecorationColor: "var(--accent, #007f83)", textUnderlineOffset: "3px" },
});
