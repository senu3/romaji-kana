export type ConversionTrigger =
  | "period"
  | "comma"
  | "enter"
  | "shortcut";

export type ModelProvider = "ollama" | "lmstudio";
export type ConversionPreset = "none" | "conversation" | "businessEmail";

export interface UserDictionaryEntry {
  id: string;
  reading: string;
  output: string;
  note: string;
  enabled: boolean;
}

export interface UserHomophonePreference {
  id: string;
  reading: string;
  preferred: string;
  replaceFrom: string[];
  note: string;
  enabled: boolean;
}

export interface AppSettings {
  modelProvider: ModelProvider;
  ollamaApiUrl: string;
  lmStudioApiUrl: string;
  modelName: string;
  autoConvert: boolean;
  conversionMode: "replace" | "ghost";
  triggers: {
    period: boolean;
    comma: boolean;
    enter: boolean;
    manualShortcut: string;
  };
  punctuationConversion: {
    periodToJapanese: boolean;
    commaToJapanese: boolean;
  };
  conversionPrompt: string;
  conversionPreset: ConversionPreset;
  userDictionary: UserDictionaryEntry[];
  userHomophones: UserHomophonePreference[];
  think: boolean;
}

export interface ConversionRange {
  from: number;
  to: number;
  text: string;
  trigger: ConversionTrigger;
}

export type RomajiKanaTokenKind =
  | "exact"
  | "sokuon"
  | "n"
  | "punctuation"
  | "unknown"
  | "repaired";

export interface RomajiKanaToken {
  romaji: string;
  kana: string;
  inputFrom: number;
  inputTo: number;
  kanaFrom: number;
  kanaTo: number;
  confidence: number;
  kind: RomajiKanaTokenKind;
}

export interface RomajiKanaSpan {
  romaji: string;
  kana: string;
  inputFrom: number;
  inputTo: number;
  kanaFrom: number;
  kanaTo: number;
  contextKana: string;
  sourceRomaji: string;
}

export interface RomajiKanaResult {
  kana: string;
  tokens: RomajiKanaToken[];
  lowConfidenceSpans: RomajiKanaSpan[];
}

export interface ConversionAnchor {
  from: number;
  to: number;
  originalText: string;
  appliedText?: string;
  docVersion: number;
}

export interface GhostConversionSuggestion {
  id: string;
  from: number;
  to: number;
  originalText: string;
  convertedText: string;
  inputText: string;
  reviewKana?: string;
  source: "editor" | "history";
}

export interface HomophoneReviewSuggestion {
  id: string;
  entryId: string;
  reading: string;
  preferred: string;
  target: string;
  from: number;
  to: number;
}

export interface PendingConversion {
  id: string;
  range?: ConversionRange;
  anchor?: ConversionAnchor;
  originalText: string;
  createdAt: number;
  docVersion?: number;
  source: "editor" | "history";
  status: "queued" | "running";
}

export type ConversionHistoryStatus = "success" | "error" | "skipped" | "canceled";

export interface ConversionHistoryItem {
  id: string;
  status: ConversionHistoryStatus;
  input: string;
  output?: string;
  error?: string;
  modelName: string;
  createdAt: number;
  source: "editor" | "history";
  anchor?: ConversionAnchor;
}

export interface LocalModel {
  name: string;
  modifiedAt?: string;
  size?: number;
}

export type OllamaModel = LocalModel;

export type LocalModelConnectionStatus =
  | { kind: "idle"; message: string }
  | { kind: "checking"; message: string }
  | { kind: "connected"; message: string; checkedAt: number }
  | { kind: "warning"; message: string; checkedAt: number }
  | { kind: "error"; message: string; checkedAt: number };

export type OllamaConnectionStatus = LocalModelConnectionStatus;

export type ConversionStatus =
  | { kind: "idle"; message: string }
  | { kind: "loading"; message: string }
  | { kind: "success"; message: string }
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string };
