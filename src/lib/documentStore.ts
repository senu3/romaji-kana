const DOCUMENT_STORAGE_KEY = "romaji-kana-document";

export const sampleDocument =
  "anatahadonnakotogasukidesuka.\n\n## memo\n- kyouhayoi tenkidesu.";

export function loadDocument(): string {
  try {
    return localStorage.getItem(DOCUMENT_STORAGE_KEY) ?? sampleDocument;
  } catch {
    return sampleDocument;
  }
}

export function saveDocument(documentText: string): void {
  localStorage.setItem(DOCUMENT_STORAGE_KEY, documentText);
}
