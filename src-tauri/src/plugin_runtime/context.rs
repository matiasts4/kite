//! Active plugin context assembly (`<plugin_skills>`, `<plugin_rules>`,
//! `<plugin_sidecars>`) and `KITE_ACTIVE_SIDECARS_JSON` serialization for agent turns.

use crate::persist::roaming_app_dir;
use crate::plugin_runtime::types::{
    DiscoveredPlugin, SidecarSpec, SidecarStateKind, SidecarStatusSnapshot,
};
use serde::Serialize;
use std::path::Path;

const MAX_SKILLS_TOTAL_CHARS: usize = 6_000;
const MAX_SINGLE_RULE_CHARS: usize = 6_000;
const MAX_RULES_TOTAL_CHARS: usize = 12_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveSidecarEnvItem {
    namespaced_id: String,
    plugin_id: String,
    display_name: String,
    upstream_port: Option<u16>,
    proxy_url: Option<String>,
    log_path: String,
    sidecar_uri: Option<String>,
}

fn is_plugin_active_for_agent(plugin: &DiscoveredPlugin, disabled_plugin_ids: &[String]) -> bool {
    if !plugin.enabled {
        return false;
    }
    if crate::plugins::is_plugin_disabled(disabled_plugin_ids, &plugin.dir_id) {
        return false;
    }
    if !plugin.name.trim().is_empty()
        && crate::plugins::is_plugin_disabled(disabled_plugin_ids, &plugin.name)
    {
        return false;
    }
    true
}

fn resolve_plugins_for_context(workspace_dir: Option<&Path>) -> Vec<DiscoveredPlugin> {
    let cached = crate::plugin_runtime::cached_discovered_plugins();
    if !cached.is_empty() {
        match workspace_dir {
            Some(ws) if crate::plugin_runtime::current_workspace_dir().as_deref() == Some(ws) => {
                return cached;
            }
            None => return cached,
            _ => {}
        }
    }

    #[cfg(test)]
    {
        let settings = crate::plugin_runtime::types::PluginRuntimeSettings {
            enable_shared_system_roots: false,
            ..Default::default()
        };
        crate::plugin_runtime::registry::discover_plugins_at(
            &roaming_app_dir(),
            None,
            workspace_dir,
            &settings,
        )
    }

    #[cfg(not(test))]
    {
        crate::plugin_runtime::sync_runtime_with_workspace(workspace_dir)
    }
}

fn current_sidecar_snapshots() -> Vec<SidecarStatusSnapshot> {
    #[cfg(test)]
    {
        Vec::new()
    }
    #[cfg(not(test))]
    {
        let pool = crate::plugin_runtime::proxy::global_sidecar_proxy_pool();
        crate::plugin_runtime::sidecar::global_sidecar_supervisor()
            .list_snapshots()
            .into_iter()
            .map(|mut snap| {
                if snap.proxy_url.is_none() {
                    if let Some(ep) = pool.get_endpoint(&snap.namespaced_id) {
                        snap.proxy_port = Some(ep.port);
                        snap.proxy_url = Some(ep.proxy_url);
                    }
                }
                snap
            })
            .collect()
    }
}

fn sanitize_path_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '\0' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

fn default_sidecar_log_path(spec: &SidecarSpec) -> String {
    roaming_app_dir()
        .join("sidecar_data")
        .join(sanitize_path_segment(&spec.plugin_id))
        .join(sanitize_path_segment(&spec.id))
        .join("logs")
        .join("sidecar.log")
        .to_string_lossy()
        .to_string()
}

fn find_snapshot<'a>(
    snapshots: &'a [SidecarStatusSnapshot],
    namespaced_id: &str,
) -> Option<&'a SidecarStatusSnapshot> {
    snapshots
        .iter()
        .find(|s| s.namespaced_id == namespaced_id)
        .or_else(|| {
            snapshots
                .iter()
                .find(|s| s.namespaced_id.eq_ignore_ascii_case(namespaced_id))
        })
}

fn live_upstream_port_for(snap: Option<&SidecarStatusSnapshot>) -> Option<u16> {
    snap.and_then(|s| match s.state {
        SidecarStateKind::Running | SidecarStateKind::Starting => s.upstream_port,
        SidecarStateKind::Unhealthy
        | SidecarStateKind::Stopped
        | SidecarStateKind::Crashed
        | SidecarStateKind::Stopping => None,
    })
}

