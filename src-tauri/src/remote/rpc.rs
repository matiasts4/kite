use crate::remote::auth::{host_name, now_unix_ms, AuthStore};
use crate::remote::events::{active_run_cursor, RemoteEventBus};
use crate::remote::voice::handle_voice;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
    pub fn invalid_params(msg: impl Into<String>) -> Self { Self::new("invalid_params", msg) }
    pub fn internal(msg: impl Into<String>) -> Self { Self::new("internal_error", msg) }
}

pub struct RpcContext {
    pub auth: Arc<AuthStore>,
    pub events: Arc<RemoteEventBus>,
    pub subscribed_threads: Arc<Mutex<HashSet<String>>>,
}

impl RpcContext {
    pub fn subscribe_thread(&self, thread_id: &str, cursor: Option<(String, u64)>) {
        let inserted = self
            .subscribed_threads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(thread_id.to_string());
        if inserted {
            self.events.add_thread_subscriber(thread_id, cursor);
        } else {
            self.events.ensure_thread_watcher(thread_id.to_string());
        }
    }

    pub fn unsubscribe_thread(&self, thread_id: &str) {
        let removed = self
            .subscribed_threads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(thread_id);
        if removed {
            self.events.remove_thread_subscriber(thread_id);
        }
    }
}

pub async fn dispatch_frame(ctx: &RpcContext, raw: &str) -> Option<String> {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(err) => return Some(err_frame("", RpcError::new("invalid_json", format!("Malformed JSON: {err}")))),
    };
    match parsed.get("type").and_then(Value::as_str).unwrap_or("") {
        "ping" => Some(json!({ "type": "pong", "ts": parsed.get("ts").cloned().unwrap_or_else(|| json!(now_unix_ms())) }).to_string()),
        "pong" => None,
        "req" => {
            let id = parsed.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let method = parsed.get("method").and_then(Value::as_str).unwrap_or("").trim();
            if method.is_empty() {
                return Some(err_frame(&id, RpcError::invalid_params("RPC method is required.")));
            }
            let params = parsed.get("params").cloned().unwrap_or_else(|| json!({}));
            Some(match dispatch_method(ctx, method, params).await {
                Ok(result) => json!({ "type": "res", "id": id, "ok": true, "result": result }).to_string(),
                Err(err) => err_frame(&id, err),
            })
        }
        _ => None,
    }
}

pub fn err_frame(id: &str, err: RpcError) -> String {
    json!({ "type": "res", "id": id, "ok": false, "error": { "code": err.code, "message": err.message } }).to_string()
}

pub fn req_str(params: &Value, key: &str) -> Result<String, RpcError> {
    opt_str(params, key).ok_or_else(|| RpcError::invalid_params(format!("{key} is required.")))
}

pub fn opt_str(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

pub async fn blocking<F, T>(f: F) -> Result<T, RpcError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f).await.map_err(|e| RpcError::internal(e.to_string()))
}

async fn project_thread(thread: Value) -> Result<Value, RpcError> {
    blocking(move || crate::chat::subagents::project_thread_for_ipc(thread)).await
}

fn git_err<T: serde::Serialize>(res: Result<T, crate::git::GitError>) -> Result<Value, RpcError> {
    let val = res.map_err(|e| RpcError::new(e.code, e.message))?;
    serde_json::to_value(val).map_err(|e| RpcError::internal(e.to_string()))
}

pub async fn dispatch_method(ctx: &RpcContext, method: &str, params: Value) -> Result<Value, RpcError> {
    if method.starts_with("system.") || method.starts_with("workspace.") {
        handle_system_workspace(ctx, method, params).await
    } else if method.starts_with("thread.") {
        handle_thread(ctx, method, params).await
    } else if method.starts_with("provider.") {
        handle_provider(method, params).await
    } else if method.starts_with("agent.") || method.starts_with("subagent.") || method.starts_with("swarm.") {
        handle_agents_swarms(method, params).await
    } else if method.starts_with("voice.") {
        handle_voice(ctx, method, params).await
    } else if method == "mobile.update.check" || method.starts_with("mobile.") {
        crate::remote::mobile_update::handle_mobile_rpc(method, params).await
    } else {
        Err(RpcError::new("method_not_found", format!("Unknown RPC method '{method}'.")))
    }
}

