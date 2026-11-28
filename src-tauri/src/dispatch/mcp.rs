//! Stdio JSON-RPC 2.0 MCP Server for `kite dispatch mcp` (`S13`).
//!
//! Exposes first-class typed orchestration tools (`kite_subagent_run`,
//! `kite_subagent_send`, `kite_subagent_wait`, `kite_subagent_read`, `kite_swarm`)
//! over both newline-delimited and `Content-Length:` framed JSON-RPC 2.0 streams.

use std::io::{BufRead, BufReader, Write};

use serde_json::{json, Value};

pub const SERVER_NAME: &str = "kite-dispatch";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_PROTOCOL_VERSION: &str = "2024-11-05";
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_MCP_WAIT_TIMEOUT_MS: u64 = 150_000;
pub const MAX_MCP_READ_CHARS: usize = 8_000;

/// Resolve an MCP wait timeout in milliseconds, defaulting to [`DEFAULT_TIMEOUT_MS`]
/// and clamping to [`MAX_MCP_WAIT_TIMEOUT_MS`] so calls settle below external 3-minute RPC deadlines.
pub fn bounded_mcp_timeout_ms(args: &Value) -> u64 {
    args.get("timeout_ms")
        .or_else(|| args.get("timeoutMs"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_MCP_WAIT_TIMEOUT_MS)
}

/// Truncate `text` to at most `max_chars` characters while preserving the most recent tail.
pub fn truncate_tail_chars(text: &str, max_chars: usize) -> String {
    let total_chars = text.chars().count();
    if total_chars <= max_chars {
        return text.to_string();
    }
    const PREFIX: &str = "... [truncated earlier output]\n";
    let prefix_len = PREFIX.chars().count();
    if max_chars <= prefix_len {
        return text
            .chars()
            .skip(total_chars.saturating_sub(max_chars))
            .collect();
    }
    let keep = max_chars - prefix_len;
    let start_byte = text
        .char_indices()
        .nth(total_chars - keep)
        .map(|(idx, _)| idx)
        .unwrap_or(0);
    format!("{PREFIX}{}", &text[start_byte..])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    Line,
    ContentLength,
}

/// Normalize a bare thread UUID/id (without `:`) to `"thread:<id>"`.
pub fn normalize_thread_target(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains(':') {
        trimmed.to_string()
    } else {
        format!("thread:{trimmed}")
    }
}

fn normalize_workspace_arg(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "inherit" => "inherit",
        "share" | "worktree" => "share",
        "branch" => "branch",
        _ => "inherit",
    }
}

/// Return the MCP tool catalog for `tools/list`.
pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "kite_subagent_run",
            "description": "Spawn one or more subagents in Thread Mode via Kite's configured Subagents stack (or an explicit provider/model) and optionally wait for their final responses.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "Task prompt for a single subagent (or shared prompt when n > 1)."
                    },
                    "tasks": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Multiple distinct task prompts to spawn in parallel (1..8 subagents)."
                    },
                    "n": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 8,
                        "description": "Number of parallel subagent instances to spawn (1..8)."
                    },
                    "role": {
                        "type": "string",
                        "description": "Subagent role title or configured role slug (e.g. 'Fast Executor', 'reviewer')."
                    },
                    "provider": {
                        "type": "string",
                        "description": "Optional target thread provider. Omit to use the configured Settings -> Subagents default/stack."
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional target model ID. Omit to use the configured default/lightweight model tier."
                    },
                    "effort": {
                        "type": "string",
                        "description": "Optional reasoning effort level (minimal, low, medium, high, xhigh, max, ultra)."
                    },
                    "workspace": {
                        "type": "string",
                        "enum": ["inherit", "share", "branch", "worktree"],
                        "description": "Workspace isolation mode ('inherit' shares current workspace; 'share'/'worktree'/'branch' creates an isolated git worktree)."
                    },
                    "wait": {
                        "type": "boolean",
                        "default": true,
                        "description": "Wait for spawned subagent(s) to finish and return their final output (default: true)."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "default": DEFAULT_TIMEOUT_MS,
                        "description": "Maximum wait timeout in milliseconds (default: 120000, max: 150000)."
                    },
                    "override_stack": {
                        "type": "boolean",
                        "description": "Allow an explicit user-requested provider/model outside the curated stack under 'ask' policy."
                    },
                    "parent_thread_id": {
                        "type": "string",
                        "description": "Optional parent thread ID or 'thread:<id>' override."
                    }
                }
            }
        }),
        json!({
            "name": "kite_subagent_send",
            "description": "Send a follow-up task or steering message to an existing subagent thread and optionally wait for its updated response.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "Target subagent thread address ('thread:<id>' or bare '<id>')."
                    },
                    "message": {
                        "type": "string",
                        "description": "Follow-up task or message to deliver to the subagent thread."
                    },
                    "wait": {
                        "type": "boolean",
                        "default": true,
                        "description": "Wait for the follow-up turn to settle and return the subagent's response (default: true)."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "default": DEFAULT_TIMEOUT_MS,
                        "description": "Maximum wait timeout in milliseconds (default: 120000, max: 150000)."
                    }
                },
                "required": ["target", "message"]
            }
        }),
        json!({
            "name": "kite_subagent_wait",
            "description": "Wait for one or more running subagent threads to finish and read their final assistant responses.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "targets": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Specific subagent thread addresses ('thread:<id>' or bare '<id>') to wait for."
                    },
                    "children": {
                        "type": "string",
                        "enum": ["all", "any"],
                        "description": "When 'targets' is empty, wait for 'all' or 'any' active child subagents of the caller thread."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "default": DEFAULT_TIMEOUT_MS,
                        "description": "Maximum wait timeout in milliseconds (default: 120000, max: 150000)."
                    }
                }
            }
        }),
        json!({
            "name": "kite_subagent_read",
            "description": "Read the transcript or final assistant response from a subagent thread.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "Target subagent thread address ('thread:<id>' or bare '<id>')."
                    },
                    "last": {
                        "type": "boolean",
                        "default": true,
                        "description": "Return only the final assistant response (default: true)."
                    },
                    "lines": {
                        "type": "integer",
                        "default": 80,
                        "description": "Maximum number of transcript lines when 'last' is false (default: 80)."
                    }
                },
                "required": ["target"]
            }
        }),
        json!({
            "name": "kite_swarm",
            "description": "Coordinate a multi-agent cross-provider Swarm board with reactive @mention wakeups.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["title", "add", "post", "read", "wait", "status", "model", "kill", "channel"],
                        "description": "Swarm subcommand to execute."
                    },
                    "title": {
                        "type": "string",
                        "description": "Swarm title (for action='title')."
                    },
                    "name": {
                        "type": "string",
                        "description": "Worker roster name (for action='add' | 'model' | 'kill' | 'channel')."
                    },
                    "provider": {
                        "type": "string",
                        "description": "Optional target thread provider for worker (omit to use configured default/stack)."
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional target model ID for worker."
                    },
                    "effort": {
                        "type": "string",
                        "description": "Optional reasoning effort level for worker."
                    },
                    "workspace": {
                        "type": "string",
                        "enum": ["inherit", "share", "branch", "worktree"],
                        "description": "Workspace isolation mode for worker."
                    },
                    "role": {
                        "type": "string",
                        "description": "Optional human-readable role title or role profile slug."
                    },
                    "brief": {
                        "type": "string",
                        "description": "Initial assignment brief for worker (for action='add')."
                    },
                    "members": {
                        "type": "array",
                        "description": "Batch worker definitions for action='add'. Each entry is added in order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string" },
                                "role": { "type": "string" },
                                "provider": { "type": "string" },
                                "model": { "type": "string" },
                                "effort": { "type": "string" },
                                "workspace": { "type": "string" },
                                "brief": { "type": "string" }
                            },
                            "required": ["name", "brief"]
                        }
                    },
                    "channel": {
                        "type": "string",
                        "description": "Channel name (e.g. 'main', 'parser') or channel action specification."
                    },
                    "message": {
                        "type": "string",
                        "description": "Board post message text (for action='post')."
                    },
                    "since": {
                        "type": "integer",
                        "description": "Board sequence cursor #seq (for action='read' | 'wait')."
                    },
                    "mentions_only": {
                        "type": "boolean",
                        "description": "Filter wait wakeup to posts mentioning the caller (for action='wait')."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "default": DEFAULT_TIMEOUT_MS,
                        "description": "Maximum wait timeout in milliseconds (for action='wait'; default: 120000, max: 150000)."
                    },
                    "override_stack": {
                        "type": "boolean",
                        "description": "Allow an explicit user-requested model outside the curated stack."
                    }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "kite_thread",
            "description": "List, search, read, or launch top-level Kite threads without blowing context.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "search", "read", "launch"],
                        "description": "Thread service operation."
                    },
                    "query": {
                        "type": "string",
                        "description": "Search query (for action='search')."
                    },
                    "thread_id": {
                        "type": "string",
                        "description": "Target thread ID (for action='read')."
                    },
                    "title": {
                        "type": "string",
                        "description": "Optional title for the launched thread (for action='launch')."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Initial prompt to kick off the launched thread (required for action='launch')."
                    },
                    "workspace_id": {
                        "type": "string",
                        "description": "Optional workspace ID or directory path (for list/search/launch)."
                    },
                    "provider": {
                        "type": "string",
                        "description": "Optional target thread provider (for action='launch')."
                    },
                    "model": {
                        "type": "string",
                        "description": "Optional target model ID (for action='launch')."
                    },
                    "mode": {
                        "type": "string",
                        "description": "Optional permission mode (for action='launch')."
                    },
                    "effort": {
                        "type": "string",
                        "description": "Optional reasoning effort level (for action='launch')."
                    },
                    "worktree": {
                        "type": "boolean",
                        "description": "Provision an isolated git worktree branch (for action='launch')."
                    },
                    "odd_path": {
                        "type": "string",
                        "description": "Optional ODD specification path to link on the launched thread (for action='launch')."
                    },
                    "open": {
                        "type": "boolean",
                        "description": "Open and focus the launched thread in the UI (for action='launch')."
                    },
                    "orchestrate": {
                        "type": "boolean",
                        "description": "Prepend orchestrator kickoff framing referencing odd_path and subagent/swarm tools (for action='launch')."
                    },
                    "agent_id": {
                        "type": "string",
                        "description": "Optional agent profile ID filter (for list/search)."
                    },
                    "cursor": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Pagination cursor offset."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 200,
                        "description": "Maximum number of threads or items to return."
                    }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "kite_memory",
            "description": "Read, add, or search agent memory.txt (target='agent') or shared user.txt (target='user'), enforcing memory_budget.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["read", "add", "search"],
                        "description": "Memory operation."
                    },
                    "target": {
                        "type": "string",
                        "enum": ["agent", "user"],
                        "default": "agent",
                        "description": "Memory target: 'agent' (caller memory.txt) or 'user' (shared user.txt)."
                    },
                    "text": {
                        "type": "string",
                        "description": "Fact or note to append (for action='add')."
                    },
                    "query": {
                        "type": "string",
                        "description": "Search query (for action='search')."
                    },
                    "agent_id": {
                        "type": "string",
                        "description": "Optional agent ID (defaults to caller KITE_AGENT_ID)."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 200,
                        "description": "Maximum matching lines to return (for action='search')."
                    }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "kite_routine",
            "description": "List, create, toggle, or run scheduled agent routines (requires allowAgentScheduling).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "create", "toggle", "run"],
                        "description": "Routine operation."
                    },
                    "agent_id": {
                        "type": "string",
                        "description": "Optional agent ID (defaults to caller KITE_AGENT_ID)."
                    },
                    "routine_id": {
                        "type": "string",
                        "description": "Routine ID (for toggle/run)."
                    },
                    "name": {
                        "type": "string",
                        "description": "Routine name (for create)."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Routine prompt (for create)."
                    },
                    "cadence_seconds": {
                        "type": "integer",
                        "minimum": 60,
                        "description": "Interval cadence in seconds (for create)."
                    },
                    "workspace_id": {
                        "type": "string",
                        "description": "Optional workspace ID (for create)."
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "Target enabled state (for toggle)."
                    }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "kite_teammate",
            "description": "List teammates, send direct messages (agent:<uuid>), or delegate child threads (requires allowAgentMessaging).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "send", "delegate"],
                        "description": "Teammate operation."
                    },
                    "target": {
                        "type": "string",
                        "description": "Target teammate agent ID, 'agent:<uuid>', or display name (for send/delegate)."
                    },
                    "message": {
                        "type": "string",
                        "description": "Direct message body (for action='send')."
                    },
                    "task": {
                        "type": "string",
                        "description": "Delegated task prompt (for action='delegate')."
                    },
                    "wait": {
                        "type": "boolean",
                        "description": "Wait for delegated thread completion (for action='delegate')."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "description": "Wait timeout in milliseconds (for action='delegate')."
                    }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "kite_tasks",
            "description": "List, inspect, create, update, or transition Kite Tasks issues.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "get", "create", "update", "move_state"]
                    },
                    "id": { "type": "string", "description": "Task identifier or key." },
                    "title": { "type": "string", "description": "Task title." },
                    "description": { "type": "string", "description": "Task markdown body." },
                    "state": { "type": "string", "description": "Workflow state name (e.g. Backlog, Todo, In Progress, Done)." },
                    "priority": { "type": "string", "description": "Priority value (urgent, high, medium, low, none)." },
                    "labels": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Labels attached to the task."
                    },
                    "label": { "type": "string", "description": "Filter label for list." },
                    "limit": { "type": "integer", "description": "Maximum results for list." },
                    "odd_path": { "type": "string", "description": "Linked ODD specification path." },
                    "source_agent": { "type": "string", "description": "Originating agent id or name." },
                    "source_thread_id": { "type": "string", "description": "Originating thread identifier." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "kite_ctx",
            "description": "Compact context reader, workspace/knowledge search, shared context handoffs, and CCR retrieval.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["read_compact", "search", "share_put", "share_get", "ccr_retrieve"]
                    },
                    "path": { "type": "string", "description": "File or directory path inside authorized agent Places." },
                    "mode": { "type": "string", "description": "Compact read mode (signatures, map, lines:N-M, full)." },
                    "query": { "type": "string", "description": "Search query across workspace and knowledge packs." },
                    "limit": { "type": "integer", "description": "Maximum search matches." },
                    "key": { "type": "string", "description": "Shared context entry key." },
                    "content": { "type": "string", "description": "Shared context content payload." },
                    "scope": { "type": "string", "description": "Shared context scope (workspace, thread, global)." },
                    "scope_id": { "type": "string", "description": "Shared context scope identifier." },
                    "full": { "type": "boolean", "description": "Return full content for share_get." },
                    "hash": { "type": "string", "description": "CCR artifact hash for ccr_retrieve." },
                    "lines": { "type": "string", "description": "Line range N-M for ccr_retrieve." },
                    "search": { "type": "string", "description": "Filter term for ccr_retrieve." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "kite_diff",
            "description": "Read-only Git working tree status and per-file unified diff inside authorized agent Places.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["status", "file_diff"]
                    },
                    "path": { "type": "string", "description": "Target file path for file_diff." },
                    "workspace_id": { "type": "string", "description": "Optional workspace identifier." },
                    "staged": { "type": "boolean", "description": "Inspect staged index diff instead of working tree." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "kite_browser",
            "description": "Control Kite's embedded RightDock browser via native in-process CDP with kite-ctx semantic AX diffs, batched actions, deterministic replay recipes, and console/network diagnostics.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "discover",
                            "tabs",
                            "open",
                            "close",
                            "snapshot",
                            "act",
                            "batch",
                            "replay",
                            "save_recipe",
                            "console",
                            "network",
                            "errors",
                            "screenshot",
                            "eval",
                            "takeover",
                            "resume"
                        ],
                        "description": "Browser operation. Prefer discover -> open -> snapshot(mode='auto') -> batch -> errors; use screenshot only for visual checks."
                    },
                    "url": { "type": "string", "description": "Target URL (for action='open')." },
                    "surface_id": { "type": "string", "description": "Target browser tab/surface ID." },
                    "mode": {
                        "type": "string",
                        "enum": ["auto", "diff", "full", "stub"],
                        "description": "AX snapshot compression mode (default: 'auto' for semantic diff/stub reuse)."
                    },
                    "fresh": { "type": "boolean", "description": "Bypass snapshot cache and emit a fresh full AX snapshot." },
                    "step": {
                        "type": "object",
                        "description": "Single action step for action='act' ({ op: click|fill|type|press|hover|scroll|select|wait_for|assert_text|assert_url|assert_no_errors, ref?, selector?, value?, text?, key? })."
                    },
                    "steps": {
                        "type": "array",
                        "items": { "type": "object" },
                        "description": "Ordered multi-step action and assertion sequence for action='batch' or 'save_recipe'."
                    },
                    "intent": { "type": "string", "description": "Recipe intent key (for action='replay' or 'save_recipe')." },
                    "params": { "type": "object", "description": "Parameter bindings for action='replay'." },
                    "script": { "type": "string", "description": "JavaScript expression (for action='eval', subject to browser policy)." },
                    "background": { "type": "boolean", "default": true, "description": "Keep tab in background without stealing user focus (for action='open')." },
                    "isolated": { "type": "boolean", "default": false, "description": "Use an isolated ephemeral browser profile (for action='open')." },
                    "format": { "type": "string", "enum": ["jpeg", "png"], "description": "Screenshot encoding format (default: 'jpeg')." },
                    "width": { "type": "integer", "description": "Viewport emulation width in CSS pixels." },
                    "height": { "type": "integer", "description": "Viewport emulation height in CSS pixels." },
                    "workspace_id": { "type": "string", "description": "Optional workspace identifier." },
                    "include_snapshot": { "type": "boolean", "default": true, "description": "Include a compressed post-action AX diff snapshot (default: true)." }
                },
                "required": ["action"]
            }
        }),
    ]
}

