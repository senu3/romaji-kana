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
  suggestionRejectedReason?: "diverged" | "speculative" | "protected";
}

export interface JapaneseConversionOptions {
  /** Explore spelling only, holding the previous candidate's reading fixed. */
  alternativeMode?: boolean;
  alternativeReading?: string;
  alternativeCorrectedReading?: string;
  alternativeAdditionKind?: ConversionChanges["additionKind"];
  avoidOutputs?: string[];
  strictAlternative?: boolean;
  alternativeAttempt?: number;
  /** Explicit typo-repair request (legacy name); never a spelling retry policy. */
  completionMode?: boolean;
  speculativeMode?: boolean;
  completionSourceRomaji?: string;
  protectedDictionaryEntries?: ProtectedDictionaryEntry[];
  documentVocabulary?: string[];
  signal?: AbortSignal;
}
