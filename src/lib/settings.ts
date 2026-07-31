import type { AppSettings, InputCompletionLevel, UserDictionaryEntry } from "./types";
import { defaultConversionPrompt } from "./prompts";

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
  inputCompletionLevel: "none",
  useDocumentVocabulary: false,
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
  userHomophones?: unknown;
};

function mergeSettings(settings: LegacySettings): AppSettings {
  const { thinkingMode, userHomophones, ...currentSettings } = settings;
  void userHomophones;
  const conversionPrompt = settings.conversionPrompt || defaultConversionPrompt;
  const think = settings.think ?? thinkingMode === "on";

  return {
    ...defaultSettings,
    ...currentSettings,
    conversionPrompt,
    think,
    inputCompletionLevel: normalizeInputCompletionLevel(settings.inputCompletionLevel),
    useDocumentVocabulary: settings.useDocumentVocabulary === true,
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

function normalizeInputCompletionLevel(value: unknown): InputCompletionLevel {
  return value === "word" || value === "sentence" ? value : "none";
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
