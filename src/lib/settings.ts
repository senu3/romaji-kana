import type { AppSettings, UserDictionaryEntry } from "./types";
import { defaultConversionPrompt, legacyDefaultConversionPrompt } from "./prompts";

const STORAGE_KEY = "romaji-kana-settings";
const MAX_USER_DICTIONARY_ENTRIES = 50;

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
    enter: false,
    manualShortcut: "Mod-Enter",
  },
  punctuationConversion: {
    periodToJapanese: true,
    commaToJapanese: true,
  },
  conversionPrompt: defaultConversionPrompt,
  conversionPreset: "none",
  userDictionary: [],
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

type LegacySettings = Partial<AppSettings> & {
  thinkingMode?: "auto" | "on" | "off";
};

function mergeSettings(settings: LegacySettings): AppSettings {
  const { thinkingMode, ...currentSettings } = settings;
  const conversionPrompt =
    !settings.conversionPrompt || settings.conversionPrompt === legacyDefaultConversionPrompt
      ? defaultConversionPrompt
      : settings.conversionPrompt;
  const think = settings.think ?? thinkingMode === "on";

  return {
    ...defaultSettings,
    ...currentSettings,
    conversionPrompt,
    think,
    triggers: {
      ...defaultSettings.triggers,
      ...settings.triggers,
    },
    punctuationConversion: {
      ...defaultSettings.punctuationConversion,
      ...settings.punctuationConversion,
    },
    userDictionary: normalizeUserDictionary(settings.userDictionary),
  };
}

function normalizeUserDictionary(entries: unknown): UserDictionaryEntry[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .flatMap((entry, index): UserDictionaryEntry[] => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      const record = entry as Record<string, unknown>;
      const reading = readString(record.reading).trim();
      const output = readString(record.output).trim();
      if (!reading || !output) {
        return [];
      }

      return [
        {
          id: readString(record.id).trim() || `dictionary-${index}`,
          reading,
          output,
          note: readString(record.note).trim(),
          enabled: typeof record.enabled === "boolean" ? record.enabled : true,
        },
      ];
    })
    .slice(0, MAX_USER_DICTIONARY_ENTRIES);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
