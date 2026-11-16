use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::{AppHandle, State};
use tokio::sync::Semaphore;

use super::browser::BrowserState;
use super::next_gen_tools::CheckpointStore;

/// Limit concurrent agent tool executions to prevent memory blowup from
/// parallel indexing/graph-building operations.
static TOOL_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();

fn tool_semaphore() -> &'static Semaphore {
    TOOL_SEMAPHORE.get_or_init(|| Semaphore::new(2))
}

/// Tools that mutate files on disk; their targets must be snapshotted for
/// checkpoint rollback BEFORE execution.
fn is_write_tool(name: &str) -> bool {
    matches!(
        name,
        "edit_file"
            | "write_file"
            | "multi_edit"
            | "patch_file"
            | "regex_replace"
            | "notebook_edit"
    )
}

fn is_browser_tool(name: &str) -> bool {
    matches!(
        name,
        "browser_navigate"
            | "browser_screenshot"
            | "browser_click"
            | "browser_type"
            | "browser_read"
            | "browser_scroll"
            | "browser_console"
            | "browser_eval"
            | "browser_close"
    )
}

/// Extract the target file path from a write tool's JSON arguments,
/// resolved against the request cwd.
fn extract_target_path(arguments: &str, cwd: &str) -> Option<String> {
    let args: serde_json::Value = serde_json::from_str(arguments).ok()?;
    let path = args
        .get("path")
        .or_else(|| args.get("file_path"))
        .and_then(|v| v.as_str())?;
    if std::path::Path::new(path).is_absolute() {
        Some(path.to_string())
    } else {
        Some(
            std::path::Path::new(cwd)
                .join(path)
                .to_string_lossy()
                .to_string(),
        )
    }
}

#[derive(Debug, Deserialize)]
pub struct AgentToolRequest {
    pub tool_call_id: String,
    pub name: String,
    pub arguments: String,
    pub cwd: String,
    #[serde(default)]
    pub token: String,
}

#[derive(Debug, Serialize)]
pub struct AgentToolResponse {
    pub tool_call_id: String,
    pub output: String,
    pub error: String,
}

#[tauri::command]
pub async fn agent_execute_tool(
    app: AppHandle,
    checkpoint_state: State<'_, CheckpointStore>,
    browser_state: State<'_, BrowserState>,
    request: AgentToolRequest,
) -> Result<AgentToolResponse, String> {
    let fallback_id = request.tool_call_id.clone();

    // Snapshot pre-edit content for write tools so checkpoint rollback and
    // chat "Reject" can actually restore files modified by the agent.
    if is_write_tool(&request.name) {
        if let Some(path) = extract_target_path(&request.arguments, &request.cwd) {
            tokio::task::block_in_place(|| checkpoint_state.track_modified(&path));
        }
    }

    let _permit = match tool_semaphore().acquire().await {
        Ok(p) => p,
        Err(_) => {
            return Ok(AgentToolResponse {
                tool_call_id: fallback_id,
                output: String::new(),
                error: "tool execution semaphore closed".to_string(),
            });
        }
    };

    // Browser/computer-use tools run via Tauri webview APIs, not sidex-agent.
    if is_browser_tool(&request.name) {
        let args: serde_json::Value = serde_json::from_str(&request.arguments).unwrap_or(serde_json::Value::Object(Default::default()));
        let result = super::browser::execute_browser_tool(&app, browser_state.inner(), &request.name, &args).await;
        return Ok(match result {
            Ok(output) => AgentToolResponse { tool_call_id: request.tool_call_id, output, error: String::new() },
            Err(error) => AgentToolResponse { tool_call_id: request.tool_call_id, output: String::new(), error },
        });
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        let ctx = sidex_agent::ToolContext {
            cwd: request.cwd.clone(),
            token: request.token.clone(),
        };
        let req = sidex_agent::ToolRequest {
            tool_call_id: request.tool_call_id.clone(),
            name: request.name,
            arguments: request.arguments,
        };
        let resp = sidex_agent::execute(&req, &ctx);
        AgentToolResponse {
            tool_call_id: resp.tool_call_id,
            output: resp.output,
            error: resp.error,
        }
    })
    .await;

    Ok(result.unwrap_or_else(|e| AgentToolResponse {
        tool_call_id: fallback_id,
        output: String::new(),
        error: format!("internal error: {e}"),
    }))
}
