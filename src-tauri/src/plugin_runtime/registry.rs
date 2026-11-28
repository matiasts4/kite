//! Filesystem-backed plugin discovery, external state persistence, and bundle installers.

use crate::hidden_exec;
use crate::persist::roaming_app_dir;
use crate::plugin_runtime::manifest::{
    find_manifest_file, is_safe_single_segment, parse_jsonc_value, parse_plugin_bundle,
    parse_plugin_bundle_with_dir_id, validate_relative_path_inside_root,
};
use crate::plugin_runtime::types::{
    DiscoveredPlugin, PluginManifestFormat, PluginRuntimeSettings, PluginSourceKind,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const GIT_CLONE_TIMEOUT_SECS: u64 = 120;
const ARCHIVE_EXTRACT_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRuntimeState {
    #[serde(default)]
    pub enabled_overrides: BTreeMap<String, bool>,
}

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn create(prefix: &str) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!(
            "kite-plugin-{prefix}-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir)
            .map_err(|err| format!("Failed to create temporary directory: {err}"))?;
        Ok(Self { path: dir })
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn settings_path_at(app_dir: &Path) -> PathBuf {
    app_dir.join("plugin_runtime_settings.json")
}

pub fn state_path_at(app_dir: &Path) -> PathBuf {
    app_dir.join("plugin_runtime_state.json")
}

pub fn global_plugins_dir_at(app_dir: &Path) -> PathBuf {
    app_dir.join("plugins")
}

pub fn plugin_data_root_at(app_dir: &Path) -> PathBuf {
    app_dir.join("plugin_data")
}

fn resolve_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let raw = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"));
    #[cfg(not(windows))]
    let raw = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"));

    raw.ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid persistence path: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Could not create directory {}: {err}", parent.display()))?;

    let serialized = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Could not serialize JSON for {}: {err}", path.display()))?;

    let tmp_path = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("state"),
        Uuid::new_v4().simple()
    ));
    fs::write(&tmp_path, serialized)
        .map_err(|err| format!("Could not write {}: {err}", tmp_path.display()))?;

    if let Err(err) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Could not commit {}: {err}", path.display()));
    }
    Ok(())
}

pub fn load_runtime_settings_at(app_dir: &Path) -> PluginRuntimeSettings {
    let path = settings_path_at(app_dir);
    let Ok(raw) = fs::read_to_string(&path) else {
        return PluginRuntimeSettings::default();
    };
    let Ok(val) = parse_jsonc_value(&raw) else {
        return PluginRuntimeSettings::default();
    };
    serde_json::from_value::<PluginRuntimeSettings>(val).unwrap_or_default()
}

pub fn save_runtime_settings_at(
    app_dir: &Path,
    settings: &PluginRuntimeSettings,
) -> Result<(), String> {
    atomic_write_json(&settings_path_at(app_dir), settings)
}

pub fn load_runtime_settings() -> PluginRuntimeSettings {
    load_runtime_settings_at(&roaming_app_dir())
}

pub fn save_runtime_settings(settings: &PluginRuntimeSettings) -> Result<(), String> {
    save_runtime_settings_at(&roaming_app_dir(), settings)
}

pub fn load_runtime_state_at(app_dir: &Path) -> PluginRuntimeState {
    let path = state_path_at(app_dir);
    let Ok(raw) = fs::read_to_string(&path) else {
        return PluginRuntimeState::default();
    };
    let Ok(val) = parse_jsonc_value(&raw) else {
        return PluginRuntimeState::default();
    };
    if val.get("enabledOverrides").is_some() {
        if let Ok(state) = serde_json::from_value::<PluginRuntimeState>(val.clone()) {
            return state;
        }
    }
    if let Some(obj) = val.as_object() {
        let mut overrides = BTreeMap::new();
        for (k, v) in obj {
            if let Some(flag) = v.as_bool() {
                overrides.insert(k.clone(), flag);
            }
        }
        return PluginRuntimeState {
            enabled_overrides: overrides,
        };
    }
    PluginRuntimeState::default()
}

fn save_runtime_state_at(app_dir: &Path, state: &PluginRuntimeState) -> Result<(), String> {
    atomic_write_json(&state_path_at(app_dir), state)
}

pub fn set_plugin_enabled_at(
    app_dir: &Path,
    dir_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let trimmed = dir_id.trim();
    if !is_safe_single_segment(trimmed) {
        return Err(format!("Invalid plugin ID: '{dir_id}'"));
    }
    let mut state = load_runtime_state_at(app_dir);
    state
        .enabled_overrides
        .insert(trimmed.to_string(), enabled);
    save_runtime_state_at(app_dir, &state)
}

pub fn set_plugin_enabled(dir_id: &str, enabled: bool) -> Result<(), String> {
    set_plugin_enabled_at(&roaming_app_dir(), dir_id, enabled)
}

fn normalize_plugin_key(raw: &str) -> String {
    raw.trim().to_ascii_lowercase()
}

#[derive(Default)]
struct WorkspaceInheritance {
    allow_inherited: bool,
    include_only: Option<HashSet<String>>,
    exclude: HashSet<String>,
}

impl WorkspaceInheritance {
    fn allows(&self, dir_id: &str, name: &str) -> bool {
        if !self.allow_inherited {
            return false;
        }
        let d_key = normalize_plugin_key(dir_id);
        let n_key = normalize_plugin_key(name);
        if let Some(ref only) = self.include_only {
            if !only.contains(&d_key) && !only.contains(&n_key) {
                return false;
            }
        }
        if self.exclude.contains(&d_key) || self.exclude.contains(&n_key) {
            return false;
        }
        true
    }
}

struct WorkspacePluginEntry {
    path: String,
    disabled_override: Option<bool>,
}

struct WorkspacePluginsConfig {
    entries: Vec<WorkspacePluginEntry>,
    inheritance: WorkspaceInheritance,
}

impl Default for WorkspacePluginsConfig {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            inheritance: WorkspaceInheritance {
                allow_inherited: true,
                include_only: None,
                exclude: HashSet::new(),
            },
        }
    }
}

fn extract_entry_from_value(val: &Value) -> Option<WorkspacePluginEntry> {
    match val {
        Value::String(path) => {
            let trimmed = path.trim();
            (!trimmed.is_empty()).then(|| WorkspacePluginEntry {
                path: trimmed.to_string(),
                disabled_override: None,
            })
        }
        Value::Object(obj) => {
            let path = obj
                .get("path")
                .or_else(|| obj.get("dir"))
                .and_then(Value::as_str)
                .or_else(|| {
                    obj.get("source").and_then(|s| match s {
                        Value::String(p) => Some(p.as_str()),
                        Value::Object(so) => so.get("path").and_then(Value::as_str),
                        _ => None,
                    })
                })?
                .trim()
                .to_string();
            if path.is_empty() {
                return None;
            }
            let disabled_override = if let Some(disabled) = obj.get("disabled").and_then(Value::as_bool) {
                Some(disabled)
            } else {
                obj.get("enabled")
                    .and_then(Value::as_bool)
                    .map(|enabled| !enabled)
            };
            Some(WorkspacePluginEntry {
                path,
                disabled_override,
            })
        }
        _ => None,
    }
}

