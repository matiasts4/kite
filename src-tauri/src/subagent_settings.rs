//! Persistent configuration for cross-provider subagent model stacks,
//! default lightweight delegation, explicit override policies, and role profiles.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::chat::models::canonical_thread_provider_id;
use crate::dispatch::address::is_alias_name;
use crate::dispatch::cli::{normalize_effort, normalize_workspace_mode};
use crate::dispatch::role::{
    format_role_markdown, load_role_from_path, roles_dir, workspace_agents_dir, RoleFile,
};
use crate::persist::{app_state_get, app_state_set_checked, roaming_app_dir};

pub const SUBAGENT_SETTINGS_KEY: &str = "subagentSettings";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OverridePolicy {
    Allow,
    #[default]
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
        if stack.is_empty() {
            stack.push(SubagentStackEntry {
                provider: provider.clone(),
                model: model.clone(),
                effort: effort.clone(),
                enabled: true,
            });
        } else {
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
    // Repair legacy persisted configs where selecting a Default lightweight model left
    // `stack: []` and `overridePolicy: "allow"`, which silently bypassed enforcement.
    if parsed.stack.is_empty()
        && parsed.default_delegation.is_some()
        && parsed.override_policy == OverridePolicy::Allow
    {
        parsed.override_policy = OverridePolicy::Ask;
    }
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

pub fn load_subagent_settings() -> SubagentSettings {
    get_subagent_settings()
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
                    && entry.provider.eq_ignore_ascii_case(&def.provider)
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

impl SubagentSettings {
    /// Applies configured default delegation or enabled stack defaults when the
    /// caller omits `--provider` and/or `--model` for a thread subagent.
    pub fn resolve_thread_selection_defaults(
        &self,
        requested_provider: Option<&str>,
        requested_model: Option<&str>,
        requested_effort: Option<&str>,
    ) -> (Option<String>, Option<String>, Option<String>) {
        let canon_prov = requested_provider
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("inherit"))
            .map(|raw| {
                canonical_thread_provider_id(raw)
                    .map(str::to_string)
                    .unwrap_or_else(|| raw.to_string())
            });
        let clean_model = requested_model
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("inherit"))
            .map(str::to_string);
        let clean_effort = requested_effort
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("inherit"))
            .map(str::to_string);

        if clean_model.is_none() {
            if let Some(ref p) = canon_prov {
                if let Some(def) = self
                    .default_delegation
                    .as_ref()
                    .filter(|d| d.provider.eq_ignore_ascii_case(p))
                {
                    let allowed = self.stack.is_empty()
                        || self.stack.iter().any(|entry| {
                            entry.enabled
                                && entry.provider.eq_ignore_ascii_case(&def.provider)
                                && entry.model.eq_ignore_ascii_case(&def.model)
                        });
                    if allowed {
                        return (
                            canon_prov,
                            Some(def.model.clone()),
                            clean_effort.or_else(|| def.effort.clone()),
                        );
                    }
                }
                if let Some(first) = self
                    .stack
                    .iter()
                    .find(|e| e.enabled && e.provider.eq_ignore_ascii_case(p))
                {
                    return (
                        canon_prov,
                        Some(first.model.clone()),
                        clean_effort.or_else(|| first.effort.clone()),
                    );
                }
                return (canon_prov, None, clean_effort);
            }
            if let Some((dp, dm, de)) = resolve_default_delegation(self) {
                return (Some(dp), Some(dm), clean_effort.or(de));
            }
            return (None, None, clean_effort);
        }

        if let (None, Some(ref m)) = (&canon_prov, &clean_model) {
            if let Some(def) = self
                .default_delegation
                .as_ref()
                .filter(|d| d.model.eq_ignore_ascii_case(m.trim()))
            {
                return (
                    Some(def.provider.clone()),
                    clean_model,
                    clean_effort.or_else(|| def.effort.clone()),
                );
            }
            if let Some(matched) = self
                .stack
                .iter()
                .find(|e| e.enabled && e.model.eq_ignore_ascii_case(m.trim()))
            {
                return (
                    Some(matched.provider.clone()),
                    clean_model,
                    clean_effort.or_else(|| matched.effort.clone()),
                );
            }
        }

        if let (Some(ref p), Some(ref m)) = (&canon_prov, &clean_model) {
            if clean_effort.is_none() {
                if let Some(def) = self.default_delegation.as_ref().filter(|d| {
                    d.provider.eq_ignore_ascii_case(p) && d.model.eq_ignore_ascii_case(m)
                }) {
                    return (canon_prov, clean_model, def.effort.clone());
                }
                if let Some(matched) = self.stack.iter().find(|e| {
                    e.enabled
                        && e.provider.eq_ignore_ascii_case(p)
                        && e.model.eq_ignore_ascii_case(m)
                }) {
                    return (canon_prov, clean_model, matched.effort.clone());
                }
            }
        }

        (canon_prov, clean_model, clean_effort)
    }
}

