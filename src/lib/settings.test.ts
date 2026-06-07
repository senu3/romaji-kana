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
  it("normalizes user homophone preferences", () => {
    storage.set(
      "romaji-kana-settings",
      JSON.stringify({
        ...defaultSettings,
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

    expect(loadSettings().userHomophones).toEqual([
      {
        id: "goji",
        reading: "ごじ",
        preferred: "誤字",
        replaceFrom: ["五時", "ごじ"],
        note: "conversion notes",
        enabled: true,
      },
    ]);
  });
});
