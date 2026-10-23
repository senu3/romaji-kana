import { createId } from "./id";
import type { JapaneseConversionResult } from "./japaneseConversionTypes";
import type { EngineToken } from "./kanaEngine";
import type { ConversionAnchor } from "./types";

export interface SessionCandidate {
  readingPlanId?: string;
  id: string;
  kind: "conversion" | "correction" | "proposal";
  result: JapaneseConversionResult;
  cost?: number;
  tokens?: EngineToken[];
}
export interface ConversionSession {
  readingPlans: ReadingPlan[];
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
export interface ReadingPlan {
  id: string;
  kind: SessionCandidate["kind"];
  sourceReading: string;
  correctedReading?: string;
  reading: string;
}
export function createConversionSession(input: string, candidates: SessionCandidate[], context: {
  anchor?: ConversionAnchor; contextBefore?: string; contextAfter?: string;
} = {}): ConversionSession {
  const readingPlans: ReadingPlan[] = [];
  const planned = candidates.map(candidate => {
    const changes = candidate.result.changes;
    const plan = {
      kind: candidate.kind, sourceReading: changes?.sourceReading ?? candidate.result.reviewKana,
      correctedReading: changes?.correctedReading, reading: changes?.resultReading ?? candidate.result.reviewKana
    };
    let found = readingPlans.find(p => p.kind === plan.kind && p.sourceReading === plan.sourceReading &&
      p.correctedReading === plan.correctedReading && p.reading === plan.reading);
    if (!found) { found = { ...plan, id: `reading-${readingPlans.length}` }; readingPlans.push(found); }
    return { ...candidate, readingPlanId: found.id };
  });
  return {
    id: createId("session"), originalInput: input, candidates: planned, readingPlans,
    selectedId: candidates[0]?.id ?? "", contextBefore: context.contextBefore ?? "", contextAfter: context.contextAfter ?? "",
    anchor: context.anchor ? { ...context.anchor } : undefined,
    locked: false, state: "open", rerankStatus: "skipped", truncated: false
  };
}
export function sessionResult(session: ConversionSession): JapaneseConversionResult {
  const candidate = session.candidates.find(c => c.id === session.selectedId);
  if (!candidate) throw new Error("変換候補がありません。");
  return { ...candidate.result, session };
}

export function lockConversionSession(session?: ConversionSession): void {
  if (session) session.locked = true;
}

export function acceptConversionSession(session?: ConversionSession): void {
  if (session?.state === "open") {
    session.state = "accepted";
    session.locked = true;
  }
}

export function dismissConversionSession(session?: ConversionSession): void {
  if (session?.state === "open") session.state = "dismissed";
}

export function applySessionRanking(session: ConversionSession, ids: unknown): boolean {
  if (session.locked || session.state !== "open") return false;
  if (!Array.isArray(ids) || !ids.length || ids.length > session.candidates.length || new Set(ids).size !== ids.length) return false;
  const candidates = new Map(session.candidates.map(c => [c.id, c]));
  if (!ids.every(id => typeof id === "string" && candidates.has(id))) return false;
  session.candidates = [...ids.map(id => candidates.get(id)!), ...session.candidates.filter(c => !ids.includes(c.id))];
  session.selectedId = session.candidates[0].id;
  return true;
}