fn extract_key_set(val: Option<&Value>) -> Option<HashSet<String>> {
    let arr = val?.as_array()?;
    let mut set = HashSet::new();
    for item in arr {
        if let Some(s) = item.as_str() {
            let key = normalize_plugin_key(s);
            if !key.is_empty() {
                set.insert(key);
            }
        }
    }
    Some(set)
}

fn load_workspace_plugins_config(workspace_dir: &Path) -> WorkspacePluginsConfig {
    let config_path = workspace_dir.join(".agents").join("plugins.json");
    let Ok(raw) = fs::read_to_string(&config_path) else {
        return WorkspacePluginsConfig::default();
    };
    let Ok(val) = parse_jsonc_value(&raw) else {
        return WorkspacePluginsConfig::default();
    };

    let mut cfg = WorkspacePluginsConfig::default();

    match val.get("entries") {
        Some(Value::Array(items)) => {
            for item in items {
                if let Some(entry) = extract_entry_from_value(item) {
                    cfg.entries.push(entry);
                }
            }
        }
        Some(Value::Object(map)) => {
            for (_, item) in map {
                if let Some(entry) = extract_entry_from_value(item) {
                    cfg.entries.push(entry);
                }
            }
        }
        _ => {}
    }

    match val.get("inherits") {
        Some(Value::Bool(flag)) => {
            cfg.inheritance.allow_inherited = *flag;
        }
        Some(Value::Object(obj)) => {
            cfg.inheritance.include_only = extract_key_set(
                obj.get("include_only")
                    .or_else(|| obj.get("includeOnly")),
            );
            if let Some(excl) = extract_key_set(obj.get("exclude")) {
                cfg.inheritance.exclude = excl;
            }
        }
        _ => {}
    }

    if cfg.inheritance.include_only.is_none() {
        cfg.inheritance.include_only = extract_key_set(
            val.get("include_only")
                .or_else(|| val.get("includeOnly")),
        );
    }
    if let Some(excl) = extract_key_set(val.get("exclude")) {
        cfg.inheritance.exclude.extend(excl);
    }

    cfg
}

fn apply_state_override(plugin: &mut DiscoveredPlugin, state: &PluginRuntimeState) {
    if let Some(&override_val) = state.enabled_overrides.get(&plugin.dir_id).or_else(|| {
        state
            .enabled_overrides
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(&plugin.dir_id))
            .map(|(_, v)| v)
    }) {
        plugin.enabled = override_val;
    } else {
        plugin.enabled = !plugin.manifest_disabled;
    }
}

fn try_register_plugin(
    mut plugin: DiscoveredPlugin,
    state: &PluginRuntimeState,
    inheritance: Option<&WorkspaceInheritance>,
    seen_dir_ids: &mut HashSet<String>,
    seen_names: &mut HashSet<String>,
    out: &mut Vec<DiscoveredPlugin>,
) {
    if let Some(filter) = inheritance {
        if !filter.allows(&plugin.dir_id, &plugin.name) {
            return;
        }
    }
    let dir_key = normalize_plugin_key(&plugin.dir_id);
    let name_key = normalize_plugin_key(&plugin.name);
    if dir_key.is_empty() || seen_dir_ids.contains(&dir_key) || seen_names.contains(&name_key) {
        return;
    }

    apply_state_override(&mut plugin, state);
    seen_dir_ids.insert(dir_key);
    if !name_key.is_empty() {
        seen_names.insert(name_key);
    }
    out.push(plugin);
}

fn scan_plugins_parent_dir(
    parent_dir: &Path,
    data_root: &Path,
    source: PluginSourceKind,
    state: &PluginRuntimeState,
    inheritance: Option<&WorkspaceInheritance>,
    seen_dir_ids: &mut HashSet<String>,
    seen_names: &mut HashSet<String>,
    out: &mut Vec<DiscoveredPlugin>,
) {
    if !parent_dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(parent_dir) else {
        return;
    };
    let mut subdirs: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_str()?.to_string();
            if name.starts_with('.') || !path.is_dir() {
                return None;
            }
            Some((name, path))
        })
        .collect();
    subdirs.sort_by(|a, b| {
        a.0.to_ascii_lowercase()
            .cmp(&b.0.to_ascii_lowercase())
            .then_with(|| a.0.cmp(&b.0))
    });

    for (_, plugin_dir) in subdirs {
        if find_manifest_file(&plugin_dir).is_none() {
            continue;
        }
        if let Ok(plugin) = parse_plugin_bundle(&plugin_dir, data_root, source) {
            try_register_plugin(
                plugin,
                state,
                inheritance,
                seen_dir_ids,
                seen_names,
                out,
            );
        }
    }
}