fn sidecar_state_label(state: SidecarStateKind) -> &'static str {
    match state {
        SidecarStateKind::Stopped => "stopped",
        SidecarStateKind::Starting => "starting",
        SidecarStateKind::Running => "running",
        SidecarStateKind::Unhealthy => "unhealthy",
        SidecarStateKind::Crashed => "crashed",
        SidecarStateKind::Stopping => "stopping",
    }
}

fn build_sidecar_uri(spec: &SidecarSpec) -> Option<String> {
    if !spec.has_web_ui {
        return None;
    }
    let default_view = spec
        .views
        .first()
        .map(|v| v.path.trim())
        .filter(|p| !p.is_empty())
        .unwrap_or("/");
    let clean_view = default_view.trim_start_matches('/');
    Some(format!("sidecar://{}/{}", spec.namespaced_id, clean_view))
}

fn collapse_single_line(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars_with_suffix(text: &str, max_chars: usize, suffix: &str) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let suffix_chars = suffix.chars().count();
    if max_chars <= suffix_chars {
        return text.chars().take(max_chars).collect();
    }
    let keep = max_chars - suffix_chars;
    let end_byte = text
        .char_indices()
        .nth(keep)
        .map(|(idx, _)| idx)
        .unwrap_or(text.len());
    format!("{}{}", text[..end_byte].trim_end(), suffix)
}

fn format_skills_section(active_plugins: &[&DiscoveredPlugin]) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut total_chars = 0usize;
    let mut omitted = 0usize;

    for plugin in active_plugins {
        let plugin_key = if plugin.dir_id.trim().is_empty() {
            plugin.name.trim()
        } else {
            plugin.dir_id.trim()
        };
        for skill in &plugin.skills {
            if skill.disable_model_invocation {
                continue;
            }
            let skill_name = if skill.name.trim().is_empty() {
                skill.id.trim()
            } else {
                skill.name.trim()
            };
            if skill_name.is_empty() {
                continue;
            }
            let desc = collapse_single_line(&skill.description);
            let path_display = skill.path.to_string_lossy();
            let line = if desc.is_empty() {
                format!("- {plugin_key}/{skill_name} ({path_display})")
            } else {
                format!("- {plugin_key}/{skill_name}: {desc} ({path_display})")
            };
            let line_chars = line.chars().count() + 1;
            if total_chars + line_chars > MAX_SKILLS_TOTAL_CHARS {
                omitted += 1;
                continue;
            }
            total_chars += line_chars;
            lines.push(line);
        }
    }

    if lines.is_empty() {
        return None;
    }

    let mut out = String::from(
        "<plugin_skills>\nActive extension skills (read a skill's SKILL.md path on demand before executing its workflow):\n",
    );
    out.push_str(&lines.join("\n"));
    if omitted > 0 {
        out.push_str(&format!("\n- ... ({omitted} additional skills omitted)"));
    }
    out.push_str("\n</plugin_skills>");
    Some(out)
}

fn format_rules_section(active_plugins: &[&DiscoveredPlugin]) -> Option<String> {
    let mut blocks: Vec<String> = Vec::new();
    let mut used_chars = 0usize;

    'outer: for plugin in active_plugins {
        let plugin_key = if plugin.dir_id.trim().is_empty() {
            plugin.name.trim()
        } else {
            plugin.dir_id.trim()
        };
        for rule in &plugin.rules {
            let trimmed = rule.content.trim();
            if trimmed.is_empty() {
                continue;
            }
            let remaining = MAX_RULES_TOTAL_CHARS.saturating_sub(used_chars);
            if remaining == 0 {
                break 'outer;
            }
            let header = format!("### {plugin_key}/{}", rule.name.trim());
            let header_chars = header.chars().count() + 2;
            if remaining <= header_chars + 16 {
                break 'outer;
            }
            let body_budget = (remaining - header_chars).min(MAX_SINGLE_RULE_CHARS);
            let bounded_body =
                truncate_chars_with_suffix(trimmed, body_budget, "\n... [truncated]");
            let block = format!("{header}\n{bounded_body}");
            used_chars += block.chars().count() + 2;
            blocks.push(block);
        }
    }

    if blocks.is_empty() {
        return None;
    }

    Some(format!(
        "<plugin_rules>\n{}\n</plugin_rules>",
        blocks.join("\n\n")
    ))
}