/// Caller permissions and disabled-plugin policy for MCP `tools/list` and `tools/call`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPermissions {
    pub agent_id: Option<String>,
    pub allow_scheduling: bool,
    pub allow_messaging: bool,
    pub disabled_plugins: Vec<String>,
    pub tool_policies: std::collections::HashMap<String, String>,
    pub approved_tools: Vec<String>,
    pub authorized_roots: Vec<std::path::PathBuf>,
}

impl Default for ToolPermissions {
    fn default() -> Self {
        Self {
            agent_id: None,
            allow_scheduling: true,
            allow_messaging: true,
            disabled_plugins: Vec::new(),
            tool_policies: std::collections::HashMap::new(),
            approved_tools: Vec::new(),
            authorized_roots: Vec::new(),
        }
    }
}

fn parse_bool_env(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" => Some(true),
        "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

fn normalize_policy_mode(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "allow" => Some("allow"),
        "ask" => Some("ask"),
        "deny" => Some("deny"),
        _ => None,
    }
}

fn normalize_policy_family_key(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "threads" => "thread".to_string(),
        "routines" => "routine".to_string(),
        "teammates" => "teammate".to_string(),
        other => other.to_string(),
    }
}

fn parse_tool_policies_env(raw: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return map;
    }
    if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(trimmed) {
        for (k, v) in obj {
            if let Some(mode) = v.as_str().and_then(normalize_policy_mode) {
                let key = normalize_policy_family_key(&k);
                if !key.is_empty() {
                    map.insert(key, mode.to_string());
                }
            }
        }
        return map;
    }
    for pair in trimmed.split(',') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        if let Some(mode) = normalize_policy_mode(v) {
            let key = normalize_policy_family_key(k);
            if !key.is_empty() {
                map.insert(key, mode.to_string());
            }
        }
    }
    map
}

fn lexical_normalize_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut out = std::path::PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if matches!(out.components().next_back(), Some(std::path::Component::Normal(_))) {
                    out.pop();
                } else {
                    out.push(comp);
                }
            }
            other => out.push(other),
        }
    }
    out
}

fn canonicalize_or_lexical(path: &std::path::Path) -> std::path::PathBuf {
    if let Ok(canon) = std::fs::canonicalize(path) {
        return canon;
    }
    let mut probe = path.to_path_buf();
    let mut tail = Vec::new();
    while !probe.exists() {
        let Some(name) = probe.file_name().map(|n| n.to_os_string()) else {
            return lexical_normalize_path(path);
        };
        tail.push(name);
        if !probe.pop() {
            return lexical_normalize_path(path);
        }
    }
    let mut base = std::fs::canonicalize(&probe).unwrap_or_else(|_| lexical_normalize_path(&probe));
    for seg in tail.into_iter().rev() {
        base.push(seg);
    }
    lexical_normalize_path(&base)
}

impl ToolPermissions {
    pub fn from_env() -> Self {
        let agent_id = std::env::var("KITE_AGENT_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let allow_scheduling = std::env::var("KITE_ALLOW_SCHEDULING")
            .ok()
            .and_then(|v| parse_bool_env(&v))
            .unwrap_or(true);
        let allow_messaging = std::env::var("KITE_ALLOW_MESSAGING")
            .ok()
            .and_then(|v| parse_bool_env(&v))
            .unwrap_or(true);
        let disabled_plugins = std::env::var("KITE_DISABLED_PLUGINS")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let tool_policies = std::env::var("KITE_TOOL_POLICIES")
            .ok()
            .map(|raw| parse_tool_policies_env(&raw))
            .unwrap_or_default();
        let approved_tools = std::env::var("KITE_APPROVED_TOOLS")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let authorized_roots = std::env::var_os("KITE_AUTHORIZED_ROOTS")
            .map(|raw| {
                std::env::split_paths(&raw)
                    .filter(|p| !p.as_os_str().is_empty())
                    .collect()
            })
            .unwrap_or_default();
        Self {
            agent_id,
            allow_scheduling,
            allow_messaging,
            disabled_plugins,
            tool_policies,
            approved_tools,
            authorized_roots,
        }
    }

    pub fn tool_family_for_name(tool_name: &str) -> &'static str {
        match tool_name {
            "kite_tasks" => "tasks",
            "kite_ctx" => "ctx",
            "kite_diff" => "diff",
            "kite_browser" => "browser",
            "kite_memory" => "memory",
            "kite_thread" => "thread",
            "kite_routine" => "routine",
            "kite_teammate" => "teammate",
            "kite_subagent_run"
            | "kite_subagent_send"
            | "kite_subagent_wait"
            | "kite_subagent_read"
            | "kite_swarm" => "subagents",
            _ => "custom",
        }
    }

    pub fn policy_for_tool(&self, tool_name: &str) -> &str {
        let lower = tool_name.trim().to_ascii_lowercase();
        if let Some(mode) = self.tool_policies.get(&lower) {
            return mode.as_str();
        }
        let family = Self::tool_family_for_name(tool_name);
        if let Some(mode) = self.tool_policies.get(family) {
            return mode.as_str();
        }
        let legacy_alias = match family {
            "thread" => Some("threads"),
            "routine" => Some("routines"),
            "teammate" => Some("teammates"),
            _ => None,
        };
        if let Some(alias) = legacy_alias {
            if let Some(mode) = self.tool_policies.get(alias) {
                return mode.as_str();
            }
        }
        "allow"
    }

    pub fn is_plugin_disabled(&self, plugin: &str) -> bool {
        let target = plugin.trim().to_ascii_lowercase();
        self.disabled_plugins.iter().any(|p| p == &target)
    }

    pub fn is_tool_allowed(&self, tool_name: &str) -> Result<(), String> {
        let dispatch_disabled =
            self.is_plugin_disabled("kite-dispatch") || self.is_plugin_disabled("dispatch");
        if dispatch_disabled
            && matches!(
                tool_name,
                "kite_subagent_run"
                    | "kite_subagent_send"
                    | "kite_subagent_wait"
                    | "kite_subagent_read"
                    | "kite_swarm"
            )
        {
            return Err(format!(
                "Permission denied: plugin 'kite-dispatch' is disabled for this agent ({tool_name})."
            ));
        }
        let tool_lower = tool_name.trim().to_ascii_lowercase();
        if self.is_plugin_disabled(&tool_lower) {
            return Err(format!(
                "Permission denied: tool '{tool_name}' is disabled for this agent."
            ));
        }
        let pack_disabled = match tool_name {
            "kite_thread" => self.is_plugin_disabled("thread") || self.is_plugin_disabled("kite-thread"),
            "kite_memory" => {
                self.is_plugin_disabled("memory")
                    || self.is_plugin_disabled("kite-memory")
            }
            "kite_routine" => {
                self.is_plugin_disabled("routine")
                    || self.is_plugin_disabled("routines")
                    || self.is_plugin_disabled("kite-routine")
            }
            "kite_teammate" => {
                self.is_plugin_disabled("teammate")
                    || self.is_plugin_disabled("teammates")
                    || self.is_plugin_disabled("kite-teammate")
            }
            "kite_tasks" => {
                self.is_plugin_disabled("tasks") || self.is_plugin_disabled("kite-tasks")
            }
            "kite_ctx" => self.is_plugin_disabled("ctx") || self.is_plugin_disabled("kite-ctx"),
            "kite_diff" => self.is_plugin_disabled("diff") || self.is_plugin_disabled("kite-diff"),
            "kite_browser" => {
                self.is_plugin_disabled("browser") || self.is_plugin_disabled("kite-browser")
            }
            _ => false,
        };
        if pack_disabled {
            return Err(format!(
                "Permission denied: tool pack for '{tool_name}' is disabled in disabled_plugin_ids."
            ));
        }
        if tool_name == "kite_routine" && !self.allow_scheduling {
            return Err(
                "Permission denied: allowAgentScheduling is disabled for this agent.".to_string(),
            );
        }
        if tool_name == "kite_teammate" && !self.allow_messaging {
            return Err(
                "Permission denied: allowAgentMessaging is disabled for this agent.".to_string(),
            );
        }
        if self.policy_for_tool(tool_name).eq_ignore_ascii_case("deny") {
            return Err(format!(
                "Permission denied: tool policy for '{tool_name}' (family '{}') is set to 'deny'.",
                Self::tool_family_for_name(tool_name)
            ));
        }
        Ok(())
    }

