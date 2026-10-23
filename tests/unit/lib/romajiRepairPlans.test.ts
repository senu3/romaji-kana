import { expect, it } from "vitest";
import { acceptsRomajiRepair } from "../../../src/lib/romajiRepairPlans";

it("does not disguise two romaji substitutions as a small kana repair", () => {
  expect(acceptsRomajiRepair("wakkatahuriwosuru", "わかったふりをする")).toBe(false);
});

it.each([["jkan", "じかん"], ["yottei", "よてい"], ["yotie", "よてい"], ["yorei", "よてい"]])("accepts the same bounded edit for model and dictionary: %s", (input, reading) => {
  expect(acceptsRomajiRepair(input, reading)).toBe(true);
});
it.each([["hon", "ほんをよむ"], ["ikanai", "いく"], ["yotteiwokaknin", "よていをかくにん"], ["https://example.com", "https://sample.com"]])("rejects completion, negation changes, multiple edits and identifiers: %s", (input, reading) => {
  expect(acceptsRomajiRepair(input, reading)).toBe(false);
});
