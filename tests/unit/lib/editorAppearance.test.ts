// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyEditorAppearance, defaultEditorAppearance, EDITOR_APPEARANCE_KEY,
  loadEditorAppearance, normalizeEditorAppearance, saveEditorAppearance,
} from "../../../src/lib/editorAppearance";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(EDITOR_APPEARANCE_KEY);
  document.documentElement.removeAttribute("style");
});

describe("editor appearance", () => {
  it("uses defaults for absent or corrupt saved settings", () => {
    expect(loadEditorAppearance()).toEqual(defaultEditorAppearance);
    for (const value of ["broken", "null", "42", '{"fontName":12,"fontSize":"20"}']) {
      localStorage.setItem(EDITOR_APPEARANCE_KEY, value);
      expect(loadEditorAppearance()).toEqual(defaultEditorAppearance);
    }
  });

  it("restores a local font name with spaces and a fractional size", () => {
    saveEditorAppearance({ fontName: "  Yu Gothic  ", fontSize: 18.5 });
    expect(loadEditorAppearance()).toEqual({ fontName: "Yu Gothic", fontSize: 18.5 });
  });

  it("bounds invalid sizes without accepting non-finite values", () => {
    expect(normalizeEditorAppearance({ fontSize: -1 }).fontSize).toBe(12);
    expect(normalizeEditorAppearance({ fontSize: 999 }).fontSize).toBe(32);
    expect(normalizeEditorAppearance({ fontSize: NaN }).fontSize).toBe(16);
    expect(normalizeEditorAppearance({ fontSize: Infinity }).fontSize).toBe(16);
  });

  it("applies one quoted font name and preserves the standard fallback", () => {
    applyEditorAppearance({ fontName: 'Font "Special", Other', fontSize: 20 });
    expect(document.documentElement.style.getPropertyValue("--editor-font-family"))
      .toBe('"Font \\"Special\\", Other", ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace');
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("20px");
    applyEditorAppearance(defaultEditorAppearance);
    expect(document.documentElement.style.getPropertyValue("--editor-font-family")).toMatch(/^ui-monospace,/);
  });

  it("keeps appearance usable when storage access fails", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(loadEditorAppearance()).toEqual(defaultEditorAppearance);
    expect(() => saveEditorAppearance({ fontName: "Consolas", fontSize: 20 })).not.toThrow();
    expect(() => applyEditorAppearance({ fontName: "Consolas", fontSize: 20 })).not.toThrow();
  });
});
