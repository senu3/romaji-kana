import { describe, expect, it } from "vitest";
import {
  DEFAULT_TYPING_SPEED_CPS,
  estimateTypingSpeedCps,
  isNaturalRomajiBoundary,
  predictiveSuggestionThresholds,
} from "./predictiveSuggestions";

describe("predictive suggestion timing", () => {
  it("starts around 10 characters and refreshes around 4 at 5.7 keys per second", () => {
    expect(predictiveSuggestionThresholds(5.7, "auto")).toEqual({
      initial: 10,
      continuation: 4,
    });
  });

  it("keeps automatic thresholds within the supported range", () => {
    expect(predictiveSuggestionThresholds(1, "auto")).toEqual({
      initial: 6,
      continuation: 3,
    });
    expect(predictiveSuggestionThresholds(12, "auto")).toEqual({
      initial: 12,
      continuation: 6,
    });
  });

  it("offers stable early and deliberate timing profiles", () => {
    expect(predictiveSuggestionThresholds(5.7, "early")).toEqual({
      initial: 7,
      continuation: 3,
    });
    expect(predictiveSuggestionThresholds(5.7, "deliberate")).toEqual({
      initial: 12,
      continuation: 5,
    });
  });

  it("uses the median of recent realistic typing intervals", () => {
    expect(estimateTypingSpeedCps([170, 175, 180, 10, 2_000])).toBeCloseTo(1_000 / 175);
    expect(estimateTypingSpeedCps([170, 175])).toBe(DEFAULT_TYPING_SPEED_CPS);
  });

  it("recognizes vowel and explicit n boundaries", () => {
    expect(isNaturalRomajiBoundary("ashitakaigi")).toBe(true);
    expect(isNaturalRomajiBoundary("konn")).toBe(true);
    expect(isNaturalRomajiBoundary("ashitakaig")).toBe(false);
  });
});
