import type { ProtectedDictionaryEntry } from "./conversionInput";

export interface JapaneseConversionResult {
  text: string;
  reviewKana: string;
  conversionStrategy?: "completion" | "speculative";
  inputCompletionApplied?: boolean;
  inputCompletionSourceKana?: string;
  inputCompletionAdditions?: string[];
  suggestionRejected?: boolean;
  suggestionRejectedReason?: "diverged" | "speculative";
}

export interface JapaneseConversionOptions {
  avoidOutputs?: string[];
  strictAlternative?: boolean;
  alternativeAttempt?: number;
  completionMode?: boolean;
  speculativeMode?: boolean;
  completionSourceRomaji?: string;
  protectedDictionaryEntries?: ProtectedDictionaryEntry[];
  documentVocabulary?: string[];
  signal?: AbortSignal;
}
