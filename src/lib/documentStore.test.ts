import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDocument, sampleDocument, saveDocument } from "./documentStore";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
});

describe("documentStore", () => {
  it("loads the sample document when nothing has been saved", () => {
    expect(loadDocument()).toBe(sampleDocument);
  });

  it("saves and loads the editor document", () => {
    saveDocument("# memo\nwatashihanihongogasukidesu.");
    expect(loadDocument()).toBe("# memo\nwatashihanihongogasukidesu.");
  });
});
