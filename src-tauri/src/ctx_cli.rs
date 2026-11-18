//! CLI command dispatcher for `kite ctx ...` backed by the `kite-ctx` crate.

use std::io::{Read, Write};
use std::process::Command;

use kite_ctx::{
    apply_agent_setup, discover_from_host, evaluate_hook_input, resolve_home_dir,
    run_mcp_stdio_proxy, scan_volatile_tokens, AgentTarget, ContentKind, ContextEngine,
    ContextScope, ReadMode, DEFAULT_MCP_MIN_BYTES,
};
use serde_json::json;

pub fn run_ctx_cli(args: &[String]) -> i32 {
    run_ctx_cli_with_io(args, None)
}

fn open_engine() -> Result<ContextEngine, String> {
    ContextEngine::open_default().map_err(|e| format!("failed to open context store: {e}"))
}

pub fn run_ctx_cli_with_io(args: &[String], stdin_override: Option<&str>) -> i32 {
    let Some(sub) = args.first().map(String::as_str) else {
        print_usage();
        return 2;
    };

    if matches!(sub, "-h" | "--help" | "help") {
        print_usage();
        return 0;
    }

    match sub {
        "read" => cmd_read(&args[1..]),
        "exec" => cmd_exec(&args[1..]),
        "compress" => cmd_compress(&args[1..], stdin_override),
        "retrieve" => cmd_retrieve(&args[1..]),
        "share" => cmd_share(&args[1..], stdin_override),
        "stats" => cmd_stats(&args[1..]),
        "init" => cmd_init(&args[1..]),
        "hook-rewrite" => cmd_hook_rewrite(&args[1..], stdin_override),
        "mcp-proxy" => cmd_mcp_proxy(&args[1..]),
        "discover" => cmd_discover(&args[1..]),
        "kv-check" => cmd_kv_check(&args[1..], stdin_override),
        other => {
            eprintln!("Unknown `kite ctx` subcommand: {other}");
            print_usage();
            2
        }
    }
}

fn print_usage() {
    println!(
        "\
Usage: kite ctx <subcommand> [options]

Subcommands:
  read <path> [--mode auto|full|signatures|map|diff|lines:N-M] [--session <id>] [--fresh]
  exec [--session <id>] [--agent <name>] [--model <name>] -- <command...>
  compress [--kind auto|json|diff|grep|log|paths|text]
  retrieve <hash> [--lines N-M] [--search <query>]
  share put <key> [--agent <name>] [--scope user|project|session|agent|turn] [--scope-id <id>] [--content <text>]
  share get <key> [--scope user|project|session|agent|turn] [--scope-id <id>] [--full]
  stats [--session <id>] [--json] [--reset]
  init [--agent claude|antigravity|cursor|codex|gemini|opencode|grok|copilot|agents|all] [--check]
  hook-rewrite [--agent <target>] [--command <cmd>]
  mcp-proxy [--server <name>] [--min-bytes <n>] -- <command...>
  discover [--json]
  kv-check [--file <path>]"
    );
}

fn env_or_default(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn read_stdin_string(override_input: Option<&str>) -> Result<String, String> {
    if let Some(s) = override_input {
        return Ok(s.to_string());
    }
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| format!("failed to read stdin: {e}"))?;
    Ok(buf)
}

