import type { ProtectedDictionaryEntry } from "./conversionInput";
import type { ConversionChanges } from "./conversionChanges";

export interface JapaneseConversionResult {
  text: string;
  reviewKana: string;
  changes?: ConversionChanges;
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