fn format_sidecars_section(
    active_plugins: &[&DiscoveredPlugin],
    snapshots: &[SidecarStatusSnapshot],
) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    for plugin in active_plugins {
        for spec in &plugin.sidecars {
            if spec.builtin.is_some() {
                continue;
            }
            let snap = find_snapshot(snapshots, &spec.namespaced_id);
            let state = snap.map(|s| s.state).unwrap_or(SidecarStateKind::Stopped);
            let state_str = sidecar_state_label(state);
            let upstream_str = match live_upstream_port_for(snap) {
                Some(port) => format!("http://127.0.0.1:{port}"),
                None => "not running".to_string(),
            };
            let log_path = snap
                .map(|s| s.log_path.clone())
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(|| default_sidecar_log_path(spec));

            if let Some(uri) = build_sidecar_uri(spec) {
                lines.push(format!(
                    "- {} (UI sidecar \"{}\", state: {}): link [{}]({}), upstream: {}, log: {}",
                    spec.namespaced_id,
                    spec.display_name,
                    state_str,
                    spec.display_name,
                    uri,
                    upstream_str,
                    log_path,
                ));
            } else {
                lines.push(format!(
                    "- {} (background sidecar \"{}\", state: {}): upstream: {}, log: {}",
                    spec.namespaced_id, spec.display_name, state_str, upstream_str, log_path,
                ));
            }
        }
    }

    if lines.is_empty() {
        return None;
    }

    Some(format!(
        "<plugin_sidecars>\nActive plugin sidecars (use [<Display Name>](sidecar://<namespaced_id>/<default_view_path>) in markdown replies to open panels):\n{}\n</plugin_sidecars>",
        lines.join("\n")
    ))
}

/// Pure context builder from pre-discovered plugins and sidecar snapshots.
pub fn build_active_plugin_context_from_plugins(
    plugins: &[DiscoveredPlugin],
    snapshots: &[SidecarStatusSnapshot],
    disabled_plugin_ids: &[String],
) -> Option<String> {
    let active_plugins: Vec<&DiscoveredPlugin> = plugins
        .iter()
        .filter(|p| is_plugin_active_for_agent(p, disabled_plugin_ids))
        .collect();
    if active_plugins.is_empty() {
        return None;
    }

    let mut sections: Vec<String> = Vec::new();
    if let Some(skills) = format_skills_section(&active_plugins) {
        sections.push(skills);
    }
    if let Some(rules) = format_rules_section(&active_plugins) {
        sections.push(rules);
    }
    if let Some(sidecars) = format_sidecars_section(&active_plugins, snapshots) {
        sections.push(sidecars);
    }

    if sections.is_empty() {
        None
    } else {
        Some(sections.join("\n\n"))
    }
}

/// Builds bounded `<plugin_skills>`, `<plugin_rules>`, and `<plugin_sidecars>` context
/// for enabled plugins not excluded in `disabled_plugin_ids`.
pub fn build_active_plugin_context(
    workspace_dir: Option<&Path>,
    disabled_plugin_ids: &[String],
) -> Option<String> {
    let plugins = resolve_plugins_for_context(workspace_dir);
    let snapshots = current_sidecar_snapshots();
    build_active_plugin_context_from_plugins(&plugins, &snapshots, disabled_plugin_ids)
}

/// Pure JSON serializer for `KITE_ACTIVE_SIDECARS_JSON` from plugins and snapshots.
pub fn active_sidecars_env_json_from_plugins(
    plugins: &[DiscoveredPlugin],
    snapshots: &[SidecarStatusSnapshot],
    disabled_plugin_ids: &[String],
) -> Option<String> {
    let mut items: Vec<ActiveSidecarEnvItem> = Vec::new();
    for plugin in plugins {
        if !is_plugin_active_for_agent(plugin, disabled_plugin_ids) {
            continue;
        }
        for spec in &plugin.sidecars {
            if spec.builtin.is_some() {
                continue;
            }
            let snap = find_snapshot(snapshots, &spec.namespaced_id);
            let upstream_port = live_upstream_port_for(snap);
            let proxy_url = snap
                .filter(|_| spec.has_web_ui)
                .and_then(|s| s.proxy_url.clone());
            let log_path = snap
                .map(|s| s.log_path.clone())
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(|| default_sidecar_log_path(spec));
            let sidecar_uri = build_sidecar_uri(spec);

            items.push(ActiveSidecarEnvItem {
                namespaced_id: spec.namespaced_id.clone(),
                plugin_id: spec.plugin_id.clone(),
                display_name: spec.display_name.clone(),
                upstream_port,
                proxy_url,
                log_path,
                sidecar_uri,
            });
        }
    }

    if items.is_empty() {
        None
    } else {
        serde_json::to_string(&items).ok()
    }
}

