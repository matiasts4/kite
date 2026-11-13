use serde_json::Value;

use super::*;

pub fn extract_subagent_meta(
    raw_name: &str,
    tool_id: &str,
    params: &Value,
    output: Option<&str>,
    raw_status: &str,
) -> Option<SubagentMeta> {
    let (_, clean_name) = strip_mcp_prefix(raw_name, params);
    let command = lookup_text(params, &["CommandLine", "command", "cmd"]);
    let cli_tokens = command.as_deref().map(tokenize_shell_tokens);
    let cli_cmd = cli_tokens.as_deref().and_then(match_dispatch_cli);
    let is_cli_run = matches!(cli_cmd, Some(DispatchCliCommand::Run(_)));
    if !is_subagent_tool_name(&clean_name) && !is_cli_run {
        return None;
    }

    let parsed_out = parse_output_json(output);
    let action = lookup_text(params, &["action", "Action"]);

    let mut role = lookup_text(
        params,
        &["Role", "role", "description", "Description", "name", "Name", "title"],
    )
    .filter(|r| !is_shell_wrapper_name(r) && !is_subagent_tool_name(&r.replace(' ', "_")));
    let mut type_name = lookup_text(
        params,
        &["TypeName", "typeName", "type_name", "subagent_type", "subagentType", "agentType"],
    );
    let mut provider = lookup_text(params, &["Provider", "provider"]);
    let mut model = lookup_text(params, &["Model", "model"]);
    let mut workspace_mode = lookup_text(
        params,
        &["Workspace", "workspace", "workspaceMode", "workspace_mode"],
    )
    .and_then(|w| normalize_workspace_mode(&w));
    let mut prompt = lookup_text(
        params,
        &["Prompt", "prompt", "Message", "message", "brief", "Brief", "task", "instruction"],
    );

    if let Some(DispatchCliCommand::Run(args)) = cli_cmd {
        role = role
            .or_else(|| take_cli_flag(&args, &["--role", "--title"]))
            .filter(|r| !is_shell_wrapper_name(r) && !is_subagent_tool_name(&r.replace(' ', "_")));
        type_name = type_name.or_else(|| take_cli_flag(&args, &["--type"]));
        provider = provider.or_else(|| take_cli_flag(&args, &["--provider", "--agent"]));
        model = model.or_else(|| take_cli_flag(&args, &["--model"]));
        workspace_mode = workspace_mode.or_else(|| {
            take_cli_flag(&args, &["--workspace"]).and_then(|w| normalize_workspace_mode(&w))
        });
        if prompt.is_none() {
            let pos = collect_cli_positionals(&args);
            if !pos.is_empty() {
                prompt = Some(pos.join(" "));
            }
        }
    }

    let extracted_thread_target = parsed_out
        .as_ref()
        .and_then(|o| lookup_text(o, &["target"]))
        .and_then(|t| t.strip_prefix("thread:").map(str::to_string))
        .or_else(|| {
            output.and_then(|raw| {
                if let Some(pos) = raw.find("[subagent_id: thread:") {
                    let rest = &raw[pos + "[subagent_id: thread:".len()..];
                    rest.find(']')
                        .map(|end| rest[..end].trim().to_string())
                        .filter(|s| !s.is_empty())
                } else if let Some(pos) = raw.find("started thread:") {
                    let rest = &raw[pos + "started thread:".len()..];
                    let token: String = rest
                        .chars()
                        .take_while(|c| !c.is_whitespace() && *c != '"' && *c != '}' && *c != ']')
                        .collect();
                    (!token.is_empty()).then_some(token)
                } else {
                    None
                }
            })
        });

    let out_sub_id = parsed_out
        .as_ref()
        .and_then(|o| {
            lookup_text(
                o,
                &[
                    "conversationId",
                    "conversation_id",
                    "subagentId",
                    "subagent_id",
                    "childThreadId",
                    "threadId",
                    "session_id",
                    "sessionId",
                ],
            )
        })
        .or_else(|| extracted_thread_target.clone());
    let param_sub_id = lookup_text(
        params,
        &[
            "subagentId",
            "subagent_id",
            "conversationId",
            "conversation_id",
            "Recipient",
            "recipient",
            "childThreadId",
            "session_id",
            "sessionId",
        ],
    );
    let subagent_id = out_sub_id
        .or(param_sub_id)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if tool_id.trim().is_empty() {
                clean_name.clone()
            } else {
                tool_id.to_string()
            }
        });

    let child_thread_id = parsed_out
        .as_ref()
        .and_then(|o| lookup_text(o, &["childThreadId", "child_thread_id", "threadId"]))
        .or_else(|| lookup_text(params, &["childThreadId", "child_thread_id"]))
        .or(extracted_thread_target);
    let transcript_uri = parsed_out
        .as_ref()
        .and_then(|o| {
            lookup_text(
                o,
                &["logAbsoluteUri", "log_absolute_uri", "transcriptUri", "transcript_uri"],
            )
        })
        .or_else(|| {
            lookup_text(
                params,
                &["logAbsoluteUri", "log_absolute_uri", "transcriptUri", "transcript_uri"],
            )
        });
    let mut latest_activity = parsed_out
        .as_ref()
        .and_then(|o| lookup_text(o, &["latestActivity", "latest_activity"]))
        .or_else(|| lookup_text(params, &["latestActivity", "latest_activity"]));
    let step_count = parsed_out
        .as_ref()
        .and_then(|o| lookup_value(o, &["stepCount", "step_count"]).and_then(|v| v.as_u64()))
        .unwrap_or(0) as usize;

    let resolved_role = role
        .or_else(|| type_name.clone())
        .unwrap_or_else(|| {
            if is_shell_wrapper_name(&clean_name) || is_subagent_tool_name(&clean_name) {
                provider
                    .as_deref()
                    .map(|p| match display_provider_label(p) {
                        "Subagent" => "Subagent".to_string(),
                        label => format!("{label} subagent"),
                    })
                    .unwrap_or_else(|| "Subagent".to_string())
            } else {
                clean_name.replace('_', " ")
            }
        });
    let mut status = normalize_subagent_status(raw_status, action.as_deref());
    if status != "killed"
        && response_indicates_failure(raw_status, Some(params), parsed_out.as_ref(), output)
    {
        status = "failed".to_string();
    }
    if status == "failed" && latest_activity.is_none() {
        latest_activity = parsed_out
            .as_ref()
            .and_then(|o| lookup_text(o, &["error", "message", "reason"]))
            .or_else(|| lookup_text(params, &["error", "message", "reason"]))
            .map(|msg| msg.chars().take(180).collect());
    }

    Some(SubagentMeta {
        subagent_id,
        role: resolved_role,
        type_name,
        provider,
        model,
        workspace_mode,
        prompt,
        status,
        transcript_uri,
        child_thread_id,
        latest_activity,
        step_count,
    })
}

