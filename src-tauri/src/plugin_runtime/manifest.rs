//! Clean-room bundle manifest, sidecar, MCP config, skill, rule, agent, and hook parser.

use crate::agent_mind::skills::parse_skill_frontmatter;
use crate::dispatch::role::{normalize_agent_slug, parse_role};
use crate::plugin_runtime::types::{
    DiscoveredPlugin, PluginAgentProfileInfo, PluginManifestFormat, PluginMcpServer,
    PluginMcpTransport, PluginRuleInfo, PluginSkillInfo, PluginSourceKind, SidecarRestartPolicy,
    SidecarSpec, SidecarUiView,
};
use base64::Engine as _;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const MAX_LOGO_BYTES: usize = 512 * 1024;
pub const MAX_SUGGESTED_PROMPTS: usize = 3;

const MANIFEST_CANDIDATES: &[(&[&str], PluginManifestFormat)] = &[
    (&["plugin.json"], PluginManifestFormat::Native),
    (
        &[".antigravity-plugin", "plugin.json"],
        PluginManifestFormat::LegacyManifest,
    ),
    (
        &[".gemini-plugin", "plugin.json"],
        PluginManifestFormat::LegacyManifest,
    ),
    (
        &[".claude-plugin", "plugin.json"],
        PluginManifestFormat::Claude,
    ),
    (
        &[".cursor-plugin", "plugin.json"],
        PluginManifestFormat::Cursor,
    ),
    (&["gemini-extension.json"], PluginManifestFormat::GeminiExtension),
];

/// Strips `//` line comments, `/* ... */` block comments, and trailing commas
/// outside JSON string literals.
pub fn strip_jsonc(raw: &str) -> String {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let chars: Vec<char> = raw.chars().collect();

    // Pass 1: Strip comments while preserving string literals verbatim.
    let mut no_comments = String::with_capacity(raw.len());
    let mut i = 0;
    let n = chars.len();
    let mut in_string = false;
    let mut escaped = false;

    while i < n {
        let ch = chars[i];
        if in_string {
            no_comments.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if ch == '"' {
            in_string = true;
            no_comments.push(ch);
            i += 1;
        } else if ch == '/' && i + 1 < n && chars[i + 1] == '/' {
            i += 2;
            while i < n && chars[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && i + 1 < n && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                if chars[i] == '\n' {
                    no_comments.push('\n');
                }
                i += 1;
            }
            if i + 1 < n {
                i += 2;
            } else {
                i = n;
            }
        } else {
            no_comments.push(ch);
            i += 1;
        }
    }

    // Pass 2: Strip trailing commas right before `}` or `]` outside strings.
    let pass2_chars: Vec<char> = no_comments.chars().collect();
    let mut out = String::with_capacity(no_comments.len());
    let m = pass2_chars.len();
    i = 0;
    in_string = false;
    escaped = false;

    while i < m {
        let ch = pass2_chars[i];
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if ch == '"' {
            in_string = true;
            out.push(ch);
            i += 1;
        } else if ch == ',' {
            let mut j = i + 1;
            while j < m && pass2_chars[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < m && (pass2_chars[j] == '}' || pass2_chars[j] == ']') {
                i += 1;
            } else {
                out.push(ch);
                i += 1;
            }
        } else {
            out.push(ch);
            i += 1;
        }
    }

    out
}

pub fn parse_jsonc_value(raw: &str) -> Result<Value, String> {
    let cleaned = strip_jsonc(raw);
    serde_json::from_str::<Value>(&cleaned).map_err(|err| format!("Invalid JSON/JSONC: {err}"))
}

/// Locates the highest-priority manifest file inside `plugin_root`.
pub fn find_manifest_file(plugin_root: &Path) -> Option<(PathBuf, PluginManifestFormat)> {
    for (segments, format) in MANIFEST_CANDIDATES {
        let mut candidate = plugin_root.to_path_buf();
        for seg in *segments {
            candidate.push(seg);
        }
        if candidate.is_file() {
            return Some((candidate, *format));
        }
    }
    None
}

pub fn expand_plugin_vars(raw: &str, plugin_root: &Path, plugin_data: &Path) -> String {
    let root_str = plugin_root.to_string_lossy();
    let data_str = plugin_data.to_string_lossy();
    raw.replace("${PLUGIN_ROOT}", root_str.as_ref())
        .replace("${PLUGIN_DATA}", data_str.as_ref())
}

pub fn is_safe_single_segment(raw: &str) -> bool {
    let trimmed = raw.trim();
    !trimmed.is_empty()
        && trimmed != "."
        && trimmed != ".."
        && !trimmed.contains('/')
        && !trimmed.contains('\\')
        && !trimmed.contains('\0')
        && !trimmed.contains(':')
}

fn has_url_scheme_or_drive(raw: &str) -> bool {
    if raw.contains("://") {
        return true;
    }
    if let Some((prefix, _)) = raw.split_once(':') {
        if !prefix.is_empty()
            && prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            return true;
        }
    }
    false
}

/// Validates a relative path under `plugin_root`, rejecting URLs, absolute paths,
/// parent traversal (`..`), and symlinks escaping `canonical_root`.
pub(crate) fn validate_relative_path_inside_root(
    plugin_root: &Path,
    canonical_root: &Path,
    raw_rel: &str,
) -> Option<(PathBuf, PathBuf)> {
    let trimmed = raw_rel.trim();
    if trimmed.is_empty() || trimmed.contains('\0') || has_url_scheme_or_drive(trimmed) {
        return None;
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return None;
    }

    let normalized = trimmed.replace('\\', "/");
    let mut clean_rel = PathBuf::new();
    for seg in normalized.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        clean_rel.push(seg);
    }
    if clean_rel.as_os_str().is_empty() {
        return None;
    }

    let candidate_path = Path::new(&clean_rel);
    if candidate_path.is_absolute() {
        return None;
    }
    for comp in candidate_path.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return None,
        }
    }

    let joined = plugin_root.join(&clean_rel);
    let canonical = fs::canonicalize(&joined).ok()?;
    if !canonical.starts_with(canonical_root) {
        return None;
    }
    Some((joined, canonical))
}