async fn handle_system_workspace(ctx: &RpcContext, method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        "system.ping" => Ok(json!({ "ok": true, "serverTimeMs": now_unix_ms(), "connectedClients": ctx.events.connected_clients() })),
        "system.bootstrap" => {
            let live_runs = crate::chat_commands::list_live_chat_runs(None).await;
            blocking(move || build_bootstrap_payload(live_runs)).await
        }
        "workspace.list" => Ok(json!({ "workspaces": blocking(crate::persist::list_workspaces_snapshot).await? })),
        "workspace.branches" => { let _ = req_str(&params, "workspaceId")?; git_err(crate::git::list_workspace_branches(Some(params)).await) }
        "workspace.changes" => { let _ = req_str(&params, "workspaceId")?; git_err(crate::git::read_workspace_changes(Some(params)).await) }
        "workspace.file_diff" => {
            let _ = req_str(&params, "workspaceId")?;
            let _ = req_str(&params, "path")?;
            git_err(crate::git::read_workspace_file_diff(Some(params)).await)
        }
        "workspace.file_preview" => {
            crate::remote::file_preview::handle_workspace_file_preview(params).await
        }
        _ => Err(RpcError::new("method_not_found", format!("Unknown method '{method}'."))),
    }
}

fn build_bootstrap_payload(live_runs: Vec<Value>) -> Value {
    let pending_approvals: Vec<Value> = {
        let items = crate::persist::threads().lock().unwrap_or_else(|e| e.into_inner());
        items.iter().filter(|t| crate::chat::archived_at_ms(t).is_none()).filter_map(|t| {
            let approval = t.get("pendingApproval").filter(|v| !v.is_null())?;
            let thread_id = t.get("id").and_then(Value::as_str)?;
            Some(json!({
                "threadId": thread_id,
                "title": t.get("title").and_then(Value::as_str).unwrap_or("Chat"),
                "profileId": t.get("profileId").cloned().unwrap_or(Value::Null),
                "approval": approval,
            }))
        }).collect()
    };
    let offline_ready = crate::voice_audio::offline_stt::probe_local_engines(None, None).iter().any(|e| e.available);
    let realtime_ready = [
        crate::voice_realtime::RealtimeProviderKind::Xai,
        crate::voice_realtime::RealtimeProviderKind::OpenAi,
        crate::voice_realtime::RealtimeProviderKind::GeminiLive,
    ].iter().any(|&p| !crate::voice_realtime::resolve_realtime_api_key(p, None).is_empty());
    let grok_stt_configured = crate::remote::voice::has_grok_stt_key();
    let openai_stt_configured = crate::remote::voice::has_openai_stt_key();
    let elevenlabs_configured = crate::credentials::resolve_provider_key("elevenlabs").is_some();
    let voice_settings = crate::remote::voice::DesktopVoiceSettings::load();
    let mut provider_models = serde_json::Map::new();
    for provider in crate::chat::models::THREAD_PROVIDERS {
        let models = crate::chat::models::cached_provider_models(provider, None);
        if !models.is_empty() {
            provider_models.insert(provider.to_string(), Value::Array(models));
        }
    }

    let mut payload = json!({
        "protocol": "kite-remote/v1",
        "hostName": host_name(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "candidateUrls": crate::remote::current_candidate_urls(),
        "workspaces": crate::persist::list_workspaces_snapshot(),
        "agents": crate::persist::list_agents_snapshot(),
        "providerModels": Value::Object(provider_models),
        "liveRuns": live_runs,
        "pendingApprovals": pending_approvals,
        "voiceCapabilities": {
            "cloudSttConfigured": grok_stt_configured || openai_stt_configured,
            "grokSttConfigured": grok_stt_configured,
            "openaiSttConfigured": openai_stt_configured,
            "offlineSttReady": offline_ready,
            "elevenLabsTtsConfigured": elevenlabs_configured,
            "realtimeConfigured": realtime_ready,
            "realtimeProviders": ["xai", "openai", "gemini_live"],
            "defaultSttProvider": "auto",
            "defaultTtsProvider": voice_settings.default_tts_provider(),
            "elevenLabsVoiceId": voice_settings.elevenlabs_voice_id,
            "elevenLabsModel": voice_settings.elevenlabs_model,
            "sttProviders": ["auto", "grok", "openai", "offline"],
            "ttsProviders": ["auto", "elevenlabs", "device"],
        }
    });
    if let Some(mobile_update) = crate::remote::mobile_update::latest_manifest_wire_json() {
        payload["mobileUpdate"] = mobile_update;
    }
    payload
}

async fn handle_thread(ctx: &RpcContext, method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        "thread.list" => {
            let (ws_f, ag_f) = (opt_str(&params, "workspaceId"), opt_str(&params, "agentId"));
            let include_archived = params.get("includeArchived").and_then(Value::as_bool).unwrap_or(false);
            let res = if let Some(ref aid) = ag_f {
                crate::chat_commands::list_agent_chat_summaries(Some(json!({ "agentId": aid }))).await
            } else {
                crate::chat_commands::list_chat_summaries(None).await
            };
            let mut summaries = res.get("summaries").and_then(Value::as_array).cloned().unwrap_or_default();
            if include_archived {
                let (ws_c, ag_c) = (ws_f.clone(), ag_f.clone());
                summaries.extend(blocking(move || {
                    let items = crate::persist::threads().lock().unwrap_or_else(|e| e.into_inner());
                    items.iter().filter(|t| crate::chat::archived_at_ms(t).is_some())
                        .filter(|t| {
                            let pid = t.get("profileId").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
                            match ag_c.as_deref() {
                                Some(a) => pid == Some(a),
                                None => pid.is_none(),
                            }
                        })
                        .filter(|t| ws_c.as_deref().is_none_or(|w| t.get("workspaceId").and_then(Value::as_str) == Some(w)))
                        .filter_map(|t| {
                            let mut s = crate::chat::summary_of(t)?;
                            s["archivedAtUnixMs"] = t["archivedAtUnixMs"].clone();
                            Some(s)
                        }).collect::<Vec<Value>>()
                }).await?);
            }
            if let Some(ref wid) = ws_f { summaries.retain(|s| s.get("workspaceId").and_then(Value::as_str) == Some(wid.as_str())); }
            if ag_f.is_none() {
                summaries.retain(|s| s.get("profileId").and_then(Value::as_str).is_none_or(|p| p.trim().is_empty()));
            }
            let mut live_runs = crate::chat_commands::list_live_chat_runs(None).await;
            if let Some(ref wid) = ws_f { live_runs.retain(|r| r.get("workspaceId").and_then(Value::as_str) == Some(wid.as_str())); }
            match ag_f.as_deref() {
                Some(aid) => live_runs.retain(|r| r.get("profileId").and_then(Value::as_str) == Some(aid)),
                None => live_runs.retain(|r| r.get("profileId").and_then(Value::as_str).is_none_or(|p| p.trim().is_empty())),
            }
            Ok(json!({ "summaries": summaries, "liveRuns": live_runs }))
        }
        "thread.load" => {
            let tid = req_str(&params, "threadId")?;
            let subscribe_req = params.get("subscribe").and_then(Value::as_bool).unwrap_or(false);
            let tid_c = tid.clone();
            let (running, cursor) = blocking(move || {
                (crate::chat::is_turn_running(&tid_c), active_run_cursor(&tid_c))
            }).await?;
            let thread = if let Some(aid) = opt_str(&params, "agentId") {
                crate::chat_commands::load_agent_chat_thread(Some(json!({ "threadId": tid, "agentId": aid }))).await
            } else {
                crate::chat_commands::load_chat_thread(Some(json!({ "threadId": tid }))).await
            };
            if running || subscribe_req {
                ctx.subscribe_thread(&tid, cursor);
            }
            Ok(thread)
        }
        "thread.create" => {
            let kind = opt_str(&params, "kind").unwrap_or_else(|| if opt_str(&params, "agentId").is_some() { "agent" } else { "general" }.into());
            let created = match kind.as_str() {
                "agent" => crate::chat_commands::create_agent_chat(Some(params)).await,
                "general" => {
                    let mut thread = crate::chat_commands::create_general_chat(Some(params.clone())).await;
                    let tid = thread.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    if !tid.is_empty() && (params.get("model").is_some() || params.get("plan").is_some() || params.get("effort").is_some()) {
                        thread = blocking(move || crate::chat::configure_thread(&tid, &params)).await?;
                    }
                    thread
                }
                other => return Err(RpcError::invalid_params(format!("Unsupported thread kind '{other}'."))),
            };
            project_thread(created).await
        }
        "thread.send" => {
            let tid = req_str(&params, "threadId")?;
            let _ = req_str(&params, "prompt")?;
            let client_msg_id = opt_str(&params, "clientMessageId");
            let mut res = if opt_str(&params, "agentId").is_some() {
                crate::chat_commands::start_agent_chat_turn(Some(params)).await
            } else {
                crate::chat_commands::start_chat_turn(Some(params)).await
            };
            if let Some(err) = res.get("error").and_then(Value::as_str) { return Err(RpcError::internal(err)); }
            if let Some(t) = res.get("thread").cloned() { res["thread"] = project_thread(t).await?; }
            if let Some(cmid) = client_msg_id { res["clientMessageId"] = json!(cmid); }
            let run_id = res.get("runId").and_then(Value::as_str).map(str::to_string);
            let cursor = run_id.map(|r| (r, 0u64));
            ctx.subscribe_thread(&tid, cursor);
            Ok(res)
        }
        "thread.cancel" => {
            let tid = req_str(&params, "threadId")?;
            if opt_str(&params, "agentId").is_some() { let _ = crate::chat_commands::cancel_agent_chat_turn(Some(params)).await; }
            else { let _ = crate::chat_commands::cancel_chat_turn(Some(params)).await; }
            Ok(json!({ "ok": true, "threadId": tid }))
        }
        "thread.configure" => { let _ = req_str(&params, "threadId")?; project_thread(crate::chat_commands::update_chat_configuration(Some(params)).await).await }
        "thread.approve" => {
            let (tid, decision) = (req_str(&params, "threadId")?, req_str(&params, "decision")?);
            if crate::chat::approval::parse_decision(&decision).is_none() {
                return Err(RpcError::invalid_params(format!("Invalid approval decision '{decision}'.")));
            }
            let mut req_payload = params.clone();
            if opt_str(&req_payload, "requestId").is_none() {
                if let Some(aid) = opt_str(&req_payload, "approvalId") { req_payload["requestId"] = json!(aid); }
            }
            let updated = crate::chat_commands::respond_chat_approval(Some(req_payload)).await;
            ctx.events.ensure_thread_watcher(tid);
            project_thread(updated).await
        }
        "thread.respond_input" => {
            let tid = req_str(&params, "threadId")?;
            let answers = params.get("answers").cloned().filter(Value::is_object)
                .ok_or_else(|| RpcError::invalid_params("answers object is required."))?;
            let explicit_req_id = opt_str(&params, "requestId");
            let updated = if let Some(req_id) = explicit_req_id {
                let tid_c = tid.clone();
                blocking(move || {
                    crate::chat::runtime::pipeline::write_user_input_to_run(&tid_c, &req_id, &answers);
                    crate::chat::load_thread(&tid_c, None, "Chat")
                }).await?
            } else {
                crate::chat_commands::respond_chat_user_input(Some(params)).await
            };
            ctx.events.ensure_thread_watcher(tid);
            project_thread(updated).await
        }
        "thread.subscribe" => {
            let tid = req_str(&params, "threadId")?;
            let tid_c = tid.clone();
            let cursor = blocking(move || active_run_cursor(&tid_c)).await?;
            ctx.subscribe_thread(&tid, cursor);
            Ok(json!({ "ok": true, "threadId": tid }))
        }
        "thread.unsubscribe" => {
            let tid = req_str(&params, "threadId")?;
            ctx.unsubscribe_thread(&tid);
            Ok(json!({ "ok": true, "threadId": tid }))
        }
        _ => Err(RpcError::new("method_not_found", format!("Unknown method '{method}'."))),
    }
}

