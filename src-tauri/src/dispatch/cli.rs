//! `kite dispatch` argument parsing, skill text, and loopback auth.
//! A missing app returns `runtime_offline` and does not start a server.

use super::address::is_caller_endpoint;
use super::policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
use super::port::Port;
use super::presence::PresenceState;
use super::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus};

fn compose_manual() -> String {
    let names = super::programs::lines();
    format!(
        "\
Kite Dispatch

Call this CLI only when KITE_DISPATCH=1 is set in the environment.
Outside that environment the CLI still works for a person.

Start another agent in one line:
  kite dispatch run <program> \"<task>\"
Example: kite dispatch run grok \"Look at the login bug.\"
The first word is the program. For a known agent, the remaining words are the task.
A word that is neither a known agent nor a role file starts that program. The remaining words are its arguments, and they are not typed as a second prompt.
An agent does not get a pane unless --pane. A person gets a pane unless --hidden. --hidden wins.
This text is the complete manual. Do not search the repository for these commands. Do not open a file to learn them. The task arrives when the process starts.
A parent hears when a child enters blocked, done, error, or gone.
Inbox files do not open panes. Delivery is this command.

Programs:
{names}

Commands:
  kite dispatch ls
  kite dispatch programs
  kite dispatch run <program> \"<task>\"
  kite dispatch run --via terminal --engine <engine> --name <alias> [--parent <address>] [--file <path>] [--pane] [--hidden]
  kite dispatch run --role <name> --name <alias> [--file <path>]
  kite dispatch send <address> \"<text>\" [--file <path>] [--if ready] [--force]
  kite dispatch wait <address> [--until idle,done,blocked] [--timeout <ms>] [--children all|any]
  kite dispatch read <address> [--lines 80]
  kite dispatch report --to <address> --body \"<text>\"
  kite dispatch kill <address>
  kite dispatch interrupt <address>
  kite dispatch keys <address> <key...>
  kite dispatch attach <address>
  kite dispatch skill

Inside a Kite terminal the command is `kite` on PATH.
`run` returns the address when the session exists. It does not wait for a pane and it does not start a second process for that pane.
An agent does not get a pane unless --pane. A person gets a pane unless --hidden. --hidden wins.
`ls` lines are `address`, then `alias:<name>` when set, then the engine when the run recorded one, then the state.
When `--parent` is omitted and KITE_ADDRESS is `session:`, `thread:`, or `alias:`, that address is the parent. The words human and agent are not parents.
`read` returns the screen text. It does not type.
`wait` blocks until the destination matches or the timeout elapses. The default timeout is 30000 ms. A timeout exits 1 with error timeout.
`interrupt` writes Ctrl+C and does not press Enter.
`keys` writes the named keys and presses Enter only when the key is enter.
`kill` ends that session and the children that do not outlive it.
`attach` asks the desktop to show that session.
`kill`, `interrupt`, `keys`, and `attach` work while the destination is working or blocked.

Envelope:
[kite from=\"<alias-or-address>\"]
This is another agent, not the person.
To reply: kite dispatch send <from> \"<reply>\"
Irreversible and privileged actions still wait for the person.
BODY:
<text>

Force rule: only a human caller may set force. An agent or a script that sets force receives force_forbidden and nothing is written. Do not answer a destination blocked with kind permission. Irreversible and privileged actions still wait for the person.

Ready means idle or done. working is queued. blocked is rejected. gone is destination_gone.
A stall means the text was submitted and presence did not change. Read before sending the same body again. The service does not send a second Enter.
"
    )
}

fn compose_skill() -> String {
    let manual = manual_text();
    format!(
        "\
---
name: kite-dispatch
description: \"Trigger: kite dispatch, spawn agent, KITE_DISPATCH. Use the Kite Dispatch CLI to start, send, wait, and read other agents.\"
---

{manual}"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Ls,
    Programs,
    Skill,
    Run {
        via: Family,
        engine: Option<String>,
        name: Option<String>,
        parent: Option<String>,
        outlive: bool,
        /// Set only by `--role`. A positional word is `program`, not a role.
        role: Option<String>,
        explicit_role: bool,
        file: Option<String>,
        task: Option<String>,
        hidden: bool,
        pane: bool,
        program: Option<String>,
        /// Remaining words after the program. Each word is one argument.
        words: Vec<String>,
    },
    Kill {
        address: String,
    },
    Interrupt {
        address: String,
    },
    Keys {
        address: String,
        keys: Vec<String>,
    },
    Attach {
        address: String,
    },
    Send {
        address: String,
        body: Option<String>,
        file: Option<String>,
        force: bool,
        only_ready: bool,
        allow_queue: bool,
    },
    Wait {
        address: Option<String>,
        until: Vec<PresenceState>,
        children: Option<ChildrenMode>,
        timeout_ms: u64,
    },
    Read {
        address: String,
        lines: usize,
    },
    Report {
        to: Option<String>,
        from: Option<String>,
        body: Option<String>,
        file: Option<String>,
    },
}

pub fn parse_args(args: &[String]) -> Result<Command, DispatchError> {
    let mut items = args.iter().map(String::as_str).peekable();
    if items.peek() == Some(&"kite") {
        items.next();
    }
    if items.peek() == Some(&"dispatch") {
        items.next();
    }
    let sub = items.next().ok_or(DispatchError::BadArgs)?;
    match sub {
        "ls" => Ok(Command::Ls),
        "programs" => Ok(Command::Programs),
        "skill" => Ok(Command::Skill),
        "run" => parse_run(&mut items),
        "send" => parse_send(&mut items),
        "wait" => parse_wait(&mut items),
        "read" => parse_read(&mut items),
        "report" => parse_report(&mut items),
        "kill" => parse_address_command(&mut items, |address| Command::Kill { address }),
        "interrupt" => parse_address_command(&mut items, |address| Command::Interrupt { address }),
        "attach" => parse_address_command(&mut items, |address| Command::Attach { address }),
        "keys" => parse_keys(&mut items),
        _ => Err(DispatchError::BadArgs),
    }
}

pub fn blocking_wait_ms(args: &[String]) -> Option<u64> {
    match parse_args(args) {
        Ok(Command::Wait { timeout_ms, .. }) => Some(timeout_ms),
        _ => None,
    }
}

fn parse_run<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let mut via = Family::Terminal;
    let mut engine = None;
    let mut name = None;
    let mut parent = None;
    let mut outlive = false;
    let mut role = None;
    let mut explicit_role = false;
    let mut file = None;
    let mut hidden = false;
    let mut pane = false;
    let mut program = None;
    let mut positionals: Vec<String> = Vec::new();
    while let Some(flag) = items.next() {
        match flag {
            "--via" => {
                via = match items.next() {
                    Some("terminal") => Family::Terminal,
                    Some("thread") => Family::Thread,
                    _ => return Err(DispatchError::BadArgs),
                }
            }
            "--engine" => engine = Some(need(items)?),
            "--name" => name = Some(need(items)?),
            "--parent" => parent = Some(need(items)?),
            "--role" => {
                role = Some(need(items)?);
                explicit_role = true;
            }
            "--file" => file = Some(need(items)?),
            "--outlive" => outlive = true,
            "--hidden" => hidden = true,
            "--pane" => pane = true,
            "--" => positionals.extend(items.by_ref().map(|part| part.to_string())),
            other if other.starts_with('-') => return Err(DispatchError::BadArgs),
            other => positionals.push(other.to_string()),
        }
    }
    // A program word is consumed only when neither --role nor --engine is set.
    if !explicit_role && engine.is_none() && !positionals.is_empty() {
        let word = positionals.remove(0);
        if name.is_none() {
            name = Some(word.clone());
        }
        program = Some(word);
    }
    let words = positionals.clone();
    let task = if positionals.is_empty() {
        None
    } else {
        Some(positionals.join(" "))
    };
    Ok(Command::Run {
        via,
        engine,
        name,
        parent,
        outlive,
        role,
        explicit_role,
        file,
        task,
        hidden,
        pane,
        program,
        words,
    })
}

fn parse_address_command<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
    build: impl FnOnce(String) -> Command,
) -> Result<Command, DispatchError> {
    let address = items.next().ok_or(DispatchError::BadArgs)?.to_string();
    if address.starts_with("--") || items.next().is_some() {
        return Err(DispatchError::BadArgs);
    }
    Ok(build(address))
}

