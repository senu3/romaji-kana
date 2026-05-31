import { describe, expect, it } from "vitest";
import { resolveConversionAnchor } from "./historyAnchor";
import type { ConversionAnchor } from "./types";

const anchor: ConversionAnchor = {
  from: 6,
  to: 13,
  originalText: "watashi.",
  appliedText: "私。",
  docVersion: 3,
};

describe("resolveConversionAnchor", () => {
  it("resolves the previous applied conversion at the stored position", () => {
    expect(resolveConversionAnchor("hello 私。", anchor)).toEqual({
      from: 6,
      to: 8,
      matchedText: "私。",
      matchedBy: "exact",
    });
  });

  it("resolves the original romaji at the stored position after undo", () => {
    expect(resolveConversionAnchor("hello watashi.", anchor)).toEqual({
      from: 6,
      to: 14,
      matchedText: "watashi.",
      matchedBy: "exact",
    });
  });

  it("finds a nearby shifted anchor after earlier edits", () => {
    expect(resolveConversionAnchor("prefix hello 私。", anchor)).toEqual({
      from: 13,
      to: 15,
      matchedText: "私。",
      matchedBy: "nearby",
    });
  });

  it("returns null when the target is gone or ambiguous", () => {
    expect(resolveConversionAnchor("hello converted", anchor)).toBeNull();
    expect(resolveConversionAnchor("私。    hello    私。", anchor)).toBeNull();
  });
});
