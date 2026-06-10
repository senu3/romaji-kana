import { describe, expect, it, vi } from "vitest";
import {
  convertRomajiToJapanese,
  convertRomajiToJapaneseDetailed,
  kanjiizeKana,
  normalizeRomajiReadingCandidate,
} from "./ollama";
import {
  buildConversionSystemPrompt,
  buildKanaKanjiSystemPrompt,
  defaultConversionPrompt,
  formatMatchingHomophonePreferences,
} from "./prompts";
import { defaultSettings } from "./settings";

describe("convertRomajiToJapanese", () => {
  it("kanjiizes high-confidence mechanical kana without repair", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "あなたは誰ですか。" }),
    };

    const result = await convertRomajiToJapanese("anatahadaredesuka.", defaultSettings, transport);

    expect(result).toBe("あなたは誰ですか。");
    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        model: "gemma3",
        system: expect.stringContaining("preserving its reading"),
        prompt: "あなたはだれですか。",
        stream: false,
        keep_alive: "5m",
        think: false,
      }),
      30_000,
    );
    expect(transport.generate).toHaveBeenCalledTimes(1);
  });

  it("repairs only low-confidence kana before kanjiization", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: "じ" })
        .mockResolvedValueOnce({ response: "あなたはよく悪じひよだ" }),
    };

    const result = await convertRomajiToJapanese(
      "anatahayokuwarujhiyoda",
      defaultSettings,
      transport,
    );

    expect(result).toBe("あなたはよく悪じひよだ");
    expect(transport.generate).toHaveBeenCalledTimes(2);
    expect(transport.generate).toHaveBeenNthCalledWith(
      1,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("uncertain kana fragment"),
        prompt: expect.stringContaining("未確定部分: j"),
      }),
      30_000,
    );
    expect(transport.generate).toHaveBeenNthCalledWith(
      2,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("preserving its reading"),
        prompt: "あなたはよくわるじひよだ",
      }),
      30_000,
    );
  });

  it("preserves the reading baseline for huri instead of asking the LLM to infer from romaji", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "わかったふりをするのをやめてください" }),
    };

    await convertRomajiToJapanese(
      "wakkatahuriwosurunowoyametekudasai",
      defaultSettings,
      transport,
    );

    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: "わかったふりをするのをやめてください",
      }),
      30_000,
    );
  });

  it("normalizes common typo candidates before kana-kanji conversion", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "あなたの笑顔が好きです。" }),
    };

    const result = await convertRomajiToJapanese(
      "anatanoegawogasukidseu",
      defaultSettings,
      transport,
    );

    expect(result).toBe("あなたの笑顔が好きです。");
    expect(transport.generate).toHaveBeenCalledTimes(1);
    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: "あなたのえがおがすきです",
      }),
      30_000,
    );
  });

  it("does not force user homophone preferences during kana-kanji conversion", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "今日の五時に集合な" }),
    };
    const settings = {
      ...defaultSettings,
      userHomophones: [
        {
          id: "goji",
          reading: "ごじ",
          preferred: "誤字",
          replaceFrom: ["五時", "ごじ"],
          note: "",
          enabled: true,
        },
      ],
    };

    const result = await convertRomajiToJapaneseDetailed(
      "kyounogozinisyuugouna",
      settings,
      transport,
    );

    expect(result).toEqual({
      text: "今日の五時に集合な",
      reviewKana: "きょうのごじにしゅうごうな",
    });
    expect(transport.generate).toHaveBeenCalledTimes(1);
    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: "きょうのごじにしゅうごうな",
      }),
      30_000,
    );
  });

  it("does not replace a whole kana input with a homophone preference", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "五時" }),
    };
    const settings = {
      ...defaultSettings,
      userHomophones: [
        {
          id: "goji",
          reading: "ごじ",
          preferred: "誤字",
          replaceFrom: ["五時", "ごじ"],
          note: "",
          enabled: true,
        },
      ],
    };

    await expect(kanjiizeKana("ごじ", settings, transport)).resolves.toBe("五時");
    expect(transport.generate).toHaveBeenCalledTimes(1);
  });

  it("keeps longer kana words intact without homophone pre-splitting", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "リンゴジュースを買った" }),
    };
    const settings = {
      ...defaultSettings,
      userHomophones: [
        {
          id: "goji",
          reading: "ごじ",
          preferred: "誤字",
          replaceFrom: ["五時", "ごじ"],
          note: "",
          enabled: true,
        },
      ],
    };

    await expect(kanjiizeKana("りんごじゅーすをかった", settings, transport)).resolves.toBe(
      "リンゴジュースを買った",
    );
    expect(transport.generate).toHaveBeenCalledTimes(1);
    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: "りんごじゅーすをかった",
      }),
      30_000,
    );
  });

  it("keeps lexical wording available for faithful kana-kanji conversion", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "おじいさんご自慢の時計さ" }),
    };

    const result = await convertRomajiToJapaneseDetailed(
      "oziisangozimannotokeisa",
      defaultSettings,
      transport,
    );

    expect(result).toEqual({
      text: "おじいさんご自慢の時計さ",
      reviewKana: "おじいさんごじまんのとけいさ",
    });
    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("Do not paraphrase"),
        prompt: "おじいさんごじまんのとけいさ",
      }),
      30_000,
    );
  });

  it("falls back to a conservative kana candidate when retry keeps returning an avoided output", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: "ご時達事はおそろしいものだ" })
        .mockResolvedValueOnce({ response: "ご時達事はおそろしいものだ" }),
    };

    const result = await convertRomajiToJapaneseDetailed(
      "gozidatuzihaosorosiimonoda",
      defaultSettings,
      transport,
      { avoidOutputs: ["ご時達事はおそろしいものだ"] },
    );

    expect(result).toEqual({
      text: "ごじだつじはおそろしいものだ",
      reviewKana: "ごじだつじはおそろしいものだ",
    });
    expect(transport.generate).toHaveBeenCalledTimes(2);
    expect(transport.generate).toHaveBeenNthCalledWith(
      2,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("Returning any listed output exactly is invalid"),
      }),
      30_000,
    );
  });

  it("passes fixed user-reviewed terms into kana-kanji conversion", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "誤字を確認する" }),
    };

    const result = await convertRomajiToJapaneseDetailed(
      "gojiwokakuninsuru",
      defaultSettings,
      transport,
      { fixedTerms: ["誤字"] },
    );

    expect(result).toEqual({
      text: "誤字を確認する",
      reviewKana: "ごじをかくにんする",
    });
    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("- 誤字"),
        prompt: "ごじをかくにんする",
      }),
      30_000,
    );
  });

  it("keeps valid wo particles before non-particle following text", () => {
    expect(normalizeRomajiReadingCandidate("sorewokakuninshimasu")).toBe(
      "sorewokakuninshimasu",
    );
  });

  it("normalizes particle-like wo when another particle immediately follows", () => {
    expect(normalizeRomajiReadingCandidate("egawoga")).toBe("egaoga");
  });

  it("reads LM Studio chat completion text", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "今日は寒いから暖かくして" } }],
      }),
    };
    const settings = {
      ...defaultSettings,
      modelProvider: "lmstudio" as const,
      lmStudioApiUrl: "http://localhost:1234",
      modelName: "local-model",
      think: true,
    };

    const result = await convertRomajiToJapanese(
      "kyouhasamuikaraatatakakuneshite",
      settings,
      transport,
    );

    expect(result).toBe("今日は寒いから暖かくして");
    expect(transport.generate).toHaveBeenCalledWith(
      "lmstudio",
      "http://localhost:1234",
      expect.objectContaining({
        model: "local-model",
        think: true,
      }),
      30_000,
    );
  });

  it("excludes dictionary terms from LLM conversion and joins converted text segments", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: "の" })
        .mockResolvedValueOnce({ response: "を確認します。" }),
    };
    const settings = {
      ...defaultSettings,
      userDictionary: [
        {
          id: "openai",
          reading: "openai",
          output: "OpenAI",
          note: "company name",
          enabled: true,
        },
        {
          id: "api",
          reading: "api",
          output: "API",
          note: "",
          enabled: true,
        },
      ],
    };

    const result = await convertRomajiToJapanese("openai no api wo kakunin.", settings, transport);

    expect(result).toBe("OpenAIのAPIを確認します。");
    expect(transport.generate).toHaveBeenCalledTimes(2);
    expect(transport.generate).toHaveBeenNthCalledWith(
      1,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.not.stringContaining("openai"),
        prompt: " の ",
      }),
      30_000,
    );
    expect(transport.generate).toHaveBeenNthCalledWith(
      2,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.not.stringContaining("api"),
        prompt: " を かくにん。",
      }),
      30_000,
    );
  });

  it("matches long dictionary terms in connected romaji without sending them to the LLM", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: "今日は" })
        .mockResolvedValueOnce({ response: "について確認します。" }),
    };
    const settings = {
      ...defaultSettings,
      userDictionary: [
        {
          id: "openai",
          reading: "openai",
          output: "OpenAI",
          note: "",
          enabled: true,
        },
      ],
    };

    const result = await convertRomajiToJapanese(
      "kyouhaopenainitsuitekakunin.",
      settings,
      transport,
    );

    expect(result).toBe("今日はOpenAIについて確認します。");
    expect(transport.generate).toHaveBeenNthCalledWith(
      1,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: "きょうは",
      }),
      30_000,
    );
    expect(transport.generate).toHaveBeenNthCalledWith(
      2,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: "についてかくにん。",
      }),
      30_000,
    );
  });

  it("keeps short dictionary terms boundary-only and avoids prefix false positives", async () => {
    const settings = {
      ...defaultSettings,
      userDictionary: [
        {
          id: "nasa",
          reading: "nasa",
          output: "NASA",
          note: "",
          enabled: true,
        },
      ],
    };
    const matchedTransport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "に行く。" }),
    };
    const unmatchedTransport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "皆さんは来ます。" }),
    };
    const connectedTransport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "ナサに行く。" }),
    };

    const matched = await convertRomajiToJapanese("nasa ni iku.", settings, matchedTransport);
    const unmatched = await convertRomajiToJapanese(
      "minasanhakimasu.",
      settings,
      unmatchedTransport,
    );
    const connected = await convertRomajiToJapanese("nasaniiku.", settings, connectedTransport);

    expect(matched).toBe("NASAに行く。");
    expect(matchedTransport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: " に いく。",
      }),
      30_000,
    );
    expect(unmatched).toBe("皆さんは来ます。");
    expect(unmatchedTransport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: "みなさんはきます。",
      }),
      30_000,
    );
    expect(connected).toBe("ナサに行く。");
    expect(connectedTransport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: "なさにいく。",
      }),
      30_000,
    );
  });

  it("keeps backtick-wrapped unknown nouns out of LLM conversion", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "に行く。" }),
    };

    const result = await convertRomajiToJapanese("`openair` ni iku.", defaultSettings, transport);

    expect(result).toBe("openairに行く。");
    expect(transport.generate).toHaveBeenCalledTimes(1);
    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.not.stringContaining("openair"),
        prompt: " に いく。",
      }),
      30_000,
    );
  });

  it("keeps backtick-wrapped nouns literal even when they match dictionary entries", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "について確認します。" }),
    };
    const settings = {
      ...defaultSettings,
      userDictionary: [
        {
          id: "openai",
          reading: "openai",
          output: "OpenAI",
          note: "",
          enabled: true,
        },
      ],
    };

    const result = await convertRomajiToJapanese("`openai` nitsuite kakunin.", settings, transport);

    expect(result).toBe("openaiについて確認します。");
    expect(transport.generate).toHaveBeenCalledTimes(1);
    expect(transport.generate).toHaveBeenCalledWith(
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: " について かくにん。",
      }),
      30_000,
    );
  });

  it("adds the fixed romaji reference and few-shot examples to the editable prompt", () => {
    const prompt = buildConversionSystemPrompt(defaultConversionPrompt);

    expect(prompt).toContain("You are an advanced Japanese conversion engine.");
    expect(prompt).toContain("shi/si=し");
    expect(prompt).toContain("anatahayokuwaraujhitoda");
    expect(prompt).toContain("あなたはよく笑う人だ");
  });

  it("adds business email preset instructions without allowing over-polite rewrites", () => {
    const prompt = buildKanaKanjiSystemPrompt(defaultConversionPrompt, "businessEmail");

    expect(prompt).toContain("Purpose preset: business email or work message.");
    expect(prompt).toContain("When the input is よろしくおねがいします, prefer よろしくお願いします.");
    expect(prompt).toContain("Do not rewrite します or しました to いたします or いたしました");
  });

  it("adds kana-kanji fidelity rules and examples", () => {
    const prompt = buildKanaKanjiSystemPrompt(defaultConversionPrompt, "none");

    expect(prompt).toContain("Do not paraphrase");
    expect(prompt).toContain("ごじまん must stay ご自慢 or ごじまん");
    expect(prompt).toContain("Do not add intensifiers");
    expect(prompt).toContain("User-side review handles homophone cleanup");
    expect(prompt).toContain("あなたの笑顔が好きです");
    expect(prompt).toContain("おじいさんご自慢の時計さ");
    expect(prompt).toContain("誤字脱字は恐ろしいものだ");
    expect(prompt).toContain("五時にケーキを食べよう");
    expect(prompt).toContain("議事に参加しよう");
    expect(prompt).toContain("未知の英語については誤字の可能性もあるため");
  });

  it("adds alternative conversion instructions only when previous outputs are provided", () => {
    const prompt = buildKanaKanjiSystemPrompt(defaultConversionPrompt, "none", [], "いち。", [
      "一。",
    ]);

    expect(prompt).toContain("Generate a different valid conversion candidate");
    expect(prompt).toContain("Avoid returning these previous outputs exactly:");
    expect(prompt).toContain("- 一。");
  });

  it("keeps kana-kanji prompts independent from user dictionary entries", () => {
    const prompt = buildKanaKanjiSystemPrompt(defaultConversionPrompt, "none");

    expect(prompt).not.toContain("User dictionary:");
    expect(prompt).not.toContain("Protected dictionary placeholders");
    expect(prompt).toContain("Alternative conversion request:\nNone.");
  });

  it("formats only matching enabled homophone preferences", () => {
    const prompt = formatMatchingHomophonePreferences("このあたりのごじをかくにん", [
      {
        id: "goji",
        reading: "ごじ",
        preferred: "誤字",
        replaceFrom: ["五時", "ごじ"],
        note: "conversion notes",
        enabled: true,
      },
      {
        id: "michi",
        reading: "みち",
        preferred: "未知",
        replaceFrom: ["道", "みち"],
        note: "",
        enabled: true,
      },
      {
        id: "disabled",
        reading: "ごじ",
        preferred: "五時",
        replaceFrom: ["誤字"],
        note: "",
        enabled: false,
      },
    ]);

    expect(prompt).toContain("- ごじ: prefer 誤字 (conversion notes)");
    expect(prompt).toContain("not fixed replacements");
    expect(prompt).not.toContain("未知");
    expect(prompt).not.toContain("五時");
  });
});