pub fn extract_swarm_meta(
    raw_name: &str,
    params: &Value,
    output: Option<&str>,
) -> Option<SwarmMeta> {
    let (_, clean_name) = strip_mcp_prefix(raw_name, params);
    let command = lookup_text(params, &["CommandLine", "command", "cmd"]);
    let cli_tokens = command.as_deref().map(tokenize_shell_tokens);
    let cli_cmd = cli_tokens.as_deref().and_then(match_dispatch_cli);
    let is_cli_swarm = matches!(cli_cmd, Some(DispatchCliCommand::Swarm(_)));
    if !is_swarm_tool_name(&clean_name) && !is_cli_swarm {
        return None;
    }

    let parsed_out = parse_output_json(output);
    let lower = clean_name.trim().to_ascii_lowercase();

    let mut action = match lower.as_str() {
        "post_message" => "post_message".to_string(),
        "read_board" => "read_board".to_string(),
        "swarm_wait" => "swarm_wait".to_string(),
        _ => lookup_text(params, &["action", "Action"])
            .unwrap_or_else(|| "status".to_string())
            .to_ascii_lowercase(),
    };
    let mut swarm_id = lookup_text(params, &["swarmId", "swarm_id"])
        .or_else(|| parsed_out.as_ref().and_then(|o| lookup_text(o, &["swarmId", "swarm_id"])));
    let mut swarm_title = lookup_text(params, &["title", "Title", "swarmTitle"]);
    let mut member_name = lookup_text(params, &["name", "Name", "memberName", "member_name"]);
    let mut member_names = expand_swarm_members(member_name.as_deref(), params);
    let mut model = lookup_text(params, &["model", "Model"]);
    let mut workspace_mode = lookup_text(
        params,
        &["workspace", "Workspace", "workspaceMode", "workspace_mode"],
    )
    .and_then(|w| normalize_workspace_mode(&w));
    let mut channel = lookup_text(params, &["channel", "Channel"]);
    let mut post_text = lookup_text(params, &["message", "Message", "text", "body", "postText"]);
    let mut brief = lookup_text(params, &["brief", "Brief"]);

    if let Some(DispatchCliCommand::Swarm(args)) = cli_cmd {
        if let Some(sub) = args.first() {
            action = match sub.to_ascii_lowercase().as_str() {
                "post" | "post_message" => "post_message".to_string(),
                "read" | "read_board" => "read_board".to_string(),
                "wait" | "swarm_wait" => "swarm_wait".to_string(),
                other => other.to_string(),
            };
            let rest = &args[1..];
            swarm_id = swarm_id.or_else(|| take_cli_flag(rest, &["--swarm", "--swarm-id"]));
            swarm_title = swarm_title.or_else(|| take_cli_flag(rest, &["--title"]));
            member_name = member_name.or_else(|| take_cli_flag(rest, &["--name", "--member"]));
            model = model.or_else(|| take_cli_flag(rest, &["--model"]));
            workspace_mode = workspace_mode.or_else(|| {
                take_cli_flag(rest, &["--workspace"]).and_then(|w| normalize_workspace_mode(&w))
            });
            channel = channel.or_else(|| take_cli_flag(rest, &["--channel"]));
            brief = brief.or_else(|| take_cli_flag(rest, &["--brief"]));

            if member_names.is_empty() {
                if let Some(tasks_csv) = take_cli_flag(rest, &["--tasks"]) {
                    let base = member_name.as_deref().unwrap_or("worker");
                    let count = tasks_csv.split(',').filter(|s| !s.trim().is_empty()).count();
                    for idx in 1..=count {
                        member_names.push(format!("{base}-{idx}"));
                    }
                } else if let Some(n_str) = take_cli_flag(rest, &["--n"]) {
                    if let Ok(n) = n_str.parse::<usize>() {
                        let base = member_name.as_deref().unwrap_or("worker");
                        for idx in 1..=n {
                            member_names.push(format!("{base}-{idx}"));
                        }
                    }
                } else if let Some(ref m) = member_name {
                    member_names.push(m.clone());
                }
            }

            let pos = collect_cli_positionals(rest);
            if action == "post_message" && post_text.is_none() && !pos.is_empty() {
                post_text = Some(pos.join(" "));
            } else if action == "title" && swarm_title.is_none() && !pos.is_empty() {
                swarm_title = Some(pos.join(" "));
            } else if action == "channel" && channel.is_none() && !pos.is_empty() {
                channel = Some(pos[0].clone());
            } else if action == "add" && brief.is_none() && !pos.is_empty() {
                brief = Some(pos.join(" "));
            }
        }
    }

    if channel.is_none() && action == "post_message" {
        channel = Some("main".to_string());
    }
    let mentions = post_text
        .as_deref()
        .map(extract_mentions)
        .unwrap_or_default();
    let seq = parsed_out
        .as_ref()
        .and_then(|o| lookup_value(o, &["seq"]).and_then(|v| v.as_u64()))
        .or_else(|| lookup_value(params, &["seq"]).and_then(|v| v.as_u64()));

    Some(SwarmMeta {
        swarm_id,
        action,
        swarm_title,
        member_name,
        member_names,
        model,
        workspace_mode,
        channel,
        post_text,
        mentions,
        seq,
        brief,
    })
}

