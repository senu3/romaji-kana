import type { AppSettings } from "./types";
import { defaultConversionPrompt, legacyDefaultConversionPrompt } from "./prompts";

const STORAGE_KEY = "romaji-kana-settings";

export const defaultSettings: AppSettings = {
  modelProvider: "ollama",
  ollamaApiUrl: "http://localhost:11434",
  lmStudioApiUrl: "http://localhost:1234",
  modelName: "gemma3",
  autoConvert: true,
  conversionMode: "replace",
  triggers: {
    period: true,
    comma: true,
    japanesePeriod: true,
    japaneseComma: true,
    manualShortcut: "Mod-Enter",
  },
  punctuationConversion: {
    periodToJapanese: true,
    commaToJapanese: true,
  },
  conversionPrompt: defaultConversionPrompt,
  thinkingMode: "auto",
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultSettings;
    }

    return mergeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

type LegacySettings = Partial<AppSettings> & {
  think?: boolean;
};

function mergeSettings(settings: LegacySettings): AppSettings {
  const { think, ...currentSettings } = settings;
  const conversionPrompt =
    !settings.conversionPrompt || settings.conversionPrompt === legacyDefaultConversionPrompt
      ? defaultConversionPrompt
      : settings.conversionPrompt;
  const thinkingMode =
    settings.thinkingMode ??
    (think === undefined ? defaultSettings.thinkingMode : think ? "on" : "off");

  return {
    ...defaultSettings,
    ...currentSettings,
    conversionPrompt,
    thinkingMode,
    triggers: {
      ...defaultSettings.triggers,
      ...settings.triggers,
    },
    punctuationConversion: {
      ...defaultSettings.punctuationConversion,
      ...settings.punctuationConversion,
    },
  };
}