fn parse_keys<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let address = items.next().ok_or(DispatchError::BadArgs)?.to_string();
    if address.starts_with("--") {
        return Err(DispatchError::BadArgs);
    }
    let keys: Vec<String> = items.map(|part| part.to_string()).collect();
    if keys.is_empty() {
        return Err(DispatchError::BadArgs);
    }
    Ok(Command::Keys { address, keys })
}

fn parse_send<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let address = items.next().ok_or(DispatchError::BadArgs)?.to_string();
    let mut body = None;
    let mut file = None;
    let mut force = false;
    let mut only_ready = false;
    let mut allow_queue = true;
    while let Some(next) = items.next() {
        match next {
            "--file" => file = Some(need(items)?),
            "--force" => force = true,
            "--if" => {
                if items.next() != Some("ready") {
                    return Err(DispatchError::BadArgs);
                }
                only_ready = true;
                allow_queue = false;
            }
            "--queue" => allow_queue = true,
            "--no-queue" => allow_queue = false,
            other if body.is_none() && !other.starts_with("--") => body = Some(other.to_string()),
            _ => return Err(DispatchError::BadArgs),
        }
    }
    if body.is_none() && file.is_none() {
        return Err(DispatchError::BadArgs);
    }
    Ok(Command::Send {
        address,
        body,
        file,
        force,
        only_ready,
        allow_queue,
    })
}