fn validate_existing_inside_root(canonical_root: &Path, target: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(target).ok()?;
    if canonical.starts_with(canonical_root) {
        Some(canonical)
    } else {
        None
    }
}

fn non_empty_str(val: Option<&Value>) -> Option<String> {
    val.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn extract_author(manifest: &Value) -> Option<String> {
    match manifest.get("author") {
        Some(Value::String(s)) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        Some(Value::Object(obj)) => non_empty_str(obj.get("name")),
        _ => None,
    }
}

fn extract_repository(manifest: &Value) -> Option<String> {
    match manifest.get("repository") {
        Some(Value::String(s)) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        Some(Value::Object(obj)) => non_empty_str(obj.get("url")),
        _ => None,
    }
}

fn extract_string_list(val: Option<&Value>, limit: Option<usize>) -> Vec<String> {
    let Some(arr) = val.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            out.push(s.to_string());
            if let Some(max) = limit {
                if out.len() >= max {
                    break;
                }
            }
        }
    }
    out
}

fn mime_for_logo_extension(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn load_logo_data_uri(
    plugin_root: &Path,
    canonical_root: &Path,
    raw_logo: Option<&str>,
) -> Option<String> {
    let raw = raw_logo?.trim();
    let (_, canonical_asset) =
        validate_relative_path_inside_root(plugin_root, canonical_root, raw)?;
    let mime = mime_for_logo_extension(&canonical_asset)?;
    let meta = fs::metadata(&canonical_asset).ok()?;
    if !meta.is_file() || meta.len() > MAX_LOGO_BYTES as u64 {
        return None;
    }
    let bytes = fs::read(&canonical_asset).ok()?;
    if bytes.len() > MAX_LOGO_BYTES {
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

fn parse_restart_policy(val: &Value) -> SidecarRestartPolicy {
    let raw = non_empty_str(val.get("restart_policy"))
        .or_else(|| non_empty_str(val.get("restartPolicy")));
    match raw
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("always") => SidecarRestartPolicy::Always,
        Some("never") => SidecarRestartPolicy::Never,
        Some("on-failure") | Some("on_failure") | Some("onfailure") | None => {
            SidecarRestartPolicy::OnFailure
        }
        Some(_) => SidecarRestartPolicy::OnFailure,
    }
}

fn scalar_env_map(val: Option<&Value>, plugin_root: &Path, plugin_data: &Path) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let Some(obj) = val.and_then(Value::as_object) else {
        return map;
    };
    for (k, v) in obj {
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        let raw_val = match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        map.insert(
            key.to_string(),
            expand_plugin_vars(&raw_val, plugin_root, plugin_data),
        );
    }
    map
}

fn parse_sidecar_views(val: &Value, default_title: &str) -> Vec<SidecarUiView> {
    let views_val = val
        .get("ui_config")
        .or_else(|| val.get("uiConfig"))
        .and_then(|ui| ui.get("views"))
        .or_else(|| val.get("views"));
    let Some(arr) = views_val.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut views = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let title = non_empty_str(obj.get("title")).unwrap_or_else(|| default_title.to_string());
        let path = non_empty_str(obj.get("path")).unwrap_or_else(|| "/".to_string());
        let entrypoint = non_empty_str(obj.get("entrypoint")).unwrap_or_default();
        views.push(SidecarUiView {
            title,
            path,
            entrypoint,
        });
    }
    views
}

