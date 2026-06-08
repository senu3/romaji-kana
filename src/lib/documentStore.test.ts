import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDocument, emptyDocument, loadDocument, saveDocument } from "./documentStore";

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
  it("starts with an empty new document", () => {
    expect(loadDocument()).toBe(emptyDocument);
  });

  it("does not restore the previous document on app startup", () => {
    saveDocument("# memo\nwatashihanihongogasukidesu.");
    expect(loadDocument()).toBe(emptyDocument);
  });

  it("clears the stored document snapshot", () => {
    saveDocument("# memo");
    clearDocument();
    expect(storage.get("romaji-kana-document")).toBeUndefined();
  });
});
