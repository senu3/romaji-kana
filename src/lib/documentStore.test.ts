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

  it("restores a clean file session", () => {
    saveFileDocumentSession("C:\\notes\\memo.md", "# saved", false);

    expect(loadDocumentSession()).toEqual({
      kind: "file",
      path: "C:\\notes\\memo.md",
      content: "# saved",
      dirty: false,
    });
  });

  it("restores unsaved edits for a file-backed document", () => {
    saveFileDocumentSession("C:\\notes\\memo.md", "# edited draft", true);

    expect(loadDocumentSession()).toEqual({
      kind: "file",
      path: "C:\\notes\\memo.md",
      content: "# edited draft",
      dirty: true,
    });
  });

  it("migrates a legacy path-only file session", () => {
    storage.set(
      "romaji-kana-document-session",
      JSON.stringify({ kind: "file", path: "C:\\notes\\memo.md" }),
    );

    expect(loadDocumentSession()).toEqual({
      kind: "file",
      path: "C:\\notes\\memo.md",
      content: "",
      dirty: false,
    });
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
