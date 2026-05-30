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
  range: ConversionRange;
  originalText: string;
  createdAt: number;
  docVersion: number;
}

export interface ConversionHistoryItem {
  id: string;
  input: string;
  output: string;
  modelName: string;
  createdAt: number;
}

export type ConversionStatus =
  | { kind: "idle"; message: string }
  | { kind: "loading"; message: string }
  | { kind: "success"; message: string }
  | { kind: "warning"; message: string }
  | { kind: "error"; message: string };