pub fn merge_subagent_meta(existing: Option<&SubagentMeta>, mut incoming: SubagentMeta) -> SubagentMeta {
    if let Some(prev) = existing {
        let is_fallback_tool_id = |id: &str| {
            id.is_empty()
                || id.starts_with("call")
                || id.starts_with("tool")
                || id.starts_with("t_")
        };
        if incoming.subagent_id.is_empty() || incoming.subagent_id == prev.subagent_id {
            // Keep prev if incoming only had a fallback tool id while prev resolved conversationId.
        } else if (prev.child_thread_id.is_some() && incoming.child_thread_id.is_none())
            || (!is_fallback_tool_id(&prev.subagent_id) && is_fallback_tool_id(&incoming.subagent_id))
        {
            incoming.subagent_id = prev.subagent_id.clone();
        }
        if is_generic_subagent_role(&incoming.role) && !is_generic_subagent_role(&prev.role) {
            incoming.role = prev.role.clone();
        } else if is_shell_wrapper_name(&incoming.role) && !prev.role.trim().is_empty() {
            incoming.role = prev.role.clone();
        }
        if incoming.type_name.is_none() {
            incoming.type_name = prev.type_name.clone();
        }
        if incoming.provider.is_none() {
            incoming.provider = prev.provider.clone();
        }
        if incoming.model.is_none() {
            incoming.model = prev.model.clone();
        }
        if incoming.workspace_mode.is_none() {
            incoming.workspace_mode = prev.workspace_mode.clone();
        }
        if incoming.prompt.is_none() {
            incoming.prompt = prev.prompt.clone();
        }
        if incoming.transcript_uri.is_none() {
            incoming.transcript_uri = prev.transcript_uri.clone();
        }
        if incoming.child_thread_id.is_none() {
            incoming.child_thread_id = prev.child_thread_id.clone();
        }
        if incoming.latest_activity.is_none() {
            incoming.latest_activity = prev.latest_activity.clone();
        }
        if incoming.step_count == 0 {
            incoming.step_count = prev.step_count;
        }
        if prev.status == "killed" && incoming.status != "killed" {
            incoming.status = "killed".to_string();
        } else if prev.status == "failed" && incoming.status == "running" {
            incoming.status = "failed".to_string();
        }
    }
    incoming
}

