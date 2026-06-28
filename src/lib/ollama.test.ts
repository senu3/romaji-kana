import { describe, expect, it, vi } from "vitest";
import {
  buildProtectedDictionaryEntries,
  convertRomajiToJapanese,
  convertRomajiToJapaneseDetailed,
  normalizeRomajiReadingCandidate,
} from "./ollama";
import {
  buildKanaKanjiSystemPrompt,
  defaultConversionPrompt,
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

  it("tries typo completion after repeated unusable alternative conversions", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: "ご時達事はおそろしいものだ" })
        .mockResolvedValueOnce({ response: "ご時達事はおそろしいものだ" })
        .mockResolvedValueOnce({ response: "ご時達事はおそろしいものだ" })
        .mockResolvedValueOnce({ response: "誤字脱字は恐ろしいものだ" }),
    };

    const result = await convertRomajiToJapaneseDetailed(
      "gozidatuzihaosorosiimonoda",
      defaultSettings,
      transport,
      { avoidOutputs: ["ご時達事はおそろしいものだ"] },
    );

    expect(result).toEqual({
      text: "誤字脱字は恐ろしいものだ",
      reviewKana: "ごじだつじはおそろしいものだ",
      conversionStrategy: "completion",
    });
    expect(transport.generate).toHaveBeenCalledTimes(4);
    expect(transport.generate).toHaveBeenNthCalledWith(
      3,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("Alternative attempt 2"),
      }),
      30_000,
    );
    expect(transport.generate).toHaveBeenNthCalledWith(
      4,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("Typo completion request:"),
      }),
      30_000,
    );
  });

  it("throws when typo completion cannot produce a usable alternative", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: "ご時達事はおそろしいものだ" })
        .mockResolvedValueOnce({ response: "ご時達事はおそろしいものだ" })
        .mockResolvedValueOnce({ response: "ご時達事はおそろしいものだ" })
        .mockResolvedValueOnce({ response: "ごじだつじはおそろしいものだ" }),
    };

    await expect(
      convertRomajiToJapaneseDetailed(
        "gozidatuzihaosorosiimonoda",
        defaultSettings,
        transport,
        { avoidOutputs: ["ご時達事はおそろしいものだ"] },
      ),
    ).rejects.toThrow("別候補に変換できませんでした。");
    expect(transport.generate).toHaveBeenCalledTimes(4);
  });

  it("passes original romaji and mechanical kana to typo completion", async () => {
    const failedOutput = "ガイドラインに戻づき変換してください";
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: failedOutput })
        .mockResolvedValueOnce({ response: failedOutput })
        .mockResolvedValueOnce({ response: failedOutput })
        .mockResolvedValueOnce({ response: "ガイドラインに基づき変換してください" }),
    };

    const result = await convertRomajiToJapaneseDetailed(
      "gaidorainnimododukihenkansitekudasai",
      defaultSettings,
      transport,
      { avoidOutputs: [failedOutput] },
    );

    expect(result).toEqual({
      text: "ガイドラインに基づき変換してください",
      reviewKana: "がいどらいんにもどづきへんかんしてください",
      conversionStrategy: "completion",
    });
    expect(transport.generate).toHaveBeenNthCalledWith(
      4,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("mododuki may be a typo of motoduki"),
        prompt: [
          "Original romaji input:",
          "gaidorainnimododukihenkansitekudasai",
          "",
          "Mechanical kana:",
          "がいどらいんにもどづきへんかんしてください",
        ].join("\n"),
      }),
      30_000,
    );
  });

  it("uses a later non-kana alternative instead of returning kana immediately", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: "失費のテストです" })
        .mockResolvedValueOnce({ response: "失費のテストです" })
        .mockResolvedValueOnce({ response: "執筆のテストです" }),
    };

    const result = await convertRomajiToJapaneseDetailed(
      "sippitunotesutodesu",
      defaultSettings,
      transport,
      { avoidOutputs: ["失費のテストです"] },
    );

    expect(result).toEqual({
      text: "執筆のテストです",
      reviewKana: "しっぴつのてすとです",
    });
    expect(transport.generate).toHaveBeenCalledTimes(3);
    expect(transport.generate).toHaveBeenNthCalledWith(
      2,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.stringContaining("never 失費"),
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

  it("keeps inline kanji terms out of LLM conversion and joins converted romaji segments", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: "私は" })
        .mockResolvedValueOnce({ response: "に行こうと思います。" }),
    };

    const result = await convertRomajiToJapanese(
      "watasiha迎賓館niikoutoomoimasu.",
      defaultSettings,
      transport,
    );

    expect(result).toBe("私は迎賓館に行こうと思います。");
    expect(transport.generate).toHaveBeenCalledTimes(2);
    expect(transport.generate).toHaveBeenNthCalledWith(
      1,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.not.stringContaining("迎賓館"),
        prompt: "わたしは",
      }),
      30_000,
    );
    expect(transport.generate).toHaveBeenNthCalledWith(
      2,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        system: expect.not.stringContaining("迎賓館"),
        prompt: "にいこうとおもいます。",
      }),
      30_000,
    );
  });

  it("re-protects current ASCII terms for history retry without sending them to the LLM", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi.fn().mockResolvedValue({ response: "に行く。" }),
    };
    const protectedDictionaryEntries = buildProtectedDictionaryEntries(
      "openair ni iku.",
      "openairに行く。",
      [],
    );

    const result = await convertRomajiToJapaneseDetailed(
      "openair ni iku.",
      defaultSettings,
      transport,
      { protectedDictionaryEntries },
    );

    expect(result).toEqual({
      text: "openairに行く。",
      reviewKana: "openair に いく。",
    });
    expect(protectedDictionaryEntries).toEqual([
      {
        reading: "openair",
        output: "openair",
        enabled: true,
      },
    ]);
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

  it("uses the current protected spelling ahead of matching user dictionary entries on history retry", async () => {
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
          output: "OpenAI Inc.",
          note: "",
          enabled: true,
        },
      ],
    };
    const protectedDictionaryEntries = buildProtectedDictionaryEntries(
      "openai nitsuite kakunin.",
      "OpenAIについて確認します。",
      settings.userDictionary,
    );

    const result = await convertRomajiToJapaneseDetailed(
      "openai nitsuite kakunin.",
      settings,
      transport,
      { protectedDictionaryEntries },
    );

    expect(result.text).toBe("OpenAIについて確認します。");
    expect(protectedDictionaryEntries).toEqual([
      {
        reading: "openai",
        output: "OpenAI",
        enabled: true,
      },
    ]);
  });

  it("keeps multiple inline kanji terms literal", async () => {
    const transport = {
      models: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValueOnce({ response: "今日は" })
        .mockResolvedValueOnce({ response: "の" })
        .mockResolvedValueOnce({ response: "を確認します。" }),
    };

    const result = await convertRomajiToJapanese(
      "kyouha昨日no予定wokakuninsimasu.",
      defaultSettings,
      transport,
    );

    expect(result).toBe("今日は昨日の予定を確認します。");
    expect(transport.generate).toHaveBeenCalledTimes(3);
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
        prompt: "の",
      }),
      30_000,
    );
    expect(transport.generate).toHaveBeenNthCalledWith(
      3,
      "ollama",
      "http://localhost:11434",
      expect.objectContaining({
        prompt: "をかくにんします。",
      }),
      30_000,
    );
  });

  it("adds business email preset instructions without allowing over-polite rewrites", () => {
    const prompt = buildKanaKanjiSystemPrompt(defaultConversionPrompt, "businessEmail");

    expect(prompt).toContain("Purpose preset: business email or work message.");
    expect(prompt).toContain("When the input is よろしくおねがいします, prefer よろしくお願いします.");
    expect(prompt).toContain("Do not rewrite します or しました to いたします or いたしました");
  });

  it("adds kana-kanji fidelity rules and examples", () => {
    const prompt = buildKanaKanjiSystemPrompt(defaultConversionPrompt, "none");

    expect(prompt).toContain("Japanese kana-to-kanji conversion engine");
    expect(prompt).toContain("Japanese kana text produced from romaji typing");
    expect(prompt).toContain("Do not paraphrase");
    expect(prompt).toContain("never 失費");
    expect(prompt).toContain("ごじまん must stay ご自慢 or ごじまん");
    expect(prompt).toContain("Do not add intensifiers");
    expect(prompt).toContain("あなたの笑顔が好きです");
    expect(prompt).toContain("執筆のテストです");
    expect(prompt).toContain("おじいさんご自慢の時計さ");
    expect(prompt).toContain("誤字脱字は恐ろしいものだ");
    expect(prompt).toContain("五時にケーキを食べよう");
    expect(prompt).toContain("議事に参加しよう");
    expect(prompt).toContain("未知の英語については誤字の可能性もあるため");
  });

  it("adds alternative conversion instructions only when previous outputs are provided", () => {
    const prompt = buildKanaKanjiSystemPrompt(defaultConversionPrompt, "none", ["一。"]);

    expect(prompt).toContain("Generate a different valid conversion candidate");
    expect(prompt).toContain("Avoid returning these previous outputs exactly:");
    expect(prompt).toContain("preserves every kana sound");
    expect(prompt).toContain("- 一。");
    expect(prompt).toContain("Typo completion request:\nNone.");
  });

  it("adds lightweight typo completion instructions and examples only in completion mode", () => {
    const prompt = buildKanaKanjiSystemPrompt(
      defaultConversionPrompt,
      "none",
      ["失費のテストです"],
      true,
      0,
      true,
    );

    expect(prompt).toContain("Assume the romaji input may contain a small typing error such as one wrong consonant.");
    expect(prompt).toContain("mododuki may be a typo of motoduki");
    expect(prompt).toContain("ガイドラインに基づき変換してください");
    expect(prompt).toContain("- 失費のテストです");
    expect(prompt).toContain("執筆のテストです");
    expect(prompt).not.toContain("未知の英語については誤字の可能性もあるため");
  });

  it("keeps kana-kanji prompts independent from user dictionary entries", () => {
    const prompt = buildKanaKanjiSystemPrompt(defaultConversionPrompt, "none");

    expect(prompt).not.toContain("User dictionary:");
    expect(prompt).not.toContain("Protected dictionary placeholders");
    expect(prompt).toContain("Alternative conversion request:\nNone.");
  });

});