    pub fn validate_path_against_places(&self, raw_path: &str) -> Result<(), String> {
        if self.authorized_roots.is_empty() {
            return Ok(());
        }
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let req_path = std::path::Path::new(trimmed);
        let candidates: Vec<std::path::PathBuf> = if req_path.is_absolute() {
            vec![canonicalize_or_lexical(req_path)]
        } else {
            self.authorized_roots
                .iter()
                .map(|root| canonicalize_or_lexical(&root.join(req_path)))
                .collect()
        };
        let norm_roots: Vec<std::path::PathBuf> = self
            .authorized_roots
            .iter()
            .map(|r| canonicalize_or_lexical(r))
            .collect();
        let allowed = candidates
            .iter()
            .any(|cand| norm_roots.iter().any(|root| cand.starts_with(root)));
        if allowed {
            Ok(())
        } else {
            Err(format!(
                "Path rejected: '{trimmed}' is outside the authorized agent Places."
            ))
        }
    }

    pub fn check_call_permissions(&self, tool_name: &str, args: &Value) -> Result<(), String> {
        self.is_tool_allowed(tool_name)?;
        if matches!(tool_name, "kite_ctx" | "kite_diff") {
            if let Some(path) = args.get("path").and_then(Value::as_str) {
                self.validate_path_against_places(path)?;
            }
        }
        Ok(())
    }
}

fn default_audit_db_path() -> Option<std::path::PathBuf> {
    if cfg!(test) {
        return None;
    }
    Some(super::roaming_app_dir().join("kite.sqlite"))
}

pub(crate) fn record_mcp_policy_denial_at(
    db_path: &std::path::Path,
    perms: &ToolPermissions,
    tool_name: &str,
    reason: &str,
) {
    if !db_path.is_file() {
        return;
    }
    let Ok(conn) = rusqlite::Connection::open(db_path) else {
        return;
    };
    let _ = conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_audit_log (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            thread_id TEXT,
            tool_name TEXT NOT NULL,
            tool_family TEXT NOT NULL,
            verdict TEXT NOT NULL,
            reason TEXT,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            skill_event TEXT,
            created_at_unix_ms INTEGER NOT NULL
        );",
    );
    let agent_id = perms
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("anonymous");
    let thread_id = std::env::var("KITE_ADDRESS")
        .ok()
        .map(|s| {
            let trimmed = s.trim();
            trimmed.strip_prefix("thread:").unwrap_or(trimmed).to_string()
        })
        .filter(|s| !s.is_empty());
    let family = ToolPermissions::tool_family_for_name(tool_name);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let bounded_reason: String = reason.chars().take(500).collect();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO agent_audit_log (
            id, agent_id, thread_id, tool_name, tool_family,
            verdict, reason, duration_ms, skill_event, created_at_unix_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'denied', ?6, 0, NULL, ?7)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            agent_id,
            thread_id,
            tool_name,
            family,
            bounded_reason,
            now_ms,
        ],
    );
}

/// Return the MCP tool catalog filtered by caller [`ToolPermissions`].
pub fn tool_definitions_for(perms: &ToolPermissions) -> Vec<Value> {
    tool_definitions()
        .into_iter()
        .filter(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| perms.is_tool_allowed(name).is_ok())
        })
        .collect()
}

fn tool_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": text.into()
            }
        ],
        "isError": is_error
    })
}

fn extract_text_from_cli_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
        let receipt = val.get("receipt").unwrap_or(&val);
        if let Some(text) = receipt.get("text").and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        }
        if let Some(text_out) = val.get("textOut").and_then(Value::as_str) {
            if !text_out.trim().is_empty() {
                return text_out.to_string();
            }
        }
    }
    trimmed.to_string()
}

fn extract_timeout_address(raw: &str) -> Option<String> {
    let val = serde_json::from_str::<Value>(raw.trim()).ok()?;
    let receipt = val.get("receipt").unwrap_or(&val);
    let addr = receipt
        .get("address")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some(normalize_thread_target(addr))
}

fn is_timeout_output(raw: &str) -> bool {
    let Ok(val) = serde_json::from_str::<Value>(raw.trim()) else {
        return false;
    };
    let receipt = val.get("receipt").unwrap_or(&val);
    receipt
        .get("error")
        .and_then(Value::as_str)
        .is_some_and(|e| e.trim().eq_ignore_ascii_case("timeout"))
}

fn read_and_format_settled_subagent<'a>(
    target: &str,
    runner: &'a dyn Fn(&[String]) -> (i32, String),
) -> String {
    let read_argv = vec![
        "kite".to_string(),
        "dispatch".to_string(),
        "read".to_string(),
        target.to_string(),
        "--last".to_string(),
    ];
    let (_read_code, read_out) = runner(&read_argv);
    let text = truncate_tail_chars(
        &extract_text_from_cli_output(&read_out),
        MAX_MCP_READ_CHARS,
    );
    let child_id = target.strip_prefix("thread:").unwrap_or(target);
    super::format_subagent_wait_output(&text, child_id)
}

pub fn build_subagent_run_argv(args: &Value) -> Result<Vec<String>, String> {
    let mut argv = vec![
        "kite".to_string(),
        "dispatch".to_string(),
        "run".to_string(),
        "--via".to_string(),
        "thread".to_string(),
    ];

    if let Some(role) = args
        .get("role")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--role".to_string());
        argv.push(role.to_string());
    }
    if let Some(provider) = args
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--provider".to_string());
        argv.push(provider.to_string());
    }
    if let Some(model) = args
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--model".to_string());
        argv.push(model.to_string());
    }
    if let Some(effort) = args
        .get("effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--effort".to_string());
        argv.push(effort.to_string());
    }
    if let Some(workspace) = args
        .get("workspace")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--workspace".to_string());
        argv.push(normalize_workspace_arg(workspace).to_string());
    }
    if let Some(parent_raw) = args
        .get("parent_thread_id")
        .or_else(|| args.get("parentThreadId"))
        .or_else(|| args.get("from_thread"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let normalized = normalize_thread_target(parent_raw);
        if !normalized.is_empty() {
            argv.push("--parent".to_string());
            argv.push(normalized);
        }
    }
    if args
        .get("override_stack")
        .or_else(|| args.get("overrideStack"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        argv.push("--override-stack".to_string());
    }
    let wait = args.get("wait").and_then(Value::as_bool).unwrap_or(true);
    if wait {
        argv.push("--wait".to_string());
    }
    let timeout_ms = bounded_mcp_timeout_ms(args);
    argv.push("--timeout-ms".to_string());
    argv.push(timeout_ms.to_string());

    let mut task_count = 0usize;
    if let Some(tasks) = args.get("tasks").and_then(Value::as_array) {
        for entry in tasks {
            if let Some(t) = entry.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                argv.push("--task".to_string());
                argv.push(t.to_string());
                task_count += 1;
            }
        }
    }

    if let Some(n) = args.get("n").and_then(Value::as_u64) {
        let clamped = n.clamp(1, 8);
        if clamped > 1 {
            argv.push("--count".to_string());
            argv.push(clamped.to_string());
        }
    }

    let single_task = args
        .get("task")
        .or_else(|| args.get("prompt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if let Some(t) = single_task {
        argv.push(t.to_string());
        task_count += 1;
    }

    if task_count == 0 {
        return Err(
            "kite_subagent_run requires either 'task' (string) or a non-empty 'tasks' array."
                .to_string(),
        );
    }

    Ok(argv)
}

fn build_swarm_add_member_argv(member: &Value, default_override_stack: bool) -> Result<Vec<String>, String> {
    let name = member
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Swarm member requires a non-empty 'name'.".to_string())?;
    let brief = member
        .get("brief")
        .or_else(|| member.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Swarm member '{name}' requires a non-empty 'brief'."))?;

    let mut argv = vec![
        "kite".to_string(),
        "dispatch".to_string(),
        "swarm".to_string(),
        "add".to_string(),
        "--name".to_string(),
        name.to_string(),
    ];
    if let Some(provider) = member
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--provider".to_string());
        argv.push(provider.to_string());
    }
    if let Some(model) = member
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--model".to_string());
        argv.push(model.to_string());
    }
    if let Some(effort) = member
        .get("effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--effort".to_string());
        argv.push(effort.to_string());
    }
    if let Some(workspace) = member
        .get("workspace")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--workspace".to_string());
        argv.push(normalize_workspace_arg(workspace).to_string());
    }
    if let Some(role) = member
        .get("role")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--role".to_string());
        argv.push(role.to_string());
    }
    if let Some(channel) = member
        .get("channel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        argv.push("--channel".to_string());
        argv.push(channel.to_string());
    }
    let override_stack = member
        .get("override_stack")
        .or_else(|| member.get("overrideStack"))
        .and_then(Value::as_bool)
        .unwrap_or(default_override_stack);
    if override_stack {
        argv.push("--override-stack".to_string());
    }
    argv.push("--brief".to_string());
    argv.push(brief.to_string());
    Ok(argv)
}

/// Execute a `tools/call` request using an injectable CLI runner for testability.
pub fn call_tool_with<'a>(
    name: &str,
    args: &Value,
    runner: &'a dyn Fn(&[String]) -> (i32, String),
) -> Value {
    call_tool_with_permissions(name, args, &ToolPermissions::default(), runner)
}

/// Execute a `tools/call` request enforcing caller [`ToolPermissions`].
pub fn call_tool_with_permissions<'a>(
    name: &str,
    args: &Value,
    perms: &ToolPermissions,
    runner: &'a dyn Fn(&[String]) -> (i32, String),
) -> Value {
    let default_db = default_audit_db_path();
    call_tool_with_permissions_at(name, args, perms, default_db.as_deref(), runner)
}

