import type { JapaneseConversionResult } from "./japaneseConversionTypes";
import type { EngineToken } from "./kanaEngine";
import type { ConversionAnchor } from "./types";
import { createId } from "./id";

export interface SessionCandidate {
  id: string;
  kind: "conversion" | "correction" | "completion" | "proposal";
  result: JapaneseConversionResult;
  cost?: number;
  tokens?: EngineToken[];
}
export interface ConversionSession {
  id: string;
  originalInput: string;
  anchor?: ConversionAnchor;
  contextBefore: string;
  contextAfter: string;
  candidates: SessionCandidate[];
  selectedId: string;
  /** Shared across async producer and UI; selection permanently locks ordering. */
  locked: boolean;
  state: "open" | "accepted" | "dismissed";
  rerankStatus: "pending" | "applied" | "skipped" | "invalid" | "failed";
  truncated: boolean;
  dictionaryRevision?: string;
}
export function createConversionSession(input: string, candidates: SessionCandidate[], context: {
  anchor?: ConversionAnchor; contextBefore?: string; contextAfter?: string;
} = {}): ConversionSession {
  return { id: createId("session"), originalInput: input, candidates,
    selectedId: candidates[0]?.id ?? "", contextBefore: context.contextBefore ?? "", contextAfter: context.contextAfter ?? "",
    anchor: context.anchor ? { ...context.anchor } : undefined,
    locked: false, state: "open", rerankStatus: "skipped", truncated: false };
}
export function sessionResult(session: ConversionSession): JapaneseConversionResult {
  const candidate = session.candidates.find(c => c.id === session.selectedId);
  if (!candidate) throw new Error("変換候補がありません。");
  return { ...candidate.result, session };
}
export function nextSessionCandidate(session: ConversionSession): JapaneseConversionResult | undefined {
  if (session.state !== "open" || session.candidates.length < 2) return undefined;
  session.locked = true;
  const index = session.candidates.findIndex(c => c.id === session.selectedId);
  session.selectedId = session.candidates[(index + 1) % session.candidates.length].id;
  return sessionResult(session);
}
export function applySessionRanking(session: ConversionSession, ids: unknown): boolean {
  if (session.locked || session.state !== "open") return false;
  if (!Array.isArray(ids) || ids.length !== session.candidates.length || new Set(ids).size !== ids.length) return false;
  const candidates = new Map(session.candidates.map(c => [c.id, c]));
  if (!ids.every(id => typeof id === "string" && candidates.has(id))) return false;
  session.candidates = ids.map(id => candidates.get(id)!);
  session.selectedId = session.candidates[0].id;
  return true;
}