fn expand_home_prefix(raw: &str, home_dir: Option<&Path>) -> PathBuf {
    let trimmed = raw.trim();
    if let Some(home) = home_dir {
        if trimmed == "~" {
            return home.to_path_buf();
        }
        if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
            return home.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

pub fn discover_plugins_at(
    app_dir: &Path,
    home_dir: Option<&Path>,
    workspace_dir: Option<&Path>,
    settings: &PluginRuntimeSettings,
) -> Vec<DiscoveredPlugin> {
    let data_root = plugin_data_root_at(app_dir);
    let state = load_runtime_state_at(app_dir);
    let mut out = Vec::new();
    let mut seen_dir_ids = HashSet::new();
    let mut seen_names = HashSet::new();

    // 1) Active workspace `.agents/plugins.json` + `.agents/plugins/`.
    let inheritance = if let Some(ws) = workspace_dir.filter(|p| p.is_dir()) {
        let ws_cfg = load_workspace_plugins_config(ws);
        if let Ok(canonical_ws) = fs::canonicalize(ws) {
            let agents_dir = ws.join(".agents");
            for entry in &ws_cfg.entries {
                let resolved = validate_relative_path_inside_root(ws, &canonical_ws, &entry.path)
                    .or_else(|| {
                        validate_relative_path_inside_root(
                            &agents_dir,
                            &canonical_ws,
                            &entry.path,
                        )
                    });
                let Some((bundle_dir, _)) = resolved else {
                    continue;
                };
                if !bundle_dir.is_dir() || find_manifest_file(&bundle_dir).is_none() {
                    continue;
                }
                if let Ok(mut plugin) =
                    parse_plugin_bundle(&bundle_dir, &data_root, PluginSourceKind::Workspace)
                {
                    if let Some(disabled) = entry.disabled_override {
                        plugin.manifest_disabled = disabled;
                    }
                    try_register_plugin(
                        plugin,
                        &state,
                        None,
                        &mut seen_dir_ids,
                        &mut seen_names,
                        &mut out,
                    );
                }
            }
        }

        scan_plugins_parent_dir(
            &ws.join(".agents").join("plugins"),
            &data_root,
            PluginSourceKind::Workspace,
            &state,
            None,
            &mut seen_dir_ids,
            &mut seen_names,
            &mut out,
        );

        ws_cfg.inheritance
    } else {
        WorkspaceInheritance {
            allow_inherited: true,
            include_only: None,
            exclude: HashSet::new(),
        }
    };

    if !inheritance.allow_inherited {
        return out;
    }

    // 2) Configured `settings.extra_plugin_dirs`.
    for raw_dir in &settings.extra_plugin_dirs {
        let trimmed = raw_dir.trim();
        if trimmed.is_empty() {
            continue;
        }
        let extra_path = expand_home_prefix(trimmed, home_dir);
        if !extra_path.is_dir() {
            continue;
        }
        if find_manifest_file(&extra_path).is_some() {
            if let Ok(plugin) =
                parse_plugin_bundle(&extra_path, &data_root, PluginSourceKind::SharedSystem)
            {
                try_register_plugin(
                    plugin,
                    &state,
                    Some(&inheritance),
                    &mut seen_dir_ids,
                    &mut seen_names,
                    &mut out,
                );
            }
        } else {
            scan_plugins_parent_dir(
                &extra_path,
                &data_root,
                PluginSourceKind::SharedSystem,
                &state,
                Some(&inheritance),
                &mut seen_dir_ids,
                &mut seen_names,
                &mut out,
            );
        }
    }

    // 3) Kite global plugins (`roaming_app_dir().join("plugins")` + `home/.kite/plugins`).
    scan_plugins_parent_dir(
        &global_plugins_dir_at(app_dir),
        &data_root,
        PluginSourceKind::GlobalKite,
        &state,
        Some(&inheritance),
        &mut seen_dir_ids,
        &mut seen_names,
        &mut out,
    );
    if let Some(home) = home_dir {
        scan_plugins_parent_dir(
            &home.join(".kite").join("plugins"),
            &data_root,
            PluginSourceKind::GlobalKite,
            &state,
            Some(&inheritance),
            &mut seen_dir_ids,
            &mut seen_names,
            &mut out,
        );
    }

    // 4) Shared system roots when enabled.
    if settings.enable_shared_system_roots {
        if let Some(home) = home_dir {
            for shared_root in [
                home.join(".gemini").join("config").join("plugins"),
                home.join(".agents").join("plugins"),
            ] {
                scan_plugins_parent_dir(
                    &shared_root,
                    &data_root,
                    PluginSourceKind::SharedSystem,
                    &state,
                    Some(&inheritance),
                    &mut seen_dir_ids,
                    &mut seen_names,
                    &mut out,
                );
            }
        }
    }

    out
}

pub fn discover_plugins(workspace_dir: Option<&Path>) -> Vec<DiscoveredPlugin> {
    let app_dir = roaming_app_dir();
    let home_dir = resolve_home_dir();
    let settings = load_runtime_settings_at(&app_dir);
    discover_plugins_at(&app_dir, home_dir.as_deref(), workspace_dir, &settings)
}

fn sanitize_plugin_dir_id(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
        if out.len() >= 80 {
            break;
        }
    }
    while out.ends_with('-') || out.ends_with('_') {
        out.pop();
    }
    out
}

fn copy_dir_safe(
    src_dir: &Path,
    canonical_src_root: &Path,
    dst_dir: &Path,
) -> Result<(), String> {
    fs::create_dir_all(dst_dir)
        .map_err(|err| format!("Failed to create directory {}: {err}", dst_dir.display()))?;
    let entries = fs::read_dir(src_dir)
        .map_err(|err| format!("Failed to read directory {}: {err}", src_dir.display()))?;

    for entry_res in entries {
        let entry = entry_res
            .map_err(|err| format!("Failed reading entry in {}: {err}", src_dir.display()))?;
        let fname = entry.file_name();
        if fname.to_str() == Some(".git") {
            continue;
        }
        let src_path = entry.path();
        let meta = fs::symlink_metadata(&src_path)
            .map_err(|err| format!("Could not inspect {}: {err}", src_path.display()))?;
        let canon = fs::canonicalize(&src_path)
            .map_err(|err| format!("Could not resolve {}: {err}", src_path.display()))?;
        if !canon.starts_with(canonical_src_root) {
            return Err(format!(
                "Refusing plugin asset that escapes source directory: {}",
                src_path.display()
            ));
        }
        if meta.file_type().is_symlink() && !canon.starts_with(canonical_src_root) {
            return Err(format!(
                "Refusing unsafe symlink in plugin bundle: {}",
                src_path.display()
            ));
        }

        let dst_path = dst_dir.join(fname);
        if canon.is_dir() {
            copy_dir_safe(&canon, canonical_src_root, &dst_path)?;
        } else if canon.is_file() {
            fs::copy(&canon, &dst_path).map_err(|err| {
                format!(
                    "Failed copying {} to {}: {err}",
                    canon.display(),
                    dst_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn normalize_staged_hooks(staging_dir: &Path, format: PluginManifestFormat) -> Result<(), String> {
    if !matches!(
        format,
        PluginManifestFormat::Claude | PluginManifestFormat::GeminiExtension
    ) {
        return Ok(());
    }
    let root_hooks = staging_dir.join("hooks.json");
    let nested_hooks = staging_dir.join("hooks").join("hooks.json");
    if !root_hooks.exists() && nested_hooks.is_file() {
        fs::copy(&nested_hooks, &root_hooks).map_err(|err| {
            format!(
                "Failed normalizing hooks.json into {}: {err}",
                root_hooks.display()
            )
        })?;
    }
    Ok(())
}

fn stage_plugin_folder_at(
    app_dir: &Path,
    source_dir: &Path,
    fallback_id: Option<&str>,
) -> Result<DiscoveredPlugin, String> {
    if !source_dir.is_dir() {
        return Err(format!(
            "Plugin source directory does not exist: {}",
            source_dir.display()
        ));
    }
    let canonical_src = fs::canonicalize(source_dir).map_err(|err| {
        format!(
            "Failed to resolve plugin source directory {}: {err}",
            source_dir.display()
        )
    })?;
    if find_manifest_file(&canonical_src).is_none() {
        return Err(format!(
            "No supported plugin manifest found in {}",
            source_dir.display()
        ));
    }

    let data_root = plugin_data_root_at(app_dir);
    let temp_probe_id = fallback_id
        .map(sanitize_plugin_dir_id)
        .filter(|s| is_safe_single_segment(s))
        .or_else(|| {
            source_dir
                .file_name()
                .and_then(|s| s.to_str())
                .map(sanitize_plugin_dir_id)
                .filter(|s| is_safe_single_segment(s))
        })
        .unwrap_or_else(|| "plugin".to_string());

    let probed = parse_plugin_bundle_with_dir_id(
        &canonical_src,
        &temp_probe_id,
        &data_root,
        PluginSourceKind::GlobalKite,
    )?;

    let dir_id = [
        sanitize_plugin_dir_id(&probed.name),
        temp_probe_id,
    ]
    .into_iter()
    .find(|candidate| is_safe_single_segment(candidate))
    .ok_or_else(|| "Could not determine a valid plugin directory ID.".to_string())?;

    let plugins_root = global_plugins_dir_at(app_dir);
    fs::create_dir_all(&plugins_root).map_err(|err| {
        format!(
            "Failed to create Kite plugins directory {}: {err}",
            plugins_root.display()
        )
    })?;
    let canonical_plugins_root = fs::canonicalize(&plugins_root).map_err(|err| {
        format!(
            "Failed to resolve plugins directory {}: {err}",
            plugins_root.display()
        )
    })?;

    let staging_dir = plugins_root.join(format!(".staging-{}", Uuid::new_v4().simple()));
    let copy_res = (|| -> Result<(), String> {
        copy_dir_safe(&canonical_src, &canonical_src, &staging_dir)?;
        normalize_staged_hooks(&staging_dir, probed.format)?;
        parse_plugin_bundle_with_dir_id(
            &staging_dir,
            &dir_id,
            &data_root,
            PluginSourceKind::GlobalKite,
        )?;
        Ok(())
    })();
    if let Err(err) = copy_res {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(err);
    }

    let target_dir = plugins_root.join(&dir_id);
    if target_dir.parent().and_then(|p| fs::canonicalize(p).ok()).as_ref()
        != Some(&canonical_plugins_root)
    {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(format!("Refusing unsafe install target: {dir_id}"));
    }

    let backup_dir = plugins_root.join(format!(".backup-{}", Uuid::new_v4().simple()));
    let had_existing = target_dir.exists();
    if had_existing {
        fs::rename(&target_dir, &backup_dir).map_err(|err| {
            let _ = fs::remove_dir_all(&staging_dir);
            format!(
                "Failed replacing existing plugin at {}: {err}",
                target_dir.display()
            )
        })?;
    }

    if let Err(err) = fs::rename(&staging_dir, &target_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        if had_existing {
            let _ = fs::rename(&backup_dir, &target_dir);
        }
        return Err(format!(
            "Failed finalizing plugin installation at {}: {err}",
            target_dir.display()
        ));
    }

    if had_existing {
        let _ = fs::remove_dir_all(&backup_dir);
    }

    let state = load_runtime_state_at(app_dir);
    let mut installed = parse_plugin_bundle_with_dir_id(
        &target_dir,
        &dir_id,
        &data_root,
        PluginSourceKind::GlobalKite,
    )?;
    apply_state_override(&mut installed, &state);
    Ok(installed)
}

pub fn install_from_folder_at(
    app_dir: &Path,
    source_dir: &Path,
) -> Result<DiscoveredPlugin, String> {
    let fallback = source_dir.file_name().and_then(|s| s.to_str());
    stage_plugin_folder_at(app_dir, source_dir, fallback)
}

pub fn install_from_folder(source_dir: &Path) -> Result<DiscoveredPlugin, String> {
    install_from_folder_at(&roaming_app_dir(), source_dir)
}

fn has_parent_traversal(raw: &str) -> bool {
    raw.replace('\\', "/")
        .split('/')
        .any(|seg| seg == "..")
}

fn validate_git_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Git repository URL is required.".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("Git repository URL cannot start with '-'.".to_string());
    }
    if trimmed.contains(['\0', '\r', '\n']) {
        return Err("Git repository URL contains invalid control characters.".to_string());
    }
    if has_parent_traversal(trimmed) {
        return Err("Git repository URL cannot contain parent traversal ('..').".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_git_ref(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(r) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if r.starts_with('-') {
        return Err("Git ref cannot start with '-'.".to_string());
    }
    if r.contains(['\0', '\r', '\n', '\\'])
        || r.chars().any(char::is_whitespace)
        || has_parent_traversal(r)
    {
        return Err(format!("Invalid Git ref: '{r}'"));
    }
    Ok(Some(r.to_string()))
}

fn validate_relative_subdir(raw: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(sub) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if sub.starts_with('-')
        || sub.starts_with('/')
        || sub.starts_with('\\')
        || sub.contains(['\0', '\r', '\n', ':'])
    {
        return Err(format!("Invalid plugin subdir: '{sub}'"));
    }
    let normalized = sub.replace('\\', "/");
    let mut rel = PathBuf::new();
    for seg in normalized.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err("Plugin subdir cannot traverse parent directories ('..').".to_string());
        }
        rel.push(seg);
    }
    if rel.as_os_str().is_empty() {
        return Ok(None);
    }
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!("Invalid relative plugin subdir: '{sub}'"));
    }
    Ok(Some(rel))
}

fn infer_repo_fallback_id(repo_url: &str, subdir: Option<&Path>) -> Option<String> {
    if let Some(sub) = subdir {
        if let Some(name) = sub.file_name().and_then(|s| s.to_str()) {
            return Some(name.to_string());
        }
    }
    let cleaned = repo_url.trim_end_matches(['/', '\\']);
    let tail = cleaned
        .rsplit(['/', '\\', ':'])
        .next()
        .map(|s| s.strip_suffix(".git").unwrap_or(s))?;
    (!tail.is_empty()).then(|| tail.to_string())
}

fn resolve_git_bin() -> PathBuf {
    if let Some(found) = crate::chat::utils::find_in_path("git") {
        return found;
    }
    #[cfg(windows)]
    {
        let candidates = [
            crate::chat::utils::user_local_appdata_dir()
                .join("Programs")
                .join("Git")
                .join("cmd")
                .join("git.exe"),
            PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Git\cmd\git.exe"),
        ];
        for candidate in candidates {
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("git")
}

pub fn install_from_git_at(
    app_dir: &Path,
    repo_url: &str,
    git_ref: Option<&str>,
    subdir: Option<&str>,
) -> Result<DiscoveredPlugin, String> {
    let url = validate_git_url(repo_url)?;
    let validated_ref = validate_git_ref(git_ref)?;
    let validated_subdir = validate_relative_subdir(subdir)?;

    let temp_clone = TempDirGuard::create("git")?;
    let clone_dest = temp_clone.path.join("repo");
    let clone_dest_str = clone_dest.to_string_lossy().into_owned();

    let mut args: Vec<&str> = vec!["clone", "--depth", "1"];
    if let Some(ref r) = validated_ref {
        args.push("--branch");
        args.push(r.as_str());
    }
    args.push("--");
    args.push(url.as_str());
    args.push(clone_dest_str.as_str());

    let git_bin = resolve_git_bin();
    let output = hidden_exec::run(
        &git_bin,
        &args,
        Duration::from_secs(GIT_CLONE_TIMEOUT_SECS),
    )
    .map_err(|err| format!("Failed to launch git clone: {err}"))?;

    if output.timed_out {
        return Err("Git clone timed out while fetching plugin repository.".to_string());
    }
    if !output.success() {
        let stderr = output.stderr_lossy();
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("Git clone failed with exit code {:?}", output.code)
        } else {
            format!("Git clone failed: {detail}")
        });
    }

    let canonical_clone = fs::canonicalize(&clone_dest)
        .map_err(|err| format!("Failed to inspect cloned repository: {err}"))?;

    let plugin_source = if let Some(ref rel_sub) = validated_subdir {
        let joined = clone_dest.join(rel_sub);
        let canon_sub = fs::canonicalize(&joined).map_err(|_| {
            format!(
                "Requested subdir '{}' does not exist in cloned repository.",
                rel_sub.display()
            )
        })?;
        if !canon_sub.starts_with(&canonical_clone) || !canon_sub.is_dir() {
            return Err("Requested subdir escapes cloned repository or is not a directory.".to_string());
        }
        canon_sub
    } else {
        canonical_clone
    };

    let fallback = infer_repo_fallback_id(&url, validated_subdir.as_deref());
    stage_plugin_folder_at(app_dir, &plugin_source, fallback.as_deref())
}

pub fn install_from_git(
    repo_url: &str,
    git_ref: Option<&str>,
    subdir: Option<&str>,
) -> Result<DiscoveredPlugin, String> {
    install_from_git_at(&roaming_app_dir(), repo_url, git_ref, subdir)
}

fn is_safe_archive_entry_name(name: &str) -> bool {
    if name.is_empty() || name.contains('\0') {
        return false;
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return false;
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    !has_parent_traversal(name)
}

fn validate_zip_entries(archive_path: &Path) -> Result<(), String> {
    let meta = fs::metadata(archive_path)
        .map_err(|err| format!("Could not read archive metadata: {err}"))?;
    if !meta.is_file() {
        return Err(format!("Archive is not a file: {}", archive_path.display()));
    }
    if meta.len() > MAX_ARCHIVE_BYTES {
        return Err("Archive exceeds maximum allowed size (256 MiB).".to_string());
    }

    let bytes = fs::read(archive_path)
        .map_err(|err| format!("Failed to read archive {}: {err}", archive_path.display()))?;
    if bytes.len() < 22 {
        return Err("Invalid .zip archive: file is too small.".to_string());
    }

    let min_offset = bytes.len().saturating_sub(22 + 65535);
    let mut eocd_pos = None;
    let mut pos = bytes.len() - 22;
    loop {
        if bytes[pos..pos + 4] == [0x50, 0x4b, 0x05, 0x06] {
            let comment_len = u16::from_le_bytes([bytes[pos + 20], bytes[pos + 21]]) as usize;
            if pos + 22 + comment_len == bytes.len() {
                eocd_pos = Some(pos);
                break;
            }
        }
        if pos == min_offset {
            break;
        }
        pos -= 1;
    }

    let eocd = eocd_pos.ok_or_else(|| "Invalid .zip archive: missing central directory.".to_string())?;
    let total_entries = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]);
    let cd_size = u32::from_le_bytes([
        bytes[eocd + 12],
        bytes[eocd + 13],
        bytes[eocd + 14],
        bytes[eocd + 15],
    ]);
    let cd_offset = u32::from_le_bytes([
        bytes[eocd + 16],
        bytes[eocd + 17],
        bytes[eocd + 18],
        bytes[eocd + 19],
    ]);

    if total_entries == u16::MAX || cd_size == u32::MAX || cd_offset == u32::MAX {
        return Ok(());
    }

    let mut cursor = cd_offset as usize;
    let cd_end = cursor.saturating_add(cd_size as usize);
    if cd_end > eocd {
        return Err("Invalid .zip archive: central directory out of bounds.".to_string());
    }

    for _ in 0..total_entries {
        if cursor + 46 > cd_end || bytes[cursor..cursor + 4] != [0x50, 0x4b, 0x01, 0x02] {
            return Err("Invalid .zip archive: malformed central directory entry.".to_string());
        }
        let version_made_by = u16::from_le_bytes([bytes[cursor + 4], bytes[cursor + 5]]);
        let fname_len = u16::from_le_bytes([bytes[cursor + 28], bytes[cursor + 29]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[cursor + 30], bytes[cursor + 31]]) as usize;
        let comment_len = u16::from_le_bytes([bytes[cursor + 32], bytes[cursor + 33]]) as usize;
        let external_attr = u32::from_le_bytes([
            bytes[cursor + 38],
            bytes[cursor + 39],
            bytes[cursor + 40],
            bytes[cursor + 41],
        ]);

        let name_start = cursor + 46;
        let name_end = name_start + fname_len;
        let next_cursor = name_end + extra_len + comment_len;
        if next_cursor > cd_end {
            return Err("Invalid .zip archive: entry metadata out of bounds.".to_string());
        }

        // Reject Unix symlink entries (`S_IFLNK = 0o120000`).
        if (version_made_by >> 8) == 3 && ((external_attr >> 16) & 0o170000) == 0o120000 {
            return Err("Refusing archive containing symbolic link entries.".to_string());
        }

        let entry_name = std::str::from_utf8(&bytes[name_start..name_end])
            .map_err(|_| "Invalid .zip archive: non-UTF-8 entry name.".to_string())?;
        if !is_safe_archive_entry_name(entry_name) {
            return Err(format!(
                "Refusing archive entry with unsafe path traversal or absolute path: '{entry_name}'"
            ));
        }

        cursor = next_cursor;
    }

    Ok(())
}

fn verify_extracted_tree_safe(dir: &Path, canonical_root: &Path) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|err| format!("Failed inspecting extracted directory {}: {err}", dir.display()))?;
    for entry_res in entries {
        let entry = entry_res
            .map_err(|err| format!("Failed reading extracted entry: {err}"))?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)
            .map_err(|err| format!("Failed inspecting extracted path {}: {err}", path.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "Refusing extracted symbolic link in archive: {}",
                path.display()
            ));
        }
        let canon = fs::canonicalize(&path)
            .map_err(|err| format!("Failed canonicalizing extracted path {}: {err}", path.display()))?;
        if !canon.starts_with(canonical_root) {
            return Err(format!(
                "Extracted archive path escapes staging directory: {}",
                path.display()
            ));
        }
        if canon.is_dir() {
            verify_extracted_tree_safe(&canon, canonical_root)?;
        }
    }
    Ok(())
}