pub(crate) fn call_tool_with_permissions_at<'a>(
    name: &str,
    args: &Value,
    perms: &ToolPermissions,
    audit_db_path: Option<&std::path::Path>,
    runner: &'a dyn Fn(&[String]) -> (i32, String),
) -> Value {
    if let Err(reason) = perms.check_call_permissions(name, args) {
        if let Some(db_path) = audit_db_path {
            record_mcp_policy_denial_at(db_path, perms, name, &reason);
        }
        return tool_result(reason, true);
    }
    match name {
        "kite_subagent_run" => match build_subagent_run_argv(args) {
            Ok(argv) => {
                let wait = args.get("wait").and_then(Value::as_bool).unwrap_or(true);
                let timeout_ms = bounded_mcp_timeout_ms(args);
                let (code, output) = runner(&argv);
                if wait && code != 0 && is_timeout_output(&output) {
                    let msg = if let Some(addr) = extract_timeout_address(&output) {
                        let child_id = addr.strip_prefix("thread:").unwrap_or(&addr);
                        format!(
                            "Subagent {addr} is still running after {timeout_ms}ms wait slice.\nCall `kite_subagent_wait` with targets=[\"{addr}\"] to continue waiting rather than polling `kite_subagent_read`.\n\n[subagent_id: thread:{child_id}]"
                        )
                    } else {
                        format!(
                            "Subagent is still running after {timeout_ms}ms wait slice.\nCall `kite_subagent_wait` with children=\"all\" to continue waiting."
                        )
                    };
                    return tool_result(msg, false);
                }
                tool_result(extract_text_from_cli_output(&output), code != 0)
            }
            Err(err) => tool_result(err, true),
        },
        "kite_subagent_send" => {
            let target_raw = args
                .get("target")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let target = normalize_thread_target(target_raw);
            let message = args
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if target.is_empty() || message.is_empty() {
                return tool_result(
                    "kite_subagent_send requires non-empty 'target' and 'message'.",
                    true,
                );
            }
            let wait = args.get("wait").and_then(Value::as_bool).unwrap_or(true);
            let timeout_ms = bounded_mcp_timeout_ms(args);
            let mut argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "send".to_string(),
                target.clone(),
                message.to_string(),
            ];
            if wait {
                argv.push("--wait".to_string());
                argv.push("--timeout-ms".to_string());
                argv.push(timeout_ms.to_string());
            }
            let (code, output) = runner(&argv);
            if wait && code != 0 && is_timeout_output(&output) {
                return tool_result(
                    format!(
                        "Follow-up message delivered to {target}; subagent is still running after {timeout_ms}ms wait slice.\nCall `kite_subagent_wait` with targets=[\"{target}\"] to continue waiting rather than polling `kite_subagent_read`."
                    ),
                    false,
                );
            }
            tool_result(extract_text_from_cli_output(&output), code != 0)
        }
        "kite_subagent_wait" => {
            let timeout_ms = bounded_mcp_timeout_ms(args);
            let targets: Vec<String> = args
                .get("targets")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(normalize_thread_target)
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();

            if !targets.is_empty() {
                let started = std::time::Instant::now();
                let budget = std::time::Duration::from_millis(timeout_ms);
                let mut sections = Vec::with_capacity(targets.len());
                let mut still_running = Vec::new();
                let mut any_error = false;
                for (idx, target) in targets.iter().enumerate() {
                    let remaining_ms = budget.saturating_sub(started.elapsed()).as_millis() as u64;
                    let wait_argv = vec![
                        "kite".to_string(),
                        "dispatch".to_string(),
                        "wait".to_string(),
                        target.clone(),
                        "--until".to_string(),
                        "done,error,gone,blocked".to_string(),
                        "--timeout-ms".to_string(),
                        remaining_ms.to_string(),
                    ];
                    let (wait_code, wait_out) = runner(&wait_argv);
                    if wait_code != 0 {
                        if is_timeout_output(&wait_out) {
                            still_running.push(target.clone());
                        } else {
                            any_error = true;
                            sections.push(format!(
                                "=== Subagent {} ({target}) ===\n{}",
                                idx + 1,
                                extract_text_from_cli_output(&wait_out)
                            ));
                        }
                        continue;
                    }
                    let formatted = read_and_format_settled_subagent(target, runner);
                    if targets.len() == 1 && still_running.is_empty() && !any_error {
                        sections.push(formatted);
                    } else {
                        sections.push(format!(
                            "=== Subagent {} ({target}) ===\n{formatted}",
                            idx + 1
                        ));
                    }
                }
                if !still_running.is_empty() {
                    let wait_targets_json = serde_json::to_string(&still_running)
                        .unwrap_or_else(|_| format!("{still_running:?}"));
                    sections.push(format!(
                        "Subagent(s) still running after {timeout_ms}ms wait slice: {}.\nCall `kite_subagent_wait` again with targets={wait_targets_json} to continue waiting; do NOT poll `kite_subagent_read` while they are active.",
                        still_running.join(", ")
                    ));
                }
                return tool_result(sections.join("\n\n"), any_error);
            }

            let children_mode = args
                .get("children")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|m| matches!(*m, "all" | "any"))
                .unwrap_or("all");
            let wait_argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "wait".to_string(),
                "--children".to_string(),
                children_mode.to_string(),
                "--timeout-ms".to_string(),
                timeout_ms.to_string(),
            ];
            let (wait_code, wait_out) = runner(&wait_argv);
            if wait_code != 0 {
                if is_timeout_output(&wait_out) {
                    return tool_result(
                        format!(
                            "Child subagents (children=\"{children_mode}\") are still running after {timeout_ms}ms wait slice.\nCall `kite_subagent_wait` again with children=\"{children_mode}\" to continue waiting; do NOT poll `kite_subagent_read` while they are active."
                        ),
                        false,
                    );
                }
                return tool_result(extract_text_from_cli_output(&wait_out), true);
            }
            let settled_targets = serde_json::from_str::<Value>(wait_out.trim())
                .ok()
                .map(|v| super::extract_spawned_thread_addresses(&v))
                .unwrap_or_default();
            if settled_targets.is_empty() {
                return tool_result(extract_text_from_cli_output(&wait_out), false);
            }
            let mut sections = Vec::with_capacity(settled_targets.len());
            for (idx, target) in settled_targets.iter().enumerate() {
                let formatted = read_and_format_settled_subagent(target, runner);
                if settled_targets.len() == 1 {
                    sections.push(formatted);
                } else {
                    sections.push(format!(
                        "=== Subagent {} ({target}) ===\n{formatted}",
                        idx + 1
                    ));
                }
            }
            tool_result(sections.join("\n\n"), false)
        }
        "kite_subagent_read" => {
            let target_raw = args
                .get("target")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let target = normalize_thread_target(target_raw);
            if target.is_empty() {
                return tool_result("kite_subagent_read requires a non-empty 'target'.", true);
            }
            let last = args.get("last").and_then(Value::as_bool).unwrap_or(true);
            let lines = args.get("lines").and_then(Value::as_u64).unwrap_or(80);
            let mut argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "read".to_string(),
                target,
                "--lines".to_string(),
                lines.to_string(),
            ];
            if last {
                argv.push("--last".to_string());
            }
            let (code, output) = runner(&argv);
            let bounded = truncate_tail_chars(&extract_text_from_cli_output(&output), MAX_MCP_READ_CHARS);
            tool_result(bounded, code != 0)
        }
        "kite_swarm" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let default_override_stack = args
                .get("override_stack")
                .or_else(|| args.get("overrideStack"))
                .and_then(Value::as_bool)
                .unwrap_or(false);

            match action {
                "title" => {
                    let title = args
                        .get("title")
                        .or_else(|| args.get("message"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if title.is_empty() {
                        return tool_result("kite_swarm action='title' requires 'title'.", true);
                    }
                    let argv = vec![
                        "kite".to_string(),
                        "dispatch".to_string(),
                        "swarm".to_string(),
                        "title".to_string(),
                        title.to_string(),
                    ];
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "add" => {
                    if let Some(members) = args
                        .get("members")
                        .and_then(Value::as_array)
                        .filter(|arr| !arr.is_empty())
                    {
                        let mut outputs = Vec::with_capacity(members.len());
                        let mut any_error = false;
                        for member in members {
                            match build_swarm_add_member_argv(member, default_override_stack) {
                                Ok(argv) => {
                                    let (code, out) = runner(&argv);
                                    if code != 0 {
                                        any_error = true;
                                    }
                                    outputs.push(extract_text_from_cli_output(&out));
                                }
                                Err(err) => {
                                    any_error = true;
                                    outputs.push(err);
                                }
                            }
                        }
                        return tool_result(outputs.join("\n"), any_error);
                    }
                    match build_swarm_add_member_argv(args, default_override_stack) {
                        Ok(argv) => {
                            let (code, out) = runner(&argv);
                            tool_result(extract_text_from_cli_output(&out), code != 0)
                        }
                        Err(err) => tool_result(err, true),
                    }
                }
                "post" => {
                    let message = args
                        .get("message")
                        .or_else(|| args.get("brief"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if message.is_empty() {
                        return tool_result("kite_swarm action='post' requires 'message'.", true);
                    }
                    let mut argv = vec![
                        "kite".to_string(),
                        "dispatch".to_string(),
                        "swarm".to_string(),
                        "post".to_string(),
                    ];
                    if let Some(ch) = args
                        .get("channel")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        argv.push("--channel".to_string());
                        argv.push(ch.to_string());
                    }
                    argv.push(message.to_string());
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "read" => {
                    let mut argv = vec![
                        "kite".to_string(),
                        "dispatch".to_string(),
                        "swarm".to_string(),
                        "read".to_string(),
                    ];
                    if let Some(since) = args.get("since").and_then(Value::as_u64) {
                        argv.push("--since".to_string());
                        argv.push(since.to_string());
                    }
                    if let Some(ch) = args
                        .get("channel")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        argv.push("--channel".to_string());
                        argv.push(ch.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "wait" => {
                    let mut argv = vec![
                        "kite".to_string(),
                        "dispatch".to_string(),
                        "swarm".to_string(),
                        "wait".to_string(),
                    ];
                    if let Some(since) = args.get("since").and_then(Value::as_u64) {
                        argv.push("--since".to_string());
                        argv.push(since.to_string());
                    }
                    if let Some(mentions_only) = args
                        .get("mentions_only")
                        .or_else(|| args.get("mentionsOnly"))
                        .and_then(Value::as_bool)
                    {
                        argv.push("--mentions-only".to_string());
                        argv.push(if mentions_only { "true" } else { "false" }.to_string());
                    }
                    let timeout_ms = bounded_mcp_timeout_ms(args);
                    argv.push("--timeout-ms".to_string());
                    argv.push(timeout_ms.to_string());
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "status" => {
                    let argv = vec![
                        "kite".to_string(),
                        "dispatch".to_string(),
                        "swarm".to_string(),
                        "status".to_string(),
                    ];
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "model" => {
                    let name = args
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    let model = args
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if name.is_empty() || model.is_empty() {
                        return tool_result(
                            "kite_swarm action='model' requires 'name' and 'model'.",
                            true,
                        );
                    }
                    let mut argv = vec![
                        "kite".to_string(),
                        "dispatch".to_string(),
                        "swarm".to_string(),
                        "model".to_string(),
                        "--name".to_string(),
                        name.to_string(),
                        "--model".to_string(),
                        model.to_string(),
                    ];
                    if let Some(provider) = args
                        .get("provider")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        argv.push("--provider".to_string());
                        argv.push(provider.to_string());
                    }
                    if let Some(effort) = args
                        .get("effort")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        argv.push("--effort".to_string());
                        argv.push(effort.to_string());
                    }
                    if default_override_stack {
                        argv.push("--override-stack".to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "kill" => {
                    let name = args
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if name.is_empty() {
                        return tool_result("kite_swarm action='kill' requires 'name'.", true);
                    }
                    let argv = vec![
                        "kite".to_string(),
                        "dispatch".to_string(),
                        "swarm".to_string(),
                        "kill".to_string(),
                        "--name".to_string(),
                        name.to_string(),
                    ];
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "channel" => {
                    let raw_ch = args
                        .get("channel")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("list");
                    let mut parts = raw_ch.split_whitespace();
                    let first = parts.next().unwrap_or("list");
                    let (sub_action, ch_name) = match first {
                        "create" | "subscribe" | "unsubscribe" | "archive" | "list" => {
                            (first, parts.next())
                        }
                        other => ("create", Some(other)),
                    };
                    let mut argv = vec![
                        "kite".to_string(),
                        "dispatch".to_string(),
                        "swarm".to_string(),
                        "channel".to_string(),
                        sub_action.to_string(),
                    ];
                    if let Some(ch) = ch_name.filter(|s| !s.is_empty()) {
                        argv.push("--channel".to_string());
                        argv.push(ch.to_string());
                    }
                    if let Some(topic) = args
                        .get("title")
                        .or_else(|| args.get("message"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        argv.push("--topic".to_string());
                        argv.push(topic.to_string());
                    }
                    if let Some(member) = args
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        argv.push("--name".to_string());
                        argv.push(member.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                other => tool_result(
                    format!(
                        "Unknown kite_swarm action '{other}'. Expected: title, add, post, read, wait, status, model, kill, channel."
                    ),
                    true,
                ),
            }
        }
        "kite_thread" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let mut argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "agent".to_string(),
                "thread".to_string(),
            ];
            match action {
                "list" => {
                    argv.push("list".to_string());
                    if let Some(ws) = args.get("workspace_id").or_else(|| args.get("workspaceId")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--workspace-id".to_string());
                        argv.push(ws.to_string());
                    }
                    if let Some(aid) = args.get("agent_id").or_else(|| args.get("agentId")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--agent-id".to_string());
                        argv.push(aid.to_string());
                    }
                    if let Some(cursor) = args.get("cursor").and_then(Value::as_u64) {
                        argv.push("--cursor".to_string());
                        argv.push(cursor.to_string());
                    }
                    if let Some(limit) = args.get("limit").and_then(Value::as_u64) {
                        argv.push("--limit".to_string());
                        argv.push(limit.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "search" => {
                    let query = args.get("query").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    if query.is_empty() {
                        return tool_result("kite_thread action='search' requires non-empty 'query'.", true);
                    }
                    argv.push("search".to_string());
                    argv.push("--query".to_string());
                    argv.push(query.to_string());
                    if let Some(ws) = args.get("workspace_id").or_else(|| args.get("workspaceId")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--workspace-id".to_string());
                        argv.push(ws.to_string());
                    }
                    if let Some(aid) = args.get("agent_id").or_else(|| args.get("agentId")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--agent-id".to_string());
                        argv.push(aid.to_string());
                    }
                    if let Some(cursor) = args.get("cursor").and_then(Value::as_u64) {
                        argv.push("--cursor".to_string());
                        argv.push(cursor.to_string());
                    }
                    if let Some(limit) = args.get("limit").and_then(Value::as_u64) {
                        argv.push("--limit".to_string());
                        argv.push(limit.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "read" => {
                    let thread_id = args
                        .get("thread_id")
                        .or_else(|| args.get("threadId"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if thread_id.is_empty() {
                        return tool_result("kite_thread action='read' requires non-empty 'thread_id'.", true);
                    }
                    argv.push("read".to_string());
                    argv.push("--thread-id".to_string());
                    argv.push(thread_id.to_string());
                    if let Some(cursor) = args.get("cursor").and_then(Value::as_u64) {
                        argv.push("--cursor".to_string());
                        argv.push(cursor.to_string());
                    }
                    if let Some(limit) = args.get("limit").and_then(Value::as_u64) {
                        argv.push("--limit".to_string());
                        argv.push(limit.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "launch" => {
                    let prompt = args.get("prompt").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    if prompt.is_empty() {
                        return tool_result("kite_thread action='launch' requires non-empty 'prompt'.", true);
                    }
                    argv.push("launch".to_string());
                    argv.push("--prompt".to_string());
                    argv.push(prompt.to_string());
                    if let Some(title) = args.get("title").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--title".to_string());
                        argv.push(title.to_string());
                    }
                    if let Some(ws) = args.get("workspace_id").or_else(|| args.get("workspaceId")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--workspace-id".to_string());
                        argv.push(ws.to_string());
                    }
                    if let Some(provider) = args.get("provider").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--provider".to_string());
                        argv.push(provider.to_string());
                    }
                    if let Some(model) = args.get("model").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--model".to_string());
                        argv.push(model.to_string());
                    }
                    if let Some(mode) = args.get("mode").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--mode".to_string());
                        argv.push(mode.to_string());
                    }
                    if let Some(effort) = args.get("effort").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--effort".to_string());
                        argv.push(effort.to_string());
                    }
                    if args.get("worktree").and_then(Value::as_bool) == Some(true) {
                        argv.push("--worktree".to_string());
                    }
                    if let Some(odd_path) = args.get("odd_path").or_else(|| args.get("oddPath")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--odd-path".to_string());
                        argv.push(odd_path.to_string());
                    }
                    if args.get("open").and_then(Value::as_bool) == Some(true) {
                        argv.push("--open".to_string());
                    }
                    if args.get("orchestrate").and_then(Value::as_bool) == Some(true) {
                        argv.push("--orchestrate".to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                other => tool_result(
                    format!("Unknown kite_thread action '{other}'. Expected: list, search, read, launch."),
                    true,
                ),
            }
        }
        "kite_memory" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let target = args
                .get("target")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("agent");
            let agent_id = args
                .get("agent_id")
                .or_else(|| args.get("agentId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or(perms.agent_id.as_deref());
            let mut argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "agent".to_string(),
                "memory".to_string(),
            ];
            match action {
                "read" => {
                    argv.push("read".to_string());
                    argv.push("--target".to_string());
                    argv.push(target.to_string());
                    if let Some(aid) = agent_id {
                        argv.push("--agent-id".to_string());
                        argv.push(aid.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "add" => {
                    let text = args.get("text").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    if text.is_empty() {
                        return tool_result("kite_memory action='add' requires non-empty 'text'.", true);
                    }
                    argv.push("add".to_string());
                    argv.push("--target".to_string());
                    argv.push(target.to_string());
                    argv.push("--text".to_string());
                    argv.push(text.to_string());
                    if let Some(aid) = agent_id {
                        argv.push("--agent-id".to_string());
                        argv.push(aid.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "search" => {
                    let query = args.get("query").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    if query.is_empty() {
                        return tool_result("kite_memory action='search' requires non-empty 'query'.", true);
                    }
                    argv.push("search".to_string());
                    argv.push("--target".to_string());
                    argv.push(target.to_string());
                    argv.push("--query".to_string());
                    argv.push(query.to_string());
                    if let Some(aid) = agent_id {
                        argv.push("--agent-id".to_string());
                        argv.push(aid.to_string());
                    }
                    if let Some(limit) = args.get("limit").and_then(Value::as_u64) {
                        argv.push("--limit".to_string());
                        argv.push(limit.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                other => tool_result(
                    format!("Unknown kite_memory action '{other}'. Expected: read, add, search."),
                    true,
                ),
            }
        }
        "kite_routine" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let agent_id = args
                .get("agent_id")
                .or_else(|| args.get("agentId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or(perms.agent_id.as_deref());
            let mut argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "agent".to_string(),
                "routine".to_string(),
            ];
            match action {
                "list" => {
                    argv.push("list".to_string());
                    if let Some(aid) = agent_id {
                        argv.push("--agent-id".to_string());
                        argv.push(aid.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "create" => {
                    let name = args.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    let prompt = args.get("prompt").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    if name.is_empty() || prompt.is_empty() {
                        return tool_result("kite_routine action='create' requires non-empty 'name' and 'prompt'.", true);
                    }
                    argv.push("create".to_string());
                    argv.push("--name".to_string());
                    argv.push(name.to_string());
                    argv.push("--prompt".to_string());
                    argv.push(prompt.to_string());
                    if let Some(secs) = args.get("cadence_seconds").or_else(|| args.get("cadenceSeconds")).and_then(Value::as_u64) {
                        argv.push("--every".to_string());
                        argv.push(secs.to_string());
                    }
                    if let Some(ws) = args.get("workspace_id").or_else(|| args.get("workspaceId")).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--workspace-id".to_string());
                        argv.push(ws.to_string());
                    }
                    if let Some(aid) = agent_id {
                        argv.push("--agent-id".to_string());
                        argv.push(aid.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "toggle" => {
                    let routine_id = args.get("routine_id").or_else(|| args.get("routineId")).and_then(Value::as_str).map(str::trim).unwrap_or("");
                    let enabled = args.get("enabled").and_then(Value::as_bool);
                    if routine_id.is_empty() || enabled.is_none() {
                        return tool_result("kite_routine action='toggle' requires 'routine_id' and boolean 'enabled'.", true);
                    }
                    argv.push("toggle".to_string());
                    argv.push("--routine-id".to_string());
                    argv.push(routine_id.to_string());
                    argv.push("--enabled".to_string());
                    argv.push(if enabled.unwrap_or(false) { "true" } else { "false" }.to_string());
                    if let Some(aid) = agent_id {
                        argv.push("--agent-id".to_string());
                        argv.push(aid.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "run" => {
                    let routine_id = args.get("routine_id").or_else(|| args.get("routineId")).and_then(Value::as_str).map(str::trim).unwrap_or("");
                    if routine_id.is_empty() {
                        return tool_result("kite_routine action='run' requires 'routine_id'.", true);
                    }
                    argv.push("run".to_string());
                    argv.push("--routine-id".to_string());
                    argv.push(routine_id.to_string());
                    if let Some(aid) = agent_id {
                        argv.push("--agent-id".to_string());
                        argv.push(aid.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                other => tool_result(
                    format!("Unknown kite_routine action '{other}'. Expected: list, create, toggle, run."),
                    true,
                ),
            }
        }
        "kite_teammate" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let mut argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "agent".to_string(),
                "teammate".to_string(),
            ];
            match action {
                "list" => {
                    argv.push("list".to_string());
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "send" => {
                    let target = args.get("target").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    let message = args.get("message").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    if target.is_empty() || message.is_empty() {
                        return tool_result("kite_teammate action='send' requires non-empty 'target' and 'message'.", true);
                    }
                    argv.push("send".to_string());
                    argv.push("--target".to_string());
                    argv.push(target.to_string());
                    argv.push("--message".to_string());
                    argv.push(message.to_string());
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                "delegate" => {
                    let target = args.get("target").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    let task = args.get("task").and_then(Value::as_str).map(str::trim).unwrap_or("");
                    if target.is_empty() || task.is_empty() {
                        return tool_result("kite_teammate action='delegate' requires non-empty 'target' and 'task'.", true);
                    }
                    argv.push("delegate".to_string());
                    argv.push("--target".to_string());
                    argv.push(target.to_string());
                    argv.push("--task".to_string());
                    argv.push(task.to_string());
                    if args.get("wait").and_then(Value::as_bool).unwrap_or(false) {
                        argv.push("--wait".to_string());
                        let timeout_ms = bounded_mcp_timeout_ms(args);
                        argv.push("--timeout-ms".to_string());
                        argv.push(timeout_ms.to_string());
                    }
                    let (code, out) = runner(&argv);
                    tool_result(extract_text_from_cli_output(&out), code != 0)
                }
                other => tool_result(
                    format!("Unknown kite_teammate action '{other}'. Expected: list, send, delegate."),
                    true,
                ),
            }
        }
        "kite_tasks" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let mut argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "agent".to_string(),
                "tasks".to_string(),
            ];
            match action {
                "list" => {
                    argv.push("list".to_string());
                    if let Some(state) = args.get("state").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--state".to_string());
                        argv.push(state.to_string());
                    }
                    if let Some(label) = args.get("label").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--label".to_string());
                        argv.push(label.to_string());
                    }
                    if let Some(limit) = args.get("limit").and_then(Value::as_u64) {
                        argv.push("--limit".to_string());
                        argv.push(limit.to_string());
                    }
                }
                "get" => {
                    let Some(id) = args.get("id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_tasks get requires non-empty 'id'.", true);
                    };
                    argv.push("get".to_string());
                    argv.push("--id".to_string());
                    argv.push(id.to_string());
                }
                "create" => {
                    let Some(title) = args.get("title").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_tasks create requires non-empty 'title'.", true);
                    };
                    argv.push("create".to_string());
                    argv.push("--title".to_string());
                    argv.push(title.to_string());
                    if let Some(desc) = args.get("description").and_then(Value::as_str) {
                        argv.push("--description".to_string());
                        argv.push(desc.to_string());
                    }
                    if let Some(state) = args.get("state").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--state".to_string());
                        argv.push(state.to_string());
                    }
                    if let Some(priority) = args.get("priority").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--priority".to_string());
                        argv.push(priority.to_string());
                    }
                    if let Some(labels) = args.get("labels").and_then(Value::as_array) {
                        let csv: Vec<&str> = labels.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).collect();
                        if !csv.is_empty() {
                            argv.push("--labels".to_string());
                            argv.push(csv.join(","));
                        }
                    }
                    if let Some(odd_path) = args.get("odd_path").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--odd-path".to_string());
                        argv.push(odd_path.to_string());
                    }
                    if let Some(source_agent) = args.get("source_agent").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--source-agent".to_string());
                        argv.push(source_agent.to_string());
                    }
                    if let Some(source_thread_id) = args.get("source_thread_id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--source-thread-id".to_string());
                        argv.push(source_thread_id.to_string());
                    }
                }
                "update" => {
                    let Some(id) = args.get("id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_tasks update requires non-empty 'id'.", true);
                    };
                    argv.push("update".to_string());
                    argv.push("--id".to_string());
                    argv.push(id.to_string());
                    if let Some(title) = args.get("title").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--title".to_string());
                        argv.push(title.to_string());
                    }
                    if let Some(desc) = args.get("description").and_then(Value::as_str) {
                        argv.push("--description".to_string());
                        argv.push(desc.to_string());
                    }
                    if let Some(state) = args.get("state").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--state".to_string());
                        argv.push(state.to_string());
                    }
                    if let Some(priority) = args.get("priority").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--priority".to_string());
                        argv.push(priority.to_string());
                    }
                    if let Some(labels) = args.get("labels").and_then(Value::as_array) {
                        let csv: Vec<&str> = labels.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).collect();
                        argv.push("--labels".to_string());
                        argv.push(csv.join(","));
                    }
                }
                "move_state" => {
                    let Some(id) = args.get("id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_tasks move_state requires non-empty 'id'.", true);
                    };
                    let Some(state) = args.get("state").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_tasks move_state requires non-empty 'state'.", true);
                    };
                    argv.push("move_state".to_string());
                    argv.push("--id".to_string());
                    argv.push(id.to_string());
                    argv.push("--state".to_string());
                    argv.push(state.to_string());
                }
                other => {
                    return tool_result(
                        format!("Unknown kite_tasks action '{other}'. Expected: list, get, create, update, move_state."),
                        true,
                    );
                }
            }
            let (code, output) = runner(&argv);
            tool_result(extract_text_from_cli_output(&output), code != 0)
        }
        "kite_ctx" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let mut argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "agent".to_string(),
                "ctx".to_string(),
            ];
            match action {
                "read_compact" => {
                    let Some(path) = args.get("path").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_ctx read_compact requires non-empty 'path'.", true);
                    };
                    argv.push("read_compact".to_string());
                    argv.push("--path".to_string());
                    argv.push(path.to_string());
                    if let Some(mode) = args.get("mode").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--mode".to_string());
                        argv.push(mode.to_string());
                    }
                }
                "search" => {
                    let Some(query) = args.get("query").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_ctx search requires non-empty 'query'.", true);
                    };
                    argv.push("search".to_string());
                    argv.push("--query".to_string());
                    argv.push(query.to_string());
                    if let Some(path) = args.get("path").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--path".to_string());
                        argv.push(path.to_string());
                    }
                    if let Some(limit) = args.get("limit").and_then(Value::as_u64) {
                        argv.push("--limit".to_string());
                        argv.push(limit.to_string());
                    }
                }
                "share_put" => {
                    let Some(key) = args.get("key").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_ctx share_put requires non-empty 'key'.", true);
                    };
                    let Some(content) = args.get("content").and_then(Value::as_str) else {
                        return tool_result("kite_ctx share_put requires 'content'.", true);
                    };
                    argv.push("share_put".to_string());
                    argv.push("--key".to_string());
                    argv.push(key.to_string());
                    argv.push("--content".to_string());
                    argv.push(content.to_string());
                    if let Some(scope) = args.get("scope").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--scope".to_string());
                        argv.push(scope.to_string());
                    }
                    if let Some(scope_id) = args.get("scope_id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--scope-id".to_string());
                        argv.push(scope_id.to_string());
                    }
                }
                "share_get" => {
                    let Some(key) = args.get("key").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_ctx share_get requires non-empty 'key'.", true);
                    };
                    argv.push("share_get".to_string());
                    argv.push("--key".to_string());
                    argv.push(key.to_string());
                    if let Some(scope) = args.get("scope").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--scope".to_string());
                        argv.push(scope.to_string());
                    }
                    if let Some(scope_id) = args.get("scope_id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--scope-id".to_string());
                        argv.push(scope_id.to_string());
                    }
                    if args.get("full").and_then(Value::as_bool) == Some(true) {
                        argv.push("--full".to_string());
                    }
                }
                "ccr_retrieve" => {
                    let Some(hash) = args.get("hash").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_ctx ccr_retrieve requires non-empty 'hash'.", true);
                    };
                    argv.push("ccr_retrieve".to_string());
                    argv.push("--hash".to_string());
                    argv.push(hash.to_string());
                    if let Some(lines) = args.get("lines").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--lines".to_string());
                        argv.push(lines.to_string());
                    }
                    if let Some(search) = args.get("search").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--search".to_string());
                        argv.push(search.to_string());
                    }
                }
                other => {
                    return tool_result(
                        format!("Unknown kite_ctx action '{other}'. Expected: read_compact, search, share_put, share_get, ccr_retrieve."),
                        true,
                    );
                }
            }
            let (code, output) = runner(&argv);
            tool_result(extract_text_from_cli_output(&output), code != 0)
        }
        "kite_diff" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let mut argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "agent".to_string(),
                "diff".to_string(),
            ];
            match action {
                "status" => {
                    argv.push("status".to_string());
                    if let Some(ws) = args.get("workspace_id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--workspace-id".to_string());
                        argv.push(ws.to_string());
                    }
                }
                "file_diff" => {
                    let Some(path) = args.get("path").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
                        return tool_result("kite_diff file_diff requires non-empty 'path'.", true);
                    };
                    argv.push("file_diff".to_string());
                    argv.push("--path".to_string());
                    argv.push(path.to_string());
                    if let Some(ws) = args.get("workspace_id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        argv.push("--workspace-id".to_string());
                        argv.push(ws.to_string());
                    }
                    if args.get("staged").and_then(Value::as_bool) == Some(true) {
                        argv.push("--staged".to_string());
                    }
                }
                other => {
                    return tool_result(
                        format!("Unknown kite_diff action '{other}'. Expected: status, file_diff."),
                        true,
                    );
                }
            }
            let (code, output) = runner(&argv);
            tool_result(extract_text_from_cli_output(&output), code != 0)
        }
        "kite_browser" => {
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("")
                .to_ascii_lowercase();
            const VALID_ACTIONS: &[&str] = &[
                "discover",
                "tabs",
                "open",
                "close",
                "snapshot",
                "act",
                "batch",
                "replay",
                "save_recipe",
                "console",
                "network",
                "errors",
                "screenshot",
                "eval",
                "takeover",
                "resume",
            ];
            if !VALID_ACTIONS.contains(&action.as_str()) {
                return tool_result(
                    format!(
                        "Unknown kite_browser action '{action}'. Expected one of: {}.",
                        VALID_ACTIONS.join(", ")
                    ),
                    true,
                );
            }
            let payload_str = serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string());
            let argv = vec![
                "kite".to_string(),
                "dispatch".to_string(),
                "agent".to_string(),
                "browser".to_string(),
                action.clone(),
                "--payload".to_string(),
                payload_str,
            ];
            let (code, output) = runner(&argv);
            let extracted = extract_text_from_cli_output(&output);
            if code == 0 && action == "screenshot" {
                if let Ok(mut parsed) = serde_json::from_str::<Value>(&extracted) {
                    let dedup = parsed
                        .get("deduplicated")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let b64 = parsed
                        .get("dataBase64")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let mime = parsed
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .unwrap_or("image/jpeg")
                        .to_string();
                    if !dedup {
                        if let Some(data) = b64.filter(|s| !s.is_empty()) {
                            if let Some(obj) = parsed.as_object_mut() {
                                obj.remove("dataBase64");
                            }
                            return json!({
                                "content": [
                                    { "type": "text", "text": parsed.to_string() },
                                    { "type": "image", "data": data, "mimeType": mime }
                                ],
                                "isError": false
                            });
                        }
                    }
                }
            }
            tool_result(extracted, code != 0)
        }
        other => tool_result(format!("Unknown tool '{other}'."), true),
    }
}

