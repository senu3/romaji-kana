import type { PredictiveSuggestionTiming } from "./types";

export const DEFAULT_TYPING_SPEED_CPS = 5.7;
export const PREDICTIVE_PAUSE_MS = 400;
export const MIN_SPACE_TRIGGER_ROMAJI_CHARACTERS = 4;
export const MIN_TYPING_INTERVAL_MS = 35;
export const MAX_TYPING_INTERVAL_MS = 800;
export const TYPING_SPEED_SAMPLE_SIZE = 12;

interface TimingProfile {
  initialSeconds: number;
  initialMinimum: number;
  initialMaximum: number;
  continuationSeconds: number;
  continuationMinimum: number;
  continuationMaximum: number;
}

export interface PredictiveSuggestionThresholds {
  initial: number;
  continuation: number;
}

const TIMING_PROFILES: Record<PredictiveSuggestionTiming, TimingProfile> = {
  early: {
    initialSeconds: 1.25,
    initialMinimum: 5,
    initialMaximum: 10,
    continuationSeconds: 0.5,
    continuationMinimum: 2,
    continuationMaximum: 5,
  },
  auto: {
    initialSeconds: 1.7,
    initialMinimum: 6,
    initialMaximum: 12,
    continuationSeconds: 0.7,
    continuationMinimum: 3,
    continuationMaximum: 6,
  },
  deliberate: {
    initialSeconds: 2.1,
    initialMinimum: 8,
    initialMaximum: 14,
    continuationSeconds: 0.9,
    continuationMinimum: 4,
    continuationMaximum: 7,
  },
};

export function countRomajiCharacters(text: string): number {
  return text.match(/[A-Za-z]/g)?.length ?? 0;
}

export function estimateTypingSpeedCps(intervals: readonly number[]): number {
  const validIntervals = intervals
    .filter((interval) => interval >= MIN_TYPING_INTERVAL_MS && interval <= MAX_TYPING_INTERVAL_MS)
    .slice(-TYPING_SPEED_SAMPLE_SIZE)
    .sort((left, right) => left - right);

  if (validIntervals.length < 3) {
    return DEFAULT_TYPING_SPEED_CPS;
  }

  const middle = Math.floor(validIntervals.length / 2);
  const median =
    validIntervals.length % 2 === 0
      ? (validIntervals[middle - 1] + validIntervals[middle]) / 2
      : validIntervals[middle];

  return clamp(1_000 / median, 1, 12);
}

export function predictiveSuggestionThresholds(
  typingSpeedCps: number,
  timing: PredictiveSuggestionTiming,
): PredictiveSuggestionThresholds {
  const profile = TIMING_PROFILES[timing];
  return {
    initial: clamp(
      Math.round(typingSpeedCps * profile.initialSeconds),
      profile.initialMinimum,
      profile.initialMaximum,
    ),
    continuation: clamp(
      Math.round(typingSpeedCps * profile.continuationSeconds),
      profile.continuationMinimum,
      profile.continuationMaximum,
    ),
  };
}

export function isNaturalRomajiBoundary(text: string): boolean {
  return /[aiueo]$/i.test(text) || /nn$/i.test(text);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
