use std::path::{Path, PathBuf};
use std::time::Duration;
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
        AgentToolCommand::Browser { .. } => "browser",
    }
}

fn describe_agent_tool_command(cmd: &AgentToolCommand) -> String {
    match cmd {
        AgentToolCommand::TasksList { state, label, .. } => format!(
            "kite_tasks.list (state={}, label={})",
            state.as_deref().unwrap_or("*"),
            label.as_deref().unwrap_or("*")
        ),
        AgentToolCommand::TasksGet { id } => format!("kite_tasks.get id={id}"),
        AgentToolCommand::TasksCreate { title, state, .. } => format!(
            "kite_tasks.create title=\"{}\" state={}",
            title.chars().take(80).collect::<String>(),
            state.as_deref().unwrap_or("To Do")
        ),
        AgentToolCommand::TasksUpdate { id, state, .. } => format!(
            "kite_tasks.update id={id} state={}",
            state.as_deref().unwrap_or("-")
        ),
        AgentToolCommand::TasksMoveState { id, state } => {
            format!("kite_tasks.move_state id={id} -> {state}")
        }
        AgentToolCommand::CtxReadCompact { path, mode } => {
            format!("kite_ctx.read path={path} mode={mode}")
        }
        AgentToolCommand::CtxSearch { query, path, .. } => format!(
            "kite_ctx.search query=\"{}\" path={}",
            query.chars().take(60).collect::<String>(),
            path.as_deref().unwrap_or(".")
        ),
        AgentToolCommand::CtxSharePut { key, scope, .. } => format!(
            "kite_ctx.share_put key={key} scope={}",
            scope.as_deref().unwrap_or("session")
        ),
        AgentToolCommand::CtxShareGet { key, scope, .. } => format!(
            "kite_ctx.share_get key={key} scope={}",
            scope.as_deref().unwrap_or("session")
        ),
        AgentToolCommand::CtxCcrRetrieve { hash, .. } => format!("kite_ctx.retrieve hash={hash}"),
        AgentToolCommand::DiffStatus { workspace_id } => format!(
            "kite_diff.status workspace={}",
            workspace_id.as_deref().unwrap_or("default")
        ),
        AgentToolCommand::DiffFile { path, staged, .. } => {
            format!("kite_diff.file path={path} staged={staged}")
        }
        AgentToolCommand::Browser { payload_json } => {
            let parsed = serde_json::from_str::<Value>(payload_json).ok();
            let act = parsed
                .as_ref()
                .and_then(|v| v.get("action"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let target = parsed
                .as_ref()
                .and_then(|v| {
                    v.get("url")
                        .or_else(|| v.get("surfaceId"))
                        .or_else(|| v.get("surface_id"))
                        .or_else(|| v.get("intent"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("");
            if target.is_empty() {
                format!("kite_browser.{act}")
            } else {
                format!(
                    "kite_browser.{act} target={}",
                    target.chars().take(80).collect::<String>()
                )
            }
        }
    }
}

pub fn check_agent_tool_policy(
    agent_id: Option<&str>,
    family: &str,
    _approved: bool,
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
        "ask" => Err(format!(
            "Policy denied: tool family '{family}' is set to 'ask' for agent '{aid}' and requires host interactive approval."
        )),
        _ => Ok(decision),
    }
}

pub fn check_agent_tool_policy_interactive(
    agent_id: Option<&str>,
    thread_id: Option<&str>,
    family: &str,
    tool_name: &str,
    detail: &str,
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
        "ask" => {
            let clean_tid = thread_id
                .map(str::trim)
                .map(|s| s.strip_prefix("thread:").unwrap_or(s).trim())
                .filter(|s| !s.is_empty());
            let Some(tid) = clean_tid else {
                return Err(format!(
                    "Policy denied: tool family '{family}' is set to 'ask' for agent '{aid}', and no active thread session is available for interactive approval."
                ));
            };
            let risk = match family {
                "shell" | "filesystem_write" => "high",
                "tasks" | "routine" | "thread" | "teammate" => "medium",
                _ => "low",
            };
            let impact = format!("Run {tool_name} ({family})");
            let title = format!("Allow {tool_name}?");
            match crate::chat::runtime::pipeline::request_host_tool_approval(
                tid,
                Some(aid),
                tool_name,
                family,
                &title,
                detail,
                risk,
                &impact,
                Duration::from_secs(300),
            )? {
                crate::chat::session::ApprovalDecision::AllowOnce
                | crate::chat::session::ApprovalDecision::AllowForSession
                | crate::chat::session::ApprovalDecision::AlwaysAllow => Ok("ask"),
                crate::chat::session::ApprovalDecision::Deny => Err(format!(
                    "Policy denied: approval denied by user for '{tool_name}' ({family})."
                )),
                crate::chat::session::ApprovalDecision::DenyAndStop => Err(format!(
                    "Policy denied: turn stopped by user during approval for '{tool_name}' ({family})."
                )),
            }
        }
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
    _approved: bool,
) -> Result<Value, String> {
    execute_agent_tool_with_caller(cmd, agent_id, caller_from, workspace)
}

pub fn execute_agent_tool_with_caller(
    cmd: &AgentToolCommand,
    agent_id: Option<&str>,
    caller_from: &str,
    workspace: Option<&Path>,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let family = tool_family_for_command(cmd);
    let tool_name = format!("kite_{family}");
    let detail = describe_agent_tool_command(cmd);
    let thread_opt = {
        let t = caller_from.trim();
        let stripped = t.strip_prefix("thread:").unwrap_or(t).trim();
        if stripped.is_empty() { None } else { Some(stripped) }
    };
    let aid_str = agent_id.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("anonymous");
    let verdict = match check_agent_tool_policy_interactive(
        agent_id,
        thread_opt,
        family,
        &tool_name,
        &detail,
    ) {
        Ok(v) => v,
        Err(err) => {
            crate::agents::record_agent_audit_event(
                aid_str,
                thread_opt,
                &tool_name,
                family,
                "denied",
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
        AgentToolCommand::Browser { payload_json } => {
            let mut payload: Value = serde_json::from_str(payload_json)
                .map_err(|e| format!("Invalid kite_browser payload JSON: {e}"))?;
            if let Some(obj) = payload.as_object_mut() {
                let caller_tid = caller_from
                    .trim()
                    .strip_prefix("thread:")
                    .unwrap_or(caller_from.trim())
                    .trim();
                if !caller_tid.is_empty() {
                    obj.entry("threadId".to_string())
                        .or_insert_with(|| json!(caller_tid));
                    obj.entry("sessionId".to_string())
                        .or_insert_with(|| json!(caller_tid));
                }
                let agent_label = resolve_agent_handle(agent_id)
                    .unwrap_or_else(|| "browser-agent".to_string());
                obj.entry("agent".to_string())
                    .or_insert_with(|| json!(agent_label));
            }
            let result = if tokio::runtime::Handle::try_current().is_ok() {
                let payload_owned = payload.clone();
                std::thread::spawn(move || {
                    tauri::async_runtime::block_on(crate::browser_cdp::execute_browser_action(
                        crate::get_app_handle(),
                        &payload_owned,
                    ))
                })
                .join()
                .map_err(|_| "browser action worker thread panicked".to_string())?
            } else {
                tauri::async_runtime::block_on(crate::browser_cdp::execute_browser_action(
                    crate::get_app_handle(),
                    &payload,
                ))
            };
            let is_plain_error = result.get("ok").and_then(Value::as_bool) == Some(false)
                && result.get("pausedForUser").and_then(Value::as_bool) != Some(true)
                && result.get("requiresApproval").and_then(Value::as_bool) != Some(true)
                && result.get("blocked").and_then(Value::as_bool) != Some(true)
                && result.get("status").is_none()
                && result.get("failedStepIndex").is_none();
            if is_plain_error {
                let err = result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("kite_browser action failed");
                return Err(err.to_string());
            }
            Ok(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{load_agent_autonomy_config, save_agent_autonomy_config, AgentAutonomyConfig};
    use crate::chat::runtime::pipeline::write_approval_to_run;
    use crate::persist::threads;
    use uuid::Uuid;

    #[test]
    fn approved_flag_cannot_bypass_ask_policy_and_headless_fails_closed() {
        let aid = format!("ag-no-bypass-{}", Uuid::new_v4());
        let mut cfg = AgentAutonomyConfig::default();
        cfg.tool_policies.insert("tasks".into(), "ask".into());
        save_agent_autonomy_config(&aid, &cfg).unwrap();

        let err = check_agent_tool_policy(Some(&aid), "tasks", true)
            .expect_err("approved=true must never bypass 'ask' policy");
        assert!(!err.contains("approved=true"), "self-bypass hint must be gone: {err}");
        assert!(err.contains("Policy denied"));

        let cmd = AgentToolCommand::TasksList {
            state: None,
            label: None,
            limit: 5,
        };
        let exec_err = execute_agent_tool(&cmd, Some(&aid), "", None, true)
            .expect_err("headless execution with no thread_id must fail closed");
        assert!(exec_err.contains("no active thread session"));
    }

    #[test]
    fn interactive_policy_prompt_resolves_allow_once_deny_and_always_allow() {
        let aid = format!("ag-inter-{}", Uuid::new_v4());
        let tid = format!("th-inter-{}", Uuid::new_v4());
        let mut cfg = AgentAutonomyConfig::default();
        cfg.tool_policies.insert("tasks".into(), "ask".into());
        save_agent_autonomy_config(&aid, &cfg).unwrap();

        {
            let mut list = threads().lock().unwrap();
            list.push(json!({
                "id": tid,
                "status": "running",
                "profileId": aid,
                "items": [],
                "pendingApproval": Value::Null,
            }));
        }

        // 1. AllowOnce resolves and permits tool execution
        let tid_allow = tid.clone();
        let responder_allow = std::thread::spawn(move || {
            for _ in 0..80 {
                let pending_id = {
                    let list = threads().lock().unwrap();
                    list.iter()
                        .find(|t| t.get("id").and_then(Value::as_str) == Some(tid_allow.as_str()))
                        .and_then(|t| t.pointer("/pendingApproval/id").and_then(Value::as_str))
                        .map(str::to_string)
                };
                if let Some(req_id) = pending_id {
                    write_approval_to_run(&tid_allow, &req_id, "allowOnce");
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });

        let cmd = AgentToolCommand::TasksList {
            state: None,
            label: None,
            limit: 3,
        };
        let res = execute_agent_tool(&cmd, Some(&aid), &format!("thread:{tid}"), None, false);
        responder_allow.join().unwrap();
        assert!(res.is_ok(), "allowOnce must permit tool call: {res:?}");

        // 2. Deny rejects execution
        let tid_deny = tid.clone();
        let responder_deny = std::thread::spawn(move || {
            for _ in 0..80 {
                let pending_id = {
                    let list = threads().lock().unwrap();
                    list.iter()
                        .find(|t| t.get("id").and_then(Value::as_str) == Some(tid_deny.as_str()))
                        .and_then(|t| t.pointer("/pendingApproval/id").and_then(Value::as_str))
                        .map(str::to_string)
                };
                if let Some(req_id) = pending_id {
                    write_approval_to_run(&tid_deny, &req_id, "deny");
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });

        let deny_err = execute_agent_tool(&cmd, Some(&aid), &tid, None, false)
            .expect_err("deny decision must fail closed");
        responder_deny.join().unwrap();
        assert!(deny_err.contains("denied by user"));

        // 3. AlwaysAllow permits execution AND persists "allow" in SQLite
        let tid_always = tid.clone();
        let responder_always = std::thread::spawn(move || {
            for _ in 0..80 {
                let pending_id = {
                    let list = threads().lock().unwrap();
                    list.iter()
                        .find(|t| t.get("id").and_then(Value::as_str) == Some(tid_always.as_str()))
                        .and_then(|t| t.pointer("/pendingApproval/id").and_then(Value::as_str))
                        .map(str::to_string)
                };
                if let Some(req_id) = pending_id {
                    write_approval_to_run(&tid_always, &req_id, "alwaysAllow");
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });

        let always_res = execute_agent_tool(&cmd, Some(&aid), &tid, None, false);
        responder_always.join().unwrap();
        assert!(always_res.is_ok(), "alwaysAllow must permit tool call");

        let updated_cfg = load_agent_autonomy_config(&aid);
        assert_eq!(
            updated_cfg.tool_policies.get("tasks").map(String::as_str),
            Some("allow"),
            "alwaysAllow must persist 'allow' to SQLite tool_policies"
        );

        // Next headless call succeeds immediately without prompting!
        assert_eq!(
            check_agent_tool_policy_interactive(Some(&aid), None, "tasks", "kite_tasks", "list")
                .unwrap(),
            "allow"
        );

        threads().lock().unwrap().retain(|t| t.get("id").and_then(Value::as_str) != Some(tid.as_str()));
    }
}