/// Handle a single JSON-RPC 2.0 request or notification message using env permissions.
pub fn handle_jsonrpc_message<'a>(
    msg: &Value,
    runner: &'a dyn Fn(&[String]) -> (i32, String),
) -> Option<Value> {
    let perms = ToolPermissions::from_env();
    handle_jsonrpc_message_with_permissions(msg, &perms, runner)
}

/// Handle a single JSON-RPC 2.0 request or notification message with explicit [`ToolPermissions`].
/// Returns `None` for notifications that do not carry an `"id"`.
pub fn handle_jsonrpc_message_with_permissions<'a>(
    msg: &Value,
    perms: &ToolPermissions,
    runner: &'a dyn Fn(&[String]) -> (i32, String),
) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let id = msg.get("id").cloned();

    if method.starts_with("notifications/") || id.is_none() {
        return None;
    }
    let id_val = id.unwrap_or(Value::Null);
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

    match method {
        "initialize" => {
            let protocol_version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL_VERSION);
            Some(json!({
                "jsonrpc": "2.0",
                "id": id_val,
                "result": {
                    "protocolVersion": protocol_version,
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": SERVER_NAME,
                        "version": SERVER_VERSION
                    }
                }
            }))
        }
        "ping" => Some(json!({
            "jsonrpc": "2.0",
            "id": id_val,
            "result": {}
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id_val,
            "result": {
                "tools": tool_definitions_for(perms)
            }
        })),
        "tools/call" => {
            let tool_name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = call_tool_with_permissions(tool_name, &arguments, perms, runner);
            Some(json!({
                "jsonrpc": "2.0",
                "id": id_val,
                "result": result
            }))
        }
        _ => Some(json!({
            "jsonrpc": "2.0",
            "id": id_val,
            "error": {
                "code": -32601,
                "message": format!("Method not found: {method}")
            }
        })),
    }
}

