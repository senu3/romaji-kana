import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, loadSettings } from "./settings";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  });
});

describe("loadSettings", () => {
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
});