fn parse_single_sidecar(
    sidecar_json_path: &Path,
    working_dir: PathBuf,
    sidecar_id: &str,
    dir_id: &str,
    plugin_name: &str,
    plugin_root: &Path,
    plugin_data: &Path,
) -> Option<SidecarSpec> {
    if !is_safe_single_segment(sidecar_id) {
        return None;
    }
    let raw = fs::read_to_string(sidecar_json_path).ok()?;
    let val = parse_jsonc_value(&raw).ok()?;
    let obj = val.as_object()?;

    let builtin = non_empty_str(obj.get("builtin"));
    let command = non_empty_str(obj.get("command"))
        .map(|c| expand_plugin_vars(&c, plugin_root, plugin_data))
        .unwrap_or_default();
    if command.is_empty() && builtin.is_none() {
        return None;
    }

    let args = obj
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|s| expand_plugin_vars(s, plugin_root, plugin_data))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let env = scalar_env_map(obj.get("env"), plugin_root, plugin_data);

    let ui_display_name = obj
        .get("ui_config")
        .or_else(|| obj.get("uiConfig"))
        .and_then(|ui| {
            non_empty_str(ui.get("display_name")).or_else(|| non_empty_str(ui.get("displayName")))
        });
    let display_name = non_empty_str(obj.get("display_name"))
        .or_else(|| non_empty_str(obj.get("displayName")))
        .or(ui_display_name)
        .unwrap_or_else(|| sidecar_id.to_string());

    let description = non_empty_str(obj.get("description")).unwrap_or_default();
    let views = parse_sidecar_views(&val, &display_name);

    let explicit_web_ui = obj
        .get("has_web_ui")
        .or_else(|| obj.get("hasWebUi"))
        .and_then(Value::as_bool);
    let has_web_ui = explicit_web_ui.unwrap_or(!views.is_empty());

    let allows_user_interactions = obj
        .get("allows_user_interactions")
        .or_else(|| obj.get("allowsUserInteractions"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    Some(SidecarSpec {
        id: sidecar_id.to_string(),
        namespaced_id: format!("{dir_id}/{sidecar_id}"),
        plugin_id: dir_id.to_string(),
        plugin_name: plugin_name.to_string(),
        display_name,
        description,
        command,
        args,
        env,
        builtin,
        restart_policy: parse_restart_policy(&val),
        has_web_ui,
        views,
        working_dir,
        plugin_root: plugin_root.to_path_buf(),
        plugin_data: plugin_data.to_path_buf(),
        allows_user_interactions,
    })
}

fn parse_sidecars(
    plugin_root: &Path,
    canonical_root: &Path,
    dir_id: &str,
    plugin_name: &str,
    plugin_data: &Path,
) -> Vec<SidecarSpec> {
    let mut specs = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_canonical_files = HashSet::new();

    // 1) Scan `<plugin_root>/sidecars/<id>/sidecar.json`.
    let sidecars_dir = plugin_root.join("sidecars");
    if sidecars_dir.is_dir() && validate_existing_inside_root(canonical_root, &sidecars_dir).is_some() {
        if let Ok(entries) = fs::read_dir(&sidecars_dir) {
            let mut subdirs: Vec<(String, PathBuf)> = entries
                .flatten()
                .filter_map(|entry| {
                    let path = entry.path();
                    if !path.is_dir() {
                        return None;
                    }
                    let id = entry.file_name().to_str()?.to_string();
                    is_safe_single_segment(&id).then_some((id, path))
                })
                .collect();
            subdirs.sort_by(|a, b| a.0.cmp(&b.0));

            for (sidecar_id, subdir) in subdirs {
                let sidecar_json = subdir.join("sidecar.json");
                let Some(canonical_json) =
                    validate_existing_inside_root(canonical_root, &sidecar_json)
                else {
                    continue;
                };
                if !canonical_json.is_file() {
                    continue;
                }
                if let Some(spec) = parse_single_sidecar(
                    &sidecar_json,
                    subdir,
                    &sidecar_id,
                    dir_id,
                    plugin_name,
                    plugin_root,
                    plugin_data,
                ) {
                    if seen_ids.insert(sidecar_id.to_ascii_lowercase())
                        && seen_canonical_files.insert(canonical_json)
                    {
                        specs.push(spec);
                    }
                }
            }
        }
    }

    // 2) Scan `<plugin_root>/sidecars.json` (array of relative paths OR `{ "<id>": "<relpath>" }`).
    let sidecars_index = plugin_root.join("sidecars.json");
    if sidecars_index.is_file()
        && validate_existing_inside_root(canonical_root, &sidecars_index).is_some()
    {
        if let Ok(raw) = fs::read_to_string(&sidecars_index) {
            if let Ok(val) = parse_jsonc_value(&raw) {
                let refs: Vec<(Option<String>, String)> = match val {
                    Value::Array(items) => items
                        .into_iter()
                        .filter_map(|item| item.as_str().map(|s| (None, s.to_string())))
                        .collect(),
                    Value::Object(map) => map
                        .into_iter()
                        .filter_map(|(k, v)| match v {
                            Value::String(s) => Some((Some(k), s)),
                            Value::Object(obj) => non_empty_str(obj.get("path"))
                                .map(|p| (Some(k), p)),
                            _ => None,
                        })
                        .collect(),
                    _ => Vec::new(),
                };

                for (explicit_id, rel_path) in refs {
                    if let Some(ref id) = explicit_id {
                        if !is_safe_single_segment(id) {
                            continue;
                        }
                    }
                    let Some((joined, canonical_target)) =
                        validate_relative_path_inside_root(plugin_root, canonical_root, &rel_path)
                    else {
                        continue;
                    };

                    let (sidecar_json, working_dir, canonical_json) = if canonical_target.is_dir() {
                        let json_path = joined.join("sidecar.json");
                        let Some(canon_json) =
                            validate_existing_inside_root(canonical_root, &json_path)
                        else {
                            continue;
                        };
                        if !canon_json.is_file() {
                            continue;
                        }
                        (json_path, joined, canon_json)
                    } else if canonical_target.is_file() {
                        let Some(parent) = joined.parent().map(Path::to_path_buf) else {
                            continue;
                        };
                        (joined, parent, canonical_target)
                    } else {
                        continue;
                    };

                    let resolved_id = match explicit_id {
                        Some(id) => id,
                        None => {
                            let id_from_json = fs::read_to_string(&sidecar_json)
                                .ok()
                                .and_then(|s| parse_jsonc_value(&s).ok())
                                .and_then(|v| non_empty_str(v.get("id")));
                            match id_from_json.filter(|s| is_safe_single_segment(s)) {
                                Some(id) => id,
                                None => match working_dir
                                    .file_name()
                                    .and_then(|s| s.to_str())
                                    .map(str::to_string)
                                    .filter(|s| is_safe_single_segment(s))
                                {
                                    Some(id) => id,
                                    None => continue,
                                },
                            }
                        }
                    };

                    if seen_ids.contains(&resolved_id.to_ascii_lowercase())
                        || seen_canonical_files.contains(&canonical_json)
                    {
                        continue;
                    }

                    if let Some(spec) = parse_single_sidecar(
                        &sidecar_json,
                        working_dir,
                        &resolved_id,
                        dir_id,
                        plugin_name,
                        plugin_root,
                        plugin_data,
                    ) {
                        seen_ids.insert(resolved_id.to_ascii_lowercase());
                        seen_canonical_files.insert(canonical_json);
                        specs.push(spec);
                    }
                }
            }
        }
    }

    specs
}

fn extract_mcp_servers_map(val: &Value, allow_top_level: bool) -> Option<&serde_json::Map<String, Value>> {
    if let Some(map) = val
        .get("mcpServers")
        .or_else(|| val.get("mcp_servers"))
        .and_then(Value::as_object)
    {
        return Some(map);
    }
    if allow_top_level {
        if let Some(obj) = val.as_object() {
            let looks_like_server_map = obj.values().any(|entry| {
                entry.as_object().is_some_and(|server| {
                    server.contains_key("command")
                        || server.contains_key("url")
                        || server.contains_key("serverUrl")
                        || server.contains_key("server_url")
                })
            });
            if looks_like_server_map {
                return Some(obj);
            }
        }
    }
    None
}

fn append_mcp_servers_from_map(
    map: &serde_json::Map<String, Value>,
    dir_id: &str,
    plugin_root: &Path,
    plugin_data: &Path,
    seen_names: &mut HashSet<String>,
    out: &mut Vec<PluginMcpServer>,
) {
    for (server_name, server_val) in map {
        let name = server_name.trim();
        if name.is_empty() || !seen_names.insert(name.to_string()) {
            continue;
        }
        let Some(obj) = server_val.as_object() else {
            continue;
        };
        if obj.get("disabled").and_then(Value::as_bool) == Some(true) {
            continue;
        }

        let url = non_empty_str(obj.get("url"))
            .or_else(|| non_empty_str(obj.get("serverUrl")))
            .or_else(|| non_empty_str(obj.get("server_url")));

        let transport = if let Some(raw_url) = url {
            let expanded_url = expand_plugin_vars(&raw_url, plugin_root, plugin_data);
            let headers = scalar_env_map(obj.get("headers"), plugin_root, plugin_data);
            PluginMcpTransport::Http {
                url: expanded_url,
                headers,
            }
        } else if let Some(raw_cmd) = non_empty_str(obj.get("command")) {
            let command = expand_plugin_vars(&raw_cmd, plugin_root, plugin_data);
            let args = obj
                .get("args")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(|s| expand_plugin_vars(s, plugin_root, plugin_data))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let env = scalar_env_map(obj.get("env"), plugin_root, plugin_data);
            PluginMcpTransport::Stdio { command, args, env }
        } else {
            continue;
        };

        out.push(PluginMcpServer {
            id: format!("{dir_id}_{name}"),
            server_name: name.to_string(),
            plugin_id: dir_id.to_string(),
            config: transport,
        });
    }
}

fn parse_mcp_servers(
    plugin_root: &Path,
    canonical_root: &Path,
    manifest_val: &Value,
    dir_id: &str,
    plugin_data: &Path,
) -> Vec<PluginMcpServer> {
    let mut out = Vec::new();
    let mut seen_names = HashSet::new();

    for filename in ["mcp_config.json", ".mcp.json"] {
        let path = plugin_root.join(filename);
        if path.is_file() && validate_existing_inside_root(canonical_root, &path).is_some() {
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(val) = parse_jsonc_value(&raw) {
                    if let Some(map) = extract_mcp_servers_map(&val, true) {
                        append_mcp_servers_from_map(
                            map,
                            dir_id,
                            plugin_root,
                            plugin_data,
                            &mut seen_names,
                            &mut out,
                        );
                    }
                }
            }
        }
    }

    if let Some(map) = extract_mcp_servers_map(manifest_val, false) {
        append_mcp_servers_from_map(
            map,
            dir_id,
            plugin_root,
            plugin_data,
            &mut seen_names,
            &mut out,
        );
    }

    out
}