/// Read the next JSON-RPC 2.0 message from `reader`, supporting both newline-delimited
/// JSON lines and `Content-Length:` HTTP-style header framing.
pub fn read_jsonrpc_message<R: BufRead>(reader: &mut R) -> std::io::Result<Option<(Value, Framing)>> {
    let mut line = String::new();
    let mut content_length: Option<usize> = None;
    let mut in_headers = false;

    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if in_headers {
                break;
            }
            continue;
        }
        if !in_headers && trimmed.starts_with('{') {
            let parsed: Value = serde_json::from_str(trimmed).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!("invalid json: {e}"))
            })?;
            return Ok(Some((parsed, Framing::Line)));
        }
        in_headers = true;
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("Content-Length") {
                content_length = v.trim().parse::<usize>().ok();
            }
        }
    }

    let len = content_length.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "missing Content-Length header",
        )
    })?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    let parsed: Value = serde_json::from_slice(&buf).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, format!("invalid json: {e}"))
    })?;
    Ok(Some((parsed, Framing::ContentLength)))
}

/// Write a JSON-RPC 2.0 response using the same framing (`Line` or `ContentLength`)
/// as the request.
pub fn write_jsonrpc_message<W: Write>(
    writer: &mut W,
    message: &Value,
    framing: Framing,
) -> std::io::Result<()> {
    let payload = serde_json::to_string(message).map_err(std::io::Error::other)?;
    match framing {
        Framing::Line => {
            writeln!(writer, "{payload}")?;
        }
        Framing::ContentLength => {
            write!(
                writer,
                "Content-Length: {}\r\n\r\n{}",
                payload.len(),
                payload
            )?;
        }
    }
    writer.flush()
}

pub fn serve_mcp_stdio<R: BufRead, W: Write>(
    reader: &mut R,
    writer: &mut W,
    runner: &dyn Fn(&[String]) -> (i32, String),
) -> std::io::Result<()> {
    while let Some((msg, framing)) = read_jsonrpc_message(reader)? {
        if let Some(resp) = handle_jsonrpc_message(&msg, runner) {
            write_jsonrpc_message(writer, &resp, framing)?;
        }
    }
    Ok(())
}

/// Default CLI runner bridging MCP tool calls through `cli_wire::execute_cli_captured`.
pub fn default_cli_runner(argv: &[String]) -> (i32, String) {
    super::execute_cli_captured(argv, None)
}

