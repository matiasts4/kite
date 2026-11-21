use crate::dispatch::address::is_caller_endpoint;
use crate::dispatch::policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
use crate::dispatch::port::Port;
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus};
use super::*;

pub(super) fn unknown_provider_message(raw: &str) -> String {
    format!(
        "Unknown thread provider `{raw}`. Allowed thread providers: antigravity, grok, codex, claude, cursor, opencode, gemini (aliases: agy, claude-code, open-code, cursor-agent). Run `kite dispatch providers` to inspect connected providers."
    )
}

pub(super) fn bad_args(detail: impl Into<String>) -> (DispatchError, String) {
    (DispatchError::BadArgs, detail.into())
}

pub fn parse_args(args: &[String]) -> Result<Command, DispatchError> {
    parse_args_detailed(args).map_err(|(err, _)| err)
}

pub fn parse_args_detailed(args: &[String]) -> Result<Command, (DispatchError, String)> {
    let mut items = args.iter().map(String::as_str).peekable();
    if items.peek() == Some(&"kite") {
        items.next();
    }
    if items.peek() == Some(&"dispatch") {
        items.next();
    }
    let sub = items
        .next()
        .ok_or_else(|| bad_args("Missing dispatch subcommand. Run `kite dispatch skill` for commands."))?;
    match sub {
        "ls" => {
            if let Some(extra) = items.next() {
                return Err(bad_args(format!("Unexpected argument `{extra}` for `ls`.")));
            }
            Ok(Command::Ls)
        }
        "programs" => {
            if let Some(extra) = items.next() {
                return Err(bad_args(format!(
                    "Unexpected argument `{extra}` for `programs`."
                )));
            }
            Ok(Command::Programs)
        }
        "providers" => {
            let mut refresh = false;
            while let Some(next) = items.next() {
                match next {
                    "--refresh" => refresh = true,
                    other => {
                        return Err(bad_args(format!(
                            "Unknown flag `{other}` for `providers`. Supported: --refresh."
                        )))
                    }
                }
            }
            Ok(Command::Providers { refresh })
        }
        "models" => {
            let mut provider = None;
            let mut refresh = false;
            while let Some(next) = items.next() {
                let (flag, inline_val) = split_flag(next);
                match flag {
                    "--refresh" if inline_val.is_none() => refresh = true,
                    "--provider" => {
                        let raw = need_flag_detailed(&mut items, "--provider", inline_val)?;
                        let canon = canonical_thread_provider(&raw)
                            .ok_or_else(|| bad_args(unknown_provider_message(&raw)))?;
                        provider = Some(canon.to_string());
                    }
                    _ if next.starts_with('-') => {
                        return Err(bad_args(format!(
                            "Unknown flag `{next}` for `models`. Supported: --provider <name>, --refresh."
                        )))
                    }
                    other if provider.is_none() => {
                        let canon = canonical_thread_provider(other)
                            .ok_or_else(|| bad_args(unknown_provider_message(other)))?;
                        provider = Some(canon.to_string());
                    }
                    other => {
                        return Err(bad_args(format!(
                            "Unexpected argument `{other}` for `models`."
                        )))
                    }
                }
            }
            Ok(Command::Models { provider, refresh })
        }
        "skill" | "help" | "--help" | "-h" => {
            for next in items {
                if next.starts_with('-') {
                    return Err(bad_args(format!(
                        "Unknown flag `{next}` for `{sub}`. Run `kite dispatch skill` with no flags."
                    )));
                }
            }
            Ok(Command::Skill)
        }
        "run" => parse_run_detailed(&mut items),
        "send" => parse_send(&mut items).map_err(|e| (e, "Invalid `send` arguments.".into())),
        "wait" => parse_wait(&mut items).map_err(|e| (e, "Invalid `wait` arguments.".into())),
        "read" => parse_read(&mut items).map_err(|e| (e, "Invalid `read` arguments.".into())),
        "report" => parse_report(&mut items).map_err(|e| (e, "Invalid `report` arguments.".into())),
        "swarm" => parse_swarm_detailed(&mut items),
        "kill" => parse_address_command(&mut items, |address| Command::Kill { address })
            .map_err(|e| (e, "Invalid `kill` arguments.".into())),
        "interrupt" => parse_address_command(&mut items, |address| Command::Interrupt { address })
            .map_err(|e| (e, "Invalid `interrupt` arguments.".into())),
        "attach" => parse_address_command(&mut items, |address| Command::Attach { address })
            .map_err(|e| (e, "Invalid `attach` arguments.".into())),
        "keys" => parse_keys(&mut items).map_err(|e| (e, "Invalid `keys` arguments.".into())),
        other => Err(bad_args(format!(
            "Unknown dispatch subcommand `{other}`. Allowed subcommands: ls, programs, providers, models, run, send, wait, read, report, swarm, kill, interrupt, keys, attach, skill."
        ))),
    }
}