fn parse_wait<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let mut address = None;
    let mut until = Vec::new();
    let mut children = None;
    let mut timeout_ms = 30_000;
    while let Some(next) = items.next() {
        match next {
            "--until" => {
                let raw = need(items)?;
                until = raw
                    .split(',')
                    .map(|part| PresenceState::parse(part.trim()).ok_or(DispatchError::BadArgs))
                    .collect::<Result<Vec<_>, _>>()?;
            }
            "--timeout" => {
                timeout_ms = need(items)?.parse().map_err(|_| DispatchError::BadArgs)?;
            }
            "--children" => {
                children = Some(match items.next() {
                    Some("all") => ChildrenMode::All,
                    Some("any") => ChildrenMode::Any,
                    _ => return Err(DispatchError::BadArgs),
                });
            }
            other if address.is_none() && !other.starts_with("--") => address = Some(other.to_string()),
            _ => return Err(DispatchError::BadArgs),
        }
    }
    Ok(Command::Wait {
        address,
        until,
        children,
        timeout_ms,
    })
}

fn parse_read<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let address = items.next().ok_or(DispatchError::BadArgs)?.to_string();
    let mut lines = 80;
    while let Some(next) = items.next() {
        match next {
            "--lines" => lines = need(items)?.parse().map_err(|_| DispatchError::BadArgs)?,
            _ => return Err(DispatchError::BadArgs),
        }
    }
    Ok(Command::Read { address, lines })
}

fn parse_report<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let mut to = None;
    let mut from = None;
    let mut body = None;
    let mut file = None;
    while let Some(next) = items.next() {
        match next {
            "--to" => to = Some(need(items)?),
            "--from" => from = Some(need(items)?),
            "--body" => body = Some(need(items)?),
            "--file" => file = Some(need(items)?),
            _ => return Err(DispatchError::BadArgs),
        }
    }
    if body.is_none() && file.is_none() {
        return Err(DispatchError::BadArgs);
    }
    Ok(Command::Report { to, from, body, file })
}

fn need<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<String, DispatchError> {
    match items.next() {
        Some(value) if !value.starts_with("--") => Ok(value.to_string()),
        _ => Err(DispatchError::BadArgs),
    }
}

pub fn manual_text() -> &'static str {
    static MANUAL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    MANUAL.get_or_init(compose_manual).as_str()
}

pub fn skill_text() -> &'static str {
    static TEXT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TEXT.get_or_init(compose_skill).as_str()
}

