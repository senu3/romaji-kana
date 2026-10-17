import { describe, expect, it } from "vitest";
import { applySessionRanking, createConversionSession, nextSessionCandidate } from "./conversionSession";
import { assessReading } from "./readingAssessment";
import { normalizePersonalDictionary } from "./settings";

describe("conversion session contracts", () => {
  const make = () => createConversionSession("kisha", [
    { id: "one", kind: "conversion", result: { text: "記者", reviewKana: "きしゃ" } },
    { id: "two", kind: "conversion", result: { text: "汽車", reviewKana: "きしゃ" } },
  ]);
  it("cycles stored candidates without generating new output and locks order", () => {
    const session = make();
    expect(nextSessionCandidate(session)?.text).toBe("汽車");
    expect(applySessionRanking(session, ["two", "one"])).toBe(false);
    expect(nextSessionCandidate(session)?.text).toBe("記者");
  });
  it.each(["accepted", "dismissed"] as const)("ignores late ranks in a %s session", state => {
    const session = make(); session.state = state;
    expect(applySessionRanking(session, ["two", "one"])).toBe(false);
    expect(nextSessionCandidate(session)).toBeUndefined();
  });
  it("keeps incomplete dictionary knowledge unverified", () => {
    const verifier = { verify: () => "unverified" as const };
    expect(assessReading("未知語", "みちご", true, verifier).status).toBe("unverified");
  });
  it("normalizes lexical readings without promoting arbitrary shortcuts to pronunciations", () => {
    expect(normalizePersonalDictionary([
      { id: "company", reading: "テストシャ", text: "試験社", pos: "organization" },
      { reading: "abbr", text: "長い定型文" },
      { reading: "よみ", text: "本文\n追加" },
    ])).toEqual([{ id: "company", reading: "てすとしゃ", text: "試験社", pos: "organization", enabled: true }]);
  });
});
