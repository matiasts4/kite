use std::path::{Path, PathBuf};
use kite_ctx::{ContextEngine, ContextScope, ReadMode};
use serde_json::{json, Value};
use super::AgentToolCommand;

pub fn tool_family_for_command(cmd: &AgentToolCommand) -> &'static str {
    match cmd {
        AgentToolCommand::TasksList { .. }
        | AgentToolCommand::TasksGet { .. }
        | AgentToolCommand::TasksCreate { .. }
        | AgentToolCommand::TasksUpdate { .. }
        | AgentToolCommand::TasksMoveState { .. } => "tasks",
        AgentToolCommand::CtxReadCompact { .. }
        | AgentToolCommand::CtxSearch { .. }
        | AgentToolCommand::CtxSharePut { .. }
        | AgentToolCommand::CtxShareGet { .. }
        | AgentToolCommand::CtxCcrRetrieve { .. } => "ctx",
        AgentToolCommand::DiffStatus { .. } | AgentToolCommand::DiffFile { .. } => "diff",
    }
}

pub fn check_agent_tool_policy(
    agent_id: Option<&str>,
    family: &str,
    approved: bool,
) -> Result<&'static str, String> {
    let Some(aid) = agent_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok("allow");
    };
    let cfg = crate::agents::load_agent_autonomy_config(aid);
    let decision = cfg
        .tool_policies
        .get(family)
        .map(String::as_str)
        .and_then(crate::agents::normalize_tool_policy_value)
        .unwrap_or_else(|| crate::agents::default_policy_for_family(family));
    match decision {
        "deny" => Err(format!(
            "Policy denied: tool family '{family}' is set to 'deny' for agent '{aid}'."
        )),
        "ask" if !approved => Err(format!(
            "Approval required: tool family '{family}' is set to 'ask' for agent '{aid}'. Re-run with approved=true after confirmation."
        )),
        _ => Ok(decision),
    }
}

fn resolve_agent_handle(agent_id: Option<&str>) -> Option<String> {
    let aid = agent_id.map(str::trim).filter(|s| !s.is_empty())?;
    let roster = crate::persist::list_agents_snapshot();
    roster
        .into_iter()
        .find(|a| a.id == aid)
        .map(|a| a.name)
        .or_else(|| Some(aid.to_string()))
}

