import { describe, expect, it } from "vitest";
import {
  buildDocumentVocabularyProfile,
  MAX_DOCUMENT_VOCABULARY_TERMS,
} from "../../../src/lib/documentVocabulary";

describe("buildDocumentVocabularyProfile", () => {
  it("extracts and ranks repeated Japanese and named Latin terms", () => {
    const profile = buildDocumentVocabularyProfile([
      "要件定義を確認します。OpenAI とローカルモデルを使います。",
      "要件定義を更新して、ローカルモデルを再確認します。",
      "LM Studio も候補です。",
    ].join("\n"));

    expect(profile.terms[0]).toBe("要件定義");
    expect(profile.terms).toContain("ローカルモデル");
    expect(profile.terms).toContain("OpenAI");
    expect(profile.terms).toContain("LM Studio");
  });

  it("ignores fenced code, inline code, and URLs", () => {
    const profile = buildDocumentVocabularyProfile([
      "本文では要件定義を扱います。",
      "```ts",
      "const HiddenProduct = '秘密用語';",
      "```",
      "`InlineProduct` と https://example.com/HiddenUrl を除外します。",
    ].join("\n"));

    expect(profile.terms).toContain("要件定義");
    expect(profile.terms).not.toContain("HiddenProduct");
    expect(profile.terms).not.toContain("秘密用語");
    expect(profile.terms).not.toContain("InlineProduct");
    expect(profile.terms).not.toContain("HiddenUrl");
  });

  it("does not combine named Latin terms across lines", () => {
    const profile = buildDocumentVocabularyProfile("OpenAI\nMarkdown");

    expect(profile.terms).toContain("OpenAI");
    expect(profile.terms).toContain("Markdown");
    expect(profile.terms).not.toContain("OpenAI Markdown");
  });

  it("caps the vocabulary size", () => {
    const terms = Array.from(
      { length: MAX_DOCUMENT_VOCABULARY_TERMS + 10 },
      (_, index) => `用語${String.fromCharCode(0x4e00 + index)}語`,
    );
    const profile = buildDocumentVocabularyProfile(terms.join(" "));

    expect(profile.terms).toHaveLength(MAX_DOCUMENT_VOCABULARY_TERMS);
  });

  it("keeps the revision stable until the extracted vocabulary changes", () => {
    const first = buildDocumentVocabularyProfile("要件定義を確認します。");
    const same = buildDocumentVocabularyProfile("要件定義を確認します。");
    const changed = buildDocumentVocabularyProfile("要件定義と基本設計を確認します。");

    expect(same.revision).toBe(first.revision);
    expect(changed.revision).not.toBe(first.revision);
  });
});