/// Builds compact JSON array for `KITE_ACTIVE_SIDECARS_JSON` from active workspace plugins.
pub fn active_sidecars_env_json(
    workspace_dir: Option<&Path>,
    disabled_plugin_ids: &[String],
) -> Option<String> {
    let plugins = resolve_plugins_for_context(workspace_dir);
    let snapshots = current_sidecar_snapshots();
    active_sidecars_env_json_from_plugins(&plugins, &snapshots, disabled_plugin_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_runtime::types::{
        PluginManifestFormat, PluginRuleInfo, PluginSkillInfo, PluginSourceKind,
        SidecarRestartPolicy, SidecarUiView,
    };
    use serde_json::Value;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn sample_sidecar(
        plugin_id: &str,
        id: &str,
        display_name: &str,
        has_web_ui: bool,
        view_path: &str,
    ) -> SidecarSpec {
        SidecarSpec {
            id: id.to_string(),
            namespaced_id: format!("{plugin_id}/{id}"),
            plugin_id: plugin_id.to_string(),
            plugin_name: plugin_id.to_string(),
            display_name: display_name.to_string(),
            description: String::new(),
            command: "node".to_string(),
            args: vec!["server.mjs".to_string()],
            env: BTreeMap::new(),
            builtin: None,
            restart_policy: SidecarRestartPolicy::OnFailure,
            has_web_ui,
            views: if has_web_ui {
                vec![SidecarUiView {
                    title: display_name.to_string(),
                    path: view_path.to_string(),
                    entrypoint: "AUX_PANE".to_string(),
                }]
            } else {
                Vec::new()
            },
            working_dir: PathBuf::from(format!("/plugins/{plugin_id}/sidecars/{id}")),
            plugin_root: PathBuf::from(format!("/plugins/{plugin_id}")),
            plugin_data: PathBuf::from(format!("/plugin_data/{plugin_id}")),
            allows_user_interactions: false,
        }
    }

    fn sample_plugin(dir_id: &str, name: &str, enabled: bool) -> DiscoveredPlugin {
        DiscoveredPlugin {
            dir_id: dir_id.to_string(),
            name: name.to_string(),
            display_name: name.to_string(),
            description: String::new(),
            version: None,
            author: None,
            homepage: None,
            repository: None,
            license: None,
            keywords: Vec::new(),
            suggested_prompts: Vec::new(),
            logo_data_uri: None,
            source: PluginSourceKind::GlobalKite,
            format: PluginManifestFormat::Native,
            root_path: PathBuf::from(format!("/plugins/{dir_id}")),
            data_path: PathBuf::from(format!("/plugin_data/{dir_id}")),
            enabled,
            manifest_disabled: !enabled,
            can_uninstall: true,
            has_hooks: false,
            hooks_path: None,
            sidecars: Vec::new(),
            mcp_servers: Vec::new(),
            skills: Vec::new(),
            rules: Vec::new(),
            agents: Vec::new(),
        }
    }

    #[test]
    fn builds_skills_rules_and_sidecar_uri_port_log_sections() {
        let mut android = sample_plugin("android-cli", "Android CLI", true);
        android.skills.push(PluginSkillInfo {
            id: "device-hub".to_string(),
            name: "device-hub".to_string(),
            description: "Mirror and control Android devices.\nSupports AVDs.".to_string(),
            path: PathBuf::from("/plugins/android-cli/skills/device-hub/SKILL.md"),
            disable_model_invocation: false,
        });
        android.skills.push(PluginSkillInfo {
            id: "manual-only".to_string(),
            name: "manual-only".to_string(),
            description: "Should not appear in model index".to_string(),
            path: PathBuf::from("/plugins/android-cli/skills/manual-only/SKILL.md"),
            disable_model_invocation: true,
        });
        android.rules.push(PluginRuleInfo {
            name: "AGENTS.md".to_string(),
            path: PathBuf::from("/plugins/android-cli/rules/AGENTS.md"),
            content: "Always check adb devices before launching an emulator.".to_string(),
        });
        android.sidecars.push(sample_sidecar(
            "android-cli",
            "device-hub",
            "Device Hub",
            true,
            "/devices",
        ));
        android.sidecars.push(sample_sidecar(
            "android-cli",
            "adb-daemon",
            "ADB Daemon",
            false,
            "/",
        ));

        let snapshots = vec![
            SidecarStatusSnapshot {
                namespaced_id: "android-cli/device-hub".to_string(),
                sidecar_id: "device-hub".to_string(),
                plugin_id: "android-cli".to_string(),
                plugin_name: "Android CLI".to_string(),
                display_name: "Device Hub".to_string(),
                description: String::new(),
                has_web_ui: true,
                views: android.sidecars[0].views.clone(),
                state: SidecarStateKind::Running,
                pid: Some(4242),
                upstream_port: Some(45123),
                proxy_port: Some(50123),
                proxy_url: Some("http://127.0.0.1:50123".to_string()),
                entry_url: Some("http://127.0.0.1:50123/devices?__kite_token=tok".to_string()),
                log_path: "/logs/android-cli/device-hub/sidecar.log".to_string(),
                restart_count: 0,
                last_error: None,
                started_at_ms: Some(1_000),
                builtin: None,
            },
            SidecarStatusSnapshot {
                namespaced_id: "android-cli/adb-daemon".to_string(),
                sidecar_id: "adb-daemon".to_string(),
                plugin_id: "android-cli".to_string(),
                plugin_name: "Android CLI".to_string(),
                display_name: "ADB Daemon".to_string(),
                description: String::new(),
                has_web_ui: false,
                views: Vec::new(),
                state: SidecarStateKind::Stopped,
                pid: None,
                upstream_port: Some(9999),
                proxy_port: None,
                proxy_url: None,
                entry_url: None,
                log_path: "/logs/android-cli/adb-daemon/sidecar.log".to_string(),
                restart_count: 0,
                last_error: None,
                started_at_ms: None,
                builtin: None,
            },
        ];

        let ctx = build_active_plugin_context_from_plugins(&[android.clone()], &snapshots, &[])
            .expect("context should be built");
        assert!(ctx.contains("<plugin_skills>"));
        assert!(ctx.contains("- android-cli/device-hub: Mirror and control Android devices. Supports AVDs. (/plugins/android-cli/skills/device-hub/SKILL.md)"));
        assert!(!ctx.contains("manual-only"));
        assert!(ctx.contains("<plugin_rules>"));
        assert!(ctx.contains("### android-cli/AGENTS.md"));
        assert!(ctx.contains("Always check adb devices before launching an emulator."));
        assert!(ctx.contains("<plugin_sidecars>"));
        assert!(ctx.contains("[Device Hub](sidecar://android-cli/device-hub/devices)"));
        assert!(ctx.contains("http://127.0.0.1:45123"));
        assert!(ctx.contains("/logs/android-cli/device-hub/sidecar.log"));
        // Stopped sidecar must not emit a live port URL.
        assert!(!ctx.contains("127.0.0.1:9999"));
        assert!(ctx.contains("/logs/android-cli/adb-daemon/sidecar.log"));

        let env_json =
            active_sidecars_env_json_from_plugins(&[android], &snapshots, &[]).expect("env json");
        assert!(!env_json.contains('\n'), "must be compact JSON");
        let parsed: Vec<Value> = serde_json::from_str(&env_json).expect("valid json array");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["namespacedId"], "android-cli/device-hub");
        assert_eq!(parsed[0]["pluginId"], "android-cli");
        assert_eq!(parsed[0]["displayName"], "Device Hub");
        assert_eq!(parsed[0]["upstreamPort"], 45123);
        assert_eq!(parsed[0]["proxyUrl"], "http://127.0.0.1:50123");
        assert_eq!(parsed[0]["logPath"], "/logs/android-cli/device-hub/sidecar.log");
        assert_eq!(parsed[0]["sidecarUri"], "sidecar://android-cli/device-hub/devices");
        assert!(parsed[1]["upstreamPort"].is_null());
        assert!(parsed[1]["sidecarUri"].is_null());
    }

    #[test]
    fn excludes_disabled_plugins_by_state_dir_id_or_name_and_bounds_rules() {
        let mut disabled_globally = sample_plugin("globally-off", "Globally Off", false);
        disabled_globally.rules.push(PluginRuleInfo {
            name: "OFF.md".to_string(),
            path: PathBuf::from("/plugins/globally-off/rules/OFF.md"),
            content: "Must never appear".to_string(),
        });

        let mut agent_disabled_by_name = sample_plugin("ext-dir", "BlockedName", true);
        agent_disabled_by_name.rules.push(PluginRuleInfo {
            name: "NAME.md".to_string(),
            path: PathBuf::from("/plugins/ext-dir/rules/NAME.md"),
            content: "Must be excluded when plugin.name is disabled".to_string(),
        });

        let mut active = sample_plugin("active-ext", "Active Ext", true);
        active.rules.push(PluginRuleInfo {
            name: "R1.md".to_string(),
            path: PathBuf::from("/plugins/active-ext/rules/R1.md"),
            content: "á".repeat(8_000),
        });
        active.rules.push(PluginRuleInfo {
            name: "R2.md".to_string(),
            path: PathBuf::from("/plugins/active-ext/rules/R2.md"),
            content: "b".repeat(8_000),
        });
        active.rules.push(PluginRuleInfo {
            name: "R3.md".to_string(),
            path: PathBuf::from("/plugins/active-ext/rules/R3.md"),
            content: "c".repeat(8_000),
        });
        active.sidecars.push(sample_sidecar(
            "active-ext",
            "panel",
            "Active Panel",
            true,
            "/",
        ));

        let plugins = vec![disabled_globally, agent_disabled_by_name, active];
        let ctx = build_active_plugin_context_from_plugins(
            &plugins,
            &[],
            &["blockedname".to_string()],
        )
        .expect("active context");

        assert!(!ctx.contains("Must never appear"));
        assert!(!ctx.contains("BlockedName"));
        assert!(ctx.contains("### active-ext/R1.md"));
        assert!(ctx.contains("sidecar://active-ext/panel/"));
        let rules_start = ctx.find("<plugin_rules>").unwrap();
        let rules_end = ctx.find("</plugin_rules>").unwrap();
        let rules_len = ctx[rules_start..rules_end].chars().count();
        assert!(
            rules_len <= MAX_RULES_TOTAL_CHARS + 64,
            "rules section exceeded bound: {rules_len}"
        );

        // Disabling `active-ext` by dir_id removes everything -> None.
        assert!(build_active_plugin_context_from_plugins(
            &plugins,
            &[],
            &["blockedname".to_string(), "active-ext".to_string()],
        )
        .is_none());
        assert!(active_sidecars_env_json_from_plugins(
            &plugins,
            &[],
            &["active-ext".to_string()],
        )
        .is_none());
    }

    #[test]
    fn resolves_workspace_plugins_from_disk_and_honors_disabled_ids() {
        let ws = std::env::temp_dir().join(format!(
            "kite-plugin-ctx-ws-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let plugin_dir = ws.join(".agents").join("plugins").join("ws-android");
        std::fs::create_dir_all(plugin_dir.join("skills").join("avd")).unwrap();
        std::fs::create_dir_all(plugin_dir.join("rules")).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"ws-android","displayName":"Workspace Android"}"#,
        )
        .unwrap();
        std::fs::write(
            plugin_dir.join("skills").join("avd").join("SKILL.md"),
            "---\nname: avd\ndescription: Manage virtual devices\n---\nInstructions.\n",
        )
        .unwrap();
        std::fs::write(
            plugin_dir.join("rules").join("AGENTS.md"),
            "Use headless emulator flags in CI.",
        )
        .unwrap();

        let ctx = build_active_plugin_context(Some(&ws), &[]).expect("workspace plugin ctx");
        assert!(ctx.contains("ws-android/avd: Manage virtual devices"));
        assert!(ctx.contains("Use headless emulator flags in CI."));
        assert!(build_active_plugin_context(Some(&ws), &["ws-android".to_string()]).is_none());

        let _ = std::fs::remove_dir_all(&ws);
    }
}