fn scan_skills(
    plugin_root: &Path,
    canonical_root: &Path,
    dir_id: &str,
) -> Vec<PluginSkillInfo> {
    let skills_dir = plugin_root.join("skills");
    if !skills_dir.is_dir() || validate_existing_inside_root(canonical_root, &skills_dir).is_none()
    {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut seen_canonical = HashSet::new();

    // Optional top-level `skills/SKILL.md` used by some bundles alongside sub-skills.
    let root_skill = skills_dir.join("SKILL.md");
    if root_skill.is_file() {
        if let Some(canon) = validate_existing_inside_root(canonical_root, &root_skill) {
            if let Ok(raw) = fs::read_to_string(&root_skill) {
                let (fm, _) = parse_skill_frontmatter(&raw);
                let name = fm
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(dir_id)
                    .to_string();
                let id = name.clone();
                let description = fm.description.unwrap_or_default().trim().to_string();
                seen_canonical.insert(canon);
                out.push(PluginSkillInfo {
                    id,
                    name,
                    description,
                    path: root_skill,
                    disable_model_invocation: fm.manual_only,
                });
            }
        }
    }

    if let Ok(entries) = fs::read_dir(&skills_dir) {
        let mut subdirs: Vec<(String, PathBuf)> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if !path.is_dir() {
                    return None;
                }
                let id = entry.file_name().to_str()?.to_string();
                is_safe_single_segment(&id).then_some((id, path))
            })
            .collect();
        subdirs.sort_by(|a, b| a.0.cmp(&b.0));

        for (skill_id, subdir) in subdirs {
            let skill_md = subdir.join("SKILL.md");
            let Some(canon) = validate_existing_inside_root(canonical_root, &skill_md) else {
                continue;
            };
            if !canon.is_file() || !seen_canonical.insert(canon) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&skill_md) else {
                continue;
            };
            let (fm, _) = parse_skill_frontmatter(&raw);
            let name = fm
                .name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&skill_id)
                .to_string();
            let description = fm.description.unwrap_or_default().trim().to_string();
            out.push(PluginSkillInfo {
                id: skill_id,
                name,
                description,
                path: skill_md,
                disable_model_invocation: fm.manual_only,
            });
        }
    }

    out
}

fn scan_rules(
    plugin_root: &Path,
    canonical_root: &Path,
    format: PluginManifestFormat,
    manifest_val: &Value,
) -> Vec<PluginRuleInfo> {
    let mut out = Vec::new();
    let mut seen_canonical = HashSet::new();

    let push_rule = |path: PathBuf,
                     canonical: PathBuf,
                     seen: &mut HashSet<PathBuf>,
                     out: &mut Vec<PluginRuleInfo>| {
        if !canonical.is_file() || !seen.insert(canonical) {
            return;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()).map(str::to_string) else {
            return;
        };
        if let Ok(content) = fs::read_to_string(&path) {
            out.push(PluginRuleInfo {
                name,
                path,
                content,
            });
        }
    };

    let rules_dir = plugin_root.join("rules");
    if rules_dir.is_dir() && validate_existing_inside_root(canonical_root, &rules_dir).is_some() {
        for priority_name in ["AGENTS.md", "GEMINI.md"] {
            let p = rules_dir.join(priority_name);
            if let Some(canon) = validate_existing_inside_root(canonical_root, &p) {
                push_rule(p, canon, &mut seen_canonical, &mut out);
            }
        }

        if let Ok(entries) = fs::read_dir(&rules_dir) {
            let mut rest: Vec<(String, PathBuf)> = entries
                .flatten()
                .filter_map(|entry| {
                    let path = entry.path();
                    let name = entry.file_name().to_str()?.to_string();
                    let is_md = path
                        .extension()
                        .and_then(|s| s.to_str())
                        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
                    (path.is_file() && is_md).then_some((name, path))
                })
                .collect();
            rest.sort_by(|a, b| {
                a.0.to_ascii_lowercase()
                    .cmp(&b.0.to_ascii_lowercase())
                    .then_with(|| a.0.cmp(&b.0))
            });

            for (_, path) in rest {
                if let Some(canon) = validate_existing_inside_root(canonical_root, &path) {
                    push_rule(path, canon, &mut seen_canonical, &mut out);
                }
            }
        }
    }

    // Support `contextFileName` in extension manifests when pointing to markdown rule files inside root.
    if format == PluginManifestFormat::GeminiExtension {
        let extra_files: Vec<String> = match manifest_val.get("contextFileName") {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            _ => Vec::new(),
        };
        for rel in extra_files {
            if let Some((joined, canon)) =
                validate_relative_path_inside_root(plugin_root, canonical_root, &rel)
            {
                let is_md = joined
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("md"));
                if is_md {
                    push_rule(joined, canon, &mut seen_canonical, &mut out);
                }
            }
        }
    }

    out
}

