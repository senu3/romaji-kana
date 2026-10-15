export type ThemePreference = "system" | "light" | "dark";
const storageKey = "romaji-kana-theme";

export function loadThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch { return "system"; }
}

export function applyTheme(preference: ThemePreference, systemDark: boolean) {
  document.documentElement.dataset.theme = preference === "system"
    ? systemDark ? "dark" : "light"
    : preference;
}

export function saveThemePreference(preference: ThemePreference) {
  try { localStorage.setItem(storageKey, preference); } catch { /* Still apply for this session. */ }
}

export function initializeTheme() {
  applyTheme(loadThemePreference(), window.matchMedia("(prefers-color-scheme: dark)").matches);
}
