import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDocumentSession,
  loadDocumentSession,
  saveFileDocumentSession,
  saveNewDocumentSession,
} from "./documentStore";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
});

describe("documentStore", () => {
  it("starts with an empty new document session", () => {
    expect(loadDocumentSession()).toEqual({ kind: "new", content: "" });
  });

  it("restores unsaved new document content", () => {
    saveNewDocumentSession("# memo\nwatashihanihongogasukidesu.");

    expect(loadDocumentSession()).toEqual({
      kind: "new",
      content: "# memo\nwatashihanihongogasukidesu.",
    });
  });

  it("restores the previous file path without storing file content as a draft", () => {
    saveFileDocumentSession("C:\\notes\\memo.md");

    expect(loadDocumentSession()).toEqual({ kind: "file", path: "C:\\notes\\memo.md" });
  });

  it("falls back from the legacy document snapshot as an unsaved new document", () => {
    storage.set("romaji-kana-document", "# old draft");

    expect(loadDocumentSession()).toEqual({ kind: "new", content: "# old draft" });
  });

  it("clears the stored document session", () => {
    saveNewDocumentSession("# memo");
    clearDocumentSession();
    expect(storage.get("romaji-kana-document-session")).toBeUndefined();
    expect(storage.get("romaji-kana-document")).toBeUndefined();
  });
});
