use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use rand::Rng;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    net::{IpAddr, Ipv4Addr},
    sync::{Arc, Mutex, RwLock},
};
use tauri::State as TauriState;
use tokio::{net::TcpListener, sync::oneshot};
use uuid::Uuid;

const COMPANION_PORT: u16 = 18_321;

#[derive(RustEmbed)]
#[folder = "../dist/"]
struct FrontendAssets;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    running: bool,
    port: u16,
    urls: Vec<String>,
    pair_code: Option<String>,
    paired_clients: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionDocument {
    content: String,
    file_name: String,
    revision: u64,
    updated_by: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSnapshot {
    document: CompanionDocument,
    settings: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelSettings {
    model_provider: String,
    ollama_api_url: String,
    lm_studio_api_url: String,
}

#[derive(Debug, Clone)]
struct SharedState {
    document: CompanionDocument,
    settings: Value,
    model_settings: Option<ModelSettings>,
}

struct RuntimeState {
    running: bool,
    pair_code: Option<String>,
    token: String,
    urls: Vec<String>,
    paired_clients: u64,
    shutdown: Option<oneshot::Sender<()>>,
}

pub struct CompanionManager {
    runtime: Arc<Mutex<RuntimeState>>,
    shared: Arc<RwLock<SharedState>>,
}

impl Default for CompanionManager {
    fn default() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(RuntimeState {
                running: false,
                pair_code: None,
                token: String::new(),
                urls: Vec::new(),
                paired_clients: 0,
                shutdown: None,
            })),
            shared: Arc::new(RwLock::new(SharedState {
                document: CompanionDocument {
                    content: String::new(),
                    file_name: "Untitled.md".to_string(),
                    revision: 0,
                    updated_by: "desktop".to_string(),
                },
                settings: Value::Null,
                model_settings: None,
            })),
        }
    }
}

#[derive(Clone)]
struct WebState {
    runtime: Arc<Mutex<RuntimeState>>,
    shared: Arc<RwLock<SharedState>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    content: String,
    file_name: String,
    settings: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDocumentRequest {
    content: String,
    file_name: String,
    client_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    code: String,
}

#[derive(Debug, Serialize)]
struct PairResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateRequest {
    body: Value,
    timeout_ms: Option<u64>,
}

#[tauri::command]
pub async fn companion_start(
    request: StartRequest,
    manager: TauriState<'_, CompanionManager>,
) -> Result<CompanionStatus, String> {
    {
        let runtime = manager.runtime.lock().map_err(lock_error)?;
        if runtime.running {
            return Ok(status_from_runtime(&runtime));
        }
    }

    update_shared_settings(&manager.shared, request.settings)?;
    {
        let mut shared = manager.shared.write().map_err(lock_error)?;
        shared.document.content = request.content;
        shared.document.file_name = request.file_name;
        shared.document.revision = shared.document.revision.saturating_add(1);
        shared.document.updated_by = "desktop".to_string();
    }

    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, COMPANION_PORT))
        .await
        .map_err(|error| {
            format!("スマホ連携用ポート {COMPANION_PORT} を開けませんでした: {error}")
        })?;
    let pair_code = format!("{:06}", rand::rng().random_range(0..1_000_000));
    let token = Uuid::new_v4().to_string();
    let urls = companion_urls();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    {
        let mut runtime = manager.runtime.lock().map_err(lock_error)?;
        runtime.running = true;
        runtime.pair_code = Some(pair_code);
        runtime.token = token;
        runtime.urls = urls;
        runtime.paired_clients = 0;
        runtime.shutdown = Some(shutdown_tx);
    }

    let web_state = WebState {
        runtime: manager.runtime.clone(),
        shared: manager.shared.clone(),
    };
    let app = Router::new()
        .route("/api/pair", post(pair))
        .route("/api/state", get(get_state))
        .route("/api/document", put(update_document_http))
        .route("/api/models", get(models))
        .route("/api/generate", post(generate))
        .route("/assets/{*path}", get(static_asset))
        .route("/{*path}", get(spa_fallback))
        .route("/", get(index))
        .with_state(web_state);

    let runtime_for_shutdown = manager.runtime.clone();
    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        let _ = server.await;
        if let Ok(mut runtime) = runtime_for_shutdown.lock() {
            runtime.running = false;
            runtime.shutdown = None;
        }
    });

    companion_status(manager)
}

