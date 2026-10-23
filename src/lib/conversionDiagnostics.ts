/** Machine-readable rejection details; existing UI rejection categories remain compatible. */
export type ConversionDiagnostic = "response-format" | "reading-format" | "protected-content" |
  "local-correction" | "completion-shape" | "text-length" | "avoided-output" | "fixed-reading" |
  "reading-contradiction" | "speculative-policy" | "no-candidate" | "unresolved-reading" | "no-plausible-candidate" | "ranking-invalid";

export class ConversionResponseError extends Error {
  constructor(readonly diagnostic: "response-format" | "reading-format", message: string) {
    super(message);
    this.name = "ConversionResponseError";
  }
}
