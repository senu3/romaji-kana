const LEGACY_DOCUMENT_STORAGE_KEY = "romaji-kana-document";
const DOCUMENT_SESSION_STORAGE_KEY = "romaji-kana-document-session";

export type DocumentSession =
  | { kind: "new"; content: string }
  | { kind: "file"; path: string };

export function loadDocumentSession(): DocumentSession {
  try {
    const rawSession = localStorage.getItem(DOCUMENT_SESSION_STORAGE_KEY);
    if (rawSession) {
      return normalizeDocumentSession(JSON.parse(rawSession) as unknown);
    }

    const legacyContent = localStorage.getItem(LEGACY_DOCUMENT_STORAGE_KEY);
    if (legacyContent) {
      return { kind: "new", content: legacyContent };
    }
  } catch {
    return { kind: "new", content: "" };
  }

  return { kind: "new", content: "" };
}

export function saveNewDocumentSession(content: string): void {
  saveDocumentSession({ kind: "new", content });
}

export function saveFileDocumentSession(path: string): void {
  saveDocumentSession({ kind: "file", path });
}

export function clearDocumentSession(): void {
  localStorage.removeItem(DOCUMENT_SESSION_STORAGE_KEY);
  localStorage.removeItem(LEGACY_DOCUMENT_STORAGE_KEY);
}

function saveDocumentSession(session: DocumentSession): void {
  localStorage.setItem(DOCUMENT_SESSION_STORAGE_KEY, JSON.stringify(session));
  localStorage.removeItem(LEGACY_DOCUMENT_STORAGE_KEY);
}

function normalizeDocumentSession(value: unknown): DocumentSession {
  if (!value || typeof value !== "object") {
    return { kind: "new", content: "" };
  }

  const record = value as Record<string, unknown>;
  if (record.kind === "file" && typeof record.path === "string" && record.path.trim()) {
    return { kind: "file", path: record.path };
  }
  if (record.kind === "new" && typeof record.content === "string") {
    return { kind: "new", content: record.content };
  }

  return { kind: "new", content: "" };
}