#[tauri::command]
pub fn companion_stop(
    manager: TauriState<'_, CompanionManager>,
) -> Result<CompanionStatus, String> {
    let mut runtime = manager.runtime.lock().map_err(lock_error)?;
    if let Some(shutdown) = runtime.shutdown.take() {
        let _ = shutdown.send(());
    }
    runtime.running = false;
    runtime.pair_code = None;
    runtime.token.clear();
    runtime.urls.clear();
    runtime.paired_clients = 0;
    Ok(status_from_runtime(&runtime))
}

#[tauri::command]
pub fn companion_status(
    manager: TauriState<'_, CompanionManager>,
) -> Result<CompanionStatus, String> {
    let runtime = manager.runtime.lock().map_err(lock_error)?;
    Ok(status_from_runtime(&runtime))
}

#[tauri::command]
pub fn companion_update_settings(
    settings: Value,
    manager: TauriState<'_, CompanionManager>,
) -> Result<(), String> {
    update_shared_settings(&manager.shared, settings)
}

#[tauri::command]
pub fn companion_update_document(
    request: UpdateDocumentRequest,
    manager: TauriState<'_, CompanionManager>,
) -> Result<CompanionSnapshot, String> {
    update_shared_document(&manager.shared, request)
}

#[tauri::command]
pub fn companion_get_state(
    manager: TauriState<'_, CompanionManager>,
) -> Result<CompanionSnapshot, String> {
    snapshot(&manager.shared)
}

async fn pair(
    State(state): State<WebState>,
    Json(request): Json<PairRequest>,
) -> impl IntoResponse {
    let mut runtime = match state.runtime.lock() {
        Ok(runtime) => runtime,
        Err(_) => {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "連携状態を読み込めません。",
            )
        }
    };
    if runtime.pair_code.as_deref() != Some(request.code.trim()) {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "接続コードが一致しません。PCに表示された6桁のコードを確認してください。",
        );
    }

    runtime.paired_clients = runtime.paired_clients.saturating_add(1);
    (
        StatusCode::OK,
        Json(serde_json::json!(PairResponse {
            token: runtime.token.clone()
        })),
    )
        .into_response()
}

async fn get_state(State(state): State<WebState>, headers: HeaderMap) -> impl IntoResponse {
    if !is_authorized(&state, &headers) {
        return api_error(StatusCode::UNAUTHORIZED, "再度ペアリングしてください。");
    }
    match snapshot(&state.shared) {
        Ok(value) => (StatusCode::OK, Json(serde_json::json!(value))).into_response(),
        Err(message) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

async fn update_document_http(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(request): Json<UpdateDocumentRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers) {
        return api_error(StatusCode::UNAUTHORIZED, "再度ペアリングしてください。");
    }
    match update_shared_document(&state.shared, request) {
        Ok(value) => (StatusCode::OK, Json(serde_json::json!(value))).into_response(),
        Err(message) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

async fn models(State(state): State<WebState>, headers: HeaderMap) -> impl IntoResponse {
    if !is_authorized(&state, &headers) {
        return api_error(StatusCode::UNAUTHORIZED, "再度ペアリングしてください。");
    }
    let settings = match model_settings(&state.shared) {
        Ok(settings) => settings,
        Err(message) => return api_error(StatusCode::SERVICE_UNAVAILABLE, &message),
    };
    let result = if settings.model_provider == "lmstudio" {
        super::get_openai_json(&settings.lm_studio_api_url, "models", Some(12_000)).await
    } else {
        super::get_json(&settings.ollama_api_url, "tags", Some(12_000)).await
    };
    model_response(result)
}

async fn generate(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(request): Json<GenerateRequest>,
) -> impl IntoResponse {
    if !is_authorized(&state, &headers) {
        return api_error(StatusCode::UNAUTHORIZED, "再度ペアリングしてください。");
    }
    let settings = match model_settings(&state.shared) {
        Ok(settings) => settings,
        Err(message) => return api_error(StatusCode::SERVICE_UNAVAILABLE, &message),
    };
    let result = if settings.model_provider == "lmstudio" {
        super::post_openai_json(
            &settings.lm_studio_api_url,
            "chat/completions",
            request.body,
            request.timeout_ms,
        )
        .await
    } else {
        super::post_json(
            &settings.ollama_api_url,
            "generate",
            request.body,
            request.timeout_ms,
        )
        .await
    };
    model_response(result)
}

async fn index() -> Response<Body> {
    asset_response("index.html", false)
}

async fn static_asset(Path(path): Path<String>) -> Response<Body> {
    asset_response(&format!("assets/{path}"), true)
}

async fn spa_fallback(Path(path): Path<String>) -> Response<Body> {
    if FrontendAssets::get(&path).is_some() {
        return asset_response(&path, true);
    }
    asset_response("index.html", false)
}

fn asset_response(path: &str, immutable: bool) -> Response<Body> {
    let Some(asset) = FrontendAssets::get(path) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("Not found"))
            .unwrap_or_else(|_| Response::new(Body::empty()));
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut response = Response::new(Body::from(asset.data.into_owned()));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref())
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-store"
        }),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn update_shared_settings(
    shared: &Arc<RwLock<SharedState>>,
    settings: Value,
) -> Result<(), String> {
    let model_settings = serde_json::from_value::<ModelSettings>(settings.clone())
        .map_err(|error| format!("モデル設定を連携できません: {error}"))?;
    let mut shared = shared.write().map_err(lock_error)?;
    shared.settings = settings;
    shared.model_settings = Some(model_settings);
    Ok(())
}

