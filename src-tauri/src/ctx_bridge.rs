//! Tauri IPC bridge exposing `kite-ctx` voice context packing, KV cache planning,
//! shared inter-agent handoffs, CCR retrieval, and compact file reads.

use kite_ctx::{scan_volatile_tokens, sha256_hex, ContextEngine, ContextScope, ReadMode};
use serde_json::{json, Value};

const DEFAULT_VOICE_SESSION_ID: &str = "argos-voice";
const DEFAULT_VOICE_AGENT: &str = "Argos";
const DEFAULT_VOICE_PROVIDER: &str = "local";
const DEFAULT_VOICE_MODEL: &str = "argos-voice";
const DEFAULT_MAX_LIVE_TURNS: usize = 4;

fn open_engine() -> Result<ContextEngine, String> {
    ContextEngine::open_default().map_err(|err| format!("failed to open kite-ctx store: {err}"))
}

fn parse_line_range(spec: &str) -> Result<(usize, usize), String> {
    let trimmed = spec.trim();
    let body = trimmed.strip_prefix("lines:").unwrap_or(trimmed);
    let parts: Vec<&str> = body.split('-').collect();
    if parts.len() != 2 {
        return Err(format!("invalid line range '{spec}' (expected N-M)"));
    }
    let start = parts[0]
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("invalid line start in '{spec}'"))?;
    let end = parts[1]
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("invalid line end in '{spec}'"))?;
    if start == 0 || end < start {
        return Err(format!("line range must satisfy 1 <= start <= end in '{spec}'"));
    }
    Ok((start, end))
}

fn resolve_scope(scope: Option<String>) -> Result<ContextScope, String> {
    match scope.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => ContextScope::parse(raw).map_err(|e| e.to_string()),
        None => Ok(ContextScope::Session),
    }
}

fn resolve_scope_id(scope_id: Option<String>) -> String {
    scope_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_VOICE_SESSION_ID)
        .to_string()
}

fn resolve_agent(agent: Option<String>) -> String {
    agent
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_VOICE_AGENT)
        .to_string()
}

pub(crate) fn pack_voice_context_with_engine(
    engine: &ContextEngine,
    text: String,
    max_tokens: Option<usize>,
) -> Result<Value, String> {
    let pack = engine
        .pack_voice_context_with_budget(&text, max_tokens)
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "text": pack.text,
        "originalTokens": pack.original_tokens,
        "compressedTokens": pack.compressed_tokens,
    }))
}

pub(crate) fn kv_plan_with_engine(
    engine: &ContextEngine,
    provider: String,
    static_prefix: String,
    turn_texts: Vec<String>,
    max_live_turns: Option<usize>,
    idle_secs: Option<u64>,
) -> Result<Value, String> {
    let volatile_findings = scan_volatile_tokens(&static_prefix);
    let static_prefix_clean = volatile_findings.is_empty();
    let static_prefix_hash = sha256_hex(&static_prefix);
    let turn_hashes: Vec<String> = turn_texts.iter().map(|t| sha256_hex(t)).collect();
    let plan = engine
        .kv()
        .plan_voice_window(
            &provider,
            &static_prefix_hash,
            &turn_hashes,
            max_live_turns.unwrap_or(DEFAULT_MAX_LIVE_TURNS),
            idle_secs.unwrap_or(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "staticPrefixClean": static_prefix_clean,
        "volatileFindings": volatile_findings,
        "frozenTurnCount": plan.frozen_message_count,
        "liveStartIndex": plan.live_start_index,
        "allowCompaction": plan.allow_compaction,
    }))
}

