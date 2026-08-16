import { describe, expect, it } from "vitest";
import {
  DEFAULT_TYPING_INTERVAL_MS,
  estimateTypingIntervalMs,
  inputPauseDurationMs,
} from "./predictiveSuggestions";

describe("input pause timing", () => {
  it("uses the median of recent realistic typing intervals", () => {
    expect(estimateTypingIntervalMs([170, 175, 180, 10, 2_000])).toBe(175);
    expect(estimateTypingIntervalMs([170, 175])).toBe(DEFAULT_TYPING_INTERVAL_MS);
  });

  it("matches the three pause profiles at 5.7 keys per second", () => {
    expect(inputPauseDurationMs([], "early")).toBe(316);
    expect(inputPauseDurationMs([], "auto")).toBe(439);
    expect(inputPauseDurationMs([], "deliberate")).toBe(614);
  });

  it("clamps very fast and slow input to stable pause ranges", () => {
    const fastIntervals = [35, 35, 35];
    const slowIntervals = [800, 800, 800];

    expect(inputPauseDurationMs(fastIntervals, "early")).toBe(220);
    expect(inputPauseDurationMs(fastIntervals, "auto")).toBe(300);
    expect(inputPauseDurationMs(fastIntervals, "deliberate")).toBe(450);
    expect(inputPauseDurationMs(slowIntervals, "early")).toBe(450);
    expect(inputPauseDurationMs(slowIntervals, "auto")).toBe(650);
    expect(inputPauseDurationMs(slowIntervals, "deliberate")).toBe(900);
  });
});
