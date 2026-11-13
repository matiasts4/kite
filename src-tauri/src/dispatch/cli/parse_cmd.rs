use crate::dispatch::address::is_caller_endpoint;
use crate::dispatch::policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
use crate::dispatch::port::Port;
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus};
use super::*;

pub(super) fn parse_address_command<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
    build: impl FnOnce(String) -> Command,
) -> Result<Command, DispatchError> {
    let address = items.next().ok_or(DispatchError::BadArgs)?.to_string();
    if address.starts_with('-') || items.next().is_some() {
        return Err(DispatchError::BadArgs);
    }
    Ok(build(address))
}

pub(super) fn parse_keys<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let address = items.next().ok_or(DispatchError::BadArgs)?.to_string();
    if address.starts_with('-') {
        return Err(DispatchError::BadArgs);
    }
    let keys: Vec<String> = items.map(|part| part.to_string()).collect();
    if keys.is_empty() {
        return Err(DispatchError::BadArgs);
    }
    Ok(Command::Keys { address, keys })
}

pub(super) fn parse_send<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let address = items.next().ok_or(DispatchError::BadArgs)?.to_string();
    if address.starts_with('-') {
        return Err(DispatchError::BadArgs);
    }
    let mut body = None;
    let mut file = None;
    let mut force = false;
    let mut only_ready = false;
    let mut allow_queue = true;
    while let Some(next) = items.next() {
        let (flag, inline_val) = parse_run::split_flag(next);
        match flag {
            "--file" => file = Some(need_flag(items, inline_val)?),
            "--force" if inline_val.is_none() => force = true,
            "--if" => {
                if need_flag(items, inline_val)? != "ready" {
                    return Err(DispatchError::BadArgs);
                }
                only_ready = true;
                allow_queue = false;
            }
            "--queue" if inline_val.is_none() => allow_queue = true,
            "--no-queue" if inline_val.is_none() => allow_queue = false,
            "--" if inline_val.is_none() && body.is_none() => {
                body = items.next().map(|part| part.to_string());
                if items.next().is_some() {
                    return Err(DispatchError::BadArgs);
                }
            }
            _ if next.starts_with('-') => return Err(DispatchError::BadArgs),
            other if body.is_none() => body = Some(other.to_string()),
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

pub(super) fn parse_wait<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let mut address = None;
    let mut until = Vec::new();
    let mut children = None;
    let mut timeout_ms = 30_000;
    while let Some(next) = items.next() {
        let (flag, inline_val) = parse_run::split_flag(next);
        match flag {
            "--until" => {
                let raw = need_flag(items, inline_val)?;
                until = raw
                    .split(',')
                    .map(|part| PresenceState::parse(part.trim()).ok_or(DispatchError::BadArgs))
                    .collect::<Result<Vec<_>, _>>()?;
            }
            "--timeout-ms" | "--timeout" => {
                timeout_ms = need_flag(items, inline_val)?
                    .parse()
                    .map_err(|_| DispatchError::BadArgs)?;
            }
            "--children" => {
                let mode_val = need_flag(items, inline_val)?;
                children = Some(match mode_val.as_str() {
                    "all" => ChildrenMode::All,
                    "any" => ChildrenMode::Any,
                    _ => return Err(DispatchError::BadArgs),
                });
            }
            _ if next.starts_with('-') => return Err(DispatchError::BadArgs),
            other if address.is_none() => address = Some(other.to_string()),
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

pub(super) fn parse_read<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let address = items.next().ok_or(DispatchError::BadArgs)?.to_string();
    if address.starts_with('-') {
        return Err(DispatchError::BadArgs);
    }
    let mut lines = 80;
    let mut last_assistant = false;
    while let Some(next) = items.next() {
        let (flag, inline_val) = parse_run::split_flag(next);
        match flag {
            "--lines" => {
                lines = need_flag(items, inline_val)?
                    .parse()
                    .map_err(|_| DispatchError::BadArgs)?;
            }
            "--last" if inline_val.is_none() => last_assistant = true,
            _ => return Err(DispatchError::BadArgs),
        }
    }
    Ok(Command::Read {
        address,
        lines,
        last_assistant,
    })
}

pub(super) fn parse_report<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let mut to = None;
    let mut from = None;
    let mut body = None;
    let mut file = None;
    while let Some(next) = items.next() {
        let (flag, inline_val) = parse_run::split_flag(next);
        match flag {
            "--to" => to = Some(need_flag(items, inline_val)?),
            "--from" => from = Some(need_flag(items, inline_val)?),
            "--body" => body = Some(need_flag(items, inline_val)?),
            "--file" => file = Some(need_flag(items, inline_val)?),
            _ => return Err(DispatchError::BadArgs),
        }
    }
    if body.is_none() && file.is_none() {
        return Err(DispatchError::BadArgs);
    }
    Ok(Command::Report { to, from, body, file })
}

pub(super) fn parse_bool_flag(raw: &str) -> Result<bool, DispatchError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" => Ok(true),
        "false" | "0" | "no" => Ok(false),
        _ => Err(DispatchError::BadArgs),
    }
}

