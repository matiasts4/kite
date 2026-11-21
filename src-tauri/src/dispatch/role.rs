//! Role files. Header is `command` plus optional `description`. The body is the brief.

use std::fs;
use std::path::{Path, PathBuf};

use super::address::is_alias_name;
use super::types::DispatchError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleFile {
    pub command: String,
    pub description: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub workspace: Option<String>,
    pub body: String,
}

pub const SAMPLE_ROLE_NAME: &str = "reviewer";

pub const SAMPLE_ROLE: &str = "\
command: auto
description: Review a task and report findings.

Review the task. Report defects, risks, and a recommendation.
Do not take irreversible actions. Those wait for the person.
";

fn split_role_header_and_body(text: &str) -> (&str, &str) {
    let normalized = text.trim_start();
    if let Some(after_open) = normalized
        .strip_prefix("---\r\n")
        .or_else(|| normalized.strip_prefix("---\n"))
    {
        if let Some(close_idx) = after_open.find("\n---") {
            let header = &after_open[..close_idx];
            let rest = &after_open[close_idx + "\n---".len()..];
            let body = rest
                .strip_prefix("\r\n")
                .or_else(|| rest.strip_prefix('\n'))
                .unwrap_or(rest)
                .trim();
            return (header, body);
        }
    }
    if let Some(idx) = text.find("\r\n\r\n") {
        return (&text[..idx], text[idx + 4..].trim());
    }
    match text.find("\n\n") {
        Some(idx) => (&text[..idx], text[idx + 2..].trim()),
        None => (text.trim(), ""),
    }
}

pub fn parse_role(text: &str) -> Result<RoleFile, DispatchError> {
    let (header, body) = split_role_header_and_body(text);
    let mut command: Option<String> = None;
    let mut description: Option<String> = None;
    let mut provider: Option<String> = None;
    let mut model: Option<String> = None;
    let mut effort: Option<String> = None;
    let mut workspace: Option<String> = None;
    for line in header.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "command" if !value.is_empty() => command = Some(value.to_string()),
            "description" if !value.is_empty() => description = Some(value.to_string()),
            "provider" if !value.is_empty() => provider = Some(value.to_string()),
            "model" if !value.is_empty() => model = Some(value.to_string()),
            "effort" if !value.is_empty() => effort = Some(value.to_string()),
            "workspace" if !value.is_empty() => workspace = Some(value.to_string()),
            _ => {}
        }
    }
    let command = command
        .or_else(|| provider.clone())
        .filter(|c| !c.is_empty())
        .ok_or(DispatchError::RoleNotFound)?;
    Ok(RoleFile {
        command,
        description,
        provider,
        model,
        effort,
        workspace,
        body: body.to_string(),
    })
}

pub fn format_role_markdown(role: &RoleFile) -> String {
    let mut header = Vec::new();
    let cmd = if role.command.trim().is_empty() {
        role.provider.as_deref().unwrap_or("auto")
    } else {
        role.command.trim()
    };
    header.push(format!("command: {cmd}"));
    if let Some(desc) = role.description.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        header.push(format!("description: {desc}"));
    }
    if let Some(prov) = role.provider.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        header.push(format!("provider: {prov}"));
    }
    if let Some(model) = role.model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        header.push(format!("model: {model}"));
    }
    if let Some(effort) = role.effort.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        header.push(format!("effort: {effort}"));
    }
    if let Some(ws) = role.workspace.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        header.push(format!("workspace: {ws}"));
    }
    let body = role.body.trim();
    if body.is_empty() {
        format!("{}\n", header.join("\n"))
    } else {
        format!("{}\n\n{}\n", header.join("\n"), body)
    }
}

pub fn roles_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("dispatch").join("roles")
}

pub fn workspace_agents_dir(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join(".kite").join("agents")
}

fn is_sample_role_stem(path: &Path) -> bool {
    path.file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|stem| {
            stem.eq_ignore_ascii_case(SAMPLE_ROLE_NAME) || stem.eq_ignore_ascii_case("review")
        })
}

