import type { ConversionChanges } from "./conversionChanges";
import type { ConversionDiagnostic } from "./conversionDiagnostics";
import type { ProtectedDictionaryEntry } from "./conversionInput";
import type { ReadingVerifier } from "./readingAssessment";

export interface JapaneseConversionResult {
  session?: import("./conversionSession").ConversionSession;
  text: string;
  reviewKana: string;
  changes?: ConversionChanges;
  conversionStrategy?: "correction" | "speculative";
  romajiCorrection?: { partIndex: number; offset: number; inserted: string; before: string; after: string };

  suggestionRejected?: boolean;
  rejectionDetail?: ConversionDiagnostic;
  suggestionRejectedReason?: "diverged" | "speculative" | "protected" | "reading" | "unconvertible";
  attempts?: Array<{ stage: "normal" | "correction" | "speculative"; outcome: "candidate" | "rejected"; detail?: ConversionDiagnostic }>;
}

export interface JapaneseConversionOptions {
  /** Whole-request budget including deferred ranking and rescue; default 60s. */
  timeoutMs?: number;
  purpose?: "normal" | "correction" | "speculative";
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
  /** Isolate normal conversion and correction in evaluations; default preserves
   * the application's existing speculative rescue behavior. */
  autoSpeculation?: boolean;
  /** Experimental branch: search one internal missing romaji letter before model repair. */
  missingLetterCorrection?: boolean;
  onMissingLetterSearch?: (metrics: { generated: number; searched: number; engineCalls: number; candidates: number; truncated: boolean; searchMs: number; elapsedMs: number }) => void;
  onRescueStart?: () => void;

  /** Local independent verification, never a reference or saved setting. */
  readingVerifier?: ReadingVerifier;

  avoidOutputs?: string[];

  /** The user rejected a valid conversion in this occurrence; reinterpret the original input. */
  userRequestedSpeculation?: boolean;

  protectedDictionaryEntries?: ProtectedDictionaryEntry[];
  documentVocabulary?: string[];
  signal?: AbortSignal;
}