pub(super) fn parse_swarm_detailed<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, (DispatchError, String)> {
    let sub = items
        .next()
        .ok_or_else(|| bad_args("Missing `swarm` subcommand (expected title, add, post, read, wait, status, model, kill, or channel)."))?;
    let cmd = match sub {
        "title" => {
            let mut title = None;
            let mut positionals: Vec<String> = Vec::new();
            while let Some(next) = items.next() {
                let (flag, inline_val) = parse_run::split_flag(next);
                match flag {
                    "--title" => {
                        title = Some(parse_run::need_flag_detailed(items, "--title", inline_val)?)
                    }
                    _ if next.starts_with('-') => {
                        return Err(bad_args(format!("Unknown flag `{next}` for `swarm title`.")))
                    }
                    other => positionals.push(other.to_string()),
                }
            }
            let text = title
                .unwrap_or_else(|| positionals.join(" "))
                .trim()
                .to_string();
            if text.is_empty() {
                return Err(bad_args("Missing title text for `swarm title`."));
            }
            SwarmCommand::Title { title: text }
        }
        "add" => {
            let mut name = None;
            let mut provider = None;
            let mut model = None;
            let mut effort = None;
            let mut workspace = None;
            let mut channels: Vec<String> = Vec::new();
            let mut fork = None;
            let mut role = None;
            let mut brief = None;
            let mut positionals: Vec<String> = Vec::new();
            while let Some(next) = items.next() {
                let (flag, inline_val) = parse_run::split_flag(next);
                match flag {
                    "--name" => {
                        name = Some(parse_run::need_flag_detailed(items, "--name", inline_val)?)
                    }
                    "--provider" => {
                        let raw = parse_run::need_flag_detailed(items, "--provider", inline_val)?;
                        provider = Some(
                            canonical_thread_provider(&raw)
                                .ok_or_else(|| bad_args(unknown_provider_message(&raw)))?
                                .to_string(),
                        );
                    }
                    "--model" => {
                        model = Some(parse_run::need_flag_detailed(items, "--model", inline_val)?)
                    }
                    "--effort" => {
                        let raw = parse_run::need_flag_detailed(items, "--effort", inline_val)?;
                        effort = Some(normalize_effort(&raw).ok_or_else(|| {
                            bad_args(format!(
                                "Invalid `--effort` value `{raw}`. Allowed: minimal, low, medium, high, xhigh, max, ultra."
                            ))
                        })?);
                    }
                    "--workspace" => {
                        let raw = parse_run::need_flag_detailed(items, "--workspace", inline_val)?;
                        workspace = Some(normalize_workspace_mode(&raw).ok_or_else(|| {
                            bad_args(format!(
                                "Invalid `--workspace` mode `{raw}`. Allowed: inherit, share, branch."
                            ))
                        })?);
                    }
                    "--channels" | "--channel" => {
                        let csv = parse_run::need_flag_detailed(items, flag, inline_val)?;
                        for part in csv.split(',') {
                            let ch = part.trim().trim_start_matches('#').to_ascii_lowercase();
                            if !ch.is_empty() && !channels.contains(&ch) {
                                channels.push(ch);
                            }
                        }
                    }
                    "--fork" => {
                        fork = Some(parse_run::need_flag_detailed(items, "--fork", inline_val)?)
                    }
                    "--role" => {
                        role = Some(parse_run::need_flag_detailed(items, "--role", inline_val)?)
                    }
                    "--brief" => {
                        brief = Some(parse_run::need_flag_detailed(items, "--brief", inline_val)?)
                    }
                    "--" if inline_val.is_none() => {
                        positionals.extend(items.by_ref().map(|p| p.to_string()))
                    }
                    _ if next.starts_with('-') => {
                        return Err(bad_args(format!("Unknown flag `{next}` for `swarm add`.")))
                    }
                    other => positionals.push(other.to_string()),
                }
            }
            let name = name
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| bad_args("`swarm add` requires `--name <worker>`."))?;
            let brief_text = brief
                .unwrap_or_else(|| positionals.join(" "))
                .trim()
                .to_string();
            if brief_text.is_empty() {
                return Err(bad_args("`swarm add` requires `--brief \"<assignment>\"`."));
            }
            SwarmCommand::Add {
                name,
                provider,
                model,
                effort,
                workspace,
                channels,
                fork,
                role,
                brief: brief_text,
            }
        }
        "model" => {
            let mut name = None;
            let mut provider = None;
            let mut model = None;
            let mut effort = None;
            while let Some(next) = items.next() {
                let (flag, inline_val) = parse_run::split_flag(next);
                match flag {
                    "--name" => {
                        name = Some(parse_run::need_flag_detailed(items, "--name", inline_val)?)
                    }
                    "--provider" => {
                        let raw = parse_run::need_flag_detailed(items, "--provider", inline_val)?;
                        provider = Some(
                            canonical_thread_provider(&raw)
                                .ok_or_else(|| bad_args(unknown_provider_message(&raw)))?
                                .to_string(),
                        );
                    }
                    "--model" => {
                        model = Some(parse_run::need_flag_detailed(items, "--model", inline_val)?)
                    }
                    "--effort" => {
                        let raw = parse_run::need_flag_detailed(items, "--effort", inline_val)?;
                        effort = Some(normalize_effort(&raw).ok_or_else(|| {
                            bad_args(format!(
                                "Invalid `--effort` value `{raw}`. Allowed: minimal, low, medium, high, xhigh, max, ultra."
                            ))
                        })?);
                    }
                    _ => {
                        return Err(bad_args(format!(
                            "Unknown flag `{next}` for `swarm model`."
                        )))
                    }
                }
            }
            SwarmCommand::Model {
                name: name
                    .map(|s| s.trim().trim_start_matches('@').to_string())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| bad_args("`swarm model` requires `--name <worker>`."))?,
                provider,
                model: model
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| bad_args("`swarm model` requires `--model <model_id>`."))?,
                effort,
            }
        }
        other => {
            return parse_swarm_rest(other, items)
                .map_err(|e| (e, format!("Invalid arguments for `swarm {other}`.")));
        }
    };
    Ok(Command::Swarm(cmd))
}