fn cmd_read(args: &[String]) -> i32 {
    let mut path: Option<String> = None;
    let mut mode_str = "auto".to_string();
    let mut session = env_or_default("KITE_SESSION_ID", "default");
    let mut agent = env_or_default("KITE_AGENT_NAME", "cli");
    let mut provider = env_or_default("KITE_PROVIDER", "local");
    let mut model = env_or_default("KITE_MODEL", "unknown");
    let mut fresh = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--mode" | "-m" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    mode_str = val.clone();
                } else {
                    eprintln!("--mode requires a value");
                    return 2;
                }
            }
            "--session" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    session = val.clone();
                } else {
                    eprintln!("--session requires a value");
                    return 2;
                }
            }
            "--agent" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    agent = val.clone();
                }
            }
            "--provider" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    provider = val.clone();
                }
            }
            "--model" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    model = val.clone();
                }
            }
            "--fresh" => fresh = true,
            flag if flag.starts_with('-') => {
                eprintln!("Unknown option: {flag}");
                return 2;
            }
            pos => {
                if path.is_none() {
                    path = Some(pos.to_string());
                } else {
                    eprintln!("Unexpected positional argument: {pos}");
                    return 2;
                }
            }
        }
        i += 1;
    }

    let Some(file_path) = path else {
        eprintln!("Usage: kite ctx read <path> [--mode ...] [--session <id>] [--fresh]");
        return 2;
    };

    let mode = match ReadMode::parse(&mode_str) {
        Ok(m) => m,
        Err(err) => {
            eprintln!("{err}");
            return 2;
        }
    };

    let engine = match open_engine() {
        Ok(e) => e,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };

    match engine.read_file_with_telemetry(
        &session,
        &file_path,
        mode,
        fresh,
        &agent,
        &provider,
        &model,
    ) {
        Ok(res) => {
            println!("{}", res.content);
            let _ = std::io::stdout().flush();
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn cmd_exec(args: &[String]) -> i32 {
    let mut session = env_or_default("KITE_SESSION_ID", "default");
    let mut agent = env_or_default("KITE_AGENT_NAME", "cli");
    let mut provider = env_or_default("KITE_PROVIDER", "local");
    let mut model = env_or_default("KITE_MODEL", "unknown");
    let mut command_args: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            command_args.extend(args[i + 1..].iter().cloned());
            break;
        }
        match arg {
            "--session" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    session = val.clone();
                }
            }
            "--agent" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    agent = val.clone();
                }
            }
            "--provider" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    provider = val.clone();
                }
            }
            "--model" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    model = val.clone();
                }
            }
            _ => {
                command_args.extend(args[i..].iter().cloned());
                break;
            }
        }
        i += 1;
    }

    let Some(program) = command_args.first() else {
        eprintln!("Usage: kite ctx exec [--session <id>] -- <command...>");
        return 2;
    };

    let output = match spawn_child_command(program, &command_args[1..]) {
        Ok(out) => out,
        Err(err) => {
            eprintln!("Failed to run `{program}`: {err}");
            return 127;
        }
    };

    let exit_code = output.status.code().unwrap_or(1);
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    let engine = match open_engine() {
        Ok(e) => e,
        Err(_) => {
            if !stdout.is_empty() {
                print!("{stdout}");
            }
            if !stderr.is_empty() {
                eprint!("{stderr}");
            }
            return exit_code;
        }
    };

    match engine.filter_command_with_telemetry(
        &command_args,
        &stdout,
        &stderr,
        exit_code,
        &session,
        &agent,
        &provider,
        &model,
    ) {
        Ok(filtered) => {
            if !filtered.text.is_empty() {
                println!("{}", filtered.text);
                let _ = std::io::stdout().flush();
            }
        }
        Err(_) => {
            if !stdout.is_empty() {
                print!("{stdout}");
            }
            if !stderr.is_empty() {
                eprint!("{stderr}");
            }
        }
    }

    exit_code
}

fn spawn_child_command(
    program: &str,
    rest: &[String],
) -> std::io::Result<std::process::Output> {
    match Command::new(program).args(rest).output() {
        Ok(out) => Ok(out),
        Err(err) if cfg!(windows) && err.kind() == std::io::ErrorKind::NotFound => {
            Command::new("cmd")
                .arg("/C")
                .arg(program)
                .args(rest)
                .output()
        }
        Err(err) => Err(err),
    }
}

fn parse_content_kind(raw: &str) -> Result<ContentKind, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "auto" => Ok(ContentKind::Auto),
        "json" => Ok(ContentKind::Json),
        "diff" => Ok(ContentKind::Diff),
        "grep" | "search" => Ok(ContentKind::Grep),
        "paths" => Ok(ContentKind::Paths),
        "log" => Ok(ContentKind::Log),
        "text" => Ok(ContentKind::Text),
        other => Err(format!("unknown kind '{other}'")),
    }
}

