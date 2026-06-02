use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenFileResult {
    path: String,
    content: String,
}

#[tauri::command]
async fn ollama_tags(request: OllamaRequest) -> Result<Value, String> {
    get_json(&request.base_url, "tags", request.timeout_ms).await
}

#[tauri::command]
async fn ollama_generate(request: OllamaGenerateRequest) -> Result<Value, String> {
    post_json(&request.base_url, "generate", request.body, request.timeout_ms).await
}

#[tauri::command]
async fn lmstudio_models(request: OllamaRequest) -> Result<Value, String> {
    get_openai_json(&request.base_url, "models", request.timeout_ms).await
}

#[tauri::command]
async fn lmstudio_chat_completions(request: OllamaGenerateRequest) -> Result<Value, String> {
    post_openai_json(
        &request.base_url,
        "chat/completions",
        request.body,
        request.timeout_ms,
    )
    .await
}

#[tauri::command]
async fn open_markdown_file() -> Result<Option<OpenFileResult>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
            .add_filter("Text", &["txt"])
            .pick_file()
        else {
            return Ok(None);
        };

        let content = std::fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read file: {error}"))?;

        Ok(Some(OpenFileResult {
            path: path_to_string(path)?,
            content,
        }))
    })
    .await
    .map_err(|error| format!("File open task failed: {error}"))?
}

#[tauri::command]
async fn save_markdown_file(path: Option<String>, content: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = match path {
            Some(path) if !path.trim().is_empty() => PathBuf::from(path),
            _ => {
                let Some(path) = rfd::FileDialog::new()
                    .add_filter("Markdown", &["md"])
                    .set_file_name("untitled.md")
                    .save_file()
                else {
                    return Ok(None);
                };
                path
            }
        };

        std::fs::write(&path, content).map_err(|error| format!("Failed to save file: {error}"))?;
        Ok(Some(path_to_string(path)?))
    })
    .await
    .map_err(|error| format!("File save task failed: {error}"))?
}

async fn get_json(base_url: &str, path: &str, timeout_ms: Option<u64>) -> Result<Value, String> {
    let client = build_client(timeout_ms)?;
    let url = ollama_url(base_url, path)?;
    let response = client.get(url).send().await.map_err(error_message)?;
    read_json_response(response, "Ollama").await
}

async fn get_openai_json(
    base_url: &str,
    path: &str,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let client = build_client(timeout_ms)?;
    let url = openai_url(base_url, path, "LM Studio")?;
    let response = client.get(url).send().await.map_err(error_message)?;
    read_json_response(response, "LM Studio").await
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
    read_json_response(response, "Ollama").await
}

async fn post_openai_json(
    base_url: &str,
    path: &str,
    body: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let client = build_client(timeout_ms)?;
    let url = openai_url(base_url, path, "LM Studio")?;
    let response = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(error_message)?;
    read_json_response(response, "LM Studio").await
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

fn openai_url(base_url: &str, path: &str, provider_label: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(format!("{provider_label} API URL is empty."));
    }

    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(format!(
            "{provider_label} API URL must start with http:// or https://."
        ));
    }

    let api_base = if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    };

    Ok(format!("{api_base}/{}", path.trim_start_matches('/')))
}

async fn read_json_response(
    response: reqwest::Response,
    provider_label: &str,
) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "{provider_label} request failed with HTTP {}. {}",
            status.as_u16(),
            body
        ));
    }

    response.json::<Value>().await.map_err(error_message)
}

fn error_message(error: reqwest::Error) -> String {
    error.to_string()
}

fn path_to_string(path: PathBuf) -> Result<String, String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| "File path contains invalid Unicode.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ollama_tags,
            ollama_generate,
            lmstudio_models,
            lmstudio_chat_completions,
            open_markdown_file,
            save_markdown_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
