use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OllamaRequest {
    base_url: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OllamaGenerateRequest {
    base_url: String,
    body: Value,
    timeout_ms: Option<u64>,
}

#[tauri::command]
async fn ollama_tags(request: OllamaRequest) -> Result<Value, String> {
    get_json(&request.base_url, "tags", request.timeout_ms).await
}

#[tauri::command]
async fn ollama_generate(request: OllamaGenerateRequest) -> Result<Value, String> {
    post_json(&request.base_url, "generate", request.body, request.timeout_ms).await
}

async fn get_json(base_url: &str, path: &str, timeout_ms: Option<u64>) -> Result<Value, String> {
    let client = build_client(timeout_ms)?;
    let url = ollama_url(base_url, path)?;
    let response = client.get(url).send().await.map_err(error_message)?;
    read_json_response(response).await
}

async fn post_json(
    base_url: &str,
    path: &str,
    body: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let client = build_client(timeout_ms)?;
    let url = ollama_url(base_url, path)?;
    let response = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(error_message)?;
    read_json_response(response).await
}

fn build_client(timeout_ms: Option<u64>) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.unwrap_or(12_000)))
        .build()
        .map_err(error_message)
}

fn ollama_url(base_url: &str, path: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Ollama API URL is empty.".to_string());
    }

    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Ollama API URL must start with http:// or https://.".to_string());
    }

    let api_base = if trimmed.ends_with("/api") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/api")
    };

    Ok(format!("{api_base}/{}", path.trim_start_matches('/')))
}

async fn read_json_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Ollama request failed with HTTP {}. {}",
            status.as_u16(),
            body
        ));
    }

    response.json::<Value>().await.map_err(error_message)
}

fn error_message(error: reqwest::Error) -> String {
    error.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![ollama_tags, ollama_generate])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
