use std::path::Path;

use serde_json::Value;

use super::*;

pub struct ShellToken {
    text: String,
    quoted: bool,
}

pub fn tokenize_shell_tokens(cmd: &str) -> Vec<ShellToken> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut current_quoted = false;
    let mut quote: Option<char> = None;
    let mut escape = false;
    for ch in cmd.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {
                if ch == '\\' {
                    escape = true;
                } else {
                    current.push(ch);
                }
            }
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                current_quoted = true;
            }
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    words.push(ShellToken {
                        text: std::mem::take(&mut current),
                        quoted: current_quoted,
                    });
                    current_quoted = false;
                }
            }
            None if ch == ';' => {
                if !current.is_empty() {
                    words.push(ShellToken {
                        text: std::mem::take(&mut current),
                        quoted: current_quoted,
                    });
                    current_quoted = false;
                }
                words.push(ShellToken {
                    text: ";".to_string(),
                    quoted: false,
                });
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        words.push(ShellToken {
            text: current,
            quoted: current_quoted,
        });
    }
    words
}

pub(super) fn sanitize_cli_args(tokens: &[ShellToken]) -> Vec<String> {
    let mut cleaned = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let tok = &tokens[i];
        if !tok.quoted {
            let t = tok.text.as_str();
            if matches!(t, "|" | "||" | "&&" | ";" | "&") {
                break;
            }
            if matches!(
                t,
                "2>&1" | "1>&2" | "2>&2" | "1>&1" | ">&1" | ">&2" | "*>&1"
            ) {
                i += 1;
                continue;
            }
            if matches!(
                t,
                ">" | ">>" | "<" | "<<" | "<<<" | "1>" | "1>>" | "2>" | "2>>" | "&>" | "&>>" | ">|" | "<>" | "*>" | "*>>"
            ) {
                i = (i + 2).min(tokens.len());
                continue;
            }
            if t.starts_with('>')
                || t.starts_with('<')
                || t.starts_with("&>")
                || t.starts_with("1>")
                || t.starts_with("2>")
                || t.starts_with("*>")
            {
                i += 1;
                continue;
            }
        }
        cleaned.push(tok.text.clone());
        i += 1;
    }
    cleaned
}

pub enum DispatchCliCommand {
    Run(Vec<String>),
    Swarm(Vec<String>),
}

pub fn match_dispatch_cli(tokens: &[ShellToken]) -> Option<DispatchCliCommand> {
    for idx in 0..tokens.len() {
        let bin = Path::new(&tokens[idx].text)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&tokens[idx].text)
            .to_ascii_lowercase();
        if bin == "kite" && tokens.get(idx + 1).is_some_and(|w| w.text.eq_ignore_ascii_case("dispatch")) {
            let sub = tokens.get(idx + 2).map(|s| s.text.to_ascii_lowercase());
            if sub.as_deref() == Some("run") {
                return Some(DispatchCliCommand::Run(sanitize_cli_args(&tokens[idx + 3..])));
            }
            if sub.as_deref() == Some("swarm") {
                return Some(DispatchCliCommand::Swarm(sanitize_cli_args(&tokens[idx + 3..])));
            }
        } else if bin == "kite-dispatch" {
            let sub = tokens.get(idx + 1).map(|s| s.text.to_ascii_lowercase());
            if sub.as_deref() == Some("run") {
                return Some(DispatchCliCommand::Run(sanitize_cli_args(&tokens[idx + 2..])));
            }
            if sub.as_deref() == Some("swarm") {
                return Some(DispatchCliCommand::Swarm(sanitize_cli_args(&tokens[idx + 2..])));
            }
        }
    }
    None
}

pub(super) fn take_cli_flag(args: &[String], names: &[&str]) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some((flag, val)) = arg.split_once('=') {
            if names.iter().any(|n| flag.eq_ignore_ascii_case(n)) {
                return Some(val.to_string());
            }
        }
        if names.iter().any(|n| arg.eq_ignore_ascii_case(n)) {
            if let Some(next) = args.get(i + 1) {
                return Some(next.clone());
            }
        }
        i += 1;
    }
    None
}