pub fn blocking_wait_ms(args: &[String]) -> Option<u64> {
    match parse_args(args) {
        Ok(Command::Wait { timeout_ms, .. }) => Some(timeout_ms),
        _ => None,
    }
}

pub fn blocking_run_wait_ms(args: &[String]) -> Option<u64> {
    match parse_args(args) {
        Ok(Command::Run {
            wait: true,
            timeout_ms,
            ..
        }) => Some(timeout_ms.unwrap_or(300_000)),
        _ => None,
    }
}

pub fn blocking_send_wait_ms(args: &[String]) -> Option<u64> {
    match parse_args(args) {
        Ok(Command::Send {
            wait: true,
            timeout_ms,
            ..
        }) => Some(timeout_ms.unwrap_or(300_000)),
        _ => None,
    }
}

pub fn blocking_swarm_wait_ms(args: &[String]) -> Option<u64> {
    match parse_args(args) {
        Ok(Command::Swarm(SwarmCommand::Wait { timeout_ms, .. })) => Some(timeout_ms),
        _ => None,
    }
}

pub fn canonical_thread_provider(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "antigravity" | "agy" => Some("antigravity"),
        "claude" | "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "cursor" | "cursor-agent" => Some("cursor"),
        "gemini" => Some("gemini"),
        "grok" => Some("grok"),
        "opencode" | "open-code" => Some("opencode"),
        _ => None,
    }
}

pub fn normalize_workspace_mode(raw: &str) -> Option<String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "inherit" => Some("inherit".to_string()),
        "share" | "worktree" => Some("share".to_string()),
        "branch" => Some("branch".to_string()),
        _ => None,
    }
}

pub fn normalize_effort(raw: &str) -> Option<String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "minimal" => Some("minimal".to_string()),
        "low" => Some("low".to_string()),
        "medium" => Some("medium".to_string()),
        "high" => Some("high".to_string()),
        "xhigh" => Some("xhigh".to_string()),
        "max" => Some("max".to_string()),
        "ultra" => Some("ultra".to_string()),
        _ => None,
    }
}

pub(super) fn split_flag(token: &str) -> (&str, Option<&str>) {
    if token.starts_with("--") {
        if let Some((flag, val)) = token.split_once('=') {
            return (flag, Some(val));
        }
    }
    (token, None)
}

pub(super) fn need_detailed<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
    flag: &str,
) -> Result<String, (DispatchError, String)> {
    match items.next() {
        Some(value) if !value.starts_with('-') => Ok(value.to_string()),
        _ => Err(bad_args(format!("Missing value for flag `{flag}`."))),
    }
}

pub(super) fn need_flag_detailed<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
    flag: &str,
    inline_val: Option<&str>,
) -> Result<String, (DispatchError, String)> {
    if let Some(val) = inline_val {
        return if val.is_empty() {
            Err(bad_args(format!("Missing value for flag `{flag}`.")))
        } else {
            Ok(val.to_string())
        };
    }
    need_detailed(items, flag)
}

