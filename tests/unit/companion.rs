use super::*;

#[test]
fn document_revision_changes_only_when_content_or_name_changes() {
    let manager = CompanionManager::default();
    let first = update_shared_document(
        &manager.shared,
        UpdateDocumentRequest {
            content: "hello".to_string(),
            file_name: "note.md".to_string(),
            client_id: "mobile-a".to_string(),
        },
    )
    .expect("first update should succeed");
    let unchanged = update_shared_document(
        &manager.shared,
        UpdateDocumentRequest {
            content: "hello".to_string(),
            file_name: "note.md".to_string(),
            client_id: "mobile-b".to_string(),
        },
    )
    .expect("unchanged update should succeed");
    let renamed = update_shared_document(
        &manager.shared,
        UpdateDocumentRequest {
            content: "hello".to_string(),
            file_name: "renamed.md".to_string(),
            client_id: "desktop".to_string(),
        },
    )
    .expect("rename should succeed");

    assert_eq!(unchanged.document.revision, first.document.revision);
    assert_eq!(renamed.document.revision, first.document.revision + 1);
    assert_eq!(renamed.document.updated_by, "desktop");
}

#[test]
fn settings_keep_full_client_value_and_extract_model_endpoint() {
    let manager = CompanionManager::default();
    let settings = serde_json::json!({
        "modelProvider": "lmstudio",
        "ollamaApiUrl": "http://localhost:11434",
        "lmStudioApiUrl": "http://localhost:1234",
        "modelName": "test-model"
    });

    update_shared_settings(&manager.shared, settings.clone(), "desktop")
        .expect("settings update should succeed");
    let snapshot = snapshot(&manager.shared).expect("snapshot should succeed");
    let model = model_settings(&manager.shared).expect("model settings should exist");

    assert_eq!(snapshot.settings, settings);
    assert_eq!(model.model_provider, "lmstudio");
    assert_eq!(model.lm_studio_api_url, "http://localhost:1234");
}

#[test]
fn mobile_settings_update_only_shared_conversion_fields() {
    let manager = CompanionManager::default();
    let desktop_settings = serde_json::json!({
        "modelProvider": "lmstudio",
        "ollamaApiUrl": "http://localhost:11434",
        "lmStudioApiUrl": "http://localhost:1234",
        "modelName": "desktop-model",
        "autoConvert": true,
        "conversionMode": "replace",
        "triggers": { "period": true, "comma": true, "enter": false, "manualShortcut": "Mod-Enter" },
        "punctuationConversion": { "periodToJapanese": true, "commaToJapanese": true },
        "conversionPrompt": "desktop prompt",
        "personalDictionary": [],
        "inputPauseTiming": "auto",
        "useDocumentVocabulary": false,
        "userDictionary": [],
        "think": false
    });
    update_shared_settings(&manager.shared, desktop_settings, "desktop")
        .expect("desktop settings should initialize shared state");

    let snapshot = update_shared_conversion_settings(
        &manager.shared,
        UpdateSettingsRequest {
            settings: serde_json::json!({
                "autoConvert": false,
                "conversionMode": "ghost",
                "triggers": { "period": false, "comma": true, "enter": true, "manualShortcut": "Mod-Enter" },
                "punctuationConversion": { "periodToJapanese": false, "commaToJapanese": true },
                "conversionPrompt": "mobile prompt",
                "personalDictionary": [],
                "inputPauseTiming": "deliberate",
                "useDocumentVocabulary": true,
                "userDictionary": []
            }),
            client_id: "mobile-test".to_string(),
        },
    )
    .expect("mobile conversion settings should update shared state");

    assert_eq!(snapshot.settings["modelName"], "desktop-model");
    assert_eq!(snapshot.settings["conversionMode"], "ghost");
    assert_eq!(snapshot.settings["conversionPrompt"], "mobile prompt");
    assert_eq!(snapshot.settings["inputPauseTiming"], "deliberate");
    assert_eq!(snapshot.settings_updated_by, "mobile-test");
    assert_eq!(
        model_settings(&manager.shared).unwrap().model_provider,
        "lmstudio"
    );
}

#[test]
fn authorization_requires_the_current_bearer_token() {
    let manager = CompanionManager::default();
    manager.runtime.lock().expect("runtime lock").token = "secret".to_string();
    let state = WebState {
        runtime: manager.runtime,
        shared: manager.shared,
    };
    let mut valid = HeaderMap::new();
    valid.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer secret"),
    );
    let mut invalid = HeaderMap::new();
    invalid.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer wrong"),
    );

    assert!(is_authorized(&state, &valid));
    assert!(!is_authorized(&state, &invalid));
    assert!(!is_authorized(&state, &HeaderMap::new()));
}