pub(super) fn collect_cli_positionals(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg.starts_with("--") {
            if !arg.contains('=')
                && !matches!(
                    arg.as_str(),
                    "--wait" | "--all" | "--json" | "--exact" | "--refresh" | "--no-wait" | "--help"
                )
                && i + 1 < args.len()
            {
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        out.push(arg.clone());
        i += 1;
    }
    out
}

pub fn strip_mcp_prefix(raw_name: &str, params: &Value) -> (Option<String>, String) {
    let mut server_name = params
        .get("ServerName")
        .or_else(|| params.get("serverName"))
        .or_else(|| params.get("server_name"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut clean_name = raw_name.to_string();
    if raw_name == "call_mcp_tool" {
        if let Some(tn) = params
            .get("ToolName")
            .or_else(|| params.get("toolName"))
            .and_then(|v| v.as_str())
        {
            clean_name = tn.to_string();
        }
    } else if let Some(rest) = raw_name.strip_prefix("mcp__") {
        let parts: Vec<&str> = rest.splitn(2, "__").collect();
        if parts.len() == 2 {
            server_name = Some(parts[0].to_string());
            clean_name = parts[1].to_string();
        }
    } else if let Some(rest) = raw_name.strip_prefix("mcp_") {
        if let Some(kite_tool) = rest
            .strip_prefix("kite-dispatch_")
            .or_else(|| rest.strip_prefix("kite_dispatch_"))
        {
            if server_name.is_none() {
                server_name = Some("kite-dispatch".to_string());
            }
            clean_name = kite_tool.to_string();
        } else {
            let parts: Vec<&str> = rest.splitn(2, '_').collect();
            if parts.len() == 2 && server_name.is_none() {
                server_name = Some(parts[0].to_string());
                clean_name = parts[1].to_string();
            }
        }
    }
    (server_name, clean_name)
}

pub fn is_non_delegating_subagent_tool(clean_name: &str) -> bool {
    matches!(
        clean_name.trim().to_ascii_lowercase().as_str(),
        "define_subagent"
            | "manage_subagents"
            | "send_message"
            | "kite_subagent_send"
            | "kite_subagent_wait"
            | "kite_subagent_read"
    )
}

pub fn is_subagent_tool_name(clean_name: &str) -> bool {
    matches!(
        clean_name.trim().to_ascii_lowercase().as_str(),
        "invoke_subagent"
            | "task"
            | "agent"
            | "dispatch_agent"
            | "subagent"
            | "delegate"
            | "spawn_agent"
            | "kite_subagent_run"
    )
}

pub fn is_swarm_tool_name(clean_name: &str) -> bool {
    matches!(
        clean_name.trim().to_ascii_lowercase().as_str(),
        "swarm" | "post_message" | "read_board" | "swarm_wait" | "kite_swarm"
    )
}

fn extract_balanced_json_values(text: &str, open_ch: char, close_ch: char) -> Vec<Value> {
    let mut out = Vec::new();
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].1 != open_ch {
            i += 1;
            continue;
        }
        let start_byte = chars[i].0;
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        let mut end_idx = None;
        for (j, &(byte_pos, ch)) in chars.iter().enumerate().skip(i) {
            if in_string {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    in_string = false;
                }
                continue;
            }
            if ch == '"' {
                in_string = true;
            } else if ch == open_ch {
                depth += 1;
            } else if ch == close_ch {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    end_idx = Some((j, byte_pos + ch.len_utf8()));
                    break;
                }
            }
        }
        if let Some((j, end_byte)) = end_idx {
            if let Ok(val) = serde_json::from_str::<Value>(&text[start_byte..end_byte]) {
                out.push(val);
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

pub fn parse_output_json(output: Option<&str>) -> Option<Value> {
    let text = output?.trim();
    if text.is_empty() {
        return None;
    }
    if text.starts_with('{') && text.ends_with('}') {
        if let Ok(val) = serde_json::from_str::<Value>(text) {
            if val.is_object() {
                return Some(val);
            }
        }
    }
    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') && trimmed.ends_with('}') {
            if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                if val.is_object() {
                    return Some(val);
                }
            }
        }
    }
    let embedded: Vec<Value> = extract_balanced_json_values(text, '{', '}')
        .into_iter()
        .filter(|v| v.is_object())
        .collect();
    if let Some(preferred) = embedded.iter().rev().find(|v| {
        [
            "conversationId",
            "conversation_id",
            "logAbsoluteUri",
            "log_absolute_uri",
            "transcriptUri",
            "transcript_uri",
            "transcript",
            "target",
            "subagentId",
            "childThreadId",
            "swarmId",
            "seq",
        ]
        .iter()
        .any(|k| v.get(*k).is_some())
    }) {
        return Some(preferred.clone());
    }
    embedded.into_iter().last()
}