fn update_shared_document(
    shared: &Arc<RwLock<SharedState>>,
    request: UpdateDocumentRequest,
) -> Result<CompanionSnapshot, String> {
    let mut shared = shared.write().map_err(lock_error)?;
    if shared.document.content != request.content || shared.document.file_name != request.file_name
    {
        shared.document.content = request.content;
        shared.document.file_name = request.file_name;
        shared.document.revision = shared.document.revision.saturating_add(1);
        shared.document.updated_by = request.client_id;
    }
    Ok(CompanionSnapshot {
        document: shared.document.clone(),
        settings: shared.settings.clone(),
    })
}

fn snapshot(shared: &Arc<RwLock<SharedState>>) -> Result<CompanionSnapshot, String> {
    let shared = shared.read().map_err(lock_error)?;
    Ok(CompanionSnapshot {
        document: shared.document.clone(),
        settings: shared.settings.clone(),
    })
}

fn model_settings(shared: &Arc<RwLock<SharedState>>) -> Result<ModelSettings, String> {
    let shared = shared.read().map_err(lock_error)?;
    shared
        .model_settings
        .clone()
        .ok_or_else(|| "PC側のモデル設定をまだ受け取っていません。".to_string())
}

fn is_authorized(state: &WebState, headers: &HeaderMap) -> bool {
    let Ok(runtime) = state.runtime.lock() else {
        return false;
    };
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    value.strip_prefix("Bearer ") == Some(runtime.token.as_str()) && !runtime.token.is_empty()
}

fn model_response(result: Result<Value, String>) -> axum::response::Response {
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(message) => api_error(StatusCode::BAD_GATEWAY, &message),
    }
}

fn api_error(status: StatusCode, message: &str) -> axum::response::Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

fn status_from_runtime(runtime: &RuntimeState) -> CompanionStatus {
    CompanionStatus {
        running: runtime.running,
        port: COMPANION_PORT,
        urls: runtime.urls.clone(),
        pair_code: runtime.pair_code.clone(),
        paired_clients: runtime.paired_clients,
    }
}

fn companion_urls() -> Vec<String> {
    let mut addresses = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(_, ip)| match ip {
            IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() => Some(ip),
            _ => None,
        })
        .collect::<Vec<_>>();
    addresses.sort();
    addresses.dedup();
    addresses
        .into_iter()
        .map(|ip| format!("http://{ip}:{COMPANION_PORT}/remote"))
        .collect()
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> String {
    format!("スマホ連携の内部状態を読み込めません: {error}")
}

#[cfg(test)]
mod tests {
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

        update_shared_settings(&manager.shared, settings.clone())
            .expect("settings update should succeed");
        let snapshot = snapshot(&manager.shared).expect("snapshot should succeed");
        let model = model_settings(&manager.shared).expect("model settings should exist");

        assert_eq!(snapshot.settings, settings);
        assert_eq!(model.model_provider, "lmstudio");
        assert_eq!(model.lm_studio_api_url, "http://localhost:1234");
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
}