/// Strips a leading YAML frontmatter block (`---\n...\n---\n`) when present so
/// CLI flags like `--system-prompt-override` never receive a leading hyphen token.
pub fn strip_skill_frontmatter(text: &str) -> &str {
    let trimmed = text.trim_start();
    if let Some(after_open) = trimmed
        .strip_prefix("---\r\n")
        .or_else(|| trimmed.strip_prefix("---\n"))
    {
        if let Some(close_idx) = after_open.find("\n---") {
            let rest = &after_open[close_idx + "\n---".len()..];
            if let Some(body) = rest
                .strip_prefix("\r\n")
                .or_else(|| rest.strip_prefix('\n'))
            {
                return body.trim_start();
            }
        }
    }
    trimmed
}

pub fn check_token(expected: &str, presented: &str) -> bool {
    !expected.is_empty() && expected == presented
}

pub fn offline_receipt(id: &str, op: &str) -> Receipt {
    Receipt::new(
        id,
        op,
        ReceiptStatus::Failed,
        "",
        false,
        None,
        Some(DispatchError::RuntimeOffline.code().into()),
    )
}

pub fn bad_token_receipt(id: &str, op: &str) -> Receipt {
    Receipt::new(
        id,
        op,
        ReceiptStatus::Rejected,
        "",
        false,
        None,
        Some("bad_token".into()),
    )
}

fn inherited_parent(explicit: Option<&String>, from: &str) -> Option<String> {
    if let Some(parent) = explicit.filter(|value| !value.is_empty()) {
        return Some(parent.clone());
    }
    if is_caller_endpoint(from) {
        Some(from.to_string())
    } else {
        None
    }
}

/// Writes `kite.cmd` next to the app data so a terminal can call `kite` with no banner.
pub fn install_kite_shim() -> std::path::PathBuf {
    let dir = crate::persist::roaming_app_dir().join("bin");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(exe) = std::env::current_exe() {
        let script = format!("@echo off\r\n\"{}\" %*\r\n", exe.display());
        let _ = std::fs::write(dir.join("kite.cmd"), script);
    }
    dir
}

fn user_home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

fn existing_skill_roots(home: &std::path::Path) -> Vec<std::path::PathBuf> {
    [
        home.join(".claude").join("skills"),
        home.join(".grok").join("skills"),
        home.join(".codex").join("skills"),
        home.join(".cursor").join("skills"),
        home.join(".gemini").join("antigravity-cli").join("skills"),
        home.join(".gemini").join("antigravity").join("skills"),
        home.join(".gemini").join("skills"),
        home.join(".agents").join("skills"),
        home.join(".config").join("agents").join("skills"),
        home.join(".config").join("opencode").join("skills"),
        home.join(".copilot").join("skills"),
        home.join(".kimi").join("skills"),
        home.join(".amp").join("skills"),
        home.join(".config").join("amp").join("skills"),
        home.join(".factory").join("skills"),
        home.join(".droid").join("skills"),
    ]
    .into_iter()
    .filter(|root| root.is_dir())
    .collect()
}

/// Copies the manual into each existing user skill root as `kite-dispatch/SKILL.md`.
/// A missing root is left untouched.
pub(crate) fn copy_skill_into_existing_roots(home: &std::path::Path, text: &str) {
    for root in existing_skill_roots(home) {
        let dest = root.join("kite-dispatch");
        if std::fs::create_dir_all(&dest).is_ok() {
            let _ = std::fs::write(dest.join("SKILL.md"), text);
        }
    }
}

/// Writes the same manual `kite dispatch skill` prints, copies it into existing
/// agent skill directories, and returns the app-data path.
pub fn install_dispatch_skill() -> std::path::PathBuf {
    let dir = crate::persist::roaming_app_dir().join("dispatch");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("SKILL.md");
    let text = skill_text();
    let _ = std::fs::write(&path, text);
    if let Some(home) = user_home_dir() {
        copy_skill_into_existing_roots(&home, text);
    }
    path
}

/// `--hidden` wins. Otherwise `--pane` or a human caller asks for a pane.
fn show_pane(hidden: bool, pane: bool, caller: Caller) -> bool {
    if hidden {
        return false;
    }
    if pane {
        return true;
    }
    caller == Caller::Human
}

fn combine_task(file_text: Option<String>, words: Option<String>) -> Option<String> {
    match (file_text, words.filter(|value| !value.is_empty())) {
        (Some(mut file), Some(words)) => {
            file.push_str("\n\n");
            file.push_str(&words);
            Some(file)
        }
        (Some(file), None) => Some(file),
        (None, Some(words)) => Some(words),
        (None, None) => None,
    }
}