pub fn parse_output_json_array(output: Option<&str>) -> Option<Vec<Value>> {
    let text = output?.trim();
    if text.is_empty() {
        return None;
    }
    if text.starts_with('[') && text.ends_with(']') {
        if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(text) {
            if arr.iter().any(|item| item.is_object()) {
                return Some(arr);
            }
        }
    }
    if text.starts_with('{') && text.ends_with('}') {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(text) {
            if let Some(Value::Array(arr)) = map.get("subagents") {
                return Some(arr.clone());
            }
        }
    }
    let has_subagent_row = |arr: &[Value]| {
        arr.iter().any(|item| {
            item.as_object().is_some_and(|obj| {
                ["conversationId", "conversation_id", "transcript", "logAbsoluteUri", "role"]
                    .iter()
                    .any(|k| obj.contains_key(*k))
            })
        })
    };
    for candidate in extract_balanced_json_values(text, '[', ']').into_iter().rev() {
        if let Value::Array(arr) = candidate {
            if has_subagent_row(&arr) {
                return Some(arr);
            }
        }
    }
    None
}

pub(crate) fn is_shell_wrapper_name(clean_name: &str) -> bool {
    matches!(
        clean_name.trim().to_ascii_lowercase().replace(' ', "_").as_str(),
        "run_command"
            | "execute_command"
            | "command_execution"
            | "bash"
            | "shell"
            | "sh"
            | "zsh"
            | "cmd"
            | "powershell"
            | "pwsh"
            | "terminal"
            | "exec"
    )
}

pub(super) fn is_generic_subagent_role(role: &str) -> bool {
    let trimmed = role.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower == "subagent"
        || lower.ends_with(" subagent")
        || is_shell_wrapper_name(trimmed)
        || is_subagent_tool_name(&lower.replace(' ', "_"))
}

pub(super) fn display_provider_label(provider: &str) -> &str {
    match provider.trim().to_ascii_lowercase().as_str() {
        "antigravity" | "agy" => "Antigravity",
        "grok" => "Grok",
        "codex" => "Codex",
        "claude" | "claude-code" => "Claude",
        "opencode" | "open-code" => "OpenCode",
        "cursor" | "cursor-agent" => "Cursor",
        "gemini" => "Gemini",
        "fx" => "FX",
        _ => "Subagent",
    }
}

pub(super) fn expand_swarm_members(base_name: Option<&str>, params: &Value) -> Vec<String> {
    let mut members = Vec::new();
    if let Some(Value::Array(arr)) = lookup_value(params, &["members", "Members"]) {
        for entry in arr {
            if let Some(s) = entry.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                members.push(s.to_string());
            } else if let Some(n) =
                lookup_text(&entry, &["name", "Name", "memberName", "member_name"])
            {
                members.push(n);
            }
        }
        if !members.is_empty() {
            return members;
        }
    }
    let Some(base) = base_name.map(str::trim).filter(|s| !s.is_empty()) else {
        return members;
    };
    if let Some(Value::Array(tasks)) = lookup_value(params, &["tasks"]) {
        if !tasks.is_empty() {
            for idx in 1..=tasks.len() {
                members.push(format!("{base}-{idx}"));
            }
            return members;
        }
    }
    if let Some(n_val) = lookup_value(params, &["n"]).and_then(|v| v.as_u64()) {
        if n_val > 1 {
            for idx in 1..=n_val {
                members.push(format!("{base}-{idx}"));
            }
            return members;
        }
    }
    members.push(base.to_string());
    members
}

