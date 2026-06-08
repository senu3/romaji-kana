const DOCUMENT_STORAGE_KEY = "romaji-kana-document";

export const emptyDocument = "";

export function loadDocument(): string {
  return emptyDocument;
}

export function saveDocument(documentText: string): void {
  localStorage.setItem(DOCUMENT_STORAGE_KEY, documentText);
}

export function clearDocument(): void {
  localStorage.removeItem(DOCUMENT_STORAGE_KEY);
}
