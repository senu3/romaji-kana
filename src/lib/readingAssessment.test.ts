import { describe, expect, it, vi } from "vitest";
import { assessReading, requiresExplicitAcceptance } from "./readingAssessment";
import { convertRomajiToJapaneseDetailed } from "./ollama";
import { defaultSettings as applicationSettings } from "./settings";
// These tests exercise the legacy model-generation contract.
const defaultSettings = { ...applicationSettings, conversionEngine: "llm" as const };

describe("independent reading evidence", () => {
  it("does not equate internally consistent model fields with independent verification", () => {
    expect(assessReading("書類の確認。", "しょるいのかくに。", true)).toEqual({ status: "unverified", origin: "model" });
    expect(assessReading("書類の確認。", "しょるいのかくにん。", true)).toEqual({ status: "unverified", origin: "model" });
    expect(assessReading("ありがとう。", "ありがとう。", true)).toMatchObject({ status: "verified", proof: "literal" });
  });
  it("accepts any independently listed pronunciation and leaves unknown words unverified", () => {
    const verifier = { lookupReadings: (text: string) => text === "今日" ? ["きょう", "こんにち"] : undefined };
    expect(assessReading("今日", "こんにち", true, verifier).status).toBe("verified");
    expect(assessReading("今日", "きょ", true, verifier).status).toBe("contradicted");
    expect(assessReading("未知", "みち", true, verifier).status).toBe("unverified");
  });
  it("retains an unverified model candidate with explicitly provisional change information", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ convertedText: "書類の確認。", completedKana: "しょるいのかくに。" }) });
    const result = await convertRomajiToJapaneseDetailed("shoruinokakuni.", defaultSettings, { models: vi.fn(), generate });
    expect(result.text).toBe("書類の確認。");
    expect(result.changes?.readingAssessment?.status).toBe("unverified");
    expect(requiresExplicitAcceptance(result)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("rejects a contradicted reading when an independent verifier is available", async () => {
    const generate = vi.fn().mockResolvedValue({ response: JSON.stringify({ convertedText: "確認。", completedKana: "かくに。" }) });
    const result = await convertRomajiToJapaneseDetailed("kakuni.", defaultSettings, { models: vi.fn(), generate }, {
      readingVerifier: { lookupReadings: () => ["かくにん。"] },
    });
    expect(result).toMatchObject({ text: "", suggestionRejectedReason: "reading" });
  });
  it("never auto-accepts missing evidence or model-only evidence", () => {
    expect(requiresExplicitAcceptance({})).toBe(true);
    expect(requiresExplicitAcceptance({ changes: { readingAssessment: { status: "unverified", origin: "model" } } })).toBe(true);
    expect(requiresExplicitAcceptance({ changes: { readingAssessment: { status: "verified", origin: "model", proof: "independent" } } })).toBe(false);
  });
});