fn is_legacy_codex_sample_role(role: &RoleFile) -> bool {
    if !role.command.trim().eq_ignore_ascii_case("codex") {
        return false;
    }
    if role.provider.is_some()
        || role.model.is_some()
        || role.effort.is_some()
        || role.workspace.is_some()
    {
        return false;
    }
    let desc_matches = role.description.as_deref().is_some_and(|desc| {
        matches!(
            desc.trim(),
            "Review a task and report findings." | "Review the task and report findings."
        )
    });
    let body_matches = role
        .body
        .trim()
        .starts_with("Review the task. Report defects, risks, and a recommendation.");
    desc_matches && body_matches
}

pub fn load_role_from_path(path: &Path) -> Result<RoleFile, DispatchError> {
    let text = fs::read_to_string(path).map_err(|_| DispatchError::RoleNotFound)?;
    let mut role = parse_role(&text)?;
    if is_sample_role_stem(path) && is_legacy_codex_sample_role(&role) {
        role.command = "auto".to_string();
    }
    Ok(role)
}

fn write_sample(dir: &Path, name: &str) -> Result<PathBuf, DispatchError> {
    let path = dir.join(format!("{name}.md"));
    if !path.exists() {
        fs::write(&path, SAMPLE_ROLE).map_err(|_| DispatchError::RoleNotFound)?;
    } else if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(mut parsed) = parse_role(&text) {
            if is_sample_role_stem(&path) && is_legacy_codex_sample_role(&parsed) {
                parsed.command = "auto".to_string();
                let _ = fs::write(&path, format_role_markdown(&parsed));
            }
        }
    }
    Ok(path)
}

pub fn ensure_sample_role(config_dir: &Path) -> Result<PathBuf, DispatchError> {
    let dir = roles_dir(config_dir);
    fs::create_dir_all(&dir).map_err(|_| DispatchError::RoleNotFound)?;
    let reviewer = write_sample(&dir, SAMPLE_ROLE_NAME)?;
    // Sample briefs. They are not the program catalog and they are not run by themselves.
    let _ = write_sample(&dir, "review")?;
    Ok(reviewer)
}

pub fn load_role_from_dir(dir: &Path, name: &str) -> Result<RoleFile, DispatchError> {
    if !is_alias_name(name) {
        return Err(DispatchError::RoleNotFound);
    }
    let exact = dir.join(format!("{name}.md"));
    if exact.is_file() {
        return load_role_from_path(&exact);
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if stem.eq_ignore_ascii_case(name) {
                    return load_role_from_path(&path);
                }
            }
        }
    }
    Err(DispatchError::RoleNotFound)
}

pub fn find_role_across_roots(
    config_dir: Option<&Path>,
    workspace_dir: Option<&Path>,
    name: &str,
) -> Result<RoleFile, DispatchError> {
    if !is_alias_name(name) {
        return Err(DispatchError::RoleNotFound);
    }
    if let Some(ws) = workspace_dir {
        if let Ok(role) = load_role_from_dir(&workspace_agents_dir(ws), name) {
            return Ok(role);
        }
    }
    if let Some(cfg) = config_dir {
        if let Ok(role) = load_role_from_dir(&roles_dir(cfg), name) {
            return Ok(role);
        }
    }
    Err(DispatchError::RoleNotFound)
}

