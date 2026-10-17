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
  it.each([true, false])("migrates the old shared space switch to both triggers: %s", space => {
    storage.set("romaji-kana-settings", JSON.stringify({ triggers: { space } }));
    expect(loadSettings().triggers).toMatchObject({ space, typing: space });
  });
  it("keeps independent pause and space settings after loading and sharing", () => {
    storage.set("romaji-kana-settings", JSON.stringify({ triggers: { typing: false, space: true } }));
    const loaded = loadSettings();
    expect(loaded.triggers).toMatchObject({ typing: false, space: true });
    expect(mergeSharedConversionSettings(defaultSettings, sharedConversionSettings(loaded)).triggers).toMatchObject({ typing: false, space: true });
  });
  it("uses pause-based suggestions and discards the previous timing field", () => {
    expect(loadSettings().triggers.space).toBe(true);
    expect(loadSettings().inputPauseTiming).toBe("auto");
    expect(loadSettings().inputCompletionLevel).toBe("none");

    storage.set(
      "romaji-kana-settings",
      JSON.stringify({
        triggers: { period: false },
        predictiveSuggestionTiming: "early",
      }),
    );
    expect(loadSettings().triggers.space).toBe(true);
    expect(loadSettings().triggers.period).toBe(false);
    expect(loadSettings().inputPauseTiming).toBe("auto");
    expect(loadSettings()).not.toHaveProperty("predictiveSuggestionTiming");
  });

  it("restores only supported input pause timing", () => {
    storage.set(
      "romaji-kana-settings",
      JSON.stringify({ ...defaultSettings, inputPauseTiming: "early" }),
    );
    expect(loadSettings().inputPauseTiming).toBe("early");

    storage.set(
      "romaji-kana-settings",
      JSON.stringify({ ...defaultSettings, inputPauseTiming: "instant" }),
    );
    expect(loadSettings().inputPauseTiming).toBe("auto");
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
    expect(merged.inputPauseTiming).toBe("auto");
  });
});