pub struct ExecContext<'a> {
    pub id: &'a str,
    pub caller: Caller,
    pub from: &'a str,
    pub now_ms: u64,
    pub config_dir: Option<&'a std::path::Path>,
    pub workspace: Option<&'a std::path::Path>,
    pub mounted: bool,
}

pub fn execute<P: Port>(
    service: &mut Service<P>,
    command: &Command,
    ctx: &ExecContext<'_>,
) -> Result<Receipt, DispatchError> {
    match command {
        Command::Skill => Err(DispatchError::BadArgs),
        Command::Ls => {
            let mut receipt = Receipt::new(
                ctx.id,
                "ls",
                ReceiptStatus::Settled,
                "",
                false,
                None,
                None,
            );
            receipt.text = Some(service.ls().join("\n"));
            Ok(receipt)
        }
        Command::Programs => {
            let mut receipt = Receipt::new(
                ctx.id,
                "programs",
                ReceiptStatus::Settled,
                "",
                false,
                None,
                None,
            );
            receipt.text = Some(super::programs::lines());
            Ok(receipt)
        }
        Command::Run {
            via,
            engine,
            name,
            parent,
            outlive,
            role,
            explicit_role,
            file,
            task,
            hidden,
            pane,
            program,
            words,
        } => {
            let file_text = match (file, ctx.workspace) {
                (Some(path), Some(workspace)) => {
                    Some(super::files::read_workspace_file(workspace, path)?)
                }
                (Some(_), None) => return Err(DispatchError::PathRejected),
                _ => None,
            };
            let task = combine_task(file_text, task.clone());
            let parent = inherited_parent(parent.as_ref(), ctx.from);
            let cwd = ctx.workspace.map(|p| p.display().to_string());
            let hide_pane = !show_pane(*hidden, *pane, ctx.caller);
            if *explicit_role {
                let role_name = role.as_deref().ok_or(DispatchError::BadArgs)?;
                let dir = ctx.config_dir.ok_or(DispatchError::RoleNotFound)?;
                return Ok(service.run_role(
                    ctx.id,
                    dir,
                    role_name,
                    task,
                    parent.as_deref(),
                    ctx.caller,
                    ctx.now_ms,
                    name.clone(),
                    *outlive,
                    hide_pane,
                    cwd,
                ));
            }
            if let Some(word) = program {
                if let Some(dir) = ctx.config_dir {
                    if super::address::is_alias_name(word) {
                        let path = super::role::roles_dir(dir).join(format!("{word}.md"));
                        if path.is_file() {
                            return Ok(service.run_role(
                                ctx.id,
                                dir,
                                word,
                                task,
                                parent.as_deref(),
                                ctx.caller,
                                ctx.now_ms,
                                name.clone(),
                                *outlive,
                                hide_pane,
                                cwd,
                            ));
                        }
                    }
                }
                let Some(engine_name) = super::programs::canonical(word) else {
                    let mut argv = vec![word.clone()];
                    if !words.is_empty() {
                        argv.extend(words.clone());
                    } else if let Some(rest) = task.clone().filter(|text| !text.is_empty()) {
                        argv.push(rest);
                    }
                    let alias = name.clone().filter(|n| super::address::is_alias_name(n));
                    return Ok(service.run(RunInput {
                        id: ctx.id.to_string(),
                        via: *via,
                        engine: Some(word.clone()),
                        command: Some(word.clone()),
                        name: alias,
                        parent,
                        outlive: *outlive,
                        role: None,
                        role_missing: false,
                        task: None,
                        caller: ctx.caller,
                        cwd,
                        now_ms: ctx.now_ms,
                        hidden: hide_pane,
                        argv,
                    }));
                };
                return Ok(service.run(RunInput {
                    id: ctx.id.to_string(),
                    via: *via,
                    engine: Some(engine_name.to_string()),
                    command: None,
                    name: name.clone(),
                    parent,
                    outlive: *outlive,
                    role: None,
                    role_missing: false,
                    task,
                    caller: ctx.caller,
                    cwd,
                    now_ms: ctx.now_ms,
                    hidden: hide_pane,
                    argv: Vec::new(),
                }));
            }
            Ok(service.run(RunInput {
                id: ctx.id.to_string(),
                via: *via,
                engine: engine.clone(),
                command: None,
                name: name.clone(),
                parent,
                outlive: *outlive,
                role: None,
                role_missing: false,
                task,
                caller: ctx.caller,
                cwd,
                now_ms: ctx.now_ms,
                hidden: hide_pane,
                argv: Vec::new(),
            }))
        }
        Command::Send {
            address,
            body,
            file,
            force,
            only_ready,
            allow_queue,
        } => {
            let input = SendInput {
                id: ctx.id.to_string(),
                address: address.clone(),
                body: body.clone().unwrap_or_default(),
                caller: ctx.caller,
                force: *force,
                allow_queue: *allow_queue,
                only_ready: *only_ready,
                wrap: None,
                from: ctx.from.to_string(),
                mounted: ctx.mounted,
                source: None,
                label: None,
                now_ms: ctx.now_ms,
                profile_id: None,
                system: false,
                presentation_emitted: false,
            };
            if let Some(path) = file {
                let workspace = ctx.workspace.ok_or(DispatchError::PathRejected)?;
                Ok(service.send_file(input, workspace, path))
            } else {
                Ok(service.send(input))
            }
        }
        Command::Wait {
            address,
            until,
            children,
            timeout_ms,
        } => Ok(service.wait(WaitInput {
            id: ctx.id.to_string(),
            address: address.clone().or_else(|| {
                if ctx.from.is_empty() {
                    None
                } else {
                    Some(ctx.from.to_string())
                }
            }),
            until: until.clone(),
            children: *children,
            timeout_ms: *timeout_ms,
            started_ms: ctx.now_ms,
            now_ms: ctx.now_ms,
        })),
        Command::Read { address, lines } => Ok(service.read(ctx.id, address, *lines)),
        Command::Report {
            to,
            from,
            body,
            file,
        } => {
            let text = if let Some(path) = file {
                let workspace = ctx.workspace.ok_or(DispatchError::PathRejected)?;
                super::files::read_workspace_file(workspace, path)?
            } else {
                body.clone().unwrap_or_default()
            };
            Ok(service.report(
                ctx.id,
                from.as_deref().or(Some(ctx.from).filter(|s| !s.is_empty())),
                to.as_deref(),
                &text,
                ctx.caller,
                ctx.now_ms,
            ))
        }
        Command::Kill { address } => Ok(service.kill(ctx.id, address)),
        Command::Interrupt { address } => Ok(service.interrupt(ctx.id, address)),
        Command::Keys { address, keys } => Ok(service.keys(ctx.id, address, keys)),
        Command::Attach { address } => Ok(service.show(ctx.id, address)),
    }
}

