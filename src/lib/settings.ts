import type { AppSettings } from "./types";
import { defaultConversionPrompt, legacyDefaultConversionPrompt } from "./prompts";

const STORAGE_KEY = "romaji-kana-settings";

export const defaultSettings: AppSettings = {
  ollamaApiUrl: "http://localhost:11434",
  modelName: "gemma3",
  autoConvert: true,
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
  think: false,
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

function mergeSettings(settings: Partial<AppSettings>): AppSettings {
  const conversionPrompt =
    !settings.conversionPrompt || settings.conversionPrompt === legacyDefaultConversionPrompt
      ? defaultConversionPrompt
      : settings.conversionPrompt;

  return {
    ...defaultSettings,
    ...settings,
    conversionPrompt,
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
