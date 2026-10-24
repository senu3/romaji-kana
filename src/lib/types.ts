export type ConversionTrigger =
  | "typing"
  | "space"
  | "period"
  | "comma"
  | "enter"
  | "shortcut";

export type ModelProvider = "ollama" | "lmstudio";

export type InputPauseTiming = "early" | "auto" | "deliberate";



export interface AppSettings {
  modelProvider: ModelProvider;
  ollamaApiUrl: string;
  lmStudioApiUrl: string;
  modelName: string;
  autoConvert: boolean;
  autoSuggest: boolean;
  conversionMode: "replace" | "ghost";

  triggers: {
    typing: boolean;
    space: boolean;
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

  inputPauseTiming: InputPauseTiming;
  useDocumentVocabulary: boolean;
  personalDictionary?: import("./kanaEngine").PersonalWord[];
  think: boolean;
}

export type SharedConversionSettings = Pick<
  AppSettings,
  | "autoConvert"
  | "autoSuggest"
  | "conversionMode"
  | "triggers"
  | "punctuationConversion"
  | "conversionPrompt"
  | "inputPauseTiming"
  | "useDocumentVocabulary"
  | "personalDictionary"
>;

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
  session?: import("./conversionSession").ConversionSession;
  changes?: import("./conversionChanges").ConversionChanges;
  id: string;
  from: number;
  to: number;
  originalText: string;
  convertedText: string;
  inputText: string;
  reviewKana?: string;
  conversionStrategy?: "correction" | "speculative";

  trigger?: ConversionTrigger;
  documentVocabulary?: string[];
  documentVocabularyRevision?: string;
  source: "editor" | "history";
  retryOf?: string;
  avoidOutputs?: string[];
  previewOnly?: boolean;
}

export interface PendingConversion {
  userRequestedSpeculation?: boolean;

  id: string;
  range?: ConversionRange;
  anchor?: ConversionAnchor;
  originalText: string;
  createdAt: number;
  docVersion?: number;
  source: "editor" | "history";
  status: "queued" | "running";
  retryOf?: string;
  avoidOutputs?: string[];

  documentVocabulary?: string[];
  documentVocabularyRevision?: string;
}

export type ConversionHistoryStatus = "success" | "error" | "skipped" | "canceled";

export interface ConversionHistoryItem {
  session?: import("./conversionSession").ConversionSession;
  /** Observed reading of the selected candidate. */
  reviewKana?: string;
  changes?: import("./conversionChanges").ConversionChanges;
  id: string;
  status: ConversionHistoryStatus;
  input: string;
  output?: string;
  error?: string;
  modelName: string;
  createdAt: number;
  source: "editor" | "history";
  anchor?: ConversionAnchor;
  conversionStrategy?: "correction" | "speculative";

  documentVocabulary?: string[];
  documentVocabularyRevision?: string;
  retryOf?: string;
  avoidOutputs?: string[];
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