fn find_extracted_bundle_root(extract_dir: &Path) -> Result<(PathBuf, Option<String>), String> {
    if find_manifest_file(extract_dir).is_some() {
        return Ok((extract_dir.to_path_buf(), None));
    }

    let entries = fs::read_dir(extract_dir)
        .map_err(|err| format!("Failed reading extracted archive: {err}"))?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name == "__MACOSX" || name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            subdirs.push((name, path));
        }
    }

    if subdirs.len() == 1 {
        let (wrapper_name, wrapper_path) = subdirs.remove(0);
        if find_manifest_file(&wrapper_path).is_some() {
            return Ok((wrapper_path, Some(wrapper_name)));
        }
    }

    Err("Archive does not contain a valid plugin manifest.".to_string())
}

pub fn install_from_archive_at(
    app_dir: &Path,
    archive_path: &Path,
) -> Result<DiscoveredPlugin, String> {
    let is_zip = archive_path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    if !is_zip {
        return Err("Only .zip plugin archives are supported.".to_string());
    }

    validate_zip_entries(archive_path)?;

    let temp_extract = TempDirGuard::create("zip")?;
    let extract_dir = temp_extract.path.join("extracted");
    fs::create_dir_all(&extract_dir)
        .map_err(|err| format!("Failed creating extract directory: {err}"))?;

    let archive_str = archive_path.to_string_lossy().into_owned();
    let extract_str = extract_dir.to_string_lossy().into_owned();
    if archive_str.contains('\0') || extract_str.contains('\0') {
        return Err("Archive path contains invalid null characters.".to_string());
    }

    #[cfg(windows)]
    let output = {
        let ps_src = archive_str.replace('\'', "''");
        let ps_dst = extract_str.replace('\'', "''");
        let ps_script = format!(
            "Expand-Archive -LiteralPath '{ps_src}' -DestinationPath '{ps_dst}' -Force"
        );
        hidden_exec::run(
            Path::new("powershell"),
            &["-NoProfile", "-NonInteractive", "-Command", &ps_script],
            Duration::from_secs(ARCHIVE_EXTRACT_TIMEOUT_SECS),
        )
        .map_err(|err| format!("Failed launching PowerShell Expand-Archive: {err}"))?
    };

    #[cfg(not(windows))]
    let output = {
        hidden_exec::run(
            Path::new("unzip"),
            &["-qq", "-o", archive_str.as_str(), "-d", extract_str.as_str()],
            Duration::from_secs(ARCHIVE_EXTRACT_TIMEOUT_SECS),
        )
        .map_err(|err| format!("Failed launching unzip: {err}"))?
    };

    if output.timed_out {
        return Err("Archive extraction timed out.".to_string());
    }
    if !output.success() {
        let stderr = output.stderr_lossy();
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("Archive extraction failed with exit code {:?}", output.code)
        } else {
            format!("Archive extraction failed: {detail}")
        });
    }

    let canonical_extract = fs::canonicalize(&extract_dir)
        .map_err(|err| format!("Failed resolving extracted staging directory: {err}"))?;
    verify_extracted_tree_safe(&canonical_extract, &canonical_extract)?;

    let (bundle_root, wrapper_name) = find_extracted_bundle_root(&canonical_extract)?;
    let fallback = wrapper_name.or_else(|| {
        archive_path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
    });
    stage_plugin_folder_at(app_dir, &bundle_root, fallback.as_deref())
}

