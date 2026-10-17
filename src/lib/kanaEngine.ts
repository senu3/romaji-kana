import { invoke, isTauri } from "@tauri-apps/api/core";
import { isRemoteCompanionClient, remoteJson } from "./companion";

export interface PersonalWord {
  id: string;
  reading: string;
  text: string;
  pos: "noun" | "proper" | "person" | "organization";
  enabled: boolean;
}
export interface EngineToken {
  reading: string;
  text: string;
  /** Unicode scalar offsets within this segment's reading. */
  from: number;
  to: number;
  source: "mozc" | "user" | "literal";
  entryId: string;
  lid: number;
  rid: number;
  wordCost: number;
}
export interface EngineCandidate { text: string; reading: string; cost: number; tokens: EngineToken[] }
export interface EngineSearchResult { candidates: EngineCandidate[]; truncated: boolean; dictionaryRevision: string }
export interface KanaEngine {
  search(reading: string, words: readonly PersonalWord[], signal?: AbortSignal): Promise<EngineSearchResult>;
  verify(text: string, reading: string, words: readonly PersonalWord[], signal?: AbortSignal): Promise<"verified" | "unverified" | "contradicted">;
}

async function request<T>(body: object, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const task = isTauri() ? invoke<T>("kana_engine_request", { request: body })
    : isRemoteCompanionClient() ? remoteJson<T>("/api/kana-engine", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    }) : fetch("/api/kana-engine", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    }).then(async response => {
      const value = await response.json();
      if (!response.ok || value.error) throw new Error(value.error || "かな漢字エンジンに接続できませんでした。");
      return value as T;
    });
  const result = await task;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return result;
}
export const defaultKanaEngine: KanaEngine = {
  search: (reading, words, signal) => request<EngineSearchResult>({ operation: "search", reading, words: words.filter(w => w.enabled), limit: 24 }, signal),
  verify: async (text, reading, words, signal) => (await request<{ status: "verified" | "unverified" | "contradicted" }>({
    operation: "verify", text, reading, words: words.filter(w => w.enabled),
  }, signal)).status,
};