pub(crate) fn share_put_with_engine(
    engine: &ContextEngine,
    key: String,
    content: String,
    scope: Option<String>,
    scope_id: Option<String>,
    agent: Option<String>,
) -> Result<Value, String> {
    let parsed_scope = resolve_scope(scope)?;
    let resolved_scope_id = resolve_scope_id(scope_id);
    let resolved_agent = resolve_agent(agent);
    let entry = engine
        .share_put_with_telemetry(
            parsed_scope,
            &resolved_scope_id,
            &key,
            &content,
            &resolved_agent,
            DEFAULT_VOICE_PROVIDER,
            None,
            &resolved_scope_id,
            DEFAULT_VOICE_MODEL,
        )
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "key": entry.key,
        "scope": entry.scope.as_str(),
        "scopeId": entry.scope_id,
        "ccrHash": entry.ccr_hash,
        "compressedText": entry.compressed_text,
        "originalTokens": entry.original_tokens,
        "compressedTokens": entry.compressed_tokens,
        "savingsPercent": entry.savings_percent(),
    }))
}

pub(crate) fn share_get_with_engine(
    engine: &ContextEngine,
    key: String,
    scope: Option<String>,
    scope_id: Option<String>,
    full: Option<bool>,
) -> Result<Value, String> {
    let parsed_scope = resolve_scope(scope)?;
    let resolved_scope_id = resolve_scope_id(scope_id);
    let want_full = full.unwrap_or(false);
    let content = engine
        .share_get_with_telemetry(
            parsed_scope,
            &resolved_scope_id,
            &key,
            want_full,
            &resolved_scope_id,
            DEFAULT_VOICE_AGENT,
            DEFAULT_VOICE_PROVIDER,
            DEFAULT_VOICE_MODEL,
        )
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "found": content.is_some(),
        "key": key,
        "scope": parsed_scope.as_str(),
        "scopeId": resolved_scope_id,
        "full": want_full,
        "content": content,
    }))
}

pub(crate) fn ccr_retrieve_with_engine(
    engine: &ContextEngine,
    hash: String,
    lines: Option<String>,
    search: Option<String>,
) -> Result<Value, String> {
    let line_range = match lines.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(spec) => Some(parse_line_range(spec)?),
        None => None,
    };
    let search_term = search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let res = engine
        .retrieve_ccr_with_telemetry(
            &hash,
            line_range,
            search_term,
            DEFAULT_VOICE_SESSION_ID,
            DEFAULT_VOICE_AGENT,
            DEFAULT_VOICE_PROVIDER,
            DEFAULT_VOICE_MODEL,
        )
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "hash": res.hash,
        "content": res.content,
        "totalLines": res.total_lines,
        "returnedLines": res.returned_lines,
        "originalTokens": res.original_tokens,
        "strategy": res.strategy,
        "toolName": res.tool_name,
    }))
}

pub(crate) fn read_compact_with_engine(
    engine: &ContextEngine,
    path: String,
    mode: Option<String>,
) -> Result<Value, String> {
    let parsed_mode = ReadMode::parse(mode.as_deref().unwrap_or("signatures"))
        .map_err(|e| e.to_string())?;
    let res = engine
        .read_file_with_telemetry(
            DEFAULT_VOICE_SESSION_ID,
            &path,
            parsed_mode,
            false,
            DEFAULT_VOICE_AGENT,
            DEFAULT_VOICE_PROVIDER,
            DEFAULT_VOICE_MODEL,
        )
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "path": res.path,
        "mode": res.mode,
        "content": res.content,
        "rawTokens": res.raw_tokens,
        "deliveredTokens": res.delivered_tokens,
        "tokensSaved": res.tokens_saved,
        "deduplicated": res.deduplicated,
        "deltaDiff": res.delta_diff,
        "ccrHash": res.ccr_hash,
    }))
}

#[tauri::command]
pub fn ctx_pack_voice_context(text: String, max_tokens: Option<usize>) -> Result<Value, String> {
    let engine = open_engine()?;
    pack_voice_context_with_engine(&engine, text, max_tokens)
}

#[tauri::command]
pub fn ctx_kv_plan(
    provider: String,
    static_prefix: String,
    turn_texts: Vec<String>,
    max_live_turns: Option<usize>,
    idle_secs: Option<u64>,
) -> Result<Value, String> {
    let engine = open_engine()?;
    kv_plan_with_engine(
        &engine,
        provider,
        static_prefix,
        turn_texts,
        max_live_turns,
        idle_secs,
    )
}