pub fn install_from_archive(archive_path: &Path) -> Result<DiscoveredPlugin, String> {
    install_from_archive_at(&roaming_app_dir(), archive_path)
}

pub fn uninstall_plugin_at(
    app_dir: &Path,
    home_dir: Option<&Path>,
    workspace_dir: Option<&Path>,
    settings: &PluginRuntimeSettings,
    dir_id: &str,
) -> Result<(), String> {
    let trimmed = dir_id.trim();
    if !is_safe_single_segment(trimmed) {
        return Err(format!("Invalid plugin ID: '{dir_id}'"));
    }

    let plugins = discover_plugins_at(app_dir, home_dir, workspace_dir, settings);
    let target = plugins
        .iter()
        .find(|p| p.dir_id == trimmed)
        .or_else(|| plugins.iter().find(|p| p.dir_id.eq_ignore_ascii_case(trimmed)))
        .ok_or_else(|| format!("Plugin '{trimmed}' is not installed."))?;

    match target.source {
        PluginSourceKind::Workspace => {
            return Err(format!(
                "Plugin '{}' is defined by the active workspace and cannot be uninstalled.",
                target.dir_id
            ));
        }
        PluginSourceKind::SharedSystem => {
            return Err(format!(
                "Plugin '{}' lives in a read-only shared or external directory and cannot be uninstalled.",
                target.dir_id
            ));
        }
        PluginSourceKind::GlobalKite => {}
    }

    let canonical_target = fs::canonicalize(&target.root_path).map_err(|err| {
        format!(
            "Could not resolve plugin directory {}: {err}",
            target.root_path.display()
        )
    })?;

    let mut allowed_roots = vec![global_plugins_dir_at(app_dir)];
    if let Some(home) = home_dir {
        allowed_roots.push(home.join(".kite").join("plugins"));
    }
    let inside_managed_root = allowed_roots.iter().any(|root| {
        fs::canonicalize(root)
            .map(|canon_root| {
                canonical_target != canon_root && canonical_target.starts_with(&canon_root)
            })
            .unwrap_or(false)
    });
    if !inside_managed_root {
        return Err(format!(
            "Refusing to delete plugin outside Kite managed plugin directories: {}",
            target.root_path.display()
        ));
    }

    fs::remove_dir_all(&target.root_path).map_err(|err| {
        format!(
            "Failed removing plugin directory {}: {err}",
            target.root_path.display()
        )
    })?;

    let mut state = load_runtime_state_at(app_dir);
    if state.enabled_overrides.remove(&target.dir_id).is_some() {
        let _ = save_runtime_state_at(app_dir, &state);
    }
    Ok(())
}