fn cmd_compress(args: &[String], stdin_override: Option<&str>) -> i32 {
    let mut kind_str = "auto".to_string();
    let mut session = env_or_default("KITE_SESSION_ID", "default");
    let mut agent = env_or_default("KITE_AGENT_NAME", "cli");
    let mut provider = env_or_default("KITE_PROVIDER", "local");
    let mut model = env_or_default("KITE_MODEL", "unknown");

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--kind" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    kind_str = val.clone();
                }
            }
            "--session" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    session = val.clone();
                }
            }
            "--agent" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    agent = val.clone();
                }
            }
            "--provider" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    provider = val.clone();
                }
            }
            "--model" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    model = val.clone();
                }
            }
            flag => {
                eprintln!("Unknown option: {flag}");
                return 2;
            }
        }
        i += 1;
    }

    let kind = match parse_content_kind(&kind_str) {
        Ok(k) => k,
        Err(err) => {
            eprintln!("{err}");
            return 2;
        }
    };

    let input = match read_stdin_string(stdin_override) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };

    let engine = match open_engine() {
        Ok(e) => e,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };

    match engine.compress_text(&input, kind, &session, &agent, &provider, &model) {
        Ok(res) => {
            println!("{}", res.text);
            let _ = std::io::stdout().flush();
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn parse_line_range(spec: &str) -> Result<(usize, usize), String> {
    let parts: Vec<&str> = spec.split('-').collect();
    if parts.len() != 2 {
        return Err(format!("invalid line range '{spec}' (expected N-M)"));
    }
    let s = parts[0]
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("invalid line start in '{spec}'"))?;
    let e = parts[1]
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("invalid line end in '{spec}'"))?;
    if s == 0 || e < s {
        return Err(format!("invalid line bounds in '{spec}'"));
    }
    Ok((s, e))
}

fn cmd_retrieve(args: &[String]) -> i32 {
    let mut hash: Option<String> = None;
    let mut lines: Option<(usize, usize)> = None;
    let mut search: Option<String> = None;
    let mut session = env_or_default("KITE_SESSION_ID", "default");
    let mut agent = env_or_default("KITE_AGENT_NAME", "cli");
    let mut provider = env_or_default("KITE_PROVIDER", "local");
    let mut model = env_or_default("KITE_MODEL", "unknown");

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--lines" => {
                i += 1;
                let Some(val) = args.get(i) else {
                    eprintln!("--lines requires N-M");
                    return 2;
                };
                match parse_line_range(val) {
                    Ok(r) => lines = Some(r),
                    Err(err) => {
                        eprintln!("{err}");
                        return 2;
                    }
                }
            }
            "--search" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    search = Some(val.clone());
                } else {
                    eprintln!("--search requires a query");
                    return 2;
                }
            }
            "--session" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    session = val.clone();
                }
            }
            "--agent" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    agent = val.clone();
                }
            }
            "--provider" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    provider = val.clone();
                }
            }
            "--model" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    model = val.clone();
                }
            }
            flag if flag.starts_with('-') => {
                eprintln!("Unknown option: {flag}");
                return 2;
            }
            pos => {
                if hash.is_none() {
                    hash = Some(pos.to_string());
                }
            }
        }
        i += 1;
    }

    let Some(key) = hash else {
        eprintln!("Usage: kite ctx retrieve <hash> [--lines N-M] [--search <query>]");
        return 2;
    };

    let engine = match open_engine() {
        Ok(e) => e,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };

    match engine.retrieve_ccr_with_telemetry(
        &key,
        lines,
        search.as_deref(),
        &session,
        &agent,
        &provider,
        &model,
    ) {
        Ok(res) => {
            println!("{}", res.content);
            let _ = std::io::stdout().flush();
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn cmd_share(args: &[String], stdin_override: Option<&str>) -> i32 {
    let Some(op) = args.first().map(String::as_str) else {
        eprintln!("Usage: kite ctx share <put|get> <key> [options]");
        return 2;
    };

    let mut key: Option<String> = None;
    let mut scope_str = "project".to_string();
    let mut scope_id = env_or_default("KITE_PROJECT", "default");
    let mut session = env_or_default("KITE_SESSION_ID", "default");
    let mut agent = env_or_default("KITE_AGENT_NAME", "cli");
    let mut provider = env_or_default("KITE_PROVIDER", "local");
    let mut model = env_or_default("KITE_MODEL", "unknown");
    let mut tree_hash: Option<String> = None;
    let mut content_arg: Option<String> = None;
    let mut full = false;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--scope" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    scope_str = val.clone();
                }
            }
            "--scope-id" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    scope_id = val.clone();
                }
            }
            "--session" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    session = val.clone();
                }
            }
            "--agent" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    agent = val.clone();
                }
            }
            "--provider" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    provider = val.clone();
                }
            }
            "--model" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    model = val.clone();
                }
            }
            "--tree" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    tree_hash = Some(val.clone());
                }
            }
            "--content" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    content_arg = Some(val.clone());
                }
            }
            "--full" => full = true,
            flag if flag.starts_with('-') => {
                eprintln!("Unknown option: {flag}");
                return 2;
            }
            pos => {
                if key.is_none() {
                    key = Some(pos.to_string());
                }
            }
        }
        i += 1;
    }

    let Some(entry_key) = key else {
        eprintln!("Usage: kite ctx share <put|get> <key> [options]");
        return 2;
    };
    let scope = match ContextScope::parse(&scope_str) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("{err}");
            return 2;
        }
    };
    let engine = match open_engine() {
        Ok(e) => e,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };

    match op {
        "put" => {
            let body = match content_arg {
                Some(c) => c,
                None => match read_stdin_string(stdin_override) {
                    Ok(s) => s,
                    Err(err) => {
                        eprintln!("{err}");
                        return 1;
                    }
                },
            };
            match engine.share_put_with_telemetry(
                scope,
                &scope_id,
                &entry_key,
                &body,
                &agent,
                &provider,
                tree_hash.as_deref(),
                &session,
                &model,
            ) {
                Ok(entry) => {
                    println!(
                        "{}",
                        json!({
                            "ok": true,
                            "key": entry.key,
                            "scope": entry.scope,
                            "ccr_hash": entry.ccr_hash,
                            "original_tokens": entry.original_tokens,
                            "compressed_tokens": entry.compressed_tokens,
                            "savings_percent": entry.savings_percent()
                        })
                    );
                    0
                }
                Err(err) => {
                    eprintln!("{err}");
                    1
                }
            }
        }
        "get" => match engine.share_get_with_telemetry(
            scope,
            &scope_id,
            &entry_key,
            full,
            &session,
            &agent,
            &provider,
            &model,
        ) {
            Ok(Some(text)) => {
                println!("{text}");
                let _ = std::io::stdout().flush();
                0
            }
            Ok(None) => {
                eprintln!("Shared entry '{entry_key}' not found or expired");
                1
            }
            Err(err) => {
                eprintln!("{err}");
                1
            }
        },
        other => {
            eprintln!("Unknown share subcommand: {other}");
            2
        }
    }
}

