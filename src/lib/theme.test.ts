// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, loadThemePreference, saveThemePreference } from "./theme";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem("romaji-kana-theme");
  delete document.documentElement.dataset.theme;
});

describe("appearance preference", () => {
  it("defaults to system and rejects unknown stored values", () => {
    expect(loadThemePreference()).toBe("system");
    localStorage.setItem("romaji-kana-theme", "invalid");
    expect(loadThemePreference()).toBe("system");
  });
  it("preserves explicit choices irrespective of the OS appearance", () => {
    saveThemePreference("light");
    expect(loadThemePreference()).toBe("light");
    applyTheme("light", true);
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("dark", false);
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("system", false);
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("system", true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  it("works when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(loadThemePreference()).toBe("system");
    expect(() => saveThemePreference("dark")).not.toThrow();
  });
});
