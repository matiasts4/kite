use crate::account_switcher::get_alternative_accounts_with_quota;
use crate::persist::{threads, workspace_path};
use crate::quota::get_subscription_quotas;
use crate::terminal::engine_installed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationSuggestion {
    pub kind: String, // "account" (same provider, different account) | "provider" (different agent)
    pub id: String,   // accountId or providerId
    pub provider: String,
    pub title: String,
    pub subtitle: String,
    pub remaining_percent: f64,
    pub reset_at: Option<String>,
    pub is_recommended: bool,
}

pub fn detect_quota_exhaustion(provider: &str, output: &str) -> Option<String> {
    let lower = output.to_lowercase();

    // Universal error codes
    let has_429 = lower.contains("429") && (lower.contains("too many requests") || lower.contains("rate limit") || lower.contains("quota") || lower.contains("http"));
    let has_resource_exhausted = lower.contains("resource_exhausted") || lower.contains("resource has been exhausted");
    let has_quota_exceeded = lower.contains("quota exceeded")
        || lower.contains("exceeded your current quota")
        || lower.contains("insufficient_quota")
        || lower.contains("exhausted your quota")
        || lower.contains("out of credits")
        || lower.contains("out of tokens");
    let has_rate_limit = lower.contains("rate_limit_error")
        || lower.contains("rate limit reached")
        || lower.contains("rate_limit_exceeded")
        || lower.contains("rate limit exceeded")
        || lower.contains("rate_limit");
    let has_usage_limit = lower.contains("usage limit")
        || lower.contains("you've hit your limit")
        || lower.contains("you've reached your usage limit")
        || lower.contains("limit reached");
    let has_daily_limit = lower.contains("daily limit") || lower.contains("exhausted your capacity");

    match provider {
        "antigravity" | "agy" => {
            if has_resource_exhausted {
                return Some("Antigravity: Cuota de Google AI Pro agotada (RESOURCE_EXHAUSTED)".into());
            }
            if has_quota_exceeded || has_daily_limit || has_usage_limit {
                return Some("Antigravity: Límite de cuota o uso alcanzado".into());
            }
            if has_429 || has_rate_limit {
                return Some("Antigravity: Límite de tasa (Rate Limit 429) alcanzado".into());
            }
        }
        "claude" | "claude-code" => {
            if has_usage_limit || has_quota_exceeded {
                return Some("Claude Code: Límite de uso o ventana de sesión alcanzada".into());
            }
            if has_429 || has_rate_limit {
                return Some("Claude Code: Rate limit temporal (429)".into());
            }
        }
        "codex" => {
            if has_quota_exceeded || has_usage_limit {
                return Some("Codex: Cuota de OpenAI agotada".into());
            }
            if has_429 || has_rate_limit {
                return Some("Codex: Límite de solicitudes alcanzado (Rate Limit)".into());
            }
        }
        "gemini" => {
            if has_resource_exhausted || has_quota_exceeded || has_usage_limit {
                return Some("Gemini CLI: Cuota de Google AI agotada".into());
            }
            if has_429 || has_rate_limit {
                return Some("Gemini CLI: Rate Limit 429".into());
            }
        }
        _ => {
            if has_resource_exhausted || has_quota_exceeded || has_429 || has_rate_limit || has_usage_limit || has_daily_limit {
                return Some(format!("{provider}: Límite de cuota o uso alcanzado"));
            }
        }
    }

    None
}

#[tauri::command]
pub fn recommend_continuation_targets(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let current_provider = req
        .and_then(|r| r.get("currentProvider").or_else(|| r.get("current_provider")))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
    recommend_continuation_targets_direct(current_provider)
}