pub fn load_role(config_dir: &Path, name: &str) -> Result<RoleFile, DispatchError> {
    load_role_from_dir(&roles_dir(config_dir), name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAgentProfileRole {
    pub agent_id: String,
    pub display_name: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedRoleTarget {
    AgentProfile(ResolvedAgentProfileRole),
    MarkdownRole(RoleFile),
}

pub fn normalize_agent_slug(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn agent_profile_to_resolved(profile: &crate::persist::AgentProfile) -> ResolvedAgentProfileRole {
    let provider = crate::chat::models::canonical_thread_provider_id(&profile.engine)
        .map(str::to_string);
    let model = profile
        .default_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mode = profile
        .default_mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let effort = profile
        .default_provider_options
        .iter()
        .find(|opt| opt.get("id").and_then(serde_json::Value::as_str) == Some("effort"))
        .and_then(|opt| opt.get("value").and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    ResolvedAgentProfileRole {
        agent_id: profile.id.clone(),
        display_name: profile.name.clone(),
        provider,
        model,
        effort,
        mode,
    }
}

/// Resolves `--role <name|agent:id>` against SQLite `AgentProfile` records first.
/// Matches by `agent:<id>` prefix, exact `id`, case-insensitive display `name`,
/// or normalized lowercase hyphenated slug.
pub fn resolve_agent_profile_role(query: &str) -> Option<ResolvedAgentProfileRole> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return None;
    }
    let items = crate::persist::agents().lock().ok()?;
    if trimmed.len() > 6 && trimmed[..6].eq_ignore_ascii_case("agent:") {
        let id_query = trimmed[6..].trim();
        if id_query.is_empty() {
            return None;
        }
        return items
            .iter()
            .find(|p| p.id == id_query || p.id.eq_ignore_ascii_case(id_query))
            .map(agent_profile_to_resolved);
    }

    if let Some(exact) = items.iter().find(|p| p.id == trimmed) {
        return Some(agent_profile_to_resolved(exact));
    }
    if let Some(by_name) = items
        .iter()
        .find(|p| p.name.trim().eq_ignore_ascii_case(trimmed))
    {
        return Some(agent_profile_to_resolved(by_name));
    }
    let slug = normalize_agent_slug(trimmed);
    if !slug.is_empty() {
        if let Some(by_slug) = items
            .iter()
            .find(|p| normalize_agent_slug(&p.name) == slug)
        {
            return Some(agent_profile_to_resolved(by_slug));
        }
    }
    None
}

/// Resolves a role query against `AgentProfile` records first, falling back to
/// `.kite/agents/*.md` and `dispatch/roles/*.md` only when no profile matches.
pub fn resolve_role_target(
    config_dir: Option<&Path>,
    workspace_dir: Option<&Path>,
    query: &str,
) -> Option<ResolvedRoleTarget> {
    if let Some(profile) = resolve_agent_profile_role(query) {
        return Some(ResolvedRoleTarget::AgentProfile(profile));
    }
    find_role_across_roots(config_dir, workspace_dir, query)
        .ok()
        .map(ResolvedRoleTarget::MarkdownRole)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_command_ignores_unknown_fields_and_missing_file_starts_nothing() {
        let role = parse_role("command: codex\ndescription: Review\nextra: ignore\n\nLook carefully.\n").unwrap();
        assert_eq!(role.command, "codex");
        assert_eq!(role.description.as_deref(), Some("Review"));
        assert_eq!(role.body, "Look carefully.");
        assert!(parse_role("description: no command\n\nbody").is_err());

        let dir = std::env::temp_dir().join(format!("kite-dispatch-role-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(load_role(&dir, "missing").is_err());
        assert!(load_role(&dir, "../reviewer").is_err());
        let sample = ensure_sample_role(&dir).unwrap();
        assert!(sample.exists());
        let loaded = load_role(&dir, SAMPLE_ROLE_NAME).unwrap();
        assert_eq!(loaded.command, "auto");

        // Verify legacy `command: codex` sample role files auto-migrate to `command: auto` on load and ensure_sample_role.
        let rdir = roles_dir(&dir);
        let legacy_sample = "command: codex\ndescription: Review a task and report findings.\n\nReview the task. Report defects, risks, and a recommendation.\n";
        fs::write(rdir.join("review.md"), legacy_sample).unwrap();
        fs::write(rdir.join("reviewer.md"), legacy_sample).unwrap();
        assert_eq!(load_role(&dir, "review").unwrap().command, "auto");
        assert_eq!(load_role(&dir, "reviewer").unwrap().command, "auto");
        ensure_sample_role(&dir).unwrap();
        let on_disk = fs::read_to_string(rdir.join("reviewer.md")).unwrap();
        assert!(on_disk.starts_with("command: auto"), "on_disk={on_disk}");

        let _ = fs::remove_dir_all(&dir);
    }
}
