import { defaultConversionPrompt } from "./prompts";
import type {
  AppSettings,
  InputPauseTiming,
  InputCompletionLevel,
  SharedConversionSettings,
  UserDictionaryEntry,
} from "./types";

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
    space: true,
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
  inputCompletionLevel: "none",
  inputPauseTiming: "auto",
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

export function sharedConversionSettings(settings: AppSettings): SharedConversionSettings {
  return {
    autoConvert: settings.autoConvert,
    conversionMode: settings.conversionMode,
    triggers: settings.triggers,
    punctuationConversion: settings.punctuationConversion,
    conversionPrompt: settings.conversionPrompt,
    inputCompletionLevel: settings.inputCompletionLevel,
    inputPauseTiming: settings.inputPauseTiming,
    useDocumentVocabulary: settings.useDocumentVocabulary,
    userDictionary: settings.userDictionary,
  };
}

export function mergeSharedConversionSettings(
  settings: AppSettings,
  shared: SharedConversionSettings,
): AppSettings {
  return {
    ...settings,
    ...shared,
    triggers: { ...shared.triggers },
    punctuationConversion: { ...shared.punctuationConversion },
    userDictionary: [...shared.userDictionary],
  };
}

type LegacySettings = Partial<AppSettings> & {
  thinkingMode?: "auto" | "on" | "off";
  userHomophones?: unknown;
  conversionPreset?: unknown;
  predictiveSuggestionTiming?: unknown;
};

function mergeSettings(settings: LegacySettings): AppSettings {
  const {
    thinkingMode,
    userHomophones,
    conversionPreset,
    predictiveSuggestionTiming,
    ...currentSettings
  } = settings;
  void userHomophones;
  void conversionPreset;
  void predictiveSuggestionTiming;
  const conversionPrompt = settings.conversionPrompt || defaultConversionPrompt;
  const think = settings.think ?? thinkingMode === "on";

  return {
    ...defaultSettings,
    ...currentSettings,
    conversionPrompt,
    think,
    inputCompletionLevel: normalizeInputCompletionLevel(settings.inputCompletionLevel),
    inputPauseTiming: normalizeInputPauseTiming(settings.inputPauseTiming),
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
  return value === "none" || value === "word" || value === "sentence"
    ? value
    : defaultSettings.inputCompletionLevel;
}

function normalizeInputPauseTiming(value: unknown): InputPauseTiming {
  return value === "early" || value === "deliberate" ? value : "auto";
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