pub fn render_result(result: Result<Receipt, DispatchError>, id: &str, op: &str) -> (i32, String) {
    match result {
        Ok(receipt) => {
            let code = exit_code(&receipt);
            let json = serde_json::to_string(&receipt).unwrap_or_else(|_| "{}".into());
            (code, json)
        }
        Err(DispatchError::BadArgs) => (2, bad_args_line(id, op)),
        Err(err) => {
            let receipt = Receipt::new(
                id,
                op,
                ReceiptStatus::Rejected,
                "",
                false,
                None,
                Some(err.code().into()),
            );
            (exit_code(&receipt), serde_json::to_string(&receipt).unwrap_or_default())
        }
    }
}

fn bad_args_line(id: &str, op: &str) -> String {
    let receipt = Receipt::new(
        id,
        op,
        ReceiptStatus::Failed,
        "",
        false,
        None,
        Some(DispatchError::BadArgs.code().into()),
    );
    serde_json::to_string(&receipt).unwrap_or_default()
}

/// Client helper: if the app is not reachable, return runtime_offline and do not spawn anything.
pub fn client_when_unreachable(spawned: &mut u32) -> (i32, Receipt) {
    let _ = spawned;
    let receipt = offline_receipt("offline", "send");
    (exit_code(&receipt), receipt)
}

#[cfg(test)]
#[path = "cli_tests.rs"]
mod tests;