pub fn merge_swarm_meta(existing: Option<&SwarmMeta>, mut incoming: SwarmMeta) -> SwarmMeta {
    if let Some(prev) = existing {
        if incoming.swarm_id.is_none() {
            incoming.swarm_id = prev.swarm_id.clone();
        }
        if incoming.swarm_title.is_none() {
            incoming.swarm_title = prev.swarm_title.clone();
        }
        if incoming.member_name.is_none() {
            incoming.member_name = prev.member_name.clone();
        }
        if incoming.member_names.is_empty() {
            incoming.member_names = prev.member_names.clone();
        }
        if incoming.model.is_none() {
            incoming.model = prev.model.clone();
        }
        if incoming.workspace_mode.is_none() {
            incoming.workspace_mode = prev.workspace_mode.clone();
        }
        if incoming.channel.is_none() {
            incoming.channel = prev.channel.clone();
        }
        if incoming.post_text.is_none() {
            incoming.post_text = prev.post_text.clone();
        }
        if incoming.mentions.is_empty() {
            incoming.mentions = prev.mentions.clone();
        }
        if incoming.seq.is_none() {
            incoming.seq = prev.seq;
        }
        if incoming.brief.is_none() {
            incoming.brief = prev.brief.clone();
        }
    }
    incoming
}

