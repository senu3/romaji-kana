import type { ProtectedDictionaryEntry } from "./conversionInput";
import type { ConversionChanges } from "./conversionChanges";
import type { ReadingVerifier } from "./readingAssessment";
import type { ConversionDiagnostic } from "./conversionDiagnostics";

export interface JapaneseConversionResult {
  session?: import("./conversionSession").ConversionSession;
  text: string;
  reviewKana: string;
  changes?: ConversionChanges;
  conversionStrategy?: "completion" | "speculative";
  inputCompletionApplied?: boolean;
  inputCompletionSourceKana?: string;
  inputCompletionAdditions?: string[];
  suggestionRejected?: boolean;
  rejectionDetail?: ConversionDiagnostic;
  suggestionRejectedReason?: "diverged" | "speculative" | "protected" | "reading" | "unconvertible";
  attempts?: Array<{ stage: "normal" | "correction" | "speculative"; outcome: "candidate" | "rejected"; detail?: ConversionDiagnostic }>;
}

export interface JapaneseConversionOptions {
  kanaEngine?: import("./kanaEngine").KanaEngine;
  anchor?: import("./types").ConversionAnchor;
  contextBefore?: string;
  contextAfter?: string;
  rerank?: boolean;
  onLocalCandidates?: (result: JapaneseConversionResult) => void;
  /** UI-owned bounded queue; omitted by evaluation callers that await ranking. */
  deferRanking?: (run: () => Promise<void>, skip: () => void) => void;
  onRankedCandidates?: (result: JapaneseConversionResult) => void | Promise<void>;
  /** Disable correction/speculation for dictionary-only measurements. */
  autoRescue?: boolean;
  onRescueStart?: () => void;
  /** Rescue stages must supply a reading, not legacy unvalidated plain text. */
  requireStructuredResponse?: boolean;
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
