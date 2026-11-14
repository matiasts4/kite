//! Persistent configuration for cross-provider subagent model stacks,
//! default lightweight delegation, explicit override policies, and role profiles.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::chat::models::canonical_thread_provider_id;
use crate::dispatch::address::is_alias_name;
use crate::dispatch::cli::{normalize_effort, normalize_workspace_mode};
use crate::dispatch::role::{
    format_role_markdown, parse_role, roles_dir, workspace_agents_dir, RoleFile,
};
use crate::persist::{app_state_get, app_state_set_checked, roaming_app_dir};

pub const SUBAGENT_SETTINGS_KEY: &str = "subagentSettings";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OverridePolicy {
    #[default]
    Allow,
    Ask,
    Strict,
}

impl OverridePolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            OverridePolicy::Allow => "allow",
            OverridePolicy::Ask => "ask",
            OverridePolicy::Strict => "strict",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentStackEntry {
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultDelegation {
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSettings {
    #[serde(default)]
    pub stack: Vec<SubagentStackEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_delegation: Option<DefaultDelegation>,
    #[serde(default)]
    pub override_policy: OverridePolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRoleRecord {
    pub slug: String,
    pub scope: String,
    pub path: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSubagentRoleInput {
    pub scope: String,
    pub slug: String,
    pub command: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub body: String,
}

fn canonical_provider_or_err(raw: &str) -> Result<String, String> {
    canonical_thread_provider_id(raw)
        .map(str::to_string)
        .ok_or_else(|| format!("Unknown thread provider `{}`.", raw.trim()))
}

fn clean_optional_effort(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(val) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    normalize_effort(val)
        .map(Some)
        .ok_or_else(|| format!("Invalid effort level `{val}`."))
}

/// Validates and canonicalizes a `SubagentSettings` payload, deduplicating stack
/// entries case-insensitively by `(provider, model)`.
pub fn normalize_settings(input: SubagentSettings) -> Result<SubagentSettings, String> {
    let mut stack: Vec<SubagentStackEntry> = Vec::with_capacity(input.stack.len());
    for entry in input.stack {
        let provider = canonical_provider_or_err(&entry.provider)?;
        let model = entry.model.trim().to_string();
        if model.is_empty() {
            return Err(format!("Stack entry for `{provider}` requires a non-empty model id."));
        }
        let effort = clean_optional_effort(entry.effort.as_deref())?;
        if let Some(existing) = stack
            .iter_mut()
            .find(|item| item.provider == provider && item.model.eq_ignore_ascii_case(&model))
        {
            existing.enabled = entry.enabled;
            if effort.is_some() {
                existing.effort = effort;
            }
            continue;
        }
        stack.push(SubagentStackEntry {
            provider,
            model,
            effort,
            enabled: entry.enabled,
        });
    }

    let default_delegation = if let Some(def) = input.default_delegation {
        let provider = canonical_provider_or_err(&def.provider)?;
        let model = def.model.trim().to_string();
        if model.is_empty() {
            return Err("Default delegation requires a non-empty model id.".to_string());
        }
        let effort = clean_optional_effort(def.effort.as_deref())?;
        if !stack.is_empty() {
            let in_enabled_stack = stack.iter().any(|entry| {
                entry.enabled
                    && entry.provider == provider
                    && entry.model.eq_ignore_ascii_case(&model)
            });
            if !in_enabled_stack {
                return Err(format!(
                    "Default delegation `{provider}/{model}` must match an enabled model in the curated Subagents stack."
                ));
            }
        }
        Some(DefaultDelegation {
            provider,
            model,
            effort,
        })
    } else {
        None
    };

    Ok(SubagentSettings {
        stack,
        default_delegation,
        override_policy: input.override_policy,
    })
}

pub fn parse_subagent_settings_json(raw: &str) -> SubagentSettings {
    let Ok(mut parsed) = serde_json::from_str::<SubagentSettings>(raw) else {
        return SubagentSettings::default();
    };
    if let Ok(normalized) = normalize_settings(parsed.clone()) {
        return normalized;
    }
    parsed.default_delegation = None;
    normalize_settings(parsed).unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn get_subagent_settings_from_db(conn: &rusqlite::Connection) -> SubagentSettings {
    conn.query_row(
        "SELECT value FROM app_state WHERE key = ?1",
        rusqlite::params![SUBAGENT_SETTINGS_KEY],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .map(|raw| parse_subagent_settings_json(&raw))
    .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn save_subagent_settings_in_db(
    conn: &rusqlite::Connection,
    input: SubagentSettings,
) -> Result<SubagentSettings, String> {
    let normalized = normalize_settings(input)?;
    let encoded = serde_json::to_string(&normalized)
        .map_err(|err| format!("Failed to serialize subagent settings: {err}"))?;
    conn.execute(
        "INSERT INTO app_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![SUBAGENT_SETTINGS_KEY, encoded],
    )
    .map_err(|err| format!("Failed to save subagent settings: {err}"))?;
    Ok(normalized)
}

pub fn get_subagent_settings() -> SubagentSettings {
    if cfg!(test) {
        return SubagentSettings::default();
    }
    app_state_get(SUBAGENT_SETTINGS_KEY)
        .map(|raw| parse_subagent_settings_json(&raw))
        .unwrap_or_default()
}

pub fn save_subagent_settings(input: SubagentSettings) -> Result<SubagentSettings, String> {
    let normalized = normalize_settings(input)?;
    let encoded = serde_json::to_string(&normalized)
        .map_err(|err| format!("Failed to serialize subagent settings: {err}"))?;
    app_state_set_checked(SUBAGENT_SETTINGS_KEY, &encoded)
        .map_err(|err| format!("Failed to save subagent settings: {err}"))?;
    let _ = crate::dispatch::cli::install_dispatch_skill();
    Ok(normalized)
}

pub fn resolve_default_delegation(
    settings: &SubagentSettings,
) -> Option<(String, String, Option<String>)> {
    if let Some(def) = settings.default_delegation.as_ref() {
        let allowed = settings.stack.is_empty()
            || settings.stack.iter().any(|entry| {
                entry.enabled
                    && entry.provider == def.provider
                    && entry.model.eq_ignore_ascii_case(&def.model)
            });
        if allowed {
            return Some((def.provider.clone(), def.model.clone(), def.effort.clone()));
        }
    }
    settings
        .stack
        .iter()
        .find(|entry| entry.enabled)
        .map(|entry| {
            (
                entry.provider.clone(),
                entry.model.clone(),
                entry.effort.clone(),
            )
        })
}

/// Applies configured default delegation or single-entry stack defaults when the
/// caller omits `--provider` and/or `--model` for a thread subagent.
pub fn resolve_thread_selection_defaults(
    settings: &SubagentSettings,
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> (Option<String>, Option<String>, Option<String>) {
    let canon_prov = provider
        .as_deref()
        .and_then(canonical_thread_provider_id)
        .map(str::to_string)
        .or(provider);
    if canon_prov.is_none() && model.is_none() {
        if let Some((dp, dm, de)) = resolve_default_delegation(settings) {
            return (Some(dp), Some(dm), effort.or(de));
        }
        return (None, None, effort);
    }
    if let (Some(ref p), None) = (&canon_prov, &model) {
        if let Some(def) = settings.default_delegation.as_ref().filter(|d| &d.provider == p) {
            let allowed = settings.stack.is_empty()
                || settings.stack.iter().any(|entry| {
                    entry.enabled
                        && entry.provider == def.provider
                        && entry.model.eq_ignore_ascii_case(&def.model)
                });
            if allowed {
                return (
                    canon_prov,
                    Some(def.model.clone()),
                    effort.or_else(|| def.effort.clone()),
                );
            }
        }
        let enabled_for_provider: Vec<&SubagentStackEntry> = settings
            .stack
            .iter()
            .filter(|e| e.enabled && &e.provider == p)
            .collect();
        if let Some(first) = enabled_for_provider.first() {
            return (
                canon_prov,
                Some(first.model.clone()),
                effort.or_else(|| first.effort.clone()),
            );
        }
    }
    (canon_prov, model, effort)
}

/// Enforces `Settings -> Subagents` stack and override rules before spawning or
/// hot-switching a cross-provider child thread or swarm worker.
pub fn check_stack_policy(
    settings: &SubagentSettings,
    provider: Option<&str>,
    model: Option<&str>,
    override_stack: bool,
) -> Result<(), String> {
    let canon_prov = provider.and_then(canonical_thread_provider_id).or(provider);
    let enabled: Vec<&SubagentStackEntry> = settings.stack.iter().filter(|e| e.enabled).collect();
    if enabled.is_empty() {
        if settings.override_policy == OverridePolicy::Strict {
            return Err(
                "Subagent model stack has no enabled entries under `strict` override policy. Enable at least one model in Settings -> Subagents."
                    .to_string(),
            );
        }
        return Ok(());
    }

    let in_stack = match (canon_prov, model.map(str::trim).filter(|s| !s.is_empty())) {
        (Some(p), Some(m)) => enabled
            .iter()
            .any(|e| e.provider == p && e.model.eq_ignore_ascii_case(m)),
        (Some(p), None) => enabled.iter().any(|e| e.provider == p),
        (None, Some(m)) => enabled.iter().any(|e| e.model.eq_ignore_ascii_case(m)),
        (None, None) => true,
    };
    if in_stack {
        return Ok(());
    }

    let target_label = match (canon_prov, model.filter(|s| !s.trim().is_empty())) {
        (Some(p), Some(m)) => format!("{p}/{m}"),
        (Some(p), None) => p.to_string(),
        (None, Some(m)) => m.to_string(),
        (None, None) => "default".to_string(),
    };
    match settings.override_policy {
        OverridePolicy::Allow => Ok(()),
        OverridePolicy::Ask => {
            if override_stack {
                Ok(())
            } else {
                Err(format!(
                    "`{target_label}` is outside the configured Subagents stack (override policy: ask). Confirm with the user and retry with `--override-stack`, or pick an enabled stack model via `kite dispatch providers` / `kite dispatch models`."
                ))
            }
        }
        OverridePolicy::Strict => Err(format!(
            "`{target_label}` is blocked by Settings -> Subagents (override policy: strict). Only enabled models in the curated stack are permitted."
        )),
    }
}

fn scope_roles_dir(scope: &str, config_dir: &Path, workspace_path: Option<&Path>) -> Result<PathBuf, String> {
    match scope.trim().to_ascii_lowercase().as_str() {
        "global" => Ok(roles_dir(config_dir)),
        "workspace" => workspace_path
            .map(workspace_agents_dir)
            .ok_or_else(|| "Workspace scope requires an active workspace directory.".to_string()),
        other => Err(format!("Unsupported role scope `{other}` (expected `global` or `workspace`).")),
    }
}

fn scan_roles_in_dir(dir: &Path, scope: &str, out: &mut Vec<SubagentRoleRecord>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("md"))
        .collect();
    files.sort();
    for path in files {
        let Some(slug) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = parse_role(&text) else {
            continue;
        };
        out.push(SubagentRoleRecord {
            slug,
            scope: scope.to_string(),
            path: path.to_string_lossy().to_string(),
            command: parsed.command,
            description: parsed.description,
            provider: parsed.provider,
            model: parsed.model,
            effort: parsed.effort,
            workspace: parsed.workspace,
            body: parsed.body,
        });
    }
}

pub fn list_roles_in_roots(config_dir: &Path, workspace_path: Option<&Path>) -> Vec<SubagentRoleRecord> {
    let mut out = Vec::new();
    if let Some(ws) = workspace_path {
        scan_roles_in_dir(&workspace_agents_dir(ws), "workspace", &mut out);
    }
    scan_roles_in_dir(&roles_dir(config_dir), "global", &mut out);
    out
}

pub fn list_roles(workspace_path: Option<&Path>) -> Vec<SubagentRoleRecord> {
    if cfg!(test) {
        return workspace_path
            .map(|ws| {
                let mut out = Vec::new();
                scan_roles_in_dir(&workspace_agents_dir(ws), "workspace", &mut out);
                out
            })
            .unwrap_or_default();
    }
    list_roles_in_roots(&roaming_app_dir(), workspace_path)
}

pub fn save_role_in_roots(
    config_dir: &Path,
    workspace_path: Option<&Path>,
    input: SaveSubagentRoleInput,
) -> Result<SubagentRoleRecord, String> {
    let slug = input.slug.trim().to_string();
    if !is_alias_name(&slug) {
        return Err(
            "Role slug must contain only letters, numbers, `-`, or `_` without spaces or path separators."
                .to_string(),
        );
    }
    let dir = scope_roles_dir(&input.scope, config_dir, workspace_path)?;
    fs::create_dir_all(&dir).map_err(|err| format!("Failed to prepare roles folder: {err}"))?;

    let provider = match input.provider.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(canonical_provider_or_err(raw)?),
        None => None,
    };
    let effort = clean_optional_effort(input.effort.as_deref())?;
    let workspace = match input.workspace.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(
            normalize_workspace_mode(raw)
                .ok_or_else(|| format!("Invalid workspace mode `{raw}`."))?,
        ),
        None => None,
    };
    let command = {
        let trimmed = input.command.trim();
        if !trimmed.is_empty() {
            trimmed.to_string()
        } else if let Some(ref prov) = provider {
            prov.clone()
        } else {
            return Err("Role requires a non-empty `command` or `provider`.".to_string());
        }
    };
    let description = input
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let model = input
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let role = RoleFile {
        command: command.clone(),
        description: description.clone(),
        provider: provider.clone(),
        model: model.clone(),
        effort: effort.clone(),
        workspace: workspace.clone(),
        body: input.body.trim().to_string(),
    };

    let dest = dir.join(format!("{slug}.md"));
    fs::write(&dest, format_role_markdown(&role))
        .map_err(|err| format!("Failed to write role file: {err}"))?;
    let _ = crate::dispatch::cli::install_dispatch_skill();

    Ok(SubagentRoleRecord {
        slug,
        scope: input.scope.trim().to_ascii_lowercase(),
        path: dest.to_string_lossy().to_string(),
        command,
        description,
        provider,
        model,
        effort,
        workspace,
        body: role.body,
    })
}

pub fn delete_role_in_roots(
    config_dir: &Path,
    workspace_path: Option<&Path>,
    scope: &str,
    slug: &str,
) -> Result<(), String> {
    let slug = slug.trim();
    if !is_alias_name(slug) {
        return Err("Invalid role slug.".to_string());
    }
    let dir = scope_roles_dir(scope, config_dir, workspace_path)?;
    let target = dir.join(format!("{slug}.md"));
    if target.is_file() {
        fs::remove_file(&target).map_err(|err| format!("Failed to remove role file: {err}"))?;
        let _ = crate::dispatch::cli::install_dispatch_skill();
    }
    Ok(())
}

pub fn save_role(
    workspace_path: Option<&Path>,
    input: SaveSubagentRoleInput,
) -> Result<SubagentRoleRecord, String> {
    save_role_in_roots(&roaming_app_dir(), workspace_path, input)
}

pub fn delete_role(
    workspace_path: Option<&Path>,
    scope: &str,
    slug: &str,
) -> Result<(), String> {
    delete_role_in_roots(&roaming_app_dir(), workspace_path, scope, slug)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kite-subagent-settings-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn normalize_and_stack_override_policy_enforce_allow_ask_and_strict() {
        let settings = normalize_settings(SubagentSettings {
            stack: vec![
                SubagentStackEntry {
                    provider: "agy".to_string(),
                    model: "gemini-3-flash".to_string(),
                    effort: Some("LOW".to_string()),
                    enabled: true,
                },
                SubagentStackEntry {
                    provider: "antigravity".to_string(),
                    model: "gemini-3-flash".to_string(),
                    effort: Some("medium".to_string()),
                    enabled: true,
                },
                SubagentStackEntry {
                    provider: "grok".to_string(),
                    model: "grok-4.7-fast".to_string(),
                    effort: None,
                    enabled: false,
                },
            ],
            default_delegation: Some(DefaultDelegation {
                provider: "antigravity".to_string(),
                model: "gemini-3-flash".to_string(),
                effort: Some("low".to_string()),
            }),
            override_policy: OverridePolicy::Ask,
        })
        .unwrap();

        assert_eq!(settings.stack.len(), 2);
        assert_eq!(settings.stack[0].provider, "antigravity");
        assert_eq!(settings.stack[0].effort.as_deref(), Some("medium"));

        // Enabled model passes without override
        assert!(check_stack_policy(&settings, Some("antigravity"), Some("gemini-3-flash"), false).is_ok());

        // Disabled or external model under `ask` requires `--override-stack`
        assert!(check_stack_policy(&settings, Some("grok"), Some("grok-4.7-fast"), false).is_err());
        assert!(check_stack_policy(&settings, Some("grok"), Some("grok-4.7-fast"), true).is_ok());

        // Under `strict`, even `--override-stack` cannot bypass
        let strict = SubagentSettings {
            override_policy: OverridePolicy::Strict,
            ..settings.clone()
        };
        assert!(check_stack_policy(&strict, Some("grok"), Some("grok-4.7-fast"), true).is_err());
        assert!(check_stack_policy(&strict, Some("antigravity"), Some("gemini-3-flash"), false).is_ok());

        // Default delegation resolution kicks in when omitted
        let (p, m, e) = resolve_thread_selection_defaults(&settings, None, None, None);
        assert_eq!(p.as_deref(), Some("antigravity"));
        assert_eq!(m.as_deref(), Some("gemini-3-flash"));
        assert_eq!(e.as_deref(), Some("low"));

        // Default delegation outside enabled stack is rejected on normalize/save, and
        // stale JSON safely clears default_delegation without losing curated stack entries.
        let out_of_stack = normalize_settings(SubagentSettings {
            stack: settings.stack.clone(),
            default_delegation: Some(DefaultDelegation {
                provider: "grok".to_string(),
                model: "grok-4.7-build-fast".to_string(),
                effort: Some("low".to_string()),
            }),
            override_policy: OverridePolicy::Ask,
        });
        assert!(out_of_stack.is_err());

        let stale_raw = r#"{
            "stack": [{"provider":"antigravity","model":"gemini-3-flash","effort":"low","enabled":true}],
            "defaultDelegation": {"provider":"grok","model":"grok-4.7-build-fast","effort":"low"},
            "overridePolicy": "ask"
        }"#;
        let recovered = parse_subagent_settings_json(stale_raw);
        assert_eq!(recovered.stack.len(), 1);
        assert!(recovered.default_delegation.is_none());

        // Real SQLite app_state persistence roundtrip
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        save_subagent_settings_in_db(&conn, settings.clone()).unwrap();
        let loaded = get_subagent_settings_from_db(&conn);
        assert_eq!(loaded.stack.len(), 2);
        assert_eq!(loaded.default_delegation, settings.default_delegation);
        assert_eq!(loaded.override_policy, OverridePolicy::Ask);
    }

    #[test]
    fn role_crud_roundtrips_global_and_workspace_agents_files() {
        let cfg = temp_root("cfg");
        let ws = temp_root("ws");

        let saved_global = save_role_in_roots(
            &cfg,
            Some(&ws),
            SaveSubagentRoleInput {
                scope: "global".to_string(),
                slug: "fast-checker".to_string(),
                command: "grok".to_string(),
                description: Some("Fast diff reviewer".to_string()),
                provider: Some("grok".to_string()),
                model: Some("grok-4.7-fast".to_string()),
                effort: Some("low".to_string()),
                workspace: Some("inherit".to_string()),
                body: "Inspect the modified files cleanly.".to_string(),
            },
        )
        .unwrap();
        assert_eq!(saved_global.scope, "global");
        assert!(Path::new(&saved_global.path).is_file());

        let saved_ws = save_role_in_roots(
            &cfg,
            Some(&ws),
            SaveSubagentRoleInput {
                scope: "workspace".to_string(),
                slug: "repo-auditor".to_string(),
                command: "codex".to_string(),
                description: None,
                provider: Some("codex".to_string()),
                model: Some("gpt-5.3-codex".to_string()),
                effort: Some("medium".to_string()),
                workspace: Some("share".to_string()),
                body: "Audit repository invariants.".to_string(),
            },
        )
        .unwrap();
        assert!(saved_ws.path.contains(".kite"));

        let listed = list_roles_in_roots(&cfg, Some(&ws));
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].slug, "repo-auditor");
        assert_eq!(listed[1].slug, "fast-checker");

        let bad = save_role_in_roots(
            &cfg,
            Some(&ws),
            SaveSubagentRoleInput {
                scope: "global".to_string(),
                slug: "../escape".to_string(),
                command: "grok".to_string(),
                description: None,
                provider: None,
                model: None,
                effort: None,
                workspace: None,
                body: "x".to_string(),
            },
        );
        assert!(bad.is_err());

        delete_role_in_roots(&cfg, Some(&ws), "global", "fast-checker").unwrap();
        assert_eq!(list_roles_in_roots(&cfg, Some(&ws)).len(), 1);

        let _ = fs::remove_dir_all(&cfg);
        let _ = fs::remove_dir_all(&ws);
    }
}