fn unquote_header_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn split_agent_frontmatter(text: &str) -> (Option<&str>, &str) {
    let stripped = text.strip_prefix('\u{feff}').unwrap_or(text);
    let trimmed_start = stripped.trim_start();
    if let Some(after_open) = trimmed_start
        .strip_prefix("---\r\n")
        .or_else(|| trimmed_start.strip_prefix("---\n"))
    {
        if let Some(close_idx) = after_open.find("\n---") {
            let header = &after_open[..close_idx];
            let rest = &after_open[close_idx + "\n---".len()..];
            let body = rest
                .strip_prefix("\r\n")
                .or_else(|| rest.strip_prefix('\n'))
                .unwrap_or(rest)
                .trim();
            return (Some(header), body);
        }
    }
    if let Some(idx) = stripped.find("\r\n\r\n") {
        let header = &stripped[..idx];
        if header.lines().any(|l| l.contains(':')) {
            return (Some(header), stripped[idx + 4..].trim());
        }
    }
    if let Some(idx) = stripped.find("\n\n") {
        let header = &stripped[..idx];
        if header.lines().any(|l| l.contains(':')) {
            return (Some(header), stripped[idx + 2..].trim());
        }
    }
    (None, stripped.trim())
}

fn parse_agent_markdown(path: PathBuf, stem: &str, raw: &str) -> PluginAgentProfileInfo {
    let (header_opt, fallback_body) = split_agent_frontmatter(raw);
    let mut parsed_name: Option<String> = None;
    let mut parsed_desc: Option<String> = None;
    let mut parsed_provider: Option<String> = None;
    let mut parsed_model: Option<String> = None;
    let mut parsed_effort: Option<String> = None;
    let mut parsed_workspace: Option<String> = None;
    let mut parsed_command: Option<String> = None;

    if let Some(header) = header_opt {
        for line in header.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let cleaned = unquote_header_value(value).trim().to_string();
            if cleaned.is_empty() {
                continue;
            }
            match key.trim() {
                "name" => parsed_name = Some(cleaned),
                "description" => parsed_desc = Some(cleaned),
                "provider" => parsed_provider = Some(cleaned),
                "model" => parsed_model = Some(cleaned),
                "effort" => parsed_effort = Some(cleaned),
                "workspace" => parsed_workspace = Some(cleaned),
                "command" => parsed_command = Some(cleaned),
                _ => {}
            }
        }
    }

    let role_ok = parse_role(raw).ok();
    let description = role_ok
        .as_ref()
        .and_then(|r| r.description.clone())
        .or(parsed_desc);
    let provider = role_ok
        .as_ref()
        .and_then(|r| {
            r.provider.clone().or_else(|| {
                (!r.command.trim().is_empty() && !r.command.eq_ignore_ascii_case("auto"))
                    .then(|| r.command.clone())
            })
        })
        .or(parsed_provider)
        .or_else(|| {
            parsed_command
                .filter(|c| !c.is_empty() && !c.eq_ignore_ascii_case("auto"))
        });
    let model = role_ok.as_ref().and_then(|r| r.model.clone()).or(parsed_model);
    let effort = role_ok
        .as_ref()
        .and_then(|r| r.effort.clone())
        .or(parsed_effort);
    let workspace = role_ok
        .as_ref()
        .and_then(|r| r.workspace.clone())
        .or(parsed_workspace);
    let body = role_ok
        .map(|r| r.body)
        .unwrap_or_else(|| fallback_body.to_string());

    let norm_slug = normalize_agent_slug(stem);
    let slug = if norm_slug.is_empty() {
        stem.to_string()
    } else {
        norm_slug
    };
    let name = parsed_name.unwrap_or_else(|| stem.to_string());

    PluginAgentProfileInfo {
        slug,
        name,
        description,
        provider,
        model,
        effort,
        workspace,
        body,
        path,
    }
}

fn scan_agents(plugin_root: &Path, canonical_root: &Path) -> Vec<PluginAgentProfileInfo> {
    let agents_dir = plugin_root.join("agents");
    if !agents_dir.is_dir() || validate_existing_inside_root(canonical_root, &agents_dir).is_none()
    {
        return Vec::new();
    }

    let Ok(entries) = fs::read_dir(&agents_dir) else {
        return Vec::new();
    };
    let mut files: Vec<(String, String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let is_md = path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"));
            if !path.is_file() || !is_md {
                return None;
            }
            let fname = entry.file_name().to_str()?.to_string();
            let stem = path.file_stem()?.to_str()?.to_string();
            Some((fname, stem, path))
        })
        .collect();
    files.sort_by(|a, b| a.0.to_ascii_lowercase().cmp(&b.0.to_ascii_lowercase()));

    let mut out = Vec::new();
    let mut seen_canonical = HashSet::new();
    for (_, stem, path) in files {
        let Some(canon) = validate_existing_inside_root(canonical_root, &path) else {
            continue;
        };
        if !canon.is_file() || !seen_canonical.insert(canon) {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            out.push(parse_agent_markdown(path, &stem, &raw));
        }
    }
    out
}