#[tauri::command]
pub fn ctx_share_put(
    key: String,
    content: String,
    scope: Option<String>,
    scope_id: Option<String>,
    agent: Option<String>,
) -> Result<Value, String> {
    let engine = open_engine()?;
    share_put_with_engine(&engine, key, content, scope, scope_id, agent)
}

#[tauri::command]
pub fn ctx_share_get(
    key: String,
    scope: Option<String>,
    scope_id: Option<String>,
    full: Option<bool>,
) -> Result<Value, String> {
    let engine = open_engine()?;
    share_get_with_engine(&engine, key, scope, scope_id, full)
}

#[tauri::command]
pub fn ctx_ccr_retrieve(
    hash: String,
    lines: Option<String>,
    search: Option<String>,
) -> Result<Value, String> {
    let engine = open_engine()?;
    ccr_retrieve_with_engine(&engine, hash, lines, search)
}

#[tauri::command]
pub fn ctx_read_compact(path: String, mode: Option<String>) -> Result<Value, String> {
    let engine = open_engine()?;
    read_compact_with_engine(&engine, path, mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_pack_and_kv_plan_commands_return_expected_contracts() {
        let engine = ContextEngine::open_in_memory().unwrap();
        let big = format!(
            "HEAD: active branch feat/response-thread\n{}\nTAIL: all checks pending",
            "status detail repeated\n".repeat(120)
        );
        let packed = pack_voice_context_with_engine(&engine, big, None).unwrap();
        assert!(packed["compressedTokens"].as_u64().unwrap() < 250);
        assert!(packed["originalTokens"].as_u64().unwrap() > packed["compressedTokens"].as_u64().unwrap());

        let dirty_plan = kv_plan_with_engine(
            &engine,
            "anthropic".to_string(),
            "You are Argos. Updated hace 5s.".to_string(),
            (0..8).map(|i| format!("turn {i}")).collect(),
            Some(4),
            Some(10),
        )
        .unwrap();
        assert_eq!(dirty_plan["staticPrefixClean"], false);
        assert_eq!(dirty_plan["volatileFindings"].as_array().unwrap().len(), 1);
        assert_eq!(dirty_plan["frozenTurnCount"], 4);
        assert_eq!(dirty_plan["liveStartIndex"], 4);
        assert_eq!(dirty_plan["allowCompaction"], true);
    }

    #[test]
    fn share_ccr_and_read_compact_round_trip() {
        let engine = ContextEngine::open_in_memory().unwrap();
        let raw_lines: String = (1..=30).map(|i| format!("finding line {i}\n")).collect();
        let put = share_put_with_engine(
            &engine,
            "finding:child-1".to_string(),
            raw_lines.clone(),
            Some("session".to_string()),
            Some("voice-thread-1".to_string()),
            Some("Argos".to_string()),
        )
        .unwrap();
        let ccr_hash = put["ccrHash"].as_str().unwrap().to_string();

        let got = share_get_with_engine(
            &engine,
            "finding:child-1".to_string(),
            Some("session".to_string()),
            Some("voice-thread-1".to_string()),
            Some(true),
        )
        .unwrap();
        assert_eq!(got["found"], true);
        assert_eq!(got["content"], raw_lines);

        let ccr = ccr_retrieve_with_engine(
            &engine,
            ccr_hash,
            Some("2-4".to_string()),
            None,
        )
        .unwrap();
        assert_eq!(ccr["returnedLines"], 3);

        let tmp = std::env::temp_dir().join(format!("kite_ctx_bridge_test_{}.rs", std::process::id()));
        std::fs::write(&tmp, "pub fn greet() -> &'static str {\n    \"hola\"\n}\n").unwrap();
        let read = read_compact_with_engine(
            &engine,
            tmp.to_string_lossy().into_owned(),
            Some("signatures".to_string()),
        )
        .unwrap();
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(read["mode"], "signatures");
        assert!(read["content"].as_str().unwrap().contains("pub fn greet"));
    }
}
