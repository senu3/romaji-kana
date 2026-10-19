#[test]
#[cfg(not(feature = "evaluation"))]
fn production_rejects_retired_completion_requests() {
    assert!(serde_json::from_value::<super::Request>(serde_json::json!({
        "operation": "complete", "reading": "てすとし", "words": []
    }))
    .is_err());
}
use super::*;
#[test]
fn real_dictionary_provides_paths_and_independent_reading_evidence() {
    let engine = engine().unwrap();
    let result = engine
        .search(&SearchRequest {
            reading: "ほんをよむ".into(),
            words: vec![],
            limit: 16,
        })
        .unwrap();
    assert!(result.candidates.iter().any(|c| c.text == "本を読む"));
    for candidate in &result.candidates {
        assert_eq!(
            candidate
                .tokens
                .iter()
                .map(|t| t.reading.as_str())
                .collect::<String>(),
            "ほんをよむ"
        );
        assert_eq!(
            candidate
                .tokens
                .iter()
                .map(|t| t.text.as_str())
                .collect::<String>(),
            candidate.text
        );
    }
    assert_eq!(engine.verify("本を読む", "ほんをよむ", &[]), "verified");
    assert_eq!(engine.verify("本を読む", "ほんをのむ", &[]), "unverified");
    assert!(result.candidates.windows(2).all(|w| w[0].cost <= w[1].cost));
}
#[test]
fn personal_words_and_unknown_literals_survive() {
    let engine = engine().unwrap();
    let words = vec![UserWord {
        id: "u1".into(),
        reading: "てすとしゃ".into(),
        text: "試験社".into(),
        pos: "organization".into(),
    }];
    let result = engine
        .search(&SearchRequest {
            reading: "てすとしゃ".into(),
            words,
            limit: 32,
        })
        .unwrap();
    assert!(result.candidates.iter().any(|c| c.text == "試験社"));
    assert!(result
        .candidates
        .iter()
        .all(|c| c.tokens.iter().all(|t| t.source != "literal")));
    let greeting = engine
        .search(&SearchRequest {
            reading: "ありがとう".into(),
            words: vec![],
            limit: 16,
        })
        .unwrap();
    assert!(greeting
        .candidates
        .iter()
        .any(|c| c.text == "ありがとう" && c.tokens.iter().all(|t| t.source != "literal")));
    assert!(engine
        .search(&SearchRequest {
            reading: "あ".repeat(161),
            words: vec![],
            limit: 16
        })
        .is_err());
}

#[test]
#[cfg(feature = "evaluation")]
fn prefix_completions_only_extend_the_entered_reading() {
    let engine = engine().unwrap();
    let words = vec![UserWord {
        id: "user".into(),
        reading: "てすとしゃ".into(),
        text: "試験社".into(),
        pos: "organization".into(),
    }];
    let completions = engine.complete("てすとし", &words);
    assert!(completions.iter().any(|r| r == "てすとしゃ"));
    assert!(completions
        .iter()
        .all(|r| r.starts_with("てすとし") && r.chars().count() > 4));
    assert!(engine.complete("あ", &[]).is_empty());
    assert!(engine.complete("10じ", &[]).is_empty());
}
#[test]
fn astar_matches_exhaustive_paths_in_a_tiny_dictionary() {
    let entries = vec![
        Entry {
            reading: "あ".into(),
            text: "亜".into(),
            lid: 1,
            rid: 1,
            cost: -5,
            id: "a".into(),
        },
        Entry {
            reading: "あ".into(),
            text: "阿".into(),
            lid: 1,
            rid: 1,
            cost: 2,
            id: "b".into(),
        },
        Entry {
            reading: "ああ".into(),
            text: "嗚呼".into(),
            lid: 1,
            rid: 1,
            cost: -20,
            id: "c".into(),
        },
    ];
    // Literal noun id is part of the same matrix, as in the production dataset.
    let size = NOUN as usize + 1;
    let mut trie = Trie::default();
    for (i, e) in entries.iter().enumerate() {
        trie.insert(&e.reading, i);
    }
    let engine = Engine {
        entries,
        trie,
        matrix: vec![0; size * size],
        size,
    };
    let result = engine
        .search(&SearchRequest {
            reading: "ああ".into(),
            words: vec![],
            limit: 8,
        })
        .unwrap();
    let mut texts: Vec<_> = result
        .candidates
        .iter()
        .take(5)
        .map(|c| (c.cost, c.text.as_str()))
        .collect();
    texts.sort();
    assert_eq!(
        texts,
        vec![
            (-20, "嗚呼"),
            (-10, "亜亜"),
            (-3, "亜阿"),
            (-3, "阿亜"),
            (4, "阿阿")
        ]
    );
}
