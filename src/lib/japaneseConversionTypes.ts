import type { ProtectedDictionaryEntry } from "./conversionInput";
import type { ConversionChanges } from "./conversionChanges";
import type { ReadingVerifier } from "./readingAssessment";
import type { ConversionDiagnostic } from "./conversionDiagnostics";

export interface JapaneseConversionResult {
  text: string;
  reviewKana: string;
  changes?: ConversionChanges;
  conversionStrategy?: "completion" | "speculative";
  inputCompletionApplied?: boolean;
  inputCompletionSourceKana?: string;
  inputCompletionAdditions?: string[];
  suggestionRejected?: boolean;
  rejectionDetail?: ConversionDiagnostic;
  suggestionRejectedReason?: "diverged" | "speculative" | "protected" | "reading";
}

export interface JapaneseConversionOptions {
  /** Local independent verification, never a reference or saved setting. */
  readingVerifier?: ReadingVerifier;
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
