import { useEffect, useState } from "react";
import { applyTheme, loadThemePreference, saveThemePreference, type ThemePreference } from "../lib/theme";

export function ThemeSelect() {
  const [preference, setPreference] = useState(loadThemePreference);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme(preference, media.matches);
    update();
    media.addEventListener("change", update);
    const storage = (event: StorageEvent) => {
      if (event.key === "romaji-kana-theme" || event.key === null) setPreference(loadThemePreference());
    };
    window.addEventListener("storage", storage);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("storage", storage);
    };
  }, [preference]);
  return (
    <label className="theme-select">
      <span>表示</span>
      <select aria-label="表示テーマ" value={preference} onChange={event => {
        const next = event.target.value as ThemePreference;
        saveThemePreference(next);
        setPreference(next);
      }}>
        <option value="system">システム設定</option>
        <option value="light">ライト</option>
        <option value="dark">ダーク</option>
      </select>
    </label>
  );
}