pub fn normalize_subagent_snapshot_runs(mut snap: Value, filter_tid: Option<&str>) -> Value {
    let raw_runs = snap.get("runs").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut flat_runs = Vec::with_capacity(raw_runs.len());
    for entry in raw_runs {
        let entry_tid = entry.get("threadId").and_then(Value::as_str).map(str::to_string);
        if let Some(ft) = filter_tid {
            if entry_tid.as_deref() != Some(ft) { continue; }
        }
        let mut flat = match entry.get("run").and_then(Value::as_object) {
            Some(run_obj) => Value::Object(run_obj.clone()),
            None => entry.clone(),
        };
        if let Some(obj) = flat.as_object_mut() {
            if !obj.contains_key("parentThreadId") {
                if let Some(ref tid) = entry_tid { obj.insert("parentThreadId".into(), json!(tid)); }
            }
            if !obj.contains_key("threadId") {
                if let Some(tid) = entry_tid { obj.insert("threadId".into(), json!(tid)); }
            }
            for extra in ["threadTitle", "workspaceId"] {
                if !obj.contains_key(extra) {
                    if let Some(v) = entry.get(extra).filter(|v| !v.is_null()) {
                        obj.insert(extra.into(), v.clone());
                    }
                }
            }
        }
        flat_runs.push(flat);
    }
    snap["runs"] = Value::Array(flat_runs);
    snap
}

