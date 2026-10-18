// Evaluation-only conversion baseline: a89d523. Never import from production.
import type { ProtectedDictionaryEntry } from "../../../src/lib/conversionInput";
import type { ConversionChanges } from "./conversionChanges";
import type { ReadingVerifier } from "./readingAssessment";
import type { ConversionDiagnostic } from "../../../src/lib/conversionDiagnostics";

export interface JapaneseConversionResult {
  session?: import("./conversionSession").ConversionSession;
  text: string;
  reviewKana: string;
  changes?: ConversionChanges;
  conversionStrategy?: "completion" | "speculative";
  romajiCorrection?: { partIndex: number; offset: number; inserted: string; before: string; after: string };
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
  /** Experimental branch: search one internal missing romaji letter before model repair. */
  missingLetterCorrection?: boolean;
  onMissingLetterSearch?: (metrics: { generated: number; searched: number; engineCalls: number; candidates: number; truncated: boolean; searchMs: number; elapsedMs: number }) => void;
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
  /** The user rejected a valid conversion in this occurrence; reinterpret the original input. */
  userRequestedSpeculation?: boolean;
  completionSourceRomaji?: string;
  protectedDictionaryEntries?: ProtectedDictionaryEntry[];
  documentVocabulary?: string[];
  signal?: AbortSignal;
}
