import type { InputPauseTiming } from "./types";

export const DEFAULT_TYPING_INTERVAL_MS = 1_000 / 5.7;
export const MIN_TYPING_INTERVAL_MS = 35;
export const MAX_TYPING_INTERVAL_MS = 800;
export const TYPING_SPEED_SAMPLE_SIZE = 12;

interface PauseProfile {
  multiplier: number;
  minimumMs: number;
  maximumMs: number;
}

const PAUSE_PROFILES: Record<InputPauseTiming, PauseProfile> = {
  early: {
    multiplier: 1.8,
    minimumMs: 220,
    maximumMs: 450,
  },
  auto: {
    multiplier: 2.5,
    minimumMs: 300,
    maximumMs: 650,
  },
  deliberate: {
    multiplier: 3.5,
    minimumMs: 450,
    maximumMs: 900,
  },
};

export function estimateTypingIntervalMs(intervals: readonly number[]): number {
  const validIntervals = intervals
    .filter((interval) => interval >= MIN_TYPING_INTERVAL_MS && interval <= MAX_TYPING_INTERVAL_MS)
    .slice(-TYPING_SPEED_SAMPLE_SIZE)
    .sort((left, right) => left - right);

  if (validIntervals.length < 3) {
    return DEFAULT_TYPING_INTERVAL_MS;
  }

  const middle = Math.floor(validIntervals.length / 2);
  return validIntervals.length % 2 === 0
    ? (validIntervals[middle - 1] + validIntervals[middle]) / 2
    : validIntervals[middle];
}

export function inputPauseDurationMs(
  intervals: readonly number[],
  timing: InputPauseTiming,
): number {
  const profile = PAUSE_PROFILES[timing];
  return clamp(
    Math.round(estimateTypingIntervalMs(intervals) * profile.multiplier),
    profile.minimumMs,
    profile.maximumMs,
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
