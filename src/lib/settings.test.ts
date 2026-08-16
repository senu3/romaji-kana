import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  loadSettings,
  mergeSharedConversionSettings,
  sharedConversionSettings,
} from "./settings";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  });
});

describe("loadSettings", () => {
  it("enables space suggestions for new and legacy settings", () => {
    expect(loadSettings().triggers.space).toBe(true);

    storage.set(
      "romaji-kana-settings",
      JSON.stringify({ triggers: { period: false } }),
    );
    expect(loadSettings().triggers.space).toBe(true);
    expect(loadSettings().triggers.period).toBe(false);
  });

  it("drops removed homophone settings while preserving dictionary entries", () => {
    storage.set(
      "romaji-kana-settings",
      JSON.stringify({
        ...defaultSettings,
        userDictionary: [
          {
            id: "openai",
            reading: "openai",
            output: "OpenAI",
            note: "company name",
            enabled: true,
          },
        ],
        userHomophones: [
          {
            id: "goji",
            reading: "ごじ",
            preferred: "誤字",
            replaceFrom: ["五時", " ごじ ", "五時"],
            note: "conversion notes",
            enabled: true,
          },
          {
            id: "romaji",
            reading: "goji",
            preferred: "誤字",
            note: "",
            enabled: true,
          },
          {
            id: "missing",
            reading: "みち",
            preferred: "",
            note: "",
            enabled: true,
          },
        ],
      }),
    );

    expect(loadSettings()).not.toHaveProperty("userHomophones");
    expect(loadSettings().userDictionary).toEqual([
      {
        id: "openai",
        reading: "openai",
        output: "OpenAI",
        note: "company name",
        enabled: true,
      },
    ]);
  });

  it("defaults unknown or missing input completion settings to faithful conversion", () => {
    storage.set(
      "romaji-kana-settings",
      JSON.stringify({ ...defaultSettings, inputCompletionLevel: "creative" }),
    );
    expect(loadSettings().inputCompletionLevel).toBe("none");

    storage.set(
      "romaji-kana-settings",
      JSON.stringify({ modelName: "local-model" }),
    );
    expect(loadSettings().inputCompletionLevel).toBe("none");
  });

  it("restores supported input completion levels", () => {
    storage.set(
      "romaji-kana-settings",
      JSON.stringify({ ...defaultSettings, inputCompletionLevel: "sentence" }),
    );
    expect(loadSettings().inputCompletionLevel).toBe("sentence");
  });

  it("keeps document vocabulary opt-in and restores an explicit choice", () => {
    storage.set(
      "romaji-kana-settings",
      JSON.stringify({ modelName: "local-model" }),
    );
    expect(loadSettings().useDocumentVocabulary).toBe(false);

    storage.set(
      "romaji-kana-settings",
      JSON.stringify({ ...defaultSettings, useDocumentVocabulary: true }),
    );
    expect(loadSettings().useDocumentVocabulary).toBe(true);
  });

  it("shares conversion preferences without replacing PC model settings", () => {
    const mobileSettings = {
      ...defaultSettings,
      modelName: "mobile-copy",
      conversionMode: "ghost" as const,
      inputCompletionLevel: "word" as const,
    };
    const desktopSettings = {
      ...defaultSettings,
      modelName: "desktop-model",
    };

    const merged = mergeSharedConversionSettings(
      desktopSettings,
      sharedConversionSettings(mobileSettings),
    );

    expect(merged.modelName).toBe("desktop-model");
    expect(merged.conversionMode).toBe("ghost");
    expect(merged.inputCompletionLevel).toBe("word");
  });
});