fn collect_text_search_matches(
    root: &Path,
    query_lower: &str,
    limit: usize,
    out: &mut Vec<Value>,
) {
    if out.len() >= limit {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist") {
            continue;
        }
        if path.is_dir() {
            collect_text_search_matches(&path, query_lower, limit, out);
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.len() > 256 * 1024 {
                continue;
            }
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (idx, line) in content.lines().enumerate() {
            if line.to_ascii_lowercase().contains(query_lower) {
                out.push(json!({
                    "path": path.display().to_string(),
                    "line": idx + 1,
                    "text": line.trim().chars().take(240).collect::<String>(),
                }));
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
}

fn resolve_diff_workspace_dir(
    workspace_id: Option<&str>,
    fallback_workspace: Option<&Path>,
    roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let candidate = if let Some(ws_raw) = workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(p) = crate::persist::workspace_path(ws_raw) {
            PathBuf::from(p)
        } else {
            PathBuf::from(ws_raw)
        }
    } else if let Some(fb) = fallback_workspace {
        fb.to_path_buf()
    } else if let Some(first) = roots.first() {
        first.clone()
    } else {
        return Err("No workspace directory available for kite_diff.".to_string());
    };
    crate::agents::validate_path_within_authorized_roots(&candidate, roots)
}

pub fn execute_agent_tool(
    cmd: &AgentToolCommand,
    agent_id: Option<&str>,
    caller_from: &str,
    workspace: Option<&Path>,
    approved: bool,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let family = tool_family_for_command(cmd);
    let tool_name = format!("kite_{family}");
    let thread_opt = {
        let t = caller_from.trim();
        if t.is_empty() { None } else { Some(t) }
    };
    let aid_str = agent_id.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("anonymous");
    let verdict = match check_agent_tool_policy(agent_id, family, approved) {
        Ok(v) => v,
        Err(err) => {
            let verdict_label = if err.starts_with("Approval required:") {
                "asked"
            } else {
                "denied"
            };
            crate::agents::record_agent_audit_event(
                aid_str,
                thread_opt,
                &tool_name,
                family,
                verdict_label,
                Some(&err),
                started.elapsed().as_millis() as i64,
                None,
            );
            return Err(err);
        }
    };

    let result = execute_agent_tool_inner(cmd, agent_id, caller_from, workspace);
    let verdict_label = if verdict == "ask" { "asked" } else { "allowed" };
    let reason = result.as_ref().err().map(|s| s.as_str());
    crate::agents::record_agent_audit_event(
        aid_str,
        thread_opt,
        &tool_name,
        family,
        verdict_label,
        reason,
        started.elapsed().as_millis() as i64,
        None,
    );
    result
}

fn execute_agent_tool_inner(
    cmd: &AgentToolCommand,
    agent_id: Option<&str>,
    caller_from: &str,
    workspace: Option<&Path>,
) -> Result<Value, String> {
    match cmd {
        AgentToolCommand::TasksList { state, label, limit } => {
            let snap = crate::tickets::ticket_snapshot();
            let issues = snap
                .get("issues")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let filtered: Vec<Value> = issues
                .into_iter()
                .filter(|issue| {
                    if let Some(st) = state.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                        let actual = issue.get("state").and_then(Value::as_str).unwrap_or("");
                        if !actual.eq_ignore_ascii_case(st) {
                            return false;
                        }
                    }
                    if let Some(lbl) = label.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                        let has_lbl = issue
                            .get("labels")
                            .and_then(Value::as_array)
                            .is_some_and(|arr| {
                                arr.iter().any(|l| {
                                    l.as_str()
                                        .is_some_and(|s| s.eq_ignore_ascii_case(lbl))
                                })
                            });
                        if !has_lbl {
                            return false;
                        }
                    }
                    true
                })
                .take((*limit).clamp(1, 100))
                .collect();
            Ok(json!({ "tasks": filtered, "count": filtered.len() }))
        }
        AgentToolCommand::TasksGet { id } => {
            let snap = crate::tickets::ticket_snapshot();
            let found = snap
                .get("issues")
                .and_then(Value::as_array)
                .and_then(|arr| {
                    arr.iter().find(|i| {
                        i.get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|s| s.eq_ignore_ascii_case(id))
                            || i.get("uuid")
                                .and_then(Value::as_str)
                                .is_some_and(|s| s.eq_ignore_ascii_case(id))
                    })
                })
                .cloned();
            match found {
                Some(task) => Ok(json!({ "task": task })),
                None => Err(format!("Task '{id}' was not found.")),
            }
        }
        AgentToolCommand::TasksCreate {
            title,
            description,
            state,
            priority,
            labels,
            odd_path,
            source_agent,
            source_thread_id,
        } => {
            let resolved_agent = source_agent
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| resolve_agent_handle(agent_id));
            let resolved_thread = source_thread_id
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    let trimmed = caller_from.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed.to_string())
                    }
                });
            let res = crate::tickets::ticket_call(Some(json!({
                "tool": "save_issue",
                "title": title,
                "description": description,
                "state": state.as_deref().unwrap_or("To Do"),
                "priority": priority.as_deref().unwrap_or("Medium"),
                "labels": labels,
                "oddPath": odd_path,
                "sourceAgent": resolved_agent,
                "sourceThreadId": resolved_thread,
            })));
            if res.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(res)
            } else {
                Err(res
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Failed to create task")
                    .to_string())
            }
        }
        AgentToolCommand::TasksUpdate {
            id,
            title,
            description,
            state,
            priority,
            labels,
        } => {
            let mut payload = serde_json::Map::new();
            payload.insert("tool".into(), json!("save_issue"));
            payload.insert("id".into(), json!(id));
            if let Some(t) = title {
                payload.insert("title".into(), json!(t));
            }
            if let Some(d) = description {
                payload.insert("description".into(), json!(d));
            }
            if let Some(s) = state {
                payload.insert("state".into(), json!(s));
            }
            if let Some(p) = priority {
                payload.insert("priority".into(), json!(p));
            }
            if let Some(l) = labels {
                payload.insert("labels".into(), json!(l));
            }
            if let Some(sa) = resolve_agent_handle(agent_id) {
                payload.insert("sourceAgent".into(), json!(sa));
            }
            if !caller_from.trim().is_empty() {
                payload.insert("sourceThreadId".into(), json!(caller_from.trim()));
            }
            let res = crate::tickets::ticket_call(Some(Value::Object(payload)));
            if res.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(res)
            } else {
                Err(res
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Failed to update task")
                    .to_string())
            }
        }
        AgentToolCommand::TasksMoveState { id, state } => {
            let mut payload = serde_json::Map::new();
            payload.insert("tool".into(), json!("save_issue"));
            payload.insert("id".into(), json!(id));
            payload.insert("state".into(), json!(state));
            if let Some(sa) = resolve_agent_handle(agent_id) {
                payload.insert("sourceAgent".into(), json!(sa));
            }
            if !caller_from.trim().is_empty() {
                payload.insert("sourceThreadId".into(), json!(caller_from.trim()));
            }
            let res = crate::tickets::ticket_call(Some(Value::Object(payload)));
            if res.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(res)
            } else {
                Err(res
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Failed to move task state")
                    .to_string())
            }
        }
        AgentToolCommand::CtxReadCompact { path, mode } => {
            let roots = crate::agents::resolve_agent_authorized_roots(agent_id, workspace);
            let validated = crate::agents::validate_path_within_authorized_roots(Path::new(path), &roots)?;
            let parsed_mode = ReadMode::parse(mode).map_err(|e| e.to_string())?;
            let engine = ContextEngine::open_default()
                .map_err(|e| format!("Failed to open kite-ctx store: {e}"))?;
            let session_id = if caller_from.trim().is_empty() {
                "agent-ctx"
            } else {
                caller_from.trim()
            };
            let agent_label = resolve_agent_handle(agent_id).unwrap_or_else(|| "Agent".to_string());
            let res = engine
                .read_file_with_telemetry(
                    session_id,
                    &validated,
                    parsed_mode,
                    false,
                    &agent_label,
                    "kite",
                    "agent-tool",
                )
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "path": res.path,
                "mode": res.mode,
                "content": res.content,
                "rawTokens": res.raw_tokens,
                "deliveredTokens": res.delivered_tokens,
                "tokensSaved": res.tokens_saved,
                "ccrHash": res.ccr_hash,
            }))
        }
        AgentToolCommand::CtxSearch { query, path, limit } => {
            let roots = crate::agents::resolve_agent_authorized_roots(agent_id, workspace);
            let search_root = if let Some(p) = path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                crate::agents::validate_path_within_authorized_roots(Path::new(p), &roots)?
            } else if let Some(first) = roots.first() {
                first.clone()
            } else {
                return Err("No authorized root available for kite_ctx search.".to_string());
            };
            let mut matches = Vec::new();
            let capped = (*limit).clamp(1, 50);
            collect_text_search_matches(&search_root, &query.to_ascii_lowercase(), capped, &mut matches);
            let knowledge = crate::agent_mind::knowledge::search_knowledge_packs_at(
                &crate::agent_mind::agents_root(),
                agent_id.unwrap_or(""),
                query,
                capped.min(8),
            );
            Ok(json!({
                "query": query,
                "root": search_root.display().to_string(),
                "matches": matches,
                "knowledgeMatches": knowledge["matches"],
            }))
        }
        AgentToolCommand::CtxSharePut {
            key,
            content,
            scope,
            scope_id,
        } => {
            let engine = ContextEngine::open_default()
                .map_err(|e| format!("Failed to open kite-ctx store: {e}"))?;
            let parsed_scope = match scope.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(raw) => ContextScope::parse(raw).map_err(|e| e.to_string())?,
                None => ContextScope::Session,
            };
            let sid = scope_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    if caller_from.trim().is_empty() {
                        "agent-shared"
                    } else {
                        caller_from.trim()
                    }
                });
            let agent_label = resolve_agent_handle(agent_id).unwrap_or_else(|| "Agent".to_string());
            let entry = engine
                .share_put_with_telemetry(
                    parsed_scope,
                    sid,
                    key,
                    content,
                    &agent_label,
                    "kite",
                    None,
                    sid,
                    "agent-tool",
                )
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "key": entry.key,
                "scope": entry.scope.as_str(),
                "scopeId": entry.scope_id,
                "ccrHash": entry.ccr_hash,
                "originalTokens": entry.original_tokens,
                "compressedTokens": entry.compressed_tokens,
            }))
        }
        AgentToolCommand::CtxShareGet {
            key,
            scope,
            scope_id,
            full,
        } => {
            let engine = ContextEngine::open_default()
                .map_err(|e| format!("Failed to open kite-ctx store: {e}"))?;
            let parsed_scope = match scope.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(raw) => ContextScope::parse(raw).map_err(|e| e.to_string())?,
                None => ContextScope::Session,
            };
            let sid = scope_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    if caller_from.trim().is_empty() {
                        "agent-shared"
                    } else {
                        caller_from.trim()
                    }
                });
            let agent_label = resolve_agent_handle(agent_id).unwrap_or_else(|| "Agent".to_string());
            let content = engine
                .share_get_with_telemetry(
                    parsed_scope,
                    sid,
                    key,
                    *full,
                    sid,
                    &agent_label,
                    "kite",
                    "agent-tool",
                )
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "found": content.is_some(),
                "key": key,
                "scope": parsed_scope.as_str(),
                "scopeId": sid,
                "content": content,
            }))
        }
        AgentToolCommand::CtxCcrRetrieve {
            hash,
            lines,
            search,
        } => {
            let engine = ContextEngine::open_default()
                .map_err(|e| format!("Failed to open kite-ctx store: {e}"))?;
            let line_range = if let Some(spec) = lines.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let body = spec.strip_prefix("lines:").unwrap_or(spec);
                let parts: Vec<&str> = body.split('-').collect();
                if parts.len() != 2 {
                    return Err(format!("Invalid line range '{spec}' (expected N-M)."));
                }
                let start = parts[0].trim().parse::<usize>().map_err(|_| "Invalid start line".to_string())?;
                let end = parts[1].trim().parse::<usize>().map_err(|_| "Invalid end line".to_string())?;
                if start == 0 || end < start {
                    return Err("Line range must satisfy 1 <= start <= end.".to_string());
                }
                Some((start, end))
            } else {
                None
            };
            let sid = if caller_from.trim().is_empty() {
                "agent-ccr"
            } else {
                caller_from.trim()
            };
            let agent_label = resolve_agent_handle(agent_id).unwrap_or_else(|| "Agent".to_string());
            let res = engine
                .retrieve_ccr_with_telemetry(
                    hash,
                    line_range,
                    search.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                    sid,
                    &agent_label,
                    "kite",
                    "agent-tool",
                )
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "hash": res.hash,
                "content": res.content,
                "totalLines": res.total_lines,
                "returnedLines": res.returned_lines,
                "strategy": res.strategy,
            }))
        }
        AgentToolCommand::DiffStatus { workspace_id } => {
            let roots = crate::agents::resolve_agent_authorized_roots(agent_id, workspace);
            let dir = resolve_diff_workspace_dir(workspace_id.as_deref(), workspace, &roots)?;
            let out = crate::git::run_git(&dir, &["status", "--porcelain=v1", "-b"])
                .map_err(|e| e.message)?;
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            Ok(json!({
                "workspace": dir.display().to_string(),
                "status": text,
                "ok": out.status.success(),
            }))
        }
        AgentToolCommand::DiffFile {
            path,
            workspace_id,
            staged,
        } => {
            let roots = crate::agents::resolve_agent_authorized_roots(agent_id, workspace);
            let dir = resolve_diff_workspace_dir(workspace_id.as_deref(), workspace, &roots)?;
            let target_path = if Path::new(path).is_absolute() {
                PathBuf::from(path)
            } else {
                dir.join(path)
            };
            let validated = crate::agents::validate_path_within_authorized_roots(&target_path, &roots)?;
            let rel = validated.strip_prefix(&dir).unwrap_or(&validated);
            let rel_str = rel.to_string_lossy().to_string();
            let args = if *staged {
                vec!["diff", "--cached", "--", &rel_str]
            } else {
                vec!["diff", "--", &rel_str]
            };
            let out = crate::git::run_git(&dir, &args).map_err(|e| e.message)?;
            let diff = String::from_utf8_lossy(&out.stdout).to_string();
            Ok(json!({
                "workspace": dir.display().to_string(),
                "path": rel_str,
                "staged": staged,
                "diff": diff,
                "ok": out.status.success(),
            }))
        }
    }
}
