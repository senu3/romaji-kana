export type ConversionTrigger =
  | "period"
  | "comma"
  | "japanesePeriod"
  | "japaneseComma"
  | "shortcut";

export interface AppSettings {
  ollamaApiUrl: string;
  modelName: string;
  autoConvert: boolean;
  triggers: {
    period: boolean;
    comma: boolean;
    japanesePeriod: boolean;
    japaneseComma: boolean;
    manualShortcut: string;
  };
  punctuationConversion: {
    periodToJapanese: boolean;
    commaToJapanese: boolean;
  };
  conversionPrompt: string;
  think: boolean;
}

export interface ConversionRange {
  from: number;
  to: number;
  text: string;
  trigger: ConversionTrigger;
}

export interface PendingConversion {
  id: string;
  range?: ConversionRange;
  originalText: string;
  createdAt: number;
  docVersion?: number;
  source: "editor" | "history";
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
}

export interface OllamaModel {
  name: string;
  modifiedAt?: string;
  size?: number;
}

export type OllamaConnectionStatus =
  | { kind: "idle"; message: string }
  | { kind: "checking"; message: string }
  | { kind: "connected"; message: string; checkedAt: number }
  | { kind: "warning"; message: string; checkedAt: number }
  | { kind: "error"; message: string; checkedAt: number };

export type ConversionStatus =
  | { kind: "idle"; message: string }
  | { kind: "loading"; message: string }
  | { kind: "success"; message: string }
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string };