fn detect_hooks(
    plugin_root: &Path,
    canonical_root: &Path,
    format: PluginManifestFormat,
) -> (bool, Option<PathBuf>) {
    let root_hooks = plugin_root.join("hooks.json");
    if root_hooks.is_file() {
        if let Some(canon) = validate_existing_inside_root(canonical_root, &root_hooks) {
            if canon.is_file() {
                return (true, Some(root_hooks));
            }
        }
    }

    if format != PluginManifestFormat::Native {
        let nested_hooks = plugin_root.join("hooks").join("hooks.json");
        if nested_hooks.is_file() {
            if let Some(canon) = validate_existing_inside_root(canonical_root, &nested_hooks) {
                if canon.is_file() {
                    return (true, Some(nested_hooks));
                }
            }
        }
    }

    (false, None)
}

pub fn parse_plugin_bundle(
    plugin_root: &Path,
    data_root: &Path,
    source: PluginSourceKind,
) -> Result<DiscoveredPlugin, String> {
    let dir_id = plugin_root
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!(
                "Cannot derive plugin directory ID from {}",
                plugin_root.display()
            )
        })?
        .to_string();
    parse_plugin_bundle_with_dir_id(plugin_root, &dir_id, data_root, source)
}

pub fn parse_plugin_bundle_with_dir_id(
    plugin_root: &Path,
    dir_id: &str,
    data_root: &Path,
    source: PluginSourceKind,
) -> Result<DiscoveredPlugin, String> {
    if !plugin_root.is_dir() {
        return Err(format!(
            "Plugin directory does not exist: {}",
            plugin_root.display()
        ));
    }
    if !is_safe_single_segment(dir_id) {
        return Err(format!("Invalid plugin directory ID: '{dir_id}'"));
    }

    let canonical_root = fs::canonicalize(plugin_root).map_err(|err| {
        format!(
            "Could not resolve plugin root {}: {err}",
            plugin_root.display()
        )
    })?;

    let (manifest_path, format) = find_manifest_file(plugin_root).ok_or_else(|| {
        format!(
            "No supported plugin manifest found in {}",
            plugin_root.display()
        )
    })?;
    if validate_existing_inside_root(&canonical_root, &manifest_path).is_none() {
        return Err(format!(
            "Manifest path escapes plugin root: {}",
            manifest_path.display()
        ));
    }

    let raw_manifest = fs::read_to_string(&manifest_path)
        .map_err(|err| format!("Could not read {}: {err}", manifest_path.display()))?;
    let manifest_val = parse_jsonc_value(&raw_manifest)
        .map_err(|err| format!("Failed to parse {}: {err}", manifest_path.display()))?;
    if !manifest_val.is_object() {
        return Err(format!(
            "Manifest root must be a JSON object: {}",
            manifest_path.display()
        ));
    }

    let name = non_empty_str(manifest_val.get("name")).unwrap_or_else(|| dir_id.to_string());
    let display_name = non_empty_str(manifest_val.get("displayName"))
        .or_else(|| non_empty_str(manifest_val.get("display_name")))
        .unwrap_or_else(|| name.clone());
    let description = non_empty_str(manifest_val.get("description")).unwrap_or_default();
    let version = non_empty_str(manifest_val.get("version"));
    let author = extract_author(&manifest_val);
    let homepage = non_empty_str(manifest_val.get("homepage"));
    let repository = extract_repository(&manifest_val);
    let license = non_empty_str(manifest_val.get("license"));
    let keywords = extract_string_list(manifest_val.get("keywords"), None);
    let suggested_prompts = extract_string_list(
        manifest_val
            .get("suggestedPrompts")
            .or_else(|| manifest_val.get("suggested_prompts")),
        Some(MAX_SUGGESTED_PROMPTS),
    );
    let manifest_disabled = manifest_val
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let logo_raw = manifest_val.get("logo").and_then(Value::as_str);
    let logo_data_uri = load_logo_data_uri(plugin_root, &canonical_root, logo_raw);

    let data_path = data_root.join(dir_id);
    let sidecars = parse_sidecars(plugin_root, &canonical_root, dir_id, &name, &data_path);
    let mcp_servers = parse_mcp_servers(
        plugin_root,
        &canonical_root,
        &manifest_val,
        dir_id,
        &data_path,
    );
    let skills = scan_skills(plugin_root, &canonical_root, dir_id);
    let rules = scan_rules(plugin_root, &canonical_root, format, &manifest_val);
    let agents = scan_agents(plugin_root, &canonical_root);
    let (has_hooks, hooks_path) = detect_hooks(plugin_root, &canonical_root, format);

    Ok(DiscoveredPlugin {
        dir_id: dir_id.to_string(),
        name,
        display_name,
        description,
        version,
        author,
        homepage,
        repository,
        license,
        keywords,
        suggested_prompts,
        logo_data_uri,
        source,
        format,
        root_path: plugin_root.to_path_buf(),
        data_path,
        enabled: !manifest_disabled,
        manifest_disabled,
        can_uninstall: matches!(source, PluginSourceKind::GlobalKite),
        has_hooks,
        hooks_path,
        sidecars,
        mcp_servers,
        skills,
        rules,
        agents,
    })
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
            "kite-plugin-manifest-{label}-{}-{nanos}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn strip_jsonc_handles_comments_trailing_commas_and_strings() {
        let raw = "\u{feff}{\n  // single line comment\n  \"name\": \"http://example.com//keep, /* keep */\",\n  /* block \n     comment */\n  \"arr\": [1, \"a, }\", 2,],\n  \"nested\": { \"ok\": true, },\n}\n";
        let stripped = strip_jsonc(raw);
        let val: Value = serde_json::from_str(&stripped).expect("stripped JSONC must parse");
        assert_eq!(
            val["name"],
            Value::String("http://example.com//keep, /* keep */".into())
        );
        assert_eq!(val["arr"][1], Value::String("a, }".into()));
        assert_eq!(val["nested"]["ok"], Value::Bool(true));
    }

    #[test]
    fn parses_native_bundle_logo_sidecars_mcp_skills_rules_agents_and_hooks() {
        let temp = make_temp_dir("full-bundle");
        let root = temp.join("android-cli-plugin");
        let data_root = temp.join("data");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::create_dir_all(root.join("sidecars").join("device-hub")).unwrap();
        fs::create_dir_all(root.join("ext-sidecars").join("preview")).unwrap();
        fs::create_dir_all(root.join("skills").join("device-hub")).unwrap();
        fs::create_dir_all(root.join("rules")).unwrap();
        fs::create_dir_all(root.join("agents")).unwrap();

        fs::write(root.join("assets").join("logo.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        fs::write(
            root.join("plugin.json"),
            r#"{
              // JSONC manifest
              "name": "android-cli-plugin",
              "displayName": "Android CLI",
              "description": "Device tools",
              "version": "1.0.0",
              "author": { "name": "Dev Tools" },
              "homepage": "https://example.com",
              "repository": { "url": "https://example.com/repo.git" },
              "license": "Apache-2.0",
              "keywords": ["android", "mobile"],
              "suggestedPrompts": ["p1", "", "p2", "p3", "p4"],
              "logo": "assets/logo.png",
              "mcpServers": {
                "fallback-only": {
                  "url": "https://example.com/mcp",
                  "headers": { "X-Root": "${PLUGIN_ROOT}" }
                }
              },
            }"#,
        )
        .unwrap();

        fs::write(
            root.join("sidecars").join("device-hub").join("sidecar.json"),
            r#"{
              "command": "node",
              "args": ["../launch.mjs", "${PLUGIN_DATA}"],
              "env": { "ROOT": "${PLUGIN_ROOT}" },
              "restart_policy": "always",
              "display_name": "Android Device Hub",
              "has_web_ui": true,
              "allows_user_interactions": true,
              "ui_config": {
                "views": [
                  { "title": "Device Hub", "path": "/", "entrypoint": "aux_pane" }
                ]
              }
            }"#,
        )
        .unwrap();

        fs::write(
            root.join("ext-sidecars").join("preview").join("sidecar.json"),
            r#"{
              "command": "node",
              "args": ["server.mjs"],
              "restart_policy": "never"
            }"#,
        )
        .unwrap();
        fs::write(
            root.join("sidecars.json"),
            r#"{
              "compose-preview": "ext-sidecars/preview/sidecar.json",
              "escape": "../outside/sidecar.json"
            }"#,
        )
        .unwrap();

        fs::write(
            root.join("mcp_config.json"),
            r#"{
              "mcpServers": {
                "adb-stdio": {
                  "command": "node",
                  "args": ["${PLUGIN_ROOT}/mcp.mjs", "${PLUGIN_DATA}"],
                  "env": { "DATA": "${PLUGIN_DATA}" }
                },
                "remote-http": {
                  "serverUrl": "http://127.0.0.1:8080/mcp",
                  "headers": { "Authorization": "Bearer test" }
                }
              }
            }"#,
        )
        .unwrap();

        fs::write(
            root.join("skills").join("device-hub").join("SKILL.md"),
            "---\nname: device-hub\ndescription: Mirror devices\ndisable-model-invocation: true\n---\nUse device hub.\n",
        )
        .unwrap();

        fs::write(root.join("rules").join("zeta.md"), "zeta rule").unwrap();
        fs::write(root.join("rules").join("GEMINI.md"), "gemini rule").unwrap();
        fs::write(root.join("rules").join("AGENTS.md"), "agents rule").unwrap();

        fs::write(
            root.join("agents").join("device-qa.md"),
            "---\nname: Device QA\ndescription: Inspect screen\nmodel: sonnet\n---\nCheck UI.\n",
        )
        .unwrap();
        fs::write(root.join("hooks.json"), r#"{ "PreToolUse": [] }"#).unwrap();

        let parsed =
            parse_plugin_bundle(&root, &data_root, PluginSourceKind::GlobalKite).unwrap();

        assert_eq!(parsed.dir_id, "android-cli-plugin");
        assert_eq!(parsed.format, PluginManifestFormat::Native);
        assert_eq!(parsed.display_name, "Android CLI");
        assert_eq!(parsed.author.as_deref(), Some("Dev Tools"));
        assert_eq!(
            parsed.repository.as_deref(),
            Some("https://example.com/repo.git")
        );
        assert_eq!(parsed.suggested_prompts, vec!["p1", "p2", "p3"]);
        assert!(parsed
            .logo_data_uri
            .as_deref()
            .is_some_and(|u| u.starts_with("data:image/png;base64,")));
        assert!(parsed.has_hooks);

        assert_eq!(parsed.sidecars.len(), 2);
        let hub = &parsed.sidecars[0];
        assert_eq!(hub.namespaced_id, "android-cli-plugin/device-hub");
        assert_eq!(hub.working_dir, root.join("sidecars").join("device-hub"));
        assert_eq!(hub.restart_policy, SidecarRestartPolicy::Always);
        assert!(hub.has_web_ui);
        assert!(hub.allows_user_interactions);
        assert_eq!(
            hub.args[1],
            data_root.join("android-cli-plugin").to_string_lossy()
        );
        assert_eq!(parsed.sidecars[1].id, "compose-preview");
        assert_eq!(parsed.sidecars[1].restart_policy, SidecarRestartPolicy::Never);

        assert_eq!(parsed.mcp_servers.len(), 3);
        let stdio = parsed
            .mcp_servers
            .iter()
            .find(|s| s.server_name == "adb-stdio")
            .unwrap();
        assert_eq!(stdio.id, "android-cli-plugin_adb-stdio");
        match &stdio.config {
            PluginMcpTransport::Stdio { args, env, .. } => {
                assert!(args[0].contains(&*root.to_string_lossy()));
                assert_eq!(
                    env.get("DATA").unwrap().as_str(),
                    data_root.join("android-cli-plugin").to_string_lossy().as_ref()
                );
            }
            _ => panic!("expected stdio transport"),
        }

        assert_eq!(parsed.skills.len(), 1);
        assert!(parsed.skills[0].disable_model_invocation);
        assert_eq!(
            parsed
                .rules
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            vec!["AGENTS.md", "GEMINI.md", "zeta.md"]
        );
        assert_eq!(parsed.agents.len(), 1);
        assert_eq!(parsed.agents[0].slug, "device-qa");
        assert_eq!(parsed.agents[0].name, "Device QA");
        assert_eq!(parsed.agents[0].model.as_deref(), Some("sonnet"));

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn supports_all_compatibility_manifest_formats_and_hooks_fallback() {
        let cases: &[(&[&str], PluginManifestFormat)] = &[
            (&[".antigravity-plugin", "plugin.json"], PluginManifestFormat::LegacyManifest),
            (&[".gemini-plugin", "plugin.json"], PluginManifestFormat::LegacyManifest),
            (&[".claude-plugin", "plugin.json"], PluginManifestFormat::Claude),
            (&[".cursor-plugin", "plugin.json"], PluginManifestFormat::Cursor),
            (&["gemini-extension.json"], PluginManifestFormat::GeminiExtension),
        ];

        let temp = make_temp_dir("compat-formats");
        let data_root = temp.join("data");

        for (idx, (segs, expected_fmt)) in cases.iter().enumerate() {
            let root = temp.join(format!("compat-{idx}"));
            fs::create_dir_all(root.join("hooks")).unwrap();
            let mut mpath = root.clone();
            for s in *segs {
                mpath.push(s);
            }
            if let Some(p) = mpath.parent() {
                fs::create_dir_all(p).unwrap();
            }
            fs::write(
                &mpath,
                r#"{ "name": "compat-bundle", "author": "Alice", "repository": "https://example.com/r", "disabled": true }"#,
            )
            .unwrap();
            fs::write(root.join("hooks").join("hooks.json"), "{}").unwrap();

            let parsed =
                parse_plugin_bundle(&root, &data_root, PluginSourceKind::SharedSystem).unwrap();
            assert_eq!(parsed.format, *expected_fmt);
            assert_eq!(parsed.author.as_deref(), Some("Alice"));
            assert!(parsed.manifest_disabled);
            assert!(!parsed.enabled);
            assert!(!parsed.can_uninstall);
            assert!(parsed.has_hooks);
            assert_eq!(parsed.hooks_path, Some(root.join("hooks").join("hooks.json")));
        }

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn rejects_invalid_or_escaping_logos_and_sidecar_traversals() {
        let temp = make_temp_dir("security");
        let root = temp.join("sec-plugin");
        let outside = temp.join("outside");
        let data_root = temp.join("data");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::create_dir_all(&outside).unwrap();

        fs::write(outside.join("secret.png"), b"\x89PNG").unwrap();
        fs::write(outside.join("sidecar.json"), r#"{ "command": "evil" }"#).unwrap();
        fs::write(root.join("assets").join("script.exe"), b"MZ").unwrap();
        fs::write(
            root.join("assets").join("huge.png"),
            vec![0u8; MAX_LOGO_BYTES + 1],
        )
        .unwrap();

        for bad_logo in [
            "https://example.com/logo.png",
            "../outside/secret.png",
            "/abs/logo.png",
            "C:\\abs\\logo.png",
            "assets/script.exe",
            "assets/huge.png",
            "assets/missing.png",
        ] {
            fs::write(
                root.join("plugin.json"),
                serde_json::json!({ "name": "sec", "logo": bad_logo }).to_string(),
            )
            .unwrap();
            let parsed =
                parse_plugin_bundle(&root, &data_root, PluginSourceKind::Workspace).unwrap();
            assert_eq!(parsed.logo_data_uri, None, "must reject logo: {bad_logo}");
        }

        fs::write(
            root.join("sidecars.json"),
            serde_json::json!([
                "../outside/sidecar.json",
                "/abs/sidecar.json",
                "C:\\abs\\sidecar.json"
            ])
            .to_string(),
        )
        .unwrap();
        let parsed = parse_plugin_bundle(&root, &data_root, PluginSourceKind::Workspace).unwrap();
        assert!(parsed.sidecars.is_empty());

        fs::create_dir_all(root.join("ext-sidecars").join("preview")).unwrap();
        fs::write(
            root.join("ext-sidecars").join("preview").join("sidecar.json"),
            r#"{ "command": "node", "args": ["preview.mjs"] }"#,
        )
        .unwrap();
        fs::write(root.join("sidecars.json"), r#"["ext-sidecars/preview"]"#).unwrap();
        let parsed = parse_plugin_bundle(&root, &data_root, PluginSourceKind::Workspace).unwrap();
        assert_eq!(parsed.sidecars.len(), 1);
        assert_eq!(parsed.sidecars[0].id, "preview");
        assert_eq!(
            parsed.sidecars[0].working_dir,
            root.join("ext-sidecars").join("preview")
        );

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn parses_svg_logo_root_skill_and_role_style_agent_profile() {
        let temp = make_temp_dir("svg-role");
        let root = temp.join("bundle");
        let data_root = temp.join("data");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::create_dir_all(root.join("skills")).unwrap();
        fs::create_dir_all(root.join("agents")).unwrap();

        fs::write(root.join("assets").join("icon.svg"), "<svg/>").unwrap();
        fs::write(
            root.join("plugin.json"),
            r#"{ "name": "bundle", "logo": "assets/icon.svg" }"#,
        )
        .unwrap();
        fs::write(
            root.join("skills").join("SKILL.md"),
            "---\nname: root-skill\ndescription: Top-level skill\n---\nInstructions\n",
        )
        .unwrap();
        fs::write(
            root.join("agents").join("reviewer.md"),
            "command: codex\ndescription: Code reviewer\nmodel: o3\n\nReview carefully.\n",
        )
        .unwrap();

        let parsed = parse_plugin_bundle(&root, &data_root, PluginSourceKind::GlobalKite).unwrap();
        assert!(parsed
            .logo_data_uri
            .as_deref()
            .is_some_and(|u| u.starts_with("data:image/svg+xml;base64,")));
        assert_eq!(parsed.skills.len(), 1);
        assert_eq!(parsed.skills[0].id, "root-skill");
        assert_eq!(parsed.agents.len(), 1);
        assert_eq!(parsed.agents[0].provider.as_deref(), Some("codex"));
        assert_eq!(parsed.agents[0].model.as_deref(), Some("o3"));
        assert_eq!(parsed.agents[0].body, "Review carefully.");

        let _ = fs::remove_dir_all(&temp);
    }
}