pub(super) fn parse_run_detailed<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, (DispatchError, String)> {
    let mut via = Family::Terminal;
    let mut explicit_via = false;
    let mut engine = None;
    let mut provider = None;
    let mut model = None;
    let mut effort = None;
    let mut workspace = None;
    let mut override_stack = false;
    let mut name = None;
    let mut explicit_name = false;
    let mut parent = None;
    let mut outlive = false;
    let mut role = None;
    let mut explicit_role = false;
    let mut file = None;
    let mut tasks: Vec<String> = Vec::new();
    let mut count: Option<usize> = None;
    let mut wait = false;
    let mut timeout_ms = None;
    let mut hidden = false;
    let mut pane = false;
    let mut program = None;
    let mut positionals: Vec<String> = Vec::new();
    while let Some(raw_tok) = items.next() {
        let (flag, inline_val) = split_flag(raw_tok);
        match flag {
            "--via" => {
                let raw_val = need_flag_detailed(items, "--via", inline_val)?;
                via = match raw_val.as_str() {
                    "terminal" => Family::Terminal,
                    "thread" => Family::Thread,
                    other => {
                        return Err(bad_args(format!(
                            "Invalid `--via` value `{other}` (expected `thread` or `terminal`)."
                        )))
                    }
                };
                explicit_via = true;
            }
            "--engine" => engine = Some(need_flag_detailed(items, "--engine", inline_val)?),
            "--provider" => {
                let raw = need_flag_detailed(items, "--provider", inline_val)?;
                provider = Some(
                    canonical_thread_provider(&raw)
                        .ok_or_else(|| bad_args(unknown_provider_message(&raw)))?
                        .to_string(),
                );
            }
            "--model" => model = Some(need_flag_detailed(items, "--model", inline_val)?),
            "--effort" => {
                let raw = need_flag_detailed(items, "--effort", inline_val)?;
                effort = Some(normalize_effort(&raw).ok_or_else(|| {
                    bad_args(format!(
                        "Invalid `--effort` value `{raw}`. Allowed: minimal, low, medium, high, xhigh, max, ultra."
                    ))
                })?);
            }
            "--workspace" => {
                let raw = need_flag_detailed(items, "--workspace", inline_val)?;
                workspace = Some(normalize_workspace_mode(&raw).ok_or_else(|| {
                    bad_args(format!(
                        "Invalid `--workspace` mode `{raw}`. Allowed: inherit, share, branch."
                    ))
                })?);
            }
            "--override-stack" if inline_val.is_none() => override_stack = true,
            "--name" => {
                name = Some(need_flag_detailed(items, "--name", inline_val)?);
                explicit_name = true;
            }
            "--parent" => parent = Some(need_flag_detailed(items, "--parent", inline_val)?),
            "--role" => {
                role = Some(need_flag_detailed(items, "--role", inline_val)?);
                explicit_role = true;
            }
            "--file" => file = Some(need_flag_detailed(items, "--file", inline_val)?),
            "--task" => {
                let raw = need_flag_detailed(items, "--task", inline_val)?;
                if raw.trim().is_empty() {
                    return Err(bad_args("`--task` value cannot be empty."));
                }
                tasks.push(raw);
            }
            "--count" | "-n" => {
                let raw = need_flag_detailed(items, flag, inline_val)?;
                let parsed: usize = raw
                    .parse()
                    .map_err(|_| bad_args(format!("Invalid `{flag}` integer `{raw}` (expected 1..=8).")))?;
                if !(1..=8).contains(&parsed) {
                    return Err(bad_args(format!(
                        "Invalid `{flag}` value `{parsed}` (expected 1..=8)."
                    )));
                }
                count = Some(parsed);
            }
            "--wait" if inline_val.is_none() => wait = true,
            "--timeout-ms" | "--timeout" => {
                let raw = need_flag_detailed(items, flag, inline_val)?;
                timeout_ms = Some(
                    raw.parse()
                        .map_err(|_| bad_args(format!("Invalid `{flag}` integer `{raw}`.")))?,
                );
            }
            "--outlive" if inline_val.is_none() => outlive = true,
            "--hidden" if inline_val.is_none() => hidden = true,
            "--pane" if inline_val.is_none() => pane = true,
            "--" if inline_val.is_none() => {
                positionals.extend(items.by_ref().map(|part| part.to_string()))
            }
            _ if raw_tok.starts_with('-') => {
                return Err(bad_args(format!(
                    "Unknown flag `{raw_tok}` for `run`. Run `kite dispatch skill` for valid flags."
                )))
            }
            other => positionals.push(other.to_string()),
        }
    }
    if explicit_via && via == Family::Terminal && (provider.is_some() || workspace.is_some()) {
        return Err(bad_args(
            "`--provider` and `--workspace` require `--via thread` (not `--via terminal`).",
        ));
    }
    if explicit_via && via == Family::Thread {
        if !explicit_role && provider.is_none() && engine.is_none() && !positionals.is_empty() {
            if let Some(canon) = canonical_thread_provider(&positionals[0]) {
                positionals.remove(0);
                provider = Some(canon.to_string());
            }
        }
    } else if !explicit_role && engine.is_none() && !positionals.is_empty() {
        // A program word is consumed only when neither --role nor --engine is set.
        let word = positionals.remove(0);
        if name.is_none() {
            name = Some(word.clone());
        }
        program = Some(word);
    }
    let words = positionals.clone();
    let mut task = if positionals.is_empty() {
        None
    } else {
        Some(positionals.join(" "))
    };
    if !tasks.is_empty() && task.is_none() {
        task = Some(tasks[0].clone());
    }
    Ok(Command::Run {
        via,
        explicit_via,
        engine,
        provider,
        model,
        effort,
        workspace,
        override_stack,
        name,
        explicit_name,
        parent,
        outlive,
        role,
        explicit_role,
        file,
        task,
        tasks,
        count,
        wait,
        timeout_ms,
        hidden,
        pane,
        program,
        words,
    })
}