pub fn run_mcp_cli(_args: &[String]) -> i32 {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();
    match serve_mcp_stdio(&mut reader, &mut writer, &default_cli_runner) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::io::Cursor;

    #[test]
    fn tools_list_exposes_all_five_typed_subagent_and_swarm_tools() {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {}
        });
        let resp = handle_jsonrpc_message(&req, &|_| (0, String::new())).expect("response");
        let tools = resp["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 13);
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str))
            .collect();
        assert_eq!(
            names,
            vec![
                "kite_subagent_run",
                "kite_subagent_send",
                "kite_subagent_wait",
                "kite_subagent_read",
                "kite_swarm",
                "kite_thread",
                "kite_memory",
                "kite_routine",
                "kite_teammate",
                "kite_tasks",
                "kite_ctx",
                "kite_diff",
                "kite_browser",
            ]
        );
        for tool in tools {
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert!(tool["inputSchema"]["properties"].is_object());
        }
    }

    #[test]
    fn supports_both_newline_delimited_and_content_length_framed_jsonrpc() {
        let init_req = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05"
            }
        });
        let notif = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        let ping_req = json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "ping"
        });

        let init_str = serde_json::to_string(&init_req).unwrap();
        let notif_str = serde_json::to_string(&notif).unwrap();
        let ping_str = serde_json::to_string(&ping_req).unwrap();

        let stream_input = format!(
            "{init_str}\n{notif_str}\nContent-Length: {}\r\n\r\n{ping_str}",
            ping_str.len()
        );
        let mut reader = Cursor::new(stream_input.into_bytes());
        let mut writer: Vec<u8> = Vec::new();
        serve_mcp_stdio(&mut reader, &mut writer, &|_| (0, String::new())).unwrap();

        let mut resp_reader = Cursor::new(writer);
        let (first_msg, first_framing) = read_jsonrpc_message(&mut resp_reader)
            .unwrap()
            .expect("first response");
        assert_eq!(first_framing, Framing::Line);
        assert_eq!(first_msg["id"], 10);
        assert_eq!(first_msg["result"]["serverInfo"]["name"], "kite-dispatch");
        assert_eq!(first_msg["result"]["serverInfo"]["version"], SERVER_VERSION);
        assert!(first_msg["result"]["capabilities"]["tools"].is_object());

        let (second_msg, second_framing) = read_jsonrpc_message(&mut resp_reader)
            .unwrap()
            .expect("second response");
        assert_eq!(second_framing, Framing::ContentLength);
        assert_eq!(second_msg["id"], 11);
        assert_eq!(second_msg["result"], json!({}));
        assert!(read_jsonrpc_message(&mut resp_reader).unwrap().is_none());
    }

    #[test]
    fn tools_call_builds_expected_dispatch_argv_for_subagents_and_batch_swarm() {
        let recorded: RefCell<Vec<Vec<String>>> = RefCell::new(Vec::new());
        let runner = |argv: &[String]| -> (i32, String) {
            recorded.borrow_mut().push(argv.to_vec());
            (0, "ok [subagent_id: thread:child-1]".to_string())
        };

        // 1. kite_subagent_run with tasks array + workspace="worktree"
        let run_res = call_tool_with(
            "kite_subagent_run",
            &json!({
                "tasks": ["Audit auth", "Audit db"],
                "n": 2,
                "role": "Fast Executor",
                "workspace": "worktree",
                "wait": true,
                "timeout_ms": 120000
            }),
            &runner,
        );
        assert_eq!(run_res["isError"], false);

        // 2. kite_subagent_send with bare thread id
        let send_res = call_tool_with(
            "kite_subagent_send",
            &json!({
                "target": "child-1",
                "message": "Check edge case",
                "wait": true
            }),
            &runner,
        );
        assert_eq!(send_res["isError"], false);

        // 3. kite_swarm batch add with members array
        let swarm_res = call_tool_with(
            "kite_swarm",
            &json!({
                "action": "add",
                "members": [
                    { "name": "parser", "role": "Parser Worker", "workspace": "worktree", "brief": "Fix AST" },
                    { "name": "tester", "provider": "grok", "brief": "Run tests" }
                ]
            }),
            &runner,
        );
        assert_eq!(swarm_res["isError"], false);

        let calls = recorded.borrow();
        assert_eq!(calls.len(), 4);
        assert_eq!(
            calls[0],
            vec![
                "kite",
                "dispatch",
                "run",
                "--via",
                "thread",
                "--role",
                "Fast Executor",
                "--workspace",
                "share",
                "--wait",
                "--timeout-ms",
                "120000",
                "--task",
                "Audit auth",
                "--task",
                "Audit db",
                "--count",
                "2",
            ]
        );
        assert_eq!(
            calls[1],
            vec![
                "kite",
                "dispatch",
                "send",
                "thread:child-1",
                "Check edge case",
                "--wait",
                "--timeout-ms",
                "120000",
            ]
        );
        assert_eq!(
            calls[2],
            vec![
                "kite",
                "dispatch",
                "swarm",
                "add",
                "--name",
                "parser",
                "--workspace",
                "share",
                "--role",
                "Parser Worker",
                "--brief",
                "Fix AST",
            ]
        );
        assert_eq!(
            calls[3],
            vec![
                "kite",
                "dispatch",
                "swarm",
                "add",
                "--name",
                "tester",
                "--provider",
                "grok",
                "--brief",
                "Run tests",
            ]
        );
    }

    #[test]
    fn mcp_timeouts_default_to_120s_and_clamp_to_150s_across_wait_tools() {
        assert_eq!(DEFAULT_TIMEOUT_MS, 120_000);
        assert_eq!(MAX_MCP_WAIT_TIMEOUT_MS, 150_000);
        assert_eq!(bounded_mcp_timeout_ms(&json!({})), 120_000);
        assert_eq!(bounded_mcp_timeout_ms(&json!({ "timeout_ms": 300_000 })), 150_000);
        assert_eq!(bounded_mcp_timeout_ms(&json!({ "timeoutMs": 90_000 })), 90_000);

        let recorded: RefCell<Vec<Vec<String>>> = RefCell::new(Vec::new());
        let runner = |argv: &[String]| -> (i32, String) {
            recorded.borrow_mut().push(argv.to_vec());
            (0, r#"{"receipt":{"status":"settled","text":"ok"}}"#.to_string())
        };

        let _ = call_tool_with(
            "kite_subagent_run",
            &json!({ "task": "Run check", "timeout_ms": 300_000 }),
            &runner,
        );
        let _ = call_tool_with(
            "kite_subagent_send",
            &json!({ "target": "c1", "message": "Follow up", "timeout_ms": 300_000 }),
            &runner,
        );
        let _ = call_tool_with(
            "kite_subagent_wait",
            &json!({ "children": "all", "timeout_ms": 300_000 }),
            &runner,
        );
        let _ = call_tool_with(
            "kite_swarm",
            &json!({ "action": "wait", "since": 1, "timeout_ms": 300_000 }),
            &runner,
        );

        let calls = recorded.borrow();
        assert_eq!(calls.len(), 4);
        for argv in calls.iter() {
            let pos = argv.iter().position(|t| t == "--timeout-ms").expect("--timeout-ms flag");
            assert_eq!(argv[pos + 1], "150000", "argv={argv:?}");
        }
    }

    #[test]
    fn mcp_wait_timeout_returns_non_error_progress_while_hard_failures_stay_errors() {
        let runner_timeout = |argv: &[String]| -> (i32, String) {
            if argv.get(2).map(String::as_str) == Some("wait") {
                (
                    1,
                    json!({
                        "id": "cli",
                        "op": "wait",
                        "status": "failed",
                        "address": argv.get(3).cloned().unwrap_or_default(),
                        "submitted": false,
                        "error": "timeout"
                    })
                    .to_string(),
                )
            } else {
                (0, String::new())
            }
        };

        let wait_target_res = call_tool_with(
            "kite_subagent_wait",
            &json!({ "targets": ["c1"] }),
            &runner_timeout,
        );
        assert_eq!(wait_target_res["isError"], false);
        let target_text = wait_target_res["content"][0]["text"].as_str().unwrap_or("");
        assert!(target_text.contains("thread:c1"), "text={target_text}");
        assert!(target_text.contains("kite_subagent_wait"), "text={target_text}");
        assert!(target_text.contains("kite_subagent_read"), "text={target_text}");

        let wait_children_res = call_tool_with(
            "kite_subagent_wait",
            &json!({ "children": "all" }),
            &runner_timeout,
        );
        assert_eq!(wait_children_res["isError"], false);
        let children_text = wait_children_res["content"][0]["text"].as_str().unwrap_or("");
        assert!(children_text.contains("still running"), "text={children_text}");
        assert!(children_text.contains("kite_subagent_wait"), "text={children_text}");

        let send_timeout_res = call_tool_with(
            "kite_subagent_send",
            &json!({ "target": "c1", "message": "Continue", "wait": true }),
            &|_argv| {
                (
                    1,
                    json!({
                        "id": "cli",
                        "op": "wait",
                        "status": "failed",
                        "address": "thread:c1",
                        "submitted": false,
                        "error": "timeout"
                    })
                    .to_string(),
                )
            },
        );
        assert_eq!(send_timeout_res["isError"], false);

        let offline_res = call_tool_with(
            "kite_subagent_wait",
            &json!({ "targets": ["c1"] }),
            &|_argv| {
                (
                    1,
                    json!({
                        "id": "cli",
                        "op": "wait",
                        "status": "failed",
                        "address": "thread:c1",
                        "submitted": false,
                        "error": "runtime_offline"
                    })
                    .to_string(),
                )
            },
        );
        assert_eq!(offline_res["isError"], true);
    }

    #[test]
    fn mcp_read_caps_long_output_to_8000_chars_keeping_tail() {
        let long_body = format!("HEAD-{}TAIL-END-MARKER", "á".repeat(12_000));
        let runner = |_argv: &[String]| -> (i32, String) {
            (
                0,
                json!({
                    "receipt": {
                        "op": "read",
                        "status": "settled",
                        "text": long_body
                    }
                })
                .to_string(),
            )
        };
        let res = call_tool_with(
            "kite_subagent_read",
            &json!({ "target": "child-long", "last": true }),
            &runner,
        );
        assert_eq!(res["isError"], false);
        let text = res["content"][0]["text"].as_str().unwrap_or("");
        assert!(
            text.chars().count() <= MAX_MCP_READ_CHARS,
            "expected <= {MAX_MCP_READ_CHARS} chars, got {}",
            text.chars().count()
        );
        assert!(text.contains("[truncated earlier output]"), "text={text}");
        assert!(text.ends_with("TAIL-END-MARKER"), "tail must be preserved");
        assert!(!text.contains("HEAD-"), "head should be trimmed");
    }

    #[test]
    fn mcp_permissions_omit_and_reject_disabled_scheduling_messaging_and_plugins() {
        let called = std::cell::RefCell::new(Vec::<Vec<String>>::new());
        let runner = |argv: &[String]| -> (i32, String) {
            called.borrow_mut().push(argv.to_vec());
            (0, "{\"ok\":true}".to_string())
        };

        // 1. allowAgentScheduling = false omits kite_routine and rejects direct calls
        let no_sched = ToolPermissions {
            agent_id: Some("agent-1".to_string()),
            allow_scheduling: false,
            allow_messaging: true,
            disabled_plugins: vec![],
            ..ToolPermissions::default()
        };
        let list_resp = handle_jsonrpc_message_with_permissions(
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
            &no_sched,
            &runner,
        )
        .unwrap();
        let names: Vec<&str> = list_resp["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(!names.contains(&"kite_routine"));
        assert!(names.contains(&"kite_teammate"));
        assert!(names.contains(&"kite_thread"));
        assert!(names.contains(&"kite_memory"));

        let call_routine = handle_jsonrpc_message_with_permissions(
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": { "name": "kite_routine", "arguments": { "action": "list" } }
            }),
            &no_sched,
            &runner,
        )
        .unwrap();
        assert_eq!(call_routine["result"]["isError"], true);
        assert!(call_routine["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("allowAgentScheduling"));
        assert!(called.borrow().is_empty(), "runner must not be invoked when denied");

        // 2. allowAgentMessaging = false omits kite_teammate and rejects direct calls
        let no_msg = ToolPermissions {
            agent_id: Some("agent-1".to_string()),
            allow_scheduling: true,
            allow_messaging: false,
            disabled_plugins: vec![],
            ..ToolPermissions::default()
        };
        let list_resp2 = handle_jsonrpc_message_with_permissions(
            &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }),
            &no_msg,
            &runner,
        )
        .unwrap();
        let names2: Vec<&str> = list_resp2["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(!names2.contains(&"kite_teammate"));
        assert!(names2.contains(&"kite_routine"));

        let call_tm = handle_jsonrpc_message_with_permissions(
            &json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": { "name": "kite_teammate", "arguments": { "action": "list" } }
            }),
            &no_msg,
            &runner,
        )
        .unwrap();
        assert_eq!(call_tm["result"]["isError"], true);
        assert!(call_tm["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("allowAgentMessaging"));
        assert!(called.borrow().is_empty());

        // 3. disabled_plugins omits kite-dispatch & kite-memory tools and rejects direct calls
        let disabled = ToolPermissions {
            agent_id: Some("agent-1".to_string()),
            allow_scheduling: true,
            allow_messaging: true,
            disabled_plugins: vec!["kite-dispatch".to_string(), "kite-memory".to_string()],
            ..ToolPermissions::default()
        };
        let list_resp3 = handle_jsonrpc_message_with_permissions(
            &json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/list" }),
            &disabled,
            &runner,
        )
        .unwrap();
        let names3: Vec<&str> = list_resp3["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(!names3.contains(&"kite_subagent_run"));
        assert!(!names3.contains(&"kite_swarm"));
        assert!(!names3.contains(&"kite_memory"));
        assert!(names3.contains(&"kite_thread"));

        let call_mem = call_tool_with_permissions(
            "kite_memory",
            &json!({ "action": "read" }),
            &disabled,
            &runner,
        );
        assert_eq!(call_mem["isError"], true);
        assert!(called.borrow().is_empty());

        // 4. Allowed service tools build expected `kite dispatch agent ...` argv
        let ok_thread = call_tool_with_permissions(
            "kite_thread",
            &json!({ "action": "search", "query": "auth", "cursor": 5, "limit": 10 }),
            &disabled,
            &runner,
        );
        assert_eq!(ok_thread["isError"], false);
        assert_eq!(
            called.borrow()[0],
            vec![
                "kite", "dispatch", "agent", "thread", "search", "--query", "auth", "--cursor",
                "5", "--limit", "10"
            ]
        );
    }

    #[test]
    fn tasks_ctx_diff_tools_enforce_tool_policies_and_places_sandbox() {
        let called: std::cell::RefCell<Vec<Vec<String>>> = std::cell::RefCell::new(Vec::new());
        let runner = |argv: &[String]| {
            called.borrow_mut().push(argv.to_vec());
            (0, r#"{"ok":true,"textOut":"done"}"#.to_string())
        };

        let mut policies = std::collections::HashMap::new();
        policies.insert("diff".to_string(), "deny".to_string());
        policies.insert("tasks".to_string(), "ask".to_string());
        policies.insert("ctx".to_string(), "allow".to_string());

        let authorized = std::env::temp_dir().join("kite_mcp_sandbox_ok");
        let _ = std::fs::create_dir_all(&authorized);

        let perms = ToolPermissions {
            tool_policies: policies,
            authorized_roots: vec![authorized.clone()],
            ..ToolPermissions::default()
        };

        // `deny` omits `kite_diff` from tools/list and blocks direct call
        let list_resp = handle_jsonrpc_message_with_permissions(
            &json!({ "jsonrpc": "2.0", "id": 10, "method": "tools/list" }),
            &perms,
            &runner,
        )
        .unwrap();
        let names: Vec<&str> = list_resp["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(!names.contains(&"kite_diff"));
        assert!(names.contains(&"kite_tasks"));
        assert!(names.contains(&"kite_ctx"));

        let diff_denied = call_tool_with_permissions(
            "kite_diff",
            &json!({ "action": "status" }),
            &perms,
            &runner,
        );
        assert_eq!(diff_denied["isError"], true);
        assert!(diff_denied["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("deny"));

        // `ask` keeps kite_tasks visible and forwards to wire server without self-bypass `--approved`
        let task_ask_forward = call_tool_with_permissions(
            "kite_tasks",
            &json!({ "action": "create", "title": "QA follow-up", "approved": true }),
            &perms,
            &runner,
        );
        assert_eq!(task_ask_forward["isError"], false);
        assert_eq!(
            called.borrow()[0],
            vec![
                "kite",
                "dispatch",
                "agent",
                "tasks",
                "create",
                "--title",
                "QA follow-up",
            ]
        );

        // `Places` sandbox rejects outside path or traversal, accepts inside path
        let outside = call_tool_with_permissions(
            "kite_ctx",
            &json!({ "action": "read_compact", "path": "../outside_secret.txt" }),
            &perms,
            &runner,
        );
        assert_eq!(outside["isError"], true);
        assert!(outside["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("outside"));

        let inside = call_tool_with_permissions(
            "kite_ctx",
            &json!({ "action": "read_compact", "path": "src/lib.rs", "mode": "signatures" }),
            &perms,
            &runner,
        );
        assert_eq!(inside["isError"], false);
        assert_eq!(
            called.borrow()[1],
            vec![
                "kite",
                "dispatch",
                "agent",
                "ctx",
                "read_compact",
                "--path",
                "src/lib.rs",
                "--mode",
                "signatures"
            ]
        );

        let _ = std::fs::remove_dir_all(&authorized);
    }

    #[test]
    fn thread_launch_schema_argv_singular_policy_alignment_and_local_denial_audit() {
        // 1. Verify schemas: kite_thread includes launch + flags, tasks/ctx/diff do not expose `approved`
        let defs = tool_definitions();
        let thread_tool = defs.iter().find(|t| t["name"] == "kite_thread").unwrap();
        let actions = thread_tool["inputSchema"]["properties"]["action"]["enum"]
            .as_array()
            .unwrap();
        assert!(actions.iter().any(|v| v == "launch"));
        for prop in [
            "title",
            "prompt",
            "workspace_id",
            "provider",
            "model",
            "mode",
            "effort",
            "worktree",
            "odd_path",
            "open",
            "orchestrate",
        ] {
            assert!(
                thread_tool["inputSchema"]["properties"].get(prop).is_some(),
                "kite_thread schema missing `{prop}`"
            );
        }
        for name in ["kite_tasks", "kite_ctx", "kite_diff"] {
            let tool = defs.iter().find(|t| t["name"] == name).unwrap();
            assert!(
                tool["inputSchema"]["properties"].get("approved").is_none(),
                "{name} schema must not expose LLM self-bypass `approved` field"
            );
        }

        // 2. Verify singular tool families and plural alias normalization
        assert_eq!(ToolPermissions::tool_family_for_name("kite_thread"), "thread");
        assert_eq!(ToolPermissions::tool_family_for_name("kite_routine"), "routine");
        assert_eq!(ToolPermissions::tool_family_for_name("kite_teammate"), "teammate");
        assert_eq!(ToolPermissions::tool_family_for_name("kite_memory"), "memory");
        let normalized_policies = parse_tool_policies_env("threads=deny,routines=ask,teammates=allow");
        assert_eq!(normalized_policies.get("thread").map(String::as_str), Some("deny"));
        assert_eq!(normalized_policies.get("routine").map(String::as_str), Some("ask"));
        assert_eq!(normalized_policies.get("teammate").map(String::as_str), Some("allow"));

        // 3. Verify kite_thread action='launch' argv mapping
        let called: RefCell<Vec<Vec<String>>> = RefCell::new(Vec::new());
        let runner = |argv: &[String]| -> (i32, String) {
            called.borrow_mut().push(argv.to_vec());
            (0, r#"{"schema":"kite.thread-launch/v1","threadId":"t-1"}"#.to_string())
        };
        let launch_res = call_tool_with(
            "kite_thread",
            &json!({
                "action": "launch",
                "title": "Build V3",
                "prompt": "Execute ODD",
                "workspace_id": "ws-1",
                "provider": "antigravity",
                "model": "gemini-4-argon",
                "mode": "fullAccess",
                "effort": "high",
                "worktree": true,
                "odd_path": "odd/tasks/v3.md",
                "open": true,
                "orchestrate": true
            }),
            &runner,
        );
        assert_eq!(launch_res["isError"], false);
        assert_eq!(
            called.borrow()[0],
            vec![
                "kite",
                "dispatch",
                "agent",
                "thread",
                "launch",
                "--prompt",
                "Execute ODD",
                "--title",
                "Build V3",
                "--workspace-id",
                "ws-1",
                "--provider",
                "antigravity",
                "--model",
                "gemini-4-argon",
                "--mode",
                "fullAccess",
                "--effort",
                "high",
                "--worktree",
                "--odd-path",
                "odd/tasks/v3.md",
                "--open",
                "--orchestrate",
            ]
        );

        // 4. Local MCP policy denial logs to agent_audit_log when DB exists and silently skips when missing
        let missing_db = std::env::temp_dir().join(format!(
            "kite-mcp-missing-{}.sqlite",
            uuid::Uuid::new_v4().simple()
        ));
        let deny_perms = ToolPermissions {
            agent_id: Some("agent-mcp-deny".to_string()),
            tool_policies: normalized_policies,
            ..ToolPermissions::default()
        };
        let denied_no_db = call_tool_with_permissions_at(
            "kite_thread",
            &json!({ "action": "list" }),
            &deny_perms,
            Some(&missing_db),
            &runner,
        );
        assert_eq!(denied_no_db["isError"], true);
        assert!(!missing_db.exists());

        let audit_db = std::env::temp_dir().join(format!(
            "kite-mcp-audit-{}.sqlite",
            uuid::Uuid::new_v4().simple()
        ));
        {
            let conn = rusqlite::Connection::open(&audit_db).unwrap();
            conn.execute_batch(
                "CREATE TABLE agent_audit_log (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    thread_id TEXT,
                    tool_name TEXT NOT NULL,
                    tool_family TEXT NOT NULL,
                    verdict TEXT NOT NULL,
                    reason TEXT,
                    duration_ms INTEGER NOT NULL DEFAULT 0,
                    skill_event TEXT,
                    created_at_unix_ms INTEGER NOT NULL
                );",
            )
            .unwrap();
        }
        let denied_with_db = call_tool_with_permissions_at(
            "kite_thread",
            &json!({ "action": "list" }),
            &deny_perms,
            Some(&audit_db),
            &runner,
        );
        assert_eq!(denied_with_db["isError"], true);
        {
            let conn = rusqlite::Connection::open(&audit_db).unwrap();
            let (agent_id, tool_name, tool_family, verdict): (String, String, String, String) = conn
                .query_row(
                    "SELECT agent_id, tool_name, tool_family, verdict FROM agent_audit_log LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .unwrap();
            assert_eq!(agent_id, "agent-mcp-deny");
            assert_eq!(tool_name, "kite_thread");
            assert_eq!(tool_family, "thread");
            assert_eq!(verdict, "denied");
        }
        let _ = std::fs::remove_file(&audit_db);
    }

    #[test]
    fn kite_subagent_run_wait_timeout_returns_non_error_still_running_with_subagent_id() {
        let timeout_json = json!({
            "schemaVersion": 1,
            "id": "cli",
            "op": "wait",
            "status": "failed",
            "address": "thread:child-timeout-42",
            "submitted": false,
            "error": "timeout"
        })
        .to_string();
        let captured_argv: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let runner = |argv: &[String]| -> (i32, String) {
            *captured_argv.borrow_mut() = argv.to_vec();
            (1, timeout_json.clone())
        };
        let res = call_tool_with(
            "kite_subagent_run",
            &json!({
                "role": "Deep Auditor",
                "task": "Audit architecture",
                "wait": true,
                "timeout_ms": 120000,
                "parent_thread_id": "parent-99"
            }),
            &runner,
        );
        assert_eq!(
            res["isError"], false,
            "wait slice timeout on kite_subagent_run must not fail the MCP tool call: {res:?}"
        );
        let text = res["content"][0]["text"].as_str().unwrap_or("");
        assert!(
            text.contains("[subagent_id: thread:child-timeout-42]"),
            "response must keep subagent_id anchor: {text}"
        );
        assert!(
            text.contains("still running after 120000ms wait slice"),
            "response must guide orchestrator to continue waiting: {text}"
        );
        let argv = captured_argv.borrow();
        let parent_pos = argv.iter().position(|a| a == "--parent");
        assert_eq!(
            parent_pos.and_then(|i| argv.get(i + 1)).map(String::as_str),
            Some("thread:parent-99")
        );
    }

    #[test]
    fn kite_browser_tool_definition_routes_actions_and_formats_screenshots() {
        let defs = tool_definitions();
        let browser_def = defs
            .iter()
            .find(|d| d.get("name").and_then(Value::as_str) == Some("kite_browser"))
            .expect("kite_browser tool must be registered in tools/list");
        let actions = browser_def["inputSchema"]["properties"]["action"]["enum"]
            .as_array()
            .expect("kite_browser action enum");
        assert!(actions.iter().any(|v| v.as_str() == Some("discover")));
        assert!(actions.iter().any(|v| v.as_str() == Some("batch")));
        assert!(actions.iter().any(|v| v.as_str() == Some("replay")));

        // Verify disabled plugin gating
        let mut perms = ToolPermissions::default();
        perms.disabled_plugins.push("kite-browser".to_string());
        assert!(perms.is_tool_allowed("kite_browser").is_err());

        // Verify screenshot response emits native MCP image block when not deduplicated
        let captured_argv: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let runner = |argv: &[String]| -> (i32, String) {
            *captured_argv.borrow_mut() = argv.to_vec();
            (
                0,
                json!({
                    "ok": true,
                    "action": "screenshot",
                    "surfaceId": "tab-1",
                    "mimeType": "image/jpeg",
                    "sha256": "deadbeef",
                    "deduplicated": false,
                    "dataBase64": "AAAA"
                })
                .to_string(),
            )
        };
        let res = call_tool_with(
            "kite_browser",
            &json!({ "action": "screenshot", "surface_id": "tab-1" }),
            &runner,
        );
        assert_eq!(res["isError"], false);
        assert_eq!(res["content"].as_array().unwrap().len(), 2);
        assert_eq!(res["content"][1]["type"], "image");
        assert_eq!(res["content"][1]["data"], "AAAA");
        assert_eq!(res["content"][1]["mimeType"], "image/jpeg");
        assert_eq!(captured_argv.borrow()[3], "browser");
        assert_eq!(captured_argv.borrow()[4], "screenshot");
    }
}
