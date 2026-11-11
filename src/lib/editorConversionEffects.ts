import { StateEffect } from "@codemirror/state";
import type { GhostConversionSuggestion } from "./types";
import type { SuggestTarget } from "./autoSuggest";

export const addLoadingDecoration = StateEffect.define<{ id: string; from: number; to: number }>();
export const removeLoadingDecoration = StateEffect.define<string>();
export const showGhostSuggestion = StateEffect.define<GhostConversionSuggestion>();
export const clearGhostSuggestion = StateEffect.define<string | null>();
export const rememberPauseConversion = StateEffect.define<{ from: number; to: number; original: string }>();
export const suggestAfterConversion = StateEffect.define<SuggestTarget>();