pub(super) fn parse_swarm_rest<'a>(
    sub: &str,
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<Command, DispatchError> {
    let cmd = match sub {
        "post" => {
            let mut channel = None;
            let mut text = None;
            let mut positionals: Vec<String> = Vec::new();
            while let Some(next) = items.next() {
                let (flag, inline_val) = parse_run::split_flag(next);
                match flag {
                    "--channel" => {
                        channel = Some(
                            need_flag(items, inline_val)?
                                .trim()
                                .trim_start_matches('#')
                                .to_ascii_lowercase(),
                        )
                    }
                    "--message" | "--body" => text = Some(need_flag(items, inline_val)?),
                    "--" if inline_val.is_none() => {
                        positionals.extend(items.by_ref().map(|p| p.to_string()))
                    }
                    _ if next.starts_with('-') => return Err(DispatchError::BadArgs),
                    other => positionals.push(other.to_string()),
                }
            }
            let body = text
                .unwrap_or_else(|| positionals.join(" "))
                .trim()
                .to_string();
            if body.is_empty() {
                return Err(DispatchError::BadArgs);
            }
            SwarmCommand::Post {
                channel: channel.filter(|c| !c.is_empty()),
                text: body,
            }
        }
        "read" => {
            let mut since = 0u64;
            let mut channel = None;
            while let Some(next) = items.next() {
                let (flag, inline_val) = parse_run::split_flag(next);
                match flag {
                    "--since" => {
                        since = need_flag(items, inline_val)?
                            .parse()
                            .map_err(|_| DispatchError::BadArgs)?;
                    }
                    "--channel" => {
                        channel = Some(
                            need_flag(items, inline_val)?
                                .trim()
                                .trim_start_matches('#')
                                .to_string(),
                        );
                    }
                    _ => return Err(DispatchError::BadArgs),
                }
            }
            SwarmCommand::Read { since, channel }
        }
        "wait" => {
            let mut since = 0u64;
            let mut mentions_only = false;
            let mut timeout_ms = 60_000u64;
            while let Some(next) = items.next() {
                let (flag, inline_val) = parse_run::split_flag(next);
                match flag {
                    "--since" => {
                        since = need_flag(items, inline_val)?
                            .parse()
                            .map_err(|_| DispatchError::BadArgs)?;
                    }
                    "--mentions" | "--mentions-only" => {
                        if let Some(val) = inline_val {
                            mentions_only = parse_bool_flag(val)?;
                        } else if let Some(&peek) = items.peek() {
                            if !peek.starts_with('-') {
                                mentions_only = parse_bool_flag(items.next().unwrap())?;
                            } else {
                                mentions_only = true;
                            }
                        } else {
                            mentions_only = true;
                        }
                    }
                    "--timeout-ms" | "--timeout" => {
                        timeout_ms = need_flag(items, inline_val)?
                            .parse()
                            .map_err(|_| DispatchError::BadArgs)?;
                    }
                    _ => return Err(DispatchError::BadArgs),
                }
            }
            SwarmCommand::Wait {
                since,
                mentions_only,
                timeout_ms,
            }
        }
        "status" => {
            if items.next().is_some() {
                return Err(DispatchError::BadArgs);
            }
            SwarmCommand::Status
        }
        "kill" => {
            let mut name = None;
            let mut positionals: Vec<String> = Vec::new();
            while let Some(next) = items.next() {
                let (flag, inline_val) = parse_run::split_flag(next);
                match flag {
                    "--name" => name = Some(need_flag(items, inline_val)?),
                    _ if next.starts_with('-') => return Err(DispatchError::BadArgs),
                    other => positionals.push(other.to_string()),
                }
            }
            let target = name
                .or_else(|| positionals.into_iter().next())
                .map(|s| s.trim().trim_start_matches('@').to_string())
                .filter(|s| !s.is_empty())
                .ok_or(DispatchError::BadArgs)?;
            SwarmCommand::Kill { name: target }
        }
        "channel" => {
            let sub_action = match items.next() {
                Some("create") => SwarmChannelAction::Create,
                Some("subscribe") => SwarmChannelAction::Subscribe,
                Some("unsubscribe") => SwarmChannelAction::Unsubscribe,
                Some("archive") => SwarmChannelAction::Archive,
                Some("list") => SwarmChannelAction::List,
                _ => return Err(DispatchError::BadArgs),
            };
            let mut channel = None;
            let mut topic = None;
            let mut member = None;
            let mut positionals: Vec<String> = Vec::new();
            while let Some(next) = items.next() {
                let (flag, inline_val) = parse_run::split_flag(next);
                match flag {
                    "--channel" => {
                        channel = Some(
                            need_flag(items, inline_val)?
                                .trim()
                                .trim_start_matches('#')
                                .to_ascii_lowercase(),
                        );
                    }
                    "--topic" => topic = Some(need_flag(items, inline_val)?),
                    "--name" => {
                        member = Some(
                            need_flag(items, inline_val)?
                                .trim()
                                .trim_start_matches('@')
                                .to_string(),
                        )
                    }
                    _ if next.starts_with('-') => return Err(DispatchError::BadArgs),
                    other => positionals.push(other.to_string()),
                }
            }
            if channel.is_none() {
                channel = positionals
                    .into_iter()
                    .next()
                    .map(|s| s.trim().trim_start_matches('#').to_ascii_lowercase())
                    .filter(|s| !s.is_empty());
            }
            SwarmCommand::Channel {
                action: sub_action,
                channel,
                topic,
                member,
            }
        }
        _ => return Err(DispatchError::BadArgs),
    };
    Ok(Command::Swarm(cmd))
}

pub(super) fn need<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
) -> Result<String, DispatchError> {
    match items.next() {
        Some(value) if !value.starts_with('-') => Ok(value.to_string()),
        _ => Err(DispatchError::BadArgs),
    }
}

pub(super) fn need_flag<'a>(
    items: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>,
    inline_val: Option<&str>,
) -> Result<String, DispatchError> {
    if let Some(val) = inline_val {
        return if val.is_empty() {
            Err(DispatchError::BadArgs)
        } else {
            Ok(val.to_string())
        };
    }
    need(items)
}

