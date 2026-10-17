import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AppSettings, SharedConversionSettings } from "./types";

const REMOTE_TOKEN_KEY = "romaji-kana-companion-token";

export interface CompanionStatus {
  running: boolean;
  port: number;
  urls: string[];
  pairCode?: string | null;
  pairedClients: number;
}

export interface CompanionDocument {
  content: string;
  fileName: string;
  revision: number;
  updatedBy: string;
}

export interface CompanionSnapshot {
  document: CompanionDocument;
  settings: AppSettings;
  settingsUpdatedBy: string;
}

export function isRemoteCompanionClient(): boolean {
  return (
    typeof window !== "undefined" &&
    !isTauri() &&
    (window.location.pathname === "/remote" || window.location.pathname.startsWith("/remote/"))
  );
}

export function hasRemoteCompanionToken(): boolean {
  return Boolean(readRemoteToken());
}

export async function pairRemoteCompanion(code: string): Promise<void> {
  const response = await fetch("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim() }),
  });
  const data = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !data.token) {
    throw new Error(data.error || "PCとペアリングできませんでした。");
  }
  localStorage.setItem(REMOTE_TOKEN_KEY, data.token);
}

export function clearRemoteCompanionToken(): void {
  localStorage.removeItem(REMOTE_TOKEN_KEY);
}

export async function startCompanion(
  content: string,
  fileName: string,
  settings: AppSettings,
): Promise<CompanionStatus> {
  return invoke<CompanionStatus>("companion_start", {
    request: { content, fileName, settings },
  });
}

export async function stopCompanion(): Promise<CompanionStatus> {
  return invoke<CompanionStatus>("companion_stop");
}

export async function getCompanionStatus(): Promise<CompanionStatus> {
  return invoke<CompanionStatus>("companion_status");
}

export async function updateCompanionSettings(
  settings: AppSettings,
  clientId: string,
): Promise<void> {
  return invoke<void>("companion_update_settings", { settings, clientId });
}

export async function updateCompanionConversionSettings(
  settings: SharedConversionSettings,
  clientId: string,
): Promise<CompanionSnapshot> {
  return remoteJson<CompanionSnapshot>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings, clientId }),
  });
}

export async function getCompanionState(): Promise<CompanionSnapshot> {
  if (isRemoteCompanionClient()) {
    return remoteJson<CompanionSnapshot>("/api/state", { method: "GET" });
  }
  return invoke<CompanionSnapshot>("companion_get_state");
}

export async function updateCompanionDocument(
  content: string,
  fileName: string,
  clientId: string,
): Promise<CompanionSnapshot> {
  const request = { content, fileName, clientId };
  if (isRemoteCompanionClient()) {
    return remoteJson<CompanionSnapshot>("/api/document", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }
  return invoke<CompanionSnapshot>("companion_update_document", { request });
}

export async function remoteModelRequest<T>(
  path: "models" | "generate",
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await remoteJson<T>(`/api/${path}`, {
      method: path === "models" ? "GET" : "POST",
      headers: path === "generate" ? { "Content-Type": "application/json" } : undefined,
      body: path === "generate" ? JSON.stringify({ body, timeoutMs }) : undefined,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function remoteJson<T>(path: string, init: RequestInit): Promise<T> {
  const token = readRemoteToken();
  if (!token) {
    throw new Error("PCとのペアリング情報がありません。再度ペアリングしてください。");
  }
  const response = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 401) {
    clearRemoteCompanionToken();
    throw new Error(data.error || "ペアリングの有効期限が切れました。ページを再読み込みしてください。");
  }
  if (!response.ok) {
    throw new Error(data.error || `PCとの通信に失敗しました（HTTP ${response.status}）。`);
  }
  return data;
}

function readRemoteToken(): string {
  if (typeof localStorage === "undefined") {
    return "";
  }
  return localStorage.getItem(REMOTE_TOKEN_KEY)?.trim() ?? "";
}