pub fn uninstall_plugin(dir_id: &str, workspace_dir: Option<&Path>) -> Result<(), String> {
    let app_dir = roaming_app_dir();
    let home_dir = resolve_home_dir();
    let settings = load_runtime_settings_at(&app_dir);
    uninstall_plugin_at(&app_dir, home_dir.as_deref(), workspace_dir, &settings, dir_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "kite-plugin-registry-{label}-{}-{nanos}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_test_plugin(dir: &Path, name: &str, description: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("plugin.json"),
            serde_json::json!({
                "name": name,
                "description": description,
            })
            .to_string(),
        )
        .unwrap();
    }

    fn crc32_ieee(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &byte in data {
            crc ^= byte as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    fn build_stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();

        for (name, data) in entries {
            let name_bytes = name.as_bytes();
            let crc = crc32_ieee(data);
            let size = data.len() as u32;
            let local_offset = out.len() as u32;

            // Local file header
            out.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04]);
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // method: store
            out.extend_from_slice(&0u16.to_le_bytes()); // mod time
            out.extend_from_slice(&0u16.to_le_bytes()); // mod date
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra len
            out.extend_from_slice(name_bytes);
            out.extend_from_slice(data);

            // Central directory header
            central.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02]);
            central.extend_from_slice(&20u16.to_le_bytes()); // made by
            central.extend_from_slice(&20u16.to_le_bytes()); // needed
            central.extend_from_slice(&0u16.to_le_bytes()); // flags
            central.extend_from_slice(&0u16.to_le_bytes()); // method: store
            central.extend_from_slice(&0u16.to_le_bytes()); // mod time
            central.extend_from_slice(&0u16.to_le_bytes()); // mod date
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes()); // extra len
            central.extend_from_slice(&0u16.to_le_bytes()); // comment len
            central.extend_from_slice(&0u16.to_le_bytes()); // disk number
            central.extend_from_slice(&0u16.to_le_bytes()); // internal attr
            central.extend_from_slice(&0u32.to_le_bytes()); // external attr
            central.extend_from_slice(&local_offset.to_le_bytes());
            central.extend_from_slice(name_bytes);
        }

        let cd_offset = out.len() as u32;
        let cd_size = central.len() as u32;
        out.extend_from_slice(&central);

        // End of central directory
        let count = entries.len() as u16;
        out.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06]);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    #[test]
    fn settings_and_external_enable_state_persist_without_mutating_shared_roots() {
        let temp = make_temp_dir("settings-state");
        let app_dir = temp.join("app");
        let home_dir = temp.join("home");
        let shared_plugin = home_dir
            .join(".gemini")
            .join("config")
            .join("plugins")
            .join("shared-one");
        write_test_plugin(&shared_plugin, "shared-one", "Shared bundle");
        let before_manifest = fs::read_to_string(shared_plugin.join("plugin.json")).unwrap();

        let defaults = load_runtime_settings_at(&app_dir);
        assert!(defaults.enable_shared_system_roots);
        assert!(!defaults.auto_start_ui_sidecars);
        assert!(defaults.extra_plugin_dirs.is_empty());

        let custom = PluginRuntimeSettings {
            enable_shared_system_roots: false,
            extra_plugin_dirs: vec![temp.join("extra").to_string_lossy().into_owned()],
            auto_start_ui_sidecars: true,
        };
        save_runtime_settings_at(&app_dir, &custom).unwrap();
        assert_eq!(load_runtime_settings_at(&app_dir), custom);

        // With shared roots disabled, shared-one is absent.
        assert!(discover_plugins_at(&app_dir, Some(&home_dir), None, &custom).is_empty());

        // Re-enable shared roots and disable `shared-one` via external state file only.
        set_plugin_enabled_at(&app_dir, "shared-one", false).unwrap();
        let enabled_settings = PluginRuntimeSettings::default();
        let found = discover_plugins_at(&app_dir, Some(&home_dir), None, &enabled_settings);
        assert_eq!(found.len(), 1);
        assert!(!found[0].enabled);
        assert!(!found[0].can_uninstall);
        assert_eq!(found[0].source, PluginSourceKind::SharedSystem);

        // Shared root file on disk must remain byte-for-byte untouched.
        let after_manifest = fs::read_to_string(shared_plugin.join("plugin.json")).unwrap();
        assert_eq!(before_manifest, after_manifest);

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn discovery_priority_deduplicates_collisions_and_honors_workspace_inherits() {
        let temp = make_temp_dir("priority-inherits");
        let app_dir = temp.join("app");
        let home_dir = temp.join("home");
        let ws = temp.join("workspace");
        let extra_dir = temp.join("extra-dir");

        // Workspace `.agents/plugins/alpha` wins over Global & Shared `alpha`.
        write_test_plugin(
            &ws.join(".agents").join("plugins").join("alpha"),
            "alpha",
            "workspace-alpha",
        );
        // Workspace `.agents/plugins.json` local entry + inherits filter.
        write_test_plugin(
            &ws.join("vendor-plugins").join("custom-ws"),
            "custom-ws",
            "entry-plugin",
        );
        fs::write(
            ws.join(".agents").join("plugins.json"),
            r#"{
              "entries": [
                { "path": "./vendor-plugins/custom-ws" },
                { "path": "../outside-ws" }
              ],
              "inherits": {
                "include_only": ["alpha", "beta", "gamma", "blocked"],
                "exclude": ["blocked"]
              }
            }"#,
        )
        .unwrap();

        // Tier 2: Extra dir `beta`.
        write_test_plugin(&extra_dir.join("beta"), "beta", "extra-beta");

        // Tier 3: Kite global `alpha` (loses on dir_id), `gamma` (wins), and `alias-beta` (loses on normalized name to extra `beta`).
        write_test_plugin(
            &app_dir.join("plugins").join("alpha"),
            "alpha",
            "global-alpha",
        );
        write_test_plugin(
            &app_dir.join("plugins").join("alias-beta"),
            "  BETA ",
            "global-alias-beta",
        );
        write_test_plugin(
            &home_dir.join(".kite").join("plugins").join("gamma"),
            "gamma",
            "global-gamma",
        );

        // Tier 4: Shared roots (`blocked` excluded, `unlisted` omitted by `include_only`).
        write_test_plugin(
            &home_dir
                .join(".gemini")
                .join("config")
                .join("plugins")
                .join("blocked"),
            "blocked",
            "shared-blocked",
        );
        write_test_plugin(
            &home_dir.join(".agents").join("plugins").join("unlisted"),
            "unlisted",
            "shared-unlisted",
        );

        let settings = PluginRuntimeSettings {
            enable_shared_system_roots: true,
            extra_plugin_dirs: vec![extra_dir.to_string_lossy().into_owned()],
            auto_start_ui_sidecars: true,
        };
        let discovered = discover_plugins_at(&app_dir, Some(&home_dir), Some(&ws), &settings);
        let summary: Vec<(&str, &str, PluginSourceKind)> = discovered
            .iter()
            .map(|p| (p.dir_id.as_str(), p.description.as_str(), p.source))
            .collect();

        assert_eq!(
            summary,
            vec![
                ("custom-ws", "entry-plugin", PluginSourceKind::Workspace),
                ("alpha", "workspace-alpha", PluginSourceKind::Workspace),
                ("beta", "extra-beta", PluginSourceKind::SharedSystem),
                ("gamma", "global-gamma", PluginSourceKind::GlobalKite),
            ]
        );

        // `inherits: false` keeps workspace plugins only.
        fs::write(
            ws.join(".agents").join("plugins.json"),
            r#"{ "inherits": false }"#,
        )
        .unwrap();
        let ws_only = discover_plugins_at(&app_dir, Some(&home_dir), Some(&ws), &settings);
        assert_eq!(ws_only.len(), 1);
        assert_eq!(ws_only[0].dir_id, "alpha");

        // Workspace plugin cannot be uninstalled.
        let ws_err = uninstall_plugin_at(&app_dir, Some(&home_dir), Some(&ws), &settings, "alpha")
            .unwrap_err();
        assert!(ws_err.contains("workspace"));

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn install_folder_normalizes_hooks_and_uninstall_respects_source_isolation() {
        let temp = make_temp_dir("folder-uninstall");
        let app_dir = temp.join("app");
        let home_dir = temp.join("home");
        let src = temp.join("claude-src");
        fs::create_dir_all(src.join(".claude-plugin")).unwrap();
        fs::create_dir_all(src.join("hooks")).unwrap();
        fs::write(
            src.join(".claude-plugin").join("plugin.json"),
            r#"{ "name": "Claude Demo", "description": "Compat hooks" }"#,
        )
        .unwrap();
        fs::write(src.join("hooks").join("hooks.json"), r#"{ "Stop": [] }"#).unwrap();

        let installed = install_from_folder_at(&app_dir, &src).unwrap();
        assert_eq!(installed.dir_id, "claude-demo");
        assert_eq!(installed.source, PluginSourceKind::GlobalKite);
        assert!(installed.can_uninstall);
        assert!(installed.root_path.join("hooks.json").is_file());
        assert_eq!(
            installed.hooks_path,
            Some(installed.root_path.join("hooks.json"))
        );

        // Shared root plugin cannot be uninstalled and stays untouched.
        let shared = home_dir
            .join(".gemini")
            .join("config")
            .join("plugins")
            .join("readonly-shared");
        write_test_plugin(&shared, "readonly-shared", "Shared");
        let settings = PluginRuntimeSettings::default();
        let err =
            uninstall_plugin_at(&app_dir, Some(&home_dir), None, &settings, "readonly-shared")
                .unwrap_err();
        assert!(err.contains("read-only"));
        assert!(shared.exists());

        // GlobalKite plugin uninstalls cleanly.
        uninstall_plugin_at(&app_dir, Some(&home_dir), None, &settings, "claude-demo").unwrap();
        assert!(!installed.root_path.exists());

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn install_from_git_rejects_flag_injection_and_installs_local_repo_with_subdir_and_ref() {
        let temp = make_temp_dir("git-install");
        let app_dir = temp.join("app");

        assert!(install_from_git_at(&app_dir, "--upload-pack=evil", None, None).is_err());
        assert!(install_from_git_at(&app_dir, "https://example.com/a.git", Some("--evil"), None).is_err());
        assert!(install_from_git_at(&app_dir, "https://example.com/a.git", None, Some("../escape")).is_err());

        // Create a real local git repository with a tagged commit and a nested plugin subdir.
        let repo_src = temp.join("local-repo");
        let nested = repo_src.join("packages").join("my-git-plugin");
        write_test_plugin(&nested, "my-git-plugin", "From local git");
        let git_bin = resolve_git_bin();
        let init = hidden_exec::run_in_dir(
            &git_bin,
            &["init"],
            Some(&repo_src),
            Duration::from_secs(15),
        )
        .expect("git binary must be available to run git install test");
        assert!(init.success(), "{}", init.stderr_lossy());

        for git_args in [
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test User"],
            vec!["add", "."],
            vec!["commit", "-m", "initial"],
            vec!["tag", "v1.0.0"],
        ] {
            let out = hidden_exec::run_in_dir(
                &git_bin,
                &git_args,
                Some(&repo_src),
                Duration::from_secs(10),
            )
            .unwrap();
            assert!(out.success(), "git {:?} failed: {}", git_args, out.stderr_lossy());
        }

        let repo_url = format!("file:///{}", repo_src.to_string_lossy().replace('\\', "/"));
        let installed = install_from_git_at(
            &app_dir,
            &repo_url,
            Some("v1.0.0"),
            Some("packages/my-git-plugin"),
        )
        .unwrap();
        assert_eq!(installed.dir_id, "my-git-plugin");
        assert_eq!(installed.description, "From local git");
        assert!(!installed.root_path.join(".git").exists());

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn install_from_archive_extracts_valid_zip_and_rejects_path_escape() {
        let temp = make_temp_dir("zip-install");
        let app_dir = temp.join("app");

        // Malicious zip attempting path traversal.
        let evil_zip = temp.join("evil.zip");
        fs::write(
            &evil_zip,
            build_stored_zip(&[
                ("plugin.json", br#"{"name":"evil"}"#),
                ("../escape.txt", b"boom"),
            ]),
        )
        .unwrap();
        let err = install_from_archive_at(&app_dir, &evil_zip).unwrap_err();
        assert!(err.contains("unsafe path traversal"), "err={err}");

        // Valid wrapped zip with GeminiExtension + hooks/hooks.json normalization.
        let good_zip = temp.join("bundle.zip");
        fs::write(
            &good_zip,
            build_stored_zip(&[
                (
                    "zip-bundle-main/gemini-extension.json",
                    br#"{"name":"Zip Bundle","description":"Packed extension"}"#,
                ),
                ("zip-bundle-main/hooks/hooks.json", br#"{"PreToolUse":[]}"#),
            ]),
        )
        .unwrap();
        let installed = install_from_archive_at(&app_dir, &good_zip).unwrap();
        assert_eq!(installed.dir_id, "zip-bundle");
        assert_eq!(installed.format, PluginManifestFormat::GeminiExtension);
        assert!(installed.root_path.join("hooks.json").is_file());

        let _ = fs::remove_dir_all(&temp);
    }
}