async fn handle_agents_swarms(method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        "agent.list" => blocking(|| json!({ "agents": crate::persist::list_agents_snapshot(), "availability": crate::agents::get_agent_availability(None) })).await,
        "agent.playbooks.list" => {
            let agent_filter = opt_str(&params, "agentId");
            blocking(move || {
                let mut playbooks = crate::agent_playbooks::list_agent_playbooks().get("playbooks").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut runs = crate::agent_playbooks::list_playbook_runs(None).get("runs").and_then(Value::as_array).cloned().unwrap_or_default();
                if let Some(ref aid) = agent_filter {
                    playbooks.retain(|pb| pb.get("stages").and_then(Value::as_array).is_some_and(|st| st.iter().any(|s| s.get("agentProfileId").and_then(Value::as_str) == Some(aid.as_str()))));
                    let ids: HashSet<String> = playbooks.iter().filter_map(|p| p.get("id").and_then(Value::as_str).map(str::to_string)).collect();
                    runs.retain(|r| r.get("playbookId").and_then(Value::as_str).is_some_and(|id| ids.contains(id)));
                }
                json!({ "playbooks": playbooks, "runs": runs })
            }).await
        }
        "agent.playbooks.run" => {
            let _ = req_str(&params, "playbookId")?;
            blocking(move || crate::agent_playbooks::run_agent_playbook(Some(params))
                .map(|v| json!({ "ok": true, "run": v.get("run").cloned().unwrap_or(Value::Null) }))
                .map_err(|e| RpcError::new("playbook_error", e))).await?
        }
        "subagent.list" => {
            let (tid, sid, wid) = (opt_str(&params, "threadId"), opt_str(&params, "subagentId"), opt_str(&params, "workspaceId"));
            let limit = params.get("limit").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(120);
            blocking(move || {
                if let (Some(t), Some(s)) = (tid.as_deref(), sid.as_deref()) {
                    return json!({ "detail": crate::chat::subagents::build_subagent_detail(t, s) });
                }
                let snap = crate::chat::subagents::list_all_subagent_runs_snapshot(wid.as_deref(), limit);
                normalize_subagent_snapshot_runs(snap, tid.as_deref())
            }).await
        }
        "subagent.send" => {
            let (tid, sid, msg) = (req_str(&params, "threadId")?, req_str(&params, "subagentId")?, req_str(&params, "message")?);
            blocking(move || match crate::chat::subagents::steer_subagent_thread(&tid, &sid, &msg) {
                Ok(run) => json!({ "ok": true, "run": run }),
                Err(error) => json!({ "ok": false, "error": error }),
            }).await
        }
        "subagent.stop" => {
            let (tid, sid) = (req_str(&params, "threadId")?, req_str(&params, "subagentId")?);
            blocking(move || match crate::chat::subagents::cancel_subagent_thread(&tid, &sid) {
                Ok(run) => json!({ "ok": true, "run": run }),
                Err(error) => json!({ "ok": false, "error": error }),
            }).await
        }
        "swarm.state" => { let tid = req_str(&params, "threadId")?; blocking(move || crate::chat::subagents::build_swarm_state(&tid)).await }
        "swarm.post" | "swarm.kill" => {
            let tid = req_str(&params, "threadId")?;
            let cmd = if method == "swarm.post" {
                crate::dispatch::cli::SwarmCommand::Post {
                    channel: opt_str(&params, "channel").or_else(|| opt_str(&params, "to")),
                    text: req_str(&params, "message")?,
                }
            } else {
                let name = opt_str(&params, "memberName").or_else(|| opt_str(&params, "name"))
                    .ok_or_else(|| RpcError::invalid_params("memberName is required."))?;
                crate::dispatch::cli::SwarmCommand::Kill { name }
            };
            blocking(move || match crate::chat::swarm::execute_swarm_action(&cmd, &format!("thread:{tid}"), None, None) {
                Ok(txt) => json!({
                    "ok": true,
                    "result": serde_json::from_str::<Value>(&txt).unwrap_or_else(|_| json!({ "message": txt })),
                    "swarmState": crate::chat::subagents::build_swarm_state(&tid),
                }),
                Err(err) => json!({ "ok": false, "error": err.code() }),
            }).await
        }
        _ => Err(RpcError::new("method_not_found", format!("Unknown method '{method}'."))),
    }
}

async fn handle_provider(method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        "provider.models" => {
            let provider = req_str(&params, "provider")?;
            if !crate::chat::provider_ok(&provider) {
                return Err(RpcError::invalid_params(format!("Unsupported provider '{provider}'.")));
            }
            Ok(crate::chat_commands::list_chat_provider_models(Some(params)).await)
        }
        _ => Err(RpcError::new("method_not_found", format!("Unknown method '{method}'."))),
    }
}