fn cmd_stats(args: &[String]) -> i32 {
    let mut session: Option<String> = None;
    let mut as_json = false;
    let mut reset = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--session" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    session = Some(val.clone());
                }
            }
            "--json" => as_json = true,
            "--reset" => reset = true,
            "--project" => {
                // Kept for CLI ergonomics; ledger already operates across workspace sessions.
            }
            flag => {
                eprintln!("Unknown option: {flag}");
                return 2;
            }
        }
        i += 1;
    }

    let engine = match open_engine() {
        Ok(e) => e,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };

    if reset {
        if let Err(err) = engine.ledger().reset() {
            eprintln!("{err}");
            return 1;
        }
        if as_json {
            println!("{}", json!({ "ok": true, "reset": true }));
        } else {
            println!("Context ledger reset.");
        }
        return 0;
    }

    let mut snap = match engine.ledger().snapshot(session.as_deref()) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };
    let home = resolve_home_dir();
    let workspace = std::env::current_dir().unwrap_or_else(|_| home.clone());
    snap.discovery = discover_from_host(&home, &workspace);

    if as_json {
        println!("{}", serde_json::to_string_pretty(&snap).unwrap_or_default());
    } else {
        println!(
            "Kite Context Engine v{} — Lifetime saved: {} tokens ({:.1}%, ~${:.2}) across {} requests | Cache hits: {} ({:.1}%)",
            snap.engine_version,
            snap.lifetime.tokens_saved,
            snap.lifetime.savings_percent,
            snap.lifetime.estimated_usd_saved,
            snap.lifetime.requests,
            snap.lifetime.cache_hits,
            snap.lifetime.cache_hit_rate
        );
        if let Some(sid) = &snap.active_session_id {
            println!(
                "Session ({sid}): {} tokens saved ({:.1}%) across {} requests",
                snap.session.tokens_saved, snap.session.savings_percent, snap.session.requests
            );
        }
        for model in &snap.models {
            println!(
                "  model {}: {} tokens saved ({} reqs, ~${:.2})",
                model.model, model.tokens_saved, model.requests, model.savings_usd
            );
        }
    }
    let _ = std::io::stdout().flush();
    0
}