pub fn recommend_continuation_targets_direct(current_provider: String) -> Value {
    let mut suggestions: Vec<ContinuationSuggestion> = Vec::new();

    // 1. Check if user has other accounts for the same provider with quota
    let alt_accounts = get_alternative_accounts_with_quota(&current_provider);
    for acc in alt_accounts {
        let pct = acc.primary_remaining_percent.unwrap_or(100.0);
        let email_str = acc.email.as_deref().unwrap_or("");
        let subtitle = if !email_str.is_empty() {
            format!("{} • {:.0}% disponible", email_str, pct)
        } else {
            format!("{:.0}% cuota disponible", pct)
        };
        suggestions.push(ContinuationSuggestion {
            kind: "account".to_string(),
            id: acc.id,
            provider: current_provider.clone(),
            title: format!("Cambiar a {}", acc.label),
            subtitle,
            remaining_percent: pct,
            reset_at: acc.primary_reset_at,
            is_recommended: true,
        });
    }

    // 2. Query live quotas for all providers
    let quotas_val = get_subscription_quotas(None, Some(false));
    let provider_list = [
        ("antigravity", "Antigravity (Google Pro)"),
        ("gemini", "Gemini CLI"),
        ("claude", "Claude Code"),
        ("codex", "OpenAI Codex"),
        ("opencode", "OpenCode"),
        ("cursor", "Cursor Agent"),
        ("grok", "xAI Grok"),
        ("droid", "Factory Droid"),
        ("deepseek", "DeepSeek"),
        ("kimi", "Moonshot Kimi"),
    ];

    for (p_id, display_name) in provider_list {
        if p_id == current_provider {
            continue;
        }

        // Must be installed
        if !engine_installed(p_id) && p_id != "antigravity" {
            continue;
        }

        if let Some(p_data) = quotas_val.get(p_id) {
            let is_available = p_data.get("isAvailable").and_then(|v| v.as_bool()).unwrap_or(true);
            let rem_pct = p_data.get("primaryRemainingPercent").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let reset_at = p_data.get("primaryResetAt").and_then(|v| v.as_str()).map(String::from);

            // Only suggest if available and remaining > 5%
            if is_available && rem_pct > 5.0 {
                suggestions.push(ContinuationSuggestion {
                    kind: "provider".to_string(),
                    id: p_id.to_string(),
                    provider: p_id.to_string(),
                    title: format!("Continuar con {display_name}"),
                    subtitle: format!("{:.0}% de suscripción disponible", rem_pct),
                    remaining_percent: rem_pct,
                    reset_at,
                    is_recommended: false,
                });
            }
        }
    }

    // Sort: account swaps first, then provider with highest remaining percent
    suggestions.sort_by(|a, b| {
        if a.kind == "account" && b.kind != "account" {
            std::cmp::Ordering::Less
        } else if a.kind != "account" && b.kind == "account" {
            std::cmp::Ordering::Greater
        } else {
            b.remaining_percent
                .partial_cmp(&a.remaining_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
        }
    });

    // Mark the top item as recommended if none is
    if !suggestions.is_empty() && !suggestions.iter().any(|s| s.is_recommended) {
        suggestions[0].is_recommended = true;
    }

    json!({
        "schemaVersion": 1,
        "currentProvider": current_provider,
        "suggestions": suggestions
    })
}

fn run_git_summary(cwd: &Path) -> (String, String) {
    let mut status_cmd = Command::new("git");
    status_cmd.args(["status", "--short"]).current_dir(cwd);
    #[cfg(windows)]
    status_cmd.creation_flags(CREATE_NO_WINDOW);

    let status_out = status_cmd
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let mut diff_cmd = Command::new("git");
    diff_cmd.args(["diff", "--stat"]).current_dir(cwd);
    #[cfg(windows)]
    diff_cmd.creation_flags(CREATE_NO_WINDOW);

    let diff_out = diff_cmd
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    (status_out, diff_out)
}

pub fn build_handoff_capsule(
    thread_id: &str,
    from_provider: &str,
    partial_text: &str,
    workspace_id: Option<&str>,
) -> String {
    let thread = {
        let threads_guard = threads().lock().unwrap();
        threads_guard.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)).cloned()
    };
    build_handoff_capsule_from_thread(thread.as_ref(), from_provider, partial_text, workspace_id)
}

