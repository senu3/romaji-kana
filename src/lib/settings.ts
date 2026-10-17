import { defaultConversionPrompt } from "./prompts";
import type {
  AppSettings,
  InputPauseTiming,
  InputCompletionLevel,
  SharedConversionSettings,
  UserDictionaryEntry,
} from "./types";
import type { PersonalWord } from "./kanaEngine";
import { normalizeKanaWidth } from "./readingComparison";

const STORAGE_KEY = "romaji-kana-settings";
const MAX_USER_DICTIONARY_ENTRIES = 50;

export const defaultSettings: AppSettings = {
  modelProvider: "ollama",
  ollamaApiUrl: "http://localhost:11434",
  lmStudioApiUrl: "http://localhost:1234",
  modelName: "gemma3",
  autoConvert: true,
  conversionMode: "replace",
  conversionEngine: "local",
  triggers: {
    typing: true,
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
  personalDictionary: [],
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
    conversionEngine: settings.conversionEngine ?? "local",
    triggers: settings.triggers,
    punctuationConversion: settings.punctuationConversion,
    conversionPrompt: settings.conversionPrompt,
    inputCompletionLevel: settings.inputCompletionLevel,
    inputPauseTiming: settings.inputPauseTiming,
    useDocumentVocabulary: settings.useDocumentVocabulary,
    userDictionary: settings.userDictionary,
    personalDictionary: settings.personalDictionary ?? [],
  };
}

export function mergeSharedConversionSettings(
  settings: AppSettings,
  shared: SharedConversionSettings,
): AppSettings {
  return {
    ...settings,
    ...shared,
    triggers: { ...shared.triggers, typing: shared.triggers.typing ?? shared.triggers.space },
    punctuationConversion: { ...shared.punctuationConversion },
    userDictionary: [...shared.userDictionary],
    personalDictionary: normalizePersonalDictionary(shared.personalDictionary),
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
    conversionEngine: settings.conversionEngine === "llm" ? "llm" : "local",
    inputPauseTiming: normalizeInputPauseTiming(settings.inputPauseTiming),
    useDocumentVocabulary: settings.useDocumentVocabulary === true,
    triggers: {
      ...defaultSettings.triggers,
      ...settings.triggers,
      typing: settings.triggers?.typing ?? settings.triggers?.space ?? defaultSettings.triggers.typing,
    },
    punctuationConversion: {
      ...defaultSettings.punctuationConversion,
      ...settings.punctuationConversion,
    },
    userDictionary: normalizeUserDictionary(settings.userDictionary),
    personalDictionary: normalizePersonalDictionary(settings.personalDictionary),
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

export function normalizePersonalDictionary(entries: unknown): PersonalWord[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry, index): PersonalWord[] => {
    if (!entry || typeof entry !== "object") return [];
    const reading = normalizeKanaWidth(readString(entry.reading).trim());
    const text = readString(entry.text).trim();
    if (!/^[ぁ-ゖー]+$/u.test(reading) || Array.from(reading).length > 80 || !text ||
      Array.from(text).length > 80 || /\p{Cc}/u.test(text)) return [];
    return [{ id: readString(entry.id) || `word-${index}`, reading, text,
      pos: ["proper", "person", "organization"].includes(entry.pos) ? entry.pos : "noun", enabled: entry.enabled !== false }];
  }).slice(0, 500);
}