fn cmd_init(args: &[String]) -> i32 {
    let mut target_str = "all".to_string();
    let mut check_only = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--agent" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    target_str = val.clone();
                } else {
                    eprintln!("--agent requires a target name");
                    return 2;
                }
            }
            "--check" => check_only = true,
            flag => {
                eprintln!("Unknown option: {flag}");
                return 2;
            }
        }
        i += 1;
    }

    let target = match AgentTarget::parse(&target_str) {
        Ok(t) => t,
        Err(err) => {
            eprintln!("{err}");
            return 2;
        }
    };

    let home = resolve_home_dir();
    let workspace = std::env::current_dir().unwrap_or_else(|_| home.clone());
    match apply_agent_setup(target, &home, &workspace, check_only) {
        Ok(actions) => {
            println!("{}", serde_json::to_string_pretty(&actions).unwrap_or_default());
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn cmd_hook_rewrite(args: &[String], stdin_override: Option<&str>) -> i32 {
    let mut agent_hint: Option<AgentTarget> = None;
    let mut command_override: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--agent" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    agent_hint = AgentTarget::parse(val).ok();
                }
            }
            "--command" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    command_override = Some(val.clone());
                }
            }
            _ => {}
        }
        i += 1;
    }

    let input = if command_override.is_some() {
        String::new()
    } else {
        match read_stdin_string(stdin_override) {
            Ok(s) => s,
            Err(_) => return 0,
        }
    };

    if let Some(output) = evaluate_hook_input(agent_hint, &input, command_override.as_deref()) {
        println!("{output}");
        let _ = std::io::stdout().flush();
    }
    0
}

fn cmd_mcp_proxy(args: &[String]) -> i32 {
    let mut server_name = "stdio".to_string();
    let mut min_bytes = DEFAULT_MCP_MIN_BYTES;
    let mut session = env_or_default("KITE_SESSION_ID", "default");
    let mut agent = env_or_default("KITE_AGENT_NAME", "cli");
    let mut provider = env_or_default("KITE_PROVIDER", "local");
    let mut model = env_or_default("KITE_MODEL", "unknown");
    let mut command_args: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            command_args.extend(args[i + 1..].iter().cloned());
            break;
        }
        match arg {
            "--server" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    server_name = val.clone();
                }
            }
            "--min-bytes" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    if let Ok(parsed) = val.parse::<usize>() {
                        min_bytes = parsed;
                    }
                }
            }
            "--session" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    session = val.clone();
                }
            }
            "--agent" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    agent = val.clone();
                }
            }
            "--provider" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    provider = val.clone();
                }
            }
            "--model" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    model = val.clone();
                }
            }
            _ => {
                command_args.extend(args[i..].iter().cloned());
                break;
            }
        }
        i += 1;
    }

    if command_args.is_empty() {
        eprintln!("Usage: kite ctx mcp-proxy [--server <name>] [--min-bytes <n>] -- <command...>");
        return 2;
    }

    let engine = match open_engine() {
        Ok(e) => e,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };

    match run_mcp_stdio_proxy(
        &engine,
        &server_name,
        min_bytes,
        &command_args,
        &session,
        &agent,
        &provider,
        &model,
    ) {
        Ok(code) => code,
        Err(err) => {
            eprintln!("MCP proxy failed: {err}");
            1
        }
    }
}

fn cmd_discover(args: &[String]) -> i32 {
    let as_json = args.iter().any(|a| a == "--json");
    let home = resolve_home_dir();
    let workspace = std::env::current_dir().unwrap_or_else(|_| home.clone());
    let summary = discover_from_host(&home, &workspace);

    if as_json {
        println!("{}", serde_json::to_string_pretty(&summary).unwrap_or_default());
    } else {
        println!(
            "Kite Context Discovery — Scanned: {} commands | Optimized: {} | Missed: {} (~{} tokens)",
            summary.scanned_commands,
            summary.already_optimized,
            summary.missed_commands,
            summary.estimated_missed_tokens
        );
        for cand in &summary.top_candidates {
            println!(
                "  {} — {}x (~{} tokens)",
                cand.command, cand.count, cand.estimated_missed_tokens
            );
        }
    }
    let _ = std::io::stdout().flush();
    0
}

