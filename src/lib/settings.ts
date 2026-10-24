import type { PersonalWord } from "./kanaEngine";
import { defaultConversionPrompt } from "./prompts";
import { normalizeKanaWidth } from "./readingComparison";
import type {
  AppSettings,
  InputPauseTiming,
  SharedConversionSettings,
} from "./types";

const STORAGE_KEY = "romaji-kana-settings";

export const defaultSettings: AppSettings = {
  modelProvider: "ollama",
  ollamaApiUrl: "http://localhost:11434",
  lmStudioApiUrl: "http://localhost:1234",
  modelName: "gemma3",
  autoConvert: true,
  autoSuggest: true,
  conversionMode: "replace",

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

  inputPauseTiming: "auto",
  useDocumentVocabulary: false,
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mergeSettings(settings)));
}

export function sharedConversionSettings(settings: AppSettings): SharedConversionSettings {
  return {
    autoConvert: settings.autoConvert,
    autoSuggest: settings.autoSuggest,
    conversionMode: settings.conversionMode,

    triggers: settings.triggers,
    punctuationConversion: settings.punctuationConversion,
    conversionPrompt: settings.conversionPrompt,

    inputPauseTiming: settings.inputPauseTiming,
    useDocumentVocabulary: settings.useDocumentVocabulary,
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

    conversionPrompt: shared.conversionPrompt,
    triggers: { ...shared.triggers },
    punctuationConversion: { ...shared.punctuationConversion },
    personalDictionary: normalizePersonalDictionary(shared.personalDictionary),
  };
}

function mergeSettings(settings: Partial<AppSettings>): AppSettings {
  const picked = Object.fromEntries(Object.keys(defaultSettings).filter(key => key in settings).map(key => [key, settings[key as keyof AppSettings]]));
  return {
    ...defaultSettings, ...picked,
    conversionPrompt: settings.conversionPrompt || defaultConversionPrompt,
    think: settings.think === true,
    autoSuggest: settings.autoSuggest !== false,
    inputPauseTiming: normalizeInputPauseTiming(settings.inputPauseTiming),
    useDocumentVocabulary: settings.useDocumentVocabulary === true,
    triggers: { ...defaultSettings.triggers, ...settings.triggers },
    punctuationConversion: { ...defaultSettings.punctuationConversion, ...settings.punctuationConversion },
    personalDictionary: normalizePersonalDictionary(settings.personalDictionary)
  };
}

function normalizeInputPauseTiming(value: unknown): InputPauseTiming {
  return value === "early" || value === "deliberate" ? value : "auto";
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
    return [{
      id: readString(entry.id) || `word-${index}`, reading, text,
      pos: ["proper", "person", "organization"].includes(entry.pos) ? entry.pos : "noun", enabled: entry.enabled !== false
    }];
  }).slice(0, 500);
}