/// Applies configured default delegation or single-entry stack defaults when the
/// caller omits `--provider` and/or `--model` for a thread subagent.
pub fn resolve_thread_selection_defaults(
    settings: &SubagentSettings,
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> (Option<String>, Option<String>, Option<String>) {
    settings.resolve_thread_selection_defaults(
        provider.as_deref(),
        model.as_deref(),
        effort.as_deref(),
    )
}

pub fn is_heavy_or_deep_thinking_model(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    lower.contains("thinking")
        || lower.contains("argon")
        || lower.contains("opus")
        || lower.contains("pro-high")
        || lower.contains("heavy")
}

pub fn is_lightweight_model_id(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    lower.contains("flash")
        || lower.contains("haiku")
        || lower.contains("mini")
        || lower.contains("lite")
        || lower.contains("fast")
        || lower.contains("sonnet-5-5")
}

/// Picks a fast/lightweight model for `provider` from `available_models` (if non-empty)
/// or known fast defaults before ever falling back to a heavy parent model.
pub fn preferred_lightweight_model(
    provider: &str,
    available_models: &[String],
    parent_model: Option<&str>,
) -> Option<String> {
    let canon = canonical_thread_provider_id(provider).unwrap_or(provider);
    let valid_available: Vec<&String> = available_models
        .iter()
        .filter(|m| {
            let trimmed = m.trim();
            !trimmed.is_empty()
                && !trimmed.eq_ignore_ascii_case("inherit")
                && !crate::chat::models::model_likely_belongs_to_another_provider(canon, trimmed)
        })
        .collect();

    let find_matching = |needles: &[&str]| -> Option<String> {
        for needle in needles {
            if let Some(found) = valid_available
                .iter()
                .find(|m| m.to_ascii_lowercase().contains(needle))
            {
                return Some((*found).clone());
            }
        }
        None
    };

    let first_non_heavy = || -> Option<String> {
        valid_available
            .iter()
            .find(|m| !is_heavy_or_deep_thinking_model(m))
            .map(|m| (*m).clone())
    };

    let fallback_parent = || -> Option<String> {
        parent_model
            .map(str::trim)
            .filter(|m| {
                !m.is_empty()
                    && !m.eq_ignore_ascii_case("inherit")
                    && !is_heavy_or_deep_thinking_model(m)
                    && !crate::chat::models::model_likely_belongs_to_another_provider(canon, m)
            })
            .map(str::to_string)
    };

    match canon.to_ascii_lowercase().as_str() {
        "antigravity" => {
            if let Some(exact) = valid_available
                .iter()
                .find(|m| m.eq_ignore_ascii_case("gemini-4-hydrogen"))
            {
                return Some((*exact).clone());
            }
            if let Some(hydrogen) = find_matching(&["hydrogen", "flash", "lite", "haiku"]) {
                return Some(hydrogen);
            }
            if let Some(non_heavy) = first_non_heavy() {
                return Some(non_heavy);
            }
            Some("gemini-4-hydrogen".to_string())
        }
        "claude" => {
            if let Some(fast) = find_matching(&["haiku", "sonnet"]) {
                return Some(fast);
            }
            if let Some(non_heavy) = first_non_heavy() {
                return Some(non_heavy);
            }
            Some("claude-haiku-4-5".to_string())
        }
        "grok" => find_matching(&["fast", "mini"])
            .or_else(first_non_heavy)
            .or_else(|| valid_available.first().map(|m| (*m).clone()))
            .or_else(fallback_parent),
        "codex" => find_matching(&["mini", "fast"])
            .or_else(first_non_heavy)
            .or_else(|| valid_available.first().map(|m| (*m).clone()))
            .or_else(fallback_parent),
        "gemini" => find_matching(&["flash", "lite"])
            .or_else(first_non_heavy)
            .or_else(|| valid_available.first().map(|m| (*m).clone()))
            .or_else(fallback_parent),
        _ => find_matching(&["flash", "haiku", "mini", "fast", "lite"])
            .or_else(first_non_heavy)
            .or_else(|| valid_available.first().map(|m| (*m).clone()))
            .or_else(fallback_parent),
    }
}

/// Alias for `preferred_lightweight_model` used across subagent and swarm spawn paths.
pub fn pick_lightweight_model_for_provider(
    provider: &str,
    available_models: &[String],
    parent_model: Option<&str>,
) -> Option<String> {
    preferred_lightweight_model(provider, available_models, parent_model)
}

/// Sanitizes subagent reasoning effort so parent `persist::last_effort()` values such as
/// `"xhigh"`, `"max"`, or `"ultra"` are never inherited implicitly, and explicit ultra-high
/// efforts are clamped to `"high"` on lightweight/non-thinking models.
pub fn sanitize_subagent_effort(
    provider: &str,
    target_model: Option<&str>,
    parent_model: Option<&str>,
    requested_effort: Option<&str>,
) -> Option<String> {
    let raw = requested_effort
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("inherit"))?;
    let eff = normalize_effort(raw).unwrap_or_else(|| raw.to_ascii_lowercase());
    let eff = crate::chat::models::resolve_effective_effort_for_provider(
        provider,
        None,
        target_model,
        Some(&eff),
    )?;
    if matches!(eff.as_str(), "xhigh" | "max" | "ultra") {
        let should_clamp = match target_model.map(str::trim).filter(|s| !s.is_empty()) {
            Some(target) => {
                let differs_from_parent = parent_model
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .is_none_or(|pm| !pm.eq_ignore_ascii_case(target));
                is_lightweight_model_id(target)
                    || (differs_from_parent && !is_heavy_or_deep_thinking_model(target))
            }
            None => true,
        };
        if should_clamp {
            return Some("high".to_string());
        }
    }
    Some(eff)
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
    let mut effective_enabled: Vec<SubagentStackEntry> = settings
        .stack
        .iter()
        .filter(|e| e.enabled)
        .cloned()
        .collect();
    if effective_enabled.is_empty() {
        if let Some(def) = settings.default_delegation.as_ref() {
            effective_enabled.push(SubagentStackEntry {
                provider: def.provider.clone(),
                model: def.model.clone(),
                effort: def.effort.clone(),
                enabled: true,
            });
        }
    }
    if effective_enabled.is_empty() {
        if settings.override_policy == OverridePolicy::Strict {
            return Err(
                "Subagent model stack has no enabled entries under `strict` override policy. Enable at least one model in Settings -> Subagents."
                    .to_string(),
            );
        }
        return Ok(());
    }

    let in_stack = match (canon_prov, model.map(str::trim).filter(|s| !s.is_empty())) {
        (Some(p), Some(m)) => effective_enabled
            .iter()
            .any(|e| e.provider == p && e.model.eq_ignore_ascii_case(m)),
        (Some(p), None) => effective_enabled.iter().any(|e| e.provider == p),
        (None, Some(m)) => effective_enabled
            .iter()
            .any(|e| e.model.eq_ignore_ascii_case(m)),
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
    let stack_summary: Vec<String> = effective_enabled
        .iter()
        .map(|e| format!("{}/{}", e.provider, e.model))
        .collect();
    let guidance = match (settings.default_delegation.as_ref(), stack_summary.as_slice()) {
        (Some(def), _) => format!(
            "Omit `--provider` and `--model` to use your configured default (`{}/{}`), or pick from the enabled stack: [{}].",
            def.provider,
            def.model,
            stack_summary.join(", ")
        ),
        (None, _) => format!(
            "Omit `--provider` and `--model` to use the enabled stack default (`{}`), or pick from: [{}].",
            stack_summary.first().map(String::as_str).unwrap_or(""),
            stack_summary.join(", ")
        ),
    };
    match settings.override_policy {
        OverridePolicy::Allow => Ok(()),
        OverridePolicy::Ask => {
            if override_stack {
                Ok(())
            } else {
                Err(format!(
                    "`{target_label}` is outside the configured Subagents stack (override policy: ask). {guidance} Confirm with the user before retrying with `--override-stack`."
                ))
            }
        }
        OverridePolicy::Strict => Err(format!(
            "`{target_label}` is blocked by Settings -> Subagents (override policy: strict). {guidance}"
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
        let Ok(parsed) = load_role_from_path(&path) else {
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

fn append_plugin_roles(
    plugins: &[crate::plugin_runtime::types::DiscoveredPlugin],
    out: &mut Vec<SubagentRoleRecord>,
) {
    for plugin in plugins {
        if !plugin.enabled {
            continue;
        }
        let scope = format!("plugin:{}", plugin.dir_id);
        for agent in &plugin.agents {
            let slug = agent.slug.trim();
            if slug.is_empty()
                || out
                    .iter()
                    .any(|existing| existing.slug.eq_ignore_ascii_case(slug))
            {
                continue;
            }
            out.push(SubagentRoleRecord {
                slug: slug.to_string(),
                scope: scope.clone(),
                path: agent.path.to_string_lossy().to_string(),
                command: "auto".to_string(),
                description: agent.description.clone(),
                provider: agent.provider.clone(),
                model: agent.model.clone(),
                effort: agent.effort.clone(),
                workspace: agent.workspace.clone(),
                body: agent.body.clone(),
            });
        }
    }
}

pub fn list_roles_in_roots(config_dir: &Path, workspace_path: Option<&Path>) -> Vec<SubagentRoleRecord> {
    let mut out = Vec::new();
    if let Some(ws) = workspace_path {
        scan_roles_in_dir(&workspace_agents_dir(ws), "workspace", &mut out);
    }
    scan_roles_in_dir(&roles_dir(config_dir), "global", &mut out);
    let plugins = if cfg!(test) {
        let settings = crate::plugin_runtime::types::PluginRuntimeSettings {
            enable_shared_system_roots: false,
            ..Default::default()
        };
        crate::plugin_runtime::registry::discover_plugins_at(
            config_dir,
            None,
            workspace_path,
            &settings,
        )
    } else {
        crate::plugin_runtime::registry::discover_plugins(workspace_path)
    };
    append_plugin_roles(&plugins, &mut out);
    out
}

pub fn list_roles(workspace_path: Option<&Path>) -> Vec<SubagentRoleRecord> {
    if cfg!(test) {
        return workspace_path
            .map(|ws| {
                let mut out = Vec::new();
                scan_roles_in_dir(&workspace_agents_dir(ws), "workspace", &mut out);
                let settings = crate::plugin_runtime::types::PluginRuntimeSettings {
                    enable_shared_system_roots: false,
                    ..Default::default()
                };
                let plugins = crate::plugin_runtime::registry::discover_plugins_at(
                    &roaming_app_dir(),
                    None,
                    Some(ws),
                    &settings,
                );
                append_plugin_roles(&plugins, &mut out);
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
    fn legacy_default_delegation_with_empty_stack_upgrades_to_ask_and_populates_stack() {
        assert_eq!(SubagentSettings::default().override_policy, OverridePolicy::Ask);

        let legacy_raw = r#"{
            "stack": [],
            "defaultDelegation": {
                "provider": "antigravity",
                "model": "gemini-4-hydrogen",
                "effort": null
            },
            "overridePolicy": "allow"
        }"#;
        let recovered = parse_subagent_settings_json(legacy_raw);
        assert_eq!(recovered.override_policy, OverridePolicy::Ask);
        assert_eq!(recovered.stack.len(), 1);
        assert_eq!(recovered.stack[0].provider, "antigravity");
        assert_eq!(recovered.stack[0].model, "gemini-4-hydrogen");
        assert!(recovered.stack[0].enabled);

        let (prov, model, _effort) = resolve_thread_selection_defaults(
            &recovered,
            None,
            Some("gemini-4-hydrogen".to_string()),
            None,
        );
        assert_eq!(prov.as_deref(), Some("antigravity"));
        assert_eq!(model.as_deref(), Some("gemini-4-hydrogen"));

        assert!(check_stack_policy(&recovered, Some("antigravity"), Some("gemini-4-hydrogen"), false).is_ok());
        let err = check_stack_policy(&recovered, Some("grok"), Some("grok-4.7"), false).unwrap_err();
        assert!(err.contains("--override-stack"), "unexpected error: {err}");
        assert!(check_stack_policy(&recovered, Some("grok"), Some("grok-4.7"), true).is_ok());

        let mut stack_only = recovered.clone();
        stack_only.default_delegation = None;
        let stack_only_err =
            check_stack_policy(&stack_only, Some("grok"), Some("grok-4.7"), false).unwrap_err();
        assert!(
            stack_only_err.contains("Omit `--provider` and `--model` to use the enabled stack default"),
            "unexpected stack-only error: {stack_only_err}"
        );
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

    #[test]
    fn lightweight_model_picker_effort_clamp_and_partial_provider_stack_resolution() {
        let agy_catalog = vec![
            "gemini-4-argon".to_string(),
            "gemini-4-hydrogen".to_string(),
            "gemini-3.8-flash".to_string(),
            "claude-opus-4-6".to_string(),
        ];
        assert_eq!(
            pick_lightweight_model_for_provider("antigravity", &agy_catalog, Some("gemini-4-argon")).as_deref(),
            Some("gemini-4-hydrogen")
        );
        assert_eq!(
            pick_lightweight_model_for_provider("antigravity", &[], Some("gemini-4-hydrogen")).as_deref(),
            Some("gemini-4-hydrogen")
        );

        let claude_catalog = vec![
            "claude-opus-4-6".to_string(),
            "claude-haiku-4-5".to_string(),
        ];
        assert_eq!(
            pick_lightweight_model_for_provider("claude", &claude_catalog, Some("claude-opus-4-6")).as_deref(),
            Some("claude-haiku-4-5")
        );
        assert_eq!(
            pick_lightweight_model_for_provider("claude", &[], Some("claude-opus-4-6")).as_deref(),
            Some("claude-haiku-4-5")
        );

        // Effort sanitizer: None / "inherit" -> None; clamps xhigh/max/ultra to high on lightweight models; preserves low/medium/high.
        assert_eq!(
            sanitize_subagent_effort("antigravity", Some("gemini-3.8-flash"), Some("gemini-4-argon"), None),
            None
        );
        assert_eq!(
            sanitize_subagent_effort("antigravity", Some("gemini-3.8-flash"), Some("gemini-4-argon"), Some("inherit")),
            None
        );
        for ultra_eff in ["xhigh", "max", "ultra"] {
            assert_eq!(
                sanitize_subagent_effort(
                    "antigravity",
                    Some("gemini-3.8-flash"),
                    Some("gemini-4-argon"),
                    Some(ultra_eff),
                )
                .as_deref(),
                Some("high"),
                "expected {ultra_eff} to clamp to high on lightweight model"
            );
        }
        for safe_eff in ["low", "medium", "high"] {
            assert_eq!(
                sanitize_subagent_effort(
                    "antigravity",
                    Some("gemini-3.8-flash"),
                    Some("gemini-4-argon"),
                    Some(safe_eff),
                )
                .as_deref(),
                Some(safe_eff)
            );
        }
        assert_eq!(
            sanitize_subagent_effort(
                "antigravity",
                Some("gemini-pro-orchestrator-neon"),
                Some("gemini-4-neon"),
                Some("high"),
            ),
            None,
            "orchestrator models do not accept --effort"
        );

        // Partial `--provider` stack resolution when `--model` is omitted
        let settings = normalize_settings(SubagentSettings {
            stack: vec![
                SubagentStackEntry {
                    provider: "antigravity".to_string(),
                    model: "gemini-3.8-flash".to_string(),
                    effort: Some("low".to_string()),
                    enabled: true,
                },
                SubagentStackEntry {
                    provider: "grok".to_string(),
                    model: "grok-4.7-build-fast".to_string(),
                    effort: Some("medium".to_string()),
                    enabled: true,
                },
            ],
            default_delegation: Some(DefaultDelegation {
                provider: "antigravity".to_string(),
                model: "gemini-3.8-flash".to_string(),
                effort: Some("low".to_string()),
            }),
            override_policy: OverridePolicy::Ask,
        })
        .unwrap();

        let (prov, model, effort) =
            settings.resolve_thread_selection_defaults(Some("grok"), None, None);
        assert_eq!(prov.as_deref(), Some("grok"));
        assert_eq!(model.as_deref(), Some("grok-4.7-build-fast"));
        assert_eq!(effort.as_deref(), Some("medium"));
    }

    #[test]
    fn list_roles_appends_enabled_plugin_agents_without_overriding_higher_priority_slugs() {
        let cfg = temp_root("plugin-roles-cfg");
        let ws = temp_root("plugin-roles-ws");

        save_role_in_roots(
            &cfg,
            Some(&ws),
            SaveSubagentRoleInput {
                scope: "workspace".to_string(),
                slug: "reviewer".to_string(),
                command: "auto".to_string(),
                description: Some("Workspace reviewer".to_string()),
                provider: None,
                model: None,
                effort: None,
                workspace: Some("inherit".to_string()),
                body: "Workspace reviewer body.".to_string(),
            },
        )
        .unwrap();

        let ws_plugin = ws.join(".agents").join("plugins").join("android-cli");
        fs::create_dir_all(ws_plugin.join("agents")).unwrap();
        fs::write(ws_plugin.join("plugin.json"), r#"{"name":"android-cli"}"#).unwrap();
        fs::write(
            ws_plugin.join("agents").join("reviewer.md"),
            "---\ndescription: Plugin reviewer override attempt\n---\nPlugin reviewer body.\n",
        )
        .unwrap();
        fs::write(
            ws_plugin.join("agents").join("avd-specialist.md"),
            "---\ndescription: Inspect AVD emulators\nprovider: gemini\nmodel: gemini-2.5-flash\neffort: low\nworkspace: inherit\n---\nRun emulator checks safely.\n",
        )
        .unwrap();

        let disabled_plugin = cfg.join("plugins").join("disabled-ext");
        fs::create_dir_all(disabled_plugin.join("agents")).unwrap();
        fs::write(disabled_plugin.join("plugin.json"), r#"{"name":"disabled-ext"}"#).unwrap();
        fs::write(
            disabled_plugin.join("agents").join("hidden-role.md"),
            "---\ndescription: Should be skipped\n---\nHidden.\n",
        )
        .unwrap();
        crate::plugin_runtime::registry::set_plugin_enabled_at(&cfg, "disabled-ext", false)
            .unwrap();

        let listed = list_roles_in_roots(&cfg, Some(&ws));
        assert_eq!(listed.len(), 2);

        let reviewer = listed.iter().find(|r| r.slug == "reviewer").unwrap();
        assert_eq!(reviewer.scope, "workspace");
        assert_eq!(reviewer.body, "Workspace reviewer body.");

        let avd = listed.iter().find(|r| r.slug == "avd-specialist").unwrap();
        assert_eq!(avd.scope, "plugin:android-cli");
        assert_eq!(avd.command, "auto");
        assert_eq!(avd.description.as_deref(), Some("Inspect AVD emulators"));
        assert_eq!(avd.provider.as_deref(), Some("gemini"));
        assert_eq!(avd.model.as_deref(), Some("gemini-2.5-flash"));
        assert_eq!(avd.effort.as_deref(), Some("low"));
        assert_eq!(avd.workspace.as_deref(), Some("inherit"));
        assert_eq!(avd.body, "Run emulator checks safely.");
        assert!(!listed.iter().any(|r| r.slug == "hidden-role"));

        let via_list_roles = list_roles(Some(&ws));
        assert!(via_list_roles
            .iter()
            .any(|r| r.slug == "avd-specialist" && r.scope == "plugin:android-cli"));

        let _ = fs::remove_dir_all(&cfg);
        let _ = fs::remove_dir_all(&ws);
    }
}