fn cmd_kv_check(args: &[String], stdin_override: Option<&str>) -> i32 {
    let mut file_path: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--file" {
            i += 1;
            file_path = args.get(i).cloned();
        }
        i += 1;
    }

    let text = match file_path {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("Failed to read {path}: {err}");
                return 1;
            }
        },
        None => match read_stdin_string(stdin_override) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("{err}");
                return 1;
            }
        },
    };

    let findings = scan_volatile_tokens(&text);
    println!("{}", serde_json::to_string_pretty(&findings).unwrap_or_default());
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "kite_{tag}_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn cli_read_exec_compress_share_and_stats_roundtrip() {
        let _guard = env_lock().lock().unwrap();
        let dir = TestDir::new("ctx_cli");
        let db = dir.path().join("cli_test.db");
        let sample = dir.path().join("code.rs");
        std::fs::write(
            &sample,
            "pub fn hello() -> usize {\n    42\n}\npub fn bye() -> usize {\n    99\n}\n",
        )
        .unwrap();

        let prev_db = std::env::var(kite_ctx::ENV_DB_PATH).ok();
        std::env::set_var(kite_ctx::ENV_DB_PATH, &db);

        let args_read: Vec<String> = vec![
            "read".into(),
            sample.to_string_lossy().into_owned(),
            "--mode".into(),
            "signatures".into(),
            "--session".into(),
            "cli-s1".into(),
        ];
        assert_eq!(run_ctx_cli_with_io(&args_read, None), 0);

        let args_share_put: Vec<String> = vec![
            "share".into(),
            "put".into(),
            "findings".into(),
            "--scope".into(),
            "session".into(),
            "--scope-id".into(),
            "cli-s1".into(),
            "--content".into(),
            "line 1\nline 1\nline 1\n".into(),
        ];
        assert_eq!(run_ctx_cli_with_io(&args_share_put, None), 0);

        let args_share_get: Vec<String> = vec![
            "share".into(),
            "get".into(),
            "findings".into(),
            "--scope".into(),
            "session".into(),
            "--scope-id".into(),
            "cli-s1".into(),
            "--full".into(),
        ];
        assert_eq!(run_ctx_cli_with_io(&args_share_get, None), 0);

        let args_stats: Vec<String> = vec!["stats".into(), "--json".into()];
        assert_eq!(run_ctx_cli_with_io(&args_stats, None), 0);

        let args_discover: Vec<String> = vec!["discover".into(), "--json".into()];
        assert_eq!(run_ctx_cli_with_io(&args_discover, None), 0);

        let args_hook_agy: Vec<String> =
            vec!["hook-rewrite".into(), "--agent".into(), "antigravity".into()];
        assert_eq!(
            run_ctx_cli_with_io(
                &args_hook_agy,
                Some(r#"{"toolCall":{"name":"run_command","args":{"CommandLine":"cargo test"}}}"#)
            ),
            0
        );

        let args_hook_oc: Vec<String> = vec![
            "hook-rewrite".into(),
            "--agent".into(),
            "opencode".into(),
            "--command".into(),
            "git status".into(),
        ];
        assert_eq!(run_ctx_cli_with_io(&args_hook_oc, None), 0);

        // Exec propagates child exit code faithfully
        let exec_cmd = if cfg!(windows) {
            vec!["exec".into(), "--".into(), "cmd".into(), "/C".into(), "exit 7".into()]
        } else {
            vec!["exec".into(), "--".into(), "sh".into(), "-c".into(), "exit 7".into()]
        };
        assert_eq!(run_ctx_cli_with_io(&exec_cmd, None), 7);

        if let Some(prev) = prev_db {
            std::env::set_var(kite_ctx::ENV_DB_PATH, prev);
        } else {
            std::env::remove_var(kite_ctx::ENV_DB_PATH);
        }
    }
}
