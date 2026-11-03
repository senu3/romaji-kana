// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, loadSettings, mergeSharedConversionSettings, saveSettings, sharedConversionSettings } from "../../../src/lib/settings";
describe("current settings contract", () => {
  beforeEach(() => localStorage.clear());
  it("contains neither completion mode nor comparative engine settings", () => {
    expect(defaultSettings).not.toHaveProperty("inputCompletionLevel");
    expect(defaultSettings).not.toHaveProperty("conversionEngine");
    saveSettings(defaultSettings);
    expect(JSON.parse(localStorage.getItem("romaji-kana-settings")!)).toEqual(defaultSettings);
  });
  it("persists current preferences and shares them without model credentials", () => {
    const settings = { ...defaultSettings, inputPauseTiming: "deliberate" as const, think: true, autoSuggest: false, autoSpeculation: true };
    saveSettings(settings);
    expect(loadSettings()).toEqual(settings);
    const shared = sharedConversionSettings(settings);
    expect(shared).not.toHaveProperty("modelName");
    expect(shared).not.toHaveProperty("conversionEngine");
    expect(mergeSharedConversionSettings(defaultSettings, shared).inputPauseTiming).toBe("deliberate");
    expect(mergeSharedConversionSettings(defaultSettings, shared).autoSuggest).toBe(false);
    expect(shared.autoSpeculation).toBe(true);
    expect(mergeSharedConversionSettings(defaultSettings, shared).autoSpeculation).toBe(true);
  });
  it("keeps automatic speculation opt-in for older and invalid settings", () => {
    expect(defaultSettings.autoSpeculation).toBe(false);
    for (const autoSpeculation of [undefined, false, "true", 1, null]) {
      localStorage.setItem("romaji-kana-settings", JSON.stringify({ autoSpeculation }));
      expect(loadSettings().autoSpeculation).toBe(false);
    }
    const { autoSpeculation: _omitted, ...legacy } = sharedConversionSettings(defaultSettings);
    expect(mergeSharedConversionSettings({ ...defaultSettings, autoSpeculation: true }, legacy as ReturnType<typeof sharedConversionSettings>).autoSpeculation).toBe(false);
  });
  it("does not restore unknown settings or obsolete policy migrations", () => {
    localStorage.setItem("romaji-kana-settings", JSON.stringify({ userDictionary: [{ reading: "hon", output: "obsolete" }], inputCompletionLevel: "word", conversionEngine: "llm", thinkingMode: "on" }));
    expect(loadSettings()).toEqual(defaultSettings);
  });
});
