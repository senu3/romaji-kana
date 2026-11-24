import { describe, expect, it, vi } from "vitest";
import { resolveCompletion } from "../../../src/lib/completionResolver";

function afterIme(doc: string) {
  return {
    doc, cursor: doc.length, ime: true, committed: false, targets: [],
    choices: [], personal: [], lookup: vi.fn(), lookupSurface: vi.fn(), signal: new AbortController().signal,
  };
}

describe("completion after an IME commit", () => {
  it("prefers enabled personal terms over learned and document terms", async () => {
    const request = afterIme("東京駅に着いた。\n東京");
    const word = { id: "1", reading: "とうきょうししゃ", text: "東京支社", enabled: true, pos: "organization" as const };
    const choices = [{ reading: "とうきょうと", text: "東京都", count: 3, updated: 1 }];
    expect(await resolveCompletion({ ...request, personal: [word], choices })).toMatchObject({ text: "支社" });
    expect(await resolveCompletion({ ...request, personal: [{ ...word, enabled: false }], choices })).toMatchObject({ text: "都" });
    expect(request.lookup).not.toHaveBeenCalled();
  });

  it("reuses a sentence after a kana-ending commit", async () => {
    expect(await resolveCompletion(afterIme("詳細は後ほど共有します。\n詳細は"))).toMatchObject({ text: "後ほど共有します。" });
  });

  it("ignores a partial term inside fenced code", async () => {
    expect(await resolveCompletion(afterIme("設計書を確認する。\n```\n設計"))).toBeNull();
  });
});