pub fn build_handoff_capsule_from_thread(
    thread: Option<&Value>,
    from_provider: &str,
    partial_text: &str,
    workspace_id: Option<&str>,
) -> String {
    let items = thread
        .and_then(|t| t.get("items"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // 1. Initial User Objective
    let initial_prompt = items
        .iter()
        .find(|it| it.get("kind").and_then(|k| k.as_str()) == Some("user"))
        .and_then(|it| it.get("text").and_then(|t| t.as_str()))
        .unwrap_or("Tarea de desarrollo");

    // 2. Latest User Prompt (interrupted turn)
    let current_prompt = items
        .iter()
        .rev()
        .find(|it| it.get("kind").and_then(|k| k.as_str()) == Some("user"))
        .and_then(|it| it.get("text").and_then(|t| t.as_str()))
        .unwrap_or(initial_prompt);

    // 3. Compact conversation summary (last 3 user/assistant turns)
    let mut history_summary = Vec::new();
    let recent_items: Vec<&Value> = items
        .iter()
        .filter(|it| matches!(it.get("kind").and_then(|k| k.as_str()), Some("user") | Some("assistant")))
        .collect();

    let start_idx = recent_items.len().saturating_sub(6);
    for it in &recent_items[start_idx..] {
        let role = it.get("kind").and_then(|k| k.as_str()).unwrap_or("user");
        let text = it.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let snippet: String = text.chars().take(250).collect();
        let ellipsis = if text.len() > 250 { "..." } else { "" };
        history_summary.push(format!("- **{role}**: {snippet}{ellipsis}"));
    }
    let history_block = if history_summary.is_empty() {
        "Sin turnos anteriores.".to_string()
    } else {
        history_summary.join("\n")
    };

    // 4. Partial output snippet
    let partial_snippet = if partial_text.trim().is_empty() {
        "(El agente anterior no alcanzó a emitir código o texto antes de cortarse la cuota)".to_string()
    } else {
        let take_chars: String = partial_text.chars().take(1500).collect();
        let ellipsis = if partial_text.len() > 1500 { "\n...[texto truncado por límite de cuota]" } else { "" };
        format!("```\n{take_chars}{ellipsis}\n```")
    };

    // 5. Workspace state
    let cwd = workspace_id
        .and_then(workspace_path)
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let (git_status, git_diff) = run_git_summary(&cwd);
    let git_section = if !git_status.is_empty() || !git_diff.is_empty() {
        format!(
            "#### Estado de archivos modificados (Git):\n```\n{}\n```\n#### Estadísticas de cambios:\n```\n{}\n```",
            if git_status.is_empty() { "Ninguno reportado por git status" } else { &git_status },
            if git_diff.is_empty() { "Sin diff pendiente" } else { &git_diff }
        )
    } else {
        "No hay modificaciones git registradas aún en el workspace.".to_string()
    };

    format!(
r#"<context_handoff>
IMPORTANTE: Estás relevando al agente anterior (`{from_provider}`) que se quedó sin cuota/tokens a mitad de esta tarea.

### 1. Objetivo Principal de la Conversación
{initial_prompt}

### 2. Contexto de Turnos Recientes
{history_block}

### 3. Solicitud Específica que Quedó Interrumpida
{current_prompt}

### 4. Lo que el agente anterior alcanzó a responder antes de quedarse sin cuota:
{partial_snippet}

### 5. Estado Actual del Workspace en Disco
{git_section}

### Directiva de Relevo
No reinicies desde cero ni repitas cambios que ya están en los archivos del workspace. Continúa de inmediato la ejecución exactamente desde donde se detuvo el agente anterior hasta completar la tarea solicitada por el usuario.
</context_handoff>"#
    )
}

#[tauri::command]
pub fn get_handoff_preview(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let thread_id = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let from_provider = req
        .and_then(|r| r.get("fromProvider").or_else(|| r.get("from_provider")))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
    let partial_text = req
        .and_then(|r| r.get("partialText").or_else(|| r.get("partial_text")))
        .and_then(|v| v.as_str())
        .map(String::from);

    get_handoff_preview_direct(thread_id, from_provider, partial_text)
}

pub fn get_handoff_preview_direct(
    thread_id: String,
    from_provider: String,
    partial_text: Option<String>,
) -> Value {
    let (thread, workspace_id) = {
        let threads_guard = threads().lock().unwrap();
        let thread = threads_guard.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(&thread_id)).cloned();
        let ws = thread.as_ref().and_then(|t| t.get("workspaceId").and_then(|v| v.as_str())).map(String::from);
        (thread, ws)
    };

    let prompt = build_handoff_capsule_from_thread(
        thread.as_ref(),
        &from_provider,
        partial_text.as_deref().unwrap_or(""),
        workspace_id.as_deref(),
    );

    json!({
        "handoffPrompt": prompt
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_quota_exhaustion_positive() {
        assert!(detect_quota_exhaustion("agy", "Error: RESOURCE_EXHAUSTED").is_some());
        assert!(detect_quota_exhaustion("gemini", "Http error 429: Too Many Requests").is_some());
        assert!(detect_quota_exhaustion("claude", "You've reached your usage limit. Try again at 4:00 PM.").is_some());
        assert!(detect_quota_exhaustion("gemini", "Rate limit exceeded for model gemini-1.5-pro").is_some());
        assert!(detect_quota_exhaustion("codex", "insufficient_quota: Check your plan").is_some());
        assert!(detect_quota_exhaustion("agy", "exhausted your quota for this period").is_some());
        assert!(detect_quota_exhaustion("agy", "exceeded your current quota").is_some());
        assert!(detect_quota_exhaustion("gemini", "out of credits or tokens remaining").is_some());
        assert!(detect_quota_exhaustion("agy", "limit reached").is_some());
    }

    #[test]
    fn test_detect_quota_exhaustion_negative() {
        assert!(detect_quota_exhaustion("agy", "cargo build finished successfully").is_none());
        assert!(detect_quota_exhaustion("gemini", "Error: file not found at path /src/main.rs").is_none());
        assert!(detect_quota_exhaustion("claude", "SyntaxError: Unexpected token '<'").is_none());
        assert!(detect_quota_exhaustion("codex", "404 Not Found").is_none());
        assert!(detect_quota_exhaustion("agy", "connection refused").is_none());
    }

    #[test]
    fn test_build_handoff_capsule_structure() {
        let capsule = build_handoff_capsule("nonexistent-thread-id", "agy", "Partial code snippet here", None);
        assert!(capsule.contains("<context_handoff>"));
        assert!(capsule.contains("</context_handoff>"));
        assert!(capsule.contains("`agy`"));
        assert!(capsule.contains("Partial code snippet here"));
        assert!(capsule.contains("Directiva de Relevo"));
    }
}
