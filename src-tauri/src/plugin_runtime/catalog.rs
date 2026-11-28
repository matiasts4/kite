//! Configurable feed-driven plugin catalog sources, fetching, version comparison, and install triggers.

use crate::persist::roaming_app_dir;
use crate::plugin_runtime::manifest::parse_jsonc_value;
use crate::plugin_runtime::registry::{
    discover_plugins, discover_plugins_at, install_from_archive_at, install_from_folder_at,
    install_from_git_at,
};
use crate::plugin_runtime::types::{
    DiscoveredPlugin, PluginRecordDto, PluginRuntimeSettings,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const HTTP_TIMEOUT_SECS: u64 = 15;
const ARCHIVE_DOWNLOAD_TIMEOUT_SECS: u64 = 120;
const MAX_CATALOG_JSON_BYTES: usize = 10 * 1024 * 1024;
const MAX_ARCHIVE_DOWNLOAD_BYTES: usize = 256 * 1024 * 1024;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginCatalogInstallKind {
    Git,
    Archive,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogSource {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub url: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogEntry {
    pub id: String,
    pub source_id: String,
    pub source_name: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub keywords: Vec<String>,
    pub install_kind: PluginCatalogInstallKind,
    pub install_location: String,
    pub git_ref: Option<String>,
    pub subdir: Option<String>,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub update_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogFetchError {
    pub source_id: String,
    pub source_name: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogFetchResult {
    pub sources: Vec<PluginCatalogSource>,
    pub entries: Vec<PluginCatalogEntry>,
    pub errors: Vec<PluginCatalogFetchError>,
}

struct TempZipFile {
    dir: PathBuf,
    file: PathBuf,
}

impl TempZipFile {
    fn create() -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!(
            "kite-catalog-zip-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir)
            .map_err(|err| format!("Failed creating temporary download directory: {err}"))?;
        let file = dir.join("plugin-bundle.zip");
        Ok(Self { dir, file })
    }
}

impl Drop for TempZipFile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

pub fn catalog_sources_path_at(app_dir: &Path) -> PathBuf {
    app_dir.join("plugin_catalog_sources.json")
}

fn sanitize_source_id(raw: &str) -> String {
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
        if out.len() >= 64 {
            break;
        }
    }
    while out.ends_with('-') || out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        "feed".to_string()
    } else {
        out
    }
}

fn infer_source_name(url: &str) -> String {
    let cleaned = url.trim().trim_end_matches(['/', '\\']);
    if let Some(last) = cleaned.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()) {
        return last.to_string();
    }
    "Catalog Feed".to_string()
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
            .unwrap_or("catalog_sources"),
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

pub fn list_catalog_sources_at(app_dir: &Path) -> Result<Vec<PluginCatalogSource>, String> {
    let path = catalog_sources_path_at(app_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let val = parse_jsonc_value(&raw)
        .map_err(|err| format!("Invalid plugin catalog sources file {}: {err}", path.display()))?;

    let array_val = if val.is_array() {
        val
    } else if let Some(sources) = val.get("sources").filter(|v| v.is_array()) {
        sources.clone()
    } else {
        return Err(format!(
            "Invalid plugin catalog sources file {}: expected array or {{ \"sources\": [...] }}",
            path.display()
        ));
    };

    serde_json::from_value::<Vec<PluginCatalogSource>>(array_val).map_err(|err| {
        format!(
            "Malformed catalog source entry in {}: {err}",
            path.display()
        )
    })
}

pub fn save_catalog_sources_at(
    app_dir: &Path,
    sources: Vec<PluginCatalogSource>,
) -> Result<Vec<PluginCatalogSource>, String> {
    let mut seen_ids = HashSet::new();
    let mut normalized = Vec::with_capacity(sources.len());

    for src in sources {
        let url = src.url.trim().to_string();
        if url.is_empty() {
            return Err("Catalog source URL or path is required.".to_string());
        }
        if url.contains(['\0', '\r', '\n']) {
            return Err("Catalog source URL or path contains invalid control characters.".to_string());
        }

        let name = {
            let trimmed = src.name.trim();
            if trimmed.is_empty() {
                infer_source_name(&url)
            } else {
                trimmed.to_string()
            }
        };

        let raw_id = src.id.trim();
        let id = if raw_id.is_empty() {
            let base = sanitize_source_id(&name);
            let mut candidate = base.clone();
            let mut suffix = 2usize;
            while seen_ids.contains(&candidate.to_ascii_lowercase()) {
                candidate = format!("{base}-{suffix}");
                suffix += 1;
            }
            candidate
        } else {
            let candidate = sanitize_source_id(raw_id);
            if seen_ids.contains(&candidate.to_ascii_lowercase()) {
                return Err(format!("Duplicate catalog source ID: '{candidate}'"));
            }
            candidate
        };

        seen_ids.insert(id.to_ascii_lowercase());
        normalized.push(PluginCatalogSource {
            id,
            name,
            url,
            enabled: src.enabled,
        });
    }

    atomic_write_json(&catalog_sources_path_at(app_dir), &normalized)?;
    Ok(normalized)
}

pub fn list_catalog_sources() -> Result<Vec<PluginCatalogSource>, String> {
    list_catalog_sources_at(&roaming_app_dir())
}

pub fn save_catalog_sources(
    sources: Vec<PluginCatalogSource>,
) -> Result<Vec<PluginCatalogSource>, String> {
    save_catalog_sources_at(&roaming_app_dir(), sources)
}

fn is_http_url(raw: &str) -> bool {
    let lower = raw.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn is_file_url(raw: &str) -> bool {
    raw.trim().to_ascii_lowercase().starts_with("file://")
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h1 = (bytes[i + 1] as char).to_digit(16);
            let h2 = (bytes[i + 2] as char).to_digit(16);
            if let (Some(a), Some(b)) = (h1, h2) {
                out.push(((a << 4) | b) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_file_url_to_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.len() < 7 || !is_file_url(trimmed) {
        return Err(format!("Invalid file URL: '{raw}'"));
    }
    let after_scheme = &trimmed[7..];
    let rest = if let Some(stripped) = after_scheme
        .strip_prefix("localhost/")
        .or_else(|| after_scheme.strip_prefix("LOCALHOST/"))
    {
        format!("/{stripped}")
    } else if !after_scheme.starts_with('/') {
        // UNC host form `file://server/share/path`
        let decoded = percent_decode(after_scheme).replace('/', "\\");
        return Ok(PathBuf::from(format!("\\\\{decoded}")));
    } else {
        after_scheme.to_string()
    };

    let decoded = percent_decode(&rest);
    #[cfg(windows)]
    let normalized = {
        let bytes = decoded.as_bytes();
        if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
            decoded[1..].replace('/', "\\")
        } else {
            decoded.replace('/', "\\")
        }
    };
    #[cfg(not(windows))]
    let normalized = decoded;

    if normalized.is_empty() {
        return Err(format!("Empty file URL path: '{raw}'"));
    }
    Ok(PathBuf::from(normalized))
}

fn http_get_bytes(url: &str, timeout_secs: u64, max_bytes: usize) -> Result<Vec<u8>, String> {
    let url_owned = url.to_string();
    let run = move || -> Result<Vec<u8>, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .user_agent(format!("kite-code/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|err| format!("Failed to initialize HTTP client: {err}"))?;
        let resp = client
            .get(&url_owned)
            .header("accept", "application/json, application/octet-stream, */*")
            .send()
            .map_err(|err| format!("Failed fetching '{url_owned}': {err}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {status} while fetching '{url_owned}'"));
        }
        if let Some(len) = resp.content_length() {
            if len > max_bytes as u64 {
                return Err(format!(
                    "Remote payload exceeds maximum allowed size ({max_bytes} bytes)"
                ));
            }
        }
        let mut buf = Vec::new();
        let mut limited = resp.take((max_bytes as u64).saturating_add(1));
        limited
            .read_to_end(&mut buf)
            .map_err(|err| format!("Failed reading response from '{url_owned}': {err}"))?;
        if buf.len() > max_bytes {
            return Err(format!(
                "Remote payload exceeds maximum allowed size ({max_bytes} bytes)"
            ));
        }
        Ok(buf)
    };

    // Guard against Tokio `Cannot drop a runtime in a context where blocking is not allowed`
    // when invoked inside `tauri::async_runtime::spawn_blocking`.
    if tokio::runtime::Handle::try_current().is_ok() {
        std::thread::Builder::new()
            .name("kite-catalog-http".to_string())
            .spawn(run)
            .map_err(|err| format!("Failed to spawn HTTP worker thread: {err}"))?
            .join()
            .map_err(|_| "Catalog HTTP worker thread panicked.".to_string())?
    } else {
        run()
    }
}

fn load_feed_text(source_url: &str) -> Result<(String, Option<PathBuf>), String> {
    let trimmed = source_url.trim();
    if is_http_url(trimmed) {
        let bytes = http_get_bytes(trimmed, HTTP_TIMEOUT_SECS, MAX_CATALOG_JSON_BYTES)?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("Catalog feed '{trimmed}' is not valid UTF-8: {err}"))?;
        return Ok((text, None));
    }

    let path = if is_file_url(trimmed) {
        parse_file_url_to_path(trimmed)?
    } else {
        PathBuf::from(trimmed)
    };

    let meta = fs::metadata(&path)
        .map_err(|err| format!("Catalog feed '{}' could not be opened: {err}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("Catalog feed '{}' is not a file.", path.display()));
    }
    if meta.len() > MAX_CATALOG_JSON_BYTES as u64 {
        return Err(format!(
            "Catalog feed '{}' exceeds maximum allowed size ({MAX_CATALOG_JSON_BYTES} bytes).",
            path.display()
        ));
    }
    let text = fs::read_to_string(&path)
        .map_err(|err| format!("Failed reading catalog feed '{}': {err}", path.display()))?;
    let base_dir = path.parent().map(Path::to_path_buf);
    Ok((text, base_dir))
}

fn non_empty_str(val: Option<&Value>) -> Option<String> {
    val.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn extract_author(val: Option<&Value>) -> Option<String> {
    match val? {
        Value::String(s) => non_empty_str(Some(&Value::String(s.clone()))),
        Value::Object(obj) => non_empty_str(obj.get("name")),
        _ => None,
    }
}

fn parse_install_kind(raw: &str) -> Option<PluginCatalogInstallKind> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "git" => Some(PluginCatalogInstallKind::Git),
        "archive" | "zip" => Some(PluginCatalogInstallKind::Archive),
        "folder" | "dir" | "directory" | "local" => Some(PluginCatalogInstallKind::Folder),
        _ => None,
    }
}

fn resolve_local_install_location(
    raw_location: &str,
    install_kind: PluginCatalogInstallKind,
    feed_base_dir: Option<&Path>,
) -> String {
    let trimmed = raw_location.trim();
    if install_kind == PluginCatalogInstallKind::Git || is_http_url(trimmed) {
        return trimmed.to_string();
    }
    if is_file_url(trimmed) {
        return parse_file_url_to_path(trimmed)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| trimmed.to_string());
    }
    let candidate = Path::new(trimmed);
    if !candidate.is_absolute() {
        if let Some(base) = feed_base_dir {
            return base.join(candidate).to_string_lossy().into_owned();
        }
    }
    trimmed.to_string()
}

fn parse_feed_entry(
    source: &PluginCatalogSource,
    item: &Value,
    feed_base_dir: Option<&Path>,
) -> Option<PluginCatalogEntry> {
    let obj = item.as_object()?;
    let id = non_empty_str(obj.get("id")).or_else(|| non_empty_str(obj.get("name")))?;
    let name = non_empty_str(obj.get("name")).unwrap_or_else(|| id.clone());
    let display_name = non_empty_str(obj.get("displayName"))
        .or_else(|| non_empty_str(obj.get("display_name")))
        .unwrap_or_else(|| name.clone());
    let description = non_empty_str(obj.get("description")).unwrap_or_default();
    let version = non_empty_str(obj.get("version"));
    let author = extract_author(obj.get("author"));
    let homepage = non_empty_str(obj.get("homepage"));
    let repository = non_empty_str(obj.get("repository"));

    let keywords = obj
        .get("keywords")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let install_obj = obj.get("install").and_then(Value::as_object);
    let raw_kind = non_empty_str(obj.get("installKind"))
        .or_else(|| non_empty_str(obj.get("install_kind")))
        .or_else(|| install_obj.and_then(|o| non_empty_str(o.get("kind"))));

    let raw_location = non_empty_str(obj.get("installLocation"))
        .or_else(|| non_empty_str(obj.get("install_location")))
        .or_else(|| install_obj.and_then(|o| non_empty_str(o.get("location"))))
        .or_else(|| install_obj.and_then(|o| non_empty_str(o.get("url"))))
        .or_else(|| install_obj.and_then(|o| non_empty_str(o.get("path"))))
        .or_else(|| non_empty_str(obj.get("archiveUrl")))
        .or_else(|| non_empty_str(obj.get("repoUrl")))
        .or_else(|| non_empty_str(obj.get("url")))
        .or_else(|| non_empty_str(obj.get("path")))
        .or_else(|| repository.clone())?;

    if raw_location.contains(['\0', '\r', '\n']) {
        return None;
    }

    let install_kind = match raw_kind {
        Some(k) => parse_install_kind(&k)?,
        None => {
            let lower = raw_location.to_ascii_lowercase();
            if lower.ends_with(".zip") {
                PluginCatalogInstallKind::Archive
            } else if lower.ends_with(".git") || repository.is_some() {
                PluginCatalogInstallKind::Git
            } else {
                PluginCatalogInstallKind::Folder
            }
        }
    };

    let git_ref = non_empty_str(obj.get("gitRef"))
        .or_else(|| non_empty_str(obj.get("git_ref")))
        .or_else(|| non_empty_str(obj.get("ref")))
        .or_else(|| install_obj.and_then(|o| non_empty_str(o.get("gitRef"))))
        .or_else(|| install_obj.and_then(|o| non_empty_str(o.get("ref"))));

    let subdir = non_empty_str(obj.get("subdir"))
        .or_else(|| install_obj.and_then(|o| non_empty_str(o.get("subdir"))));

    let install_location = resolve_local_install_location(&raw_location, install_kind, feed_base_dir);

    Some(PluginCatalogEntry {
        id,
        source_id: source.id.clone(),
        source_name: source.name.clone(),
        name,
        display_name,
        description,
        version,
        author,
        homepage,
        repository,
        keywords,
        install_kind,
        install_location,
        git_ref,
        subdir,
        installed: false,
        installed_version: None,
        update_available: false,
    })
}

fn fetch_single_source(source: &PluginCatalogSource) -> Result<Vec<PluginCatalogEntry>, String> {
    let (raw, feed_base_dir) = load_feed_text(&source.url)?;
    let val = parse_jsonc_value(&raw)
        .map_err(|err| format!("Invalid JSON in catalog feed: {err}"))?;
    let obj = val
        .as_object()
        .ok_or_else(|| "Catalog feed root must be a JSON object.".to_string())?;

    let schema_version = obj.get("schemaVersion").and_then(Value::as_u64);
    if schema_version != Some(1) {
        return Err(format!(
            "Unsupported catalog schemaVersion {:?} (expected 1).",
            obj.get("schemaVersion")
        ));
    }

    let items = obj
        .get("plugins")
        .or_else(|| obj.get("entries"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Catalog feed is missing 'plugins' array.".to_string())?;

    let mut parsed = Vec::with_capacity(items.len());
    for item in items {
        if let Some(entry) = parse_feed_entry(source, item, feed_base_dir.as_deref()) {
            parsed.push(entry);
        }
    }
    Ok(parsed)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PreIdent {
    Num(u64),
    Str(String),
}

impl Ord for PreIdent {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Num(a), Self::Num(b)) => a.cmp(b),
            (Self::Num(_), Self::Str(_)) => Ordering::Less,
            (Self::Str(_), Self::Num(_)) => Ordering::Greater,
            (Self::Str(a), Self::Str(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for PreIdent {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSemver {
    core: Vec<u64>,
    prerelease: Option<Vec<PreIdent>>,
}

fn parse_semver(raw: &str) -> Option<ParsedSemver> {
    let trimmed = raw.trim();
    let no_v = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if no_v.is_empty() {
        return None;
    }

    let without_build = no_v.split_once('+').map(|(a, _)| a).unwrap_or(no_v);
    let (core_str, pre_str) = match without_build.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (without_build, None),
    };

    if core_str.is_empty() {
        return None;
    }

    let mut core = Vec::new();
    for seg in core_str.split('.') {
        if seg.is_empty() || !seg.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        core.push(seg.parse::<u64>().ok()?);
    }

    let prerelease = match pre_str {
        Some(p) if !p.trim().is_empty() => {
            let mut idents = Vec::new();
            for part in p.split('.') {
                if part.is_empty() {
                    return None;
                }
                if part.bytes().all(|b| b.is_ascii_digit()) {
                    idents.push(PreIdent::Num(part.parse::<u64>().ok()?));
                } else {
                    idents.push(PreIdent::Str(part.to_string()));
                }
            }
            Some(idents)
        }
        _ => None,
    };

    Some(ParsedSemver { core, prerelease })
}

fn compare_semver(remote: &str, local: &str) -> Option<Ordering> {
    let r = parse_semver(remote)?;
    let l = parse_semver(local)?;

    let max_len = r.core.len().max(l.core.len());
    for idx in 0..max_len {
        let rv = r.core.get(idx).copied().unwrap_or(0);
        let lv = l.core.get(idx).copied().unwrap_or(0);
        match rv.cmp(&lv) {
            Ordering::Equal => continue,
            non_eq => return Some(non_eq),
        }
    }

    Some(match (&r.prerelease, &l.prerelease) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(rp), Some(lp)) => rp.cmp(lp),
    })
}

/// Returns `true` when `remote` is strictly newer than `local` using numeric semver
/// comparison (ignoring an optional leading `v`/`V` prefix).
pub fn is_newer_version(remote: &str, local: &str) -> bool {
    compare_semver(remote, local) == Some(Ordering::Greater)
}

fn find_installed_match<'a>(
    entry: &PluginCatalogEntry,
    installed: &'a [DiscoveredPlugin],
) -> Option<&'a DiscoveredPlugin> {
    installed.iter().find(|p| {
        p.dir_id.eq_ignore_ascii_case(&entry.id)
            || p.name.eq_ignore_ascii_case(&entry.name)
            || p.name.eq_ignore_ascii_case(&entry.id)
            || p.dir_id.eq_ignore_ascii_case(&entry.name)
    })
}

fn apply_installed_parity(entry: &mut PluginCatalogEntry, installed: &[DiscoveredPlugin]) {
    if let Some(plugin) = find_installed_match(entry, installed) {
        entry.installed = true;
        entry.installed_version = plugin.version.clone();
        entry.update_available = match (&entry.version, &plugin.version) {
            (Some(remote), Some(local)) => is_newer_version(remote, local),
            _ => false,
        };
    } else {
        entry.installed = false;
        entry.installed_version = None;
        entry.update_available = false;
    }
}

pub fn fetch_catalog_at(
    app_dir: &Path,
    home_dir: Option<&Path>,
    workspace_dir: Option<&Path>,
    settings: &PluginRuntimeSettings,
) -> Result<PluginCatalogFetchResult, String> {
    let sources = list_catalog_sources_at(app_dir)?;
    let installed = discover_plugins_at(app_dir, home_dir, workspace_dir, settings);

    let mut entries = Vec::new();
    let mut errors = Vec::new();

    for source in &sources {
        if !source.enabled {
            continue;
        }
        match fetch_single_source(source) {
            Ok(mut fetched) => {
                for entry in &mut fetched {
                    apply_installed_parity(entry, &installed);
                }
                entries.extend(fetched);
            }
            Err(message) => {
                errors.push(PluginCatalogFetchError {
                    source_id: source.id.clone(),
                    source_name: source.name.clone(),
                    message,
                });
            }
        }
    }

    Ok(PluginCatalogFetchResult {
        sources,
        entries,
        errors,
    })
}

pub fn fetch_catalog(workspace_dir: Option<&Path>) -> Result<PluginCatalogFetchResult, String> {
    let app_dir = roaming_app_dir();
    let sources = list_catalog_sources_at(&app_dir)?;
    let installed = discover_plugins(workspace_dir);

    let mut entries = Vec::new();
    let mut errors = Vec::new();

    for source in &sources {
        if !source.enabled {
            continue;
        }
        match fetch_single_source(source) {
            Ok(mut fetched) => {
                for entry in &mut fetched {
                    apply_installed_parity(entry, &installed);
                }
                entries.extend(fetched);
            }
            Err(message) => {
                errors.push(PluginCatalogFetchError {
                    source_id: source.id.clone(),
                    source_name: source.name.clone(),
                    message,
                });
            }
        }
    }

    Ok(PluginCatalogFetchResult {
        sources,
        entries,
        errors,
    })
}

fn find_catalog_entry(
    app_dir: &Path,
    source_id: &str,
    entry_id: &str,
) -> Result<PluginCatalogEntry, String> {
    let trimmed_source = source_id.trim();
    let trimmed_entry = entry_id.trim();
    if trimmed_source.is_empty() || trimmed_entry.is_empty() {
        return Err("Both sourceId and entryId are required.".to_string());
    }

    let sources = list_catalog_sources_at(app_dir)?;
    let source = sources
        .iter()
        .find(|s| s.id == trimmed_source || s.id.eq_ignore_ascii_case(trimmed_source))
        .ok_or_else(|| format!("Catalog source '{trimmed_source}' was not found."))?;

    if !source.enabled {
        return Err(format!("Catalog source '{}' is disabled.", source.name));
    }

    let entries = fetch_single_source(source)?;
    entries
        .into_iter()
        .find(|e| e.id == trimmed_entry || e.id.eq_ignore_ascii_case(trimmed_entry))
        .ok_or_else(|| {
            format!(
                "Catalog entry '{trimmed_entry}' was not found in source '{}'.",
                source.name
            )
        })
}

fn resolve_local_path_arg(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if is_http_url(trimmed) {
        return Err("Remote HTTP(S) URLs are not supported for folder installs.".to_string());
    }
    if is_file_url(trimmed) {
        return parse_file_url_to_path(trimmed);
    }
    Ok(PathBuf::from(trimmed))
}

fn prepare_archive_path(raw_location: &str) -> Result<(PathBuf, Option<TempZipFile>), String> {
    let trimmed = raw_location.trim();
    if is_http_url(trimmed) {
        let bytes = http_get_bytes(trimmed, ARCHIVE_DOWNLOAD_TIMEOUT_SECS, MAX_ARCHIVE_DOWNLOAD_BYTES)?;
        let temp = TempZipFile::create()?;
        fs::write(&temp.file, &bytes)
            .map_err(|err| format!("Failed writing downloaded archive: {err}"))?;
        let path = temp.file.clone();
        return Ok((path, Some(temp)));
    }
    let local = if is_file_url(trimmed) {
        parse_file_url_to_path(trimmed)?
    } else {
        PathBuf::from(trimmed)
    };
    Ok((local, None))
}

pub fn install_catalog_entry_at(
    app_dir: &Path,
    source_id: &str,
    entry_id: &str,
) -> Result<DiscoveredPlugin, String> {
    let entry = find_catalog_entry(app_dir, source_id, entry_id)?;
    match entry.install_kind {
        PluginCatalogInstallKind::Git => install_from_git_at(
            app_dir,
            &entry.install_location,
            entry.git_ref.as_deref(),
            entry.subdir.as_deref(),
        ),
        PluginCatalogInstallKind::Folder => {
            let folder_path = resolve_local_path_arg(&entry.install_location)?;
            install_from_folder_at(app_dir, &folder_path)
        }
        PluginCatalogInstallKind::Archive => {
            let (archive_path, _guard) = prepare_archive_path(&entry.install_location)?;
            install_from_archive_at(app_dir, &archive_path)
        }
    }
}

pub fn install_catalog_entry(
    source_id: &str,
    entry_id: &str,
    workspace_dir: Option<&Path>,
) -> Result<PluginRecordDto, String> {
    let app_dir = roaming_app_dir();
    let entry = find_catalog_entry(&app_dir, source_id, entry_id)?;

    match entry.install_kind {
        PluginCatalogInstallKind::Git => crate::plugin_runtime::install_git_and_sync(
            &entry.install_location,
            entry.git_ref.as_deref(),
            entry.subdir.as_deref(),
            workspace_dir,
        ),
        PluginCatalogInstallKind::Folder => {
            let folder_path = resolve_local_path_arg(&entry.install_location)?;
            crate::plugin_runtime::install_folder_and_sync(&folder_path, workspace_dir)
        }
        PluginCatalogInstallKind::Archive => {
            let (archive_path, _guard) = prepare_archive_path(&entry.install_location)?;
            crate::plugin_runtime::install_archive_and_sync(&archive_path, workspace_dir)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    struct TempTestDir {
        path: PathBuf,
    }

    impl TempTestDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "kite-catalog-test-{label}-{}-{}",
                std::process::id(),
                Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&dir).expect("create temp test dir");
            Self { path: dir }
        }
    }

    impl Drop for TempTestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_sample_plugin(dir: &Path, name: &str, version: &str) {
        fs::create_dir_all(dir).expect("create plugin dir");
        let manifest = serde_json::json!({
            "name": name,
            "displayName": format!("{name} Display"),
            "description": "Catalog sample plugin",
            "version": version,
            "author": "Kite Tests"
        });
        fs::write(
            dir.join("plugin.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .expect("write plugin.json");
    }

    fn to_file_url(path: &Path) -> String {
        let normalized = path.to_string_lossy().replace('\\', "/");
        if normalized.starts_with('/') {
            format!("file://{normalized}")
        } else {
            format!("file:///{normalized}")
        }
    }

    #[test]
    fn saves_normalizes_and_lists_catalog_sources() {
        let tmp = TempTestDir::new("sources");
        let app_dir = tmp.path.join("roaming");

        assert!(list_catalog_sources_at(&app_dir).unwrap().is_empty());

        let saved = save_catalog_sources_at(
            &app_dir,
            vec![
                PluginCatalogSource {
                    id: "".to_string(),
                    name: "Team Feed".to_string(),
                    url: "https://example.com/team-catalog.json".to_string(),
                    enabled: true,
                },
                PluginCatalogSource {
                    id: "".to_string(),
                    name: "Team Feed".to_string(),
                    url: "C:\\feeds\\local.json".to_string(),
                    enabled: false,
                },
            ],
        )
        .expect("sources should save");

        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0].id, "team-feed");
        assert_eq!(saved[1].id, "team-feed-2");
        assert!(saved[0].enabled);
        assert!(!saved[1].enabled);

        let loaded = list_catalog_sources_at(&app_dir).expect("sources should reload");
        assert_eq!(loaded, saved);
    }

    #[test]
    fn semver_comparison_handles_v_prefix_numeric_segments_and_prereleases() {
        assert!(is_newer_version("v1.2.0", "1.1.9"));
        assert!(is_newer_version("1.10.0", "v1.2.0"));
        assert!(is_newer_version("V2.0.0", "1.99.99"));
        assert!(is_newer_version("1.2.0", "1.2.0-rc.1"));
        assert!(!is_newer_version("1.2.0-rc.1", "1.2.0"));
        assert!(!is_newer_version("v1.2.0", "1.2.0"));
        assert!(!is_newer_version("1.2.0", "v1.2.0"));
        assert!(!is_newer_version("1.1.0", "1.2.0"));
        assert!(!is_newer_version("not-semver", "1.0.0"));
    }

    #[test]
    fn fetches_file_url_and_http_feeds_computes_update_parity_and_collects_errors() {
        let tmp = TempTestDir::new("fetch");
        let app_dir = tmp.path.join("roaming");

        // Pre-install an older version of `alpha-tool` locally.
        let alpha_src = tmp.path.join("installed-src").join("alpha-tool");
        write_sample_plugin(&alpha_src, "alpha-tool", "1.0.0");
        install_from_folder_at(&app_dir, &alpha_src).expect("install initial alpha-tool");

        // Local file:// feed with an update to alpha-tool (v1.2.0) and a new beta-tool.
        let file_feed = tmp.path.join("local-feed.json");
        let feed_json = serde_json::json!({
            "schemaVersion": 1,
            "plugins": [
                {
                    "id": "alpha-tool",
                    "name": "alpha-tool",
                    "displayName": "Alpha Tool",
                    "description": "Updated alpha",
                    "version": "v1.2.0",
                    "author": "Kite Labs",
                    "keywords": ["alpha", "cli"],
                    "installKind": "folder",
                    "installLocation": "./bundles/alpha-tool"
                },
                {
                    "id": "beta-tool",
                    "name": "beta-tool",
                    "displayName": "Beta Tool",
                    "description": "Brand new beta",
                    "version": "0.4.0",
                    "installKind": "archive",
                    "installLocation": "https://example.com/beta.zip"
                }
            ]
        });
        fs::write(&file_feed, serde_json::to_string_pretty(&feed_json).unwrap()).unwrap();

        // Mock local HTTP server serving a second schemaVersion: 1 feed.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind http mock");
        let port = listener.local_addr().unwrap().port();
        let http_body = serde_json::json!({
            "schemaVersion": 1,
            "plugins": [
                {
                    "id": "gamma-http",
                    "name": "gamma-http",
                    "displayName": "Gamma HTTP",
                    "description": "From HTTP feed",
                    "version": "2.1.0",
                    "installKind": "git",
                    "installLocation": "https://example.com/gamma.git",
                    "gitRef": "main"
                }
            ]
        })
        .to_string();

        let server_handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut req_buf = [0u8; 1024];
                let _ = stream.read(&mut req_buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    http_body.len(),
                    http_body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        // Third feed with unsupported schemaVersion: 2 -> should produce fetch error without failing others.
        let bad_feed = tmp.path.join("bad-feed.json");
        fs::write(&bad_feed, r#"{"schemaVersion":2,"plugins":[]}"#).unwrap();

        // Fourth disabled feed -> should not be fetched or produce errors.
        let disabled_feed = tmp.path.join("missing-disabled.json");

        save_catalog_sources_at(
            &app_dir,
            vec![
                PluginCatalogSource {
                    id: "local-file".to_string(),
                    name: "Local File Feed".to_string(),
                    url: to_file_url(&file_feed),
                    enabled: true,
                },
                PluginCatalogSource {
                    id: "http-mock".to_string(),
                    name: "Local HTTP Feed".to_string(),
                    url: format!("http://127.0.0.1:{port}/catalog.json"),
                    enabled: true,
                },
                PluginCatalogSource {
                    id: "bad-schema".to_string(),
                    name: "Bad Schema Feed".to_string(),
                    url: bad_feed.to_string_lossy().into_owned(),
                    enabled: true,
                },
                PluginCatalogSource {
                    id: "disabled-src".to_string(),
                    name: "Disabled Feed".to_string(),
                    url: disabled_feed.to_string_lossy().into_owned(),
                    enabled: false,
                },
            ],
        )
        .unwrap();

        let settings = PluginRuntimeSettings {
            enable_shared_system_roots: false,
            extra_plugin_dirs: Vec::new(),
            auto_start_ui_sidecars: false,
        };

        let result = fetch_catalog_at(&app_dir, None, None, &settings).expect("fetch succeeds");
        let _ = server_handle.join();

        assert_eq!(result.sources.len(), 4);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].source_id, "bad-schema");
        assert!(result.errors[0].message.contains("schemaVersion"));

        assert_eq!(result.entries.len(), 3);
        let alpha = result.entries.iter().find(|e| e.id == "alpha-tool").unwrap();
        assert!(alpha.installed);
        assert_eq!(alpha.installed_version.as_deref(), Some("1.0.0"));
        assert!(alpha.update_available);
        assert_eq!(alpha.install_kind, PluginCatalogInstallKind::Folder);

        let beta = result.entries.iter().find(|e| e.id == "beta-tool").unwrap();
        assert!(!beta.installed);
        assert!(!beta.update_available);
        assert_eq!(beta.install_kind, PluginCatalogInstallKind::Archive);

        let gamma = result.entries.iter().find(|e| e.id == "gamma-http").unwrap();
        assert!(!gamma.installed);
        assert_eq!(gamma.install_kind, PluginCatalogInstallKind::Git);
        assert_eq!(gamma.git_ref.as_deref(), Some("main"));
    }

    #[test]
    fn installs_and_updates_catalog_entry_from_local_folder_feed() {
        let tmp = TempTestDir::new("install");
        let app_dir = tmp.path.join("roaming");

        let bundles_dir = tmp.path.join("feed_root").join("bundles");
        let v1_bundle = bundles_dir.join("delta-plugin");
        write_sample_plugin(&v1_bundle, "delta-plugin", "1.0.0");

        let feed_path = tmp.path.join("feed_root").join("catalog.json");
        let write_feed = |ver: &str| {
            let feed = serde_json::json!({
                "schemaVersion": 1,
                "plugins": [{
                    "id": "delta-plugin",
                    "name": "delta-plugin",
                    "displayName": "Delta Plugin",
                    "description": "Catalog installable plugin",
                    "version": ver,
                    "installKind": "folder",
                    "installLocation": "bundles/delta-plugin"
                }]
            });
            fs::write(&feed_path, serde_json::to_string_pretty(&feed).unwrap()).unwrap();
        };
        write_feed("1.0.0");

        save_catalog_sources_at(
            &app_dir,
            vec![PluginCatalogSource {
                id: "local-cat".to_string(),
                name: "Local Catalog".to_string(),
                url: feed_path.to_string_lossy().into_owned(),
                enabled: true,
            }],
        )
        .unwrap();

        let installed =
            install_catalog_entry_at(&app_dir, "local-cat", "delta-plugin").expect("install v1");
        assert_eq!(installed.dir_id, "delta-plugin");
        assert_eq!(installed.version.as_deref(), Some("1.0.0"));

        let settings = PluginRuntimeSettings {
            enable_shared_system_roots: false,
            extra_plugin_dirs: Vec::new(),
            auto_start_ui_sidecars: false,
        };
        let after_install = fetch_catalog_at(&app_dir, None, None, &settings).unwrap();
        assert!(after_install.entries[0].installed);
        assert!(!after_install.entries[0].update_available);

        // Publish v1.3.0 in feed and source bundle, verify updateAvailable flips true then updates cleanly.
        write_sample_plugin(&v1_bundle, "delta-plugin", "1.3.0");
        write_feed("1.3.0");

        let before_update = fetch_catalog_at(&app_dir, None, None, &settings).unwrap();
        assert!(before_update.entries[0].installed);
        assert_eq!(
            before_update.entries[0].installed_version.as_deref(),
            Some("1.0.0")
        );
        assert!(before_update.entries[0].update_available);

        let updated =
            install_catalog_entry_at(&app_dir, "local-cat", "delta-plugin").expect("update v1.3.0");
        assert_eq!(updated.version.as_deref(), Some("1.3.0"));

        let after_update = fetch_catalog_at(&app_dir, None, None, &settings).unwrap();
        assert!(after_update.entries[0].installed);
        assert_eq!(
            after_update.entries[0].installed_version.as_deref(),
            Some("1.3.0")
        );
        assert!(!after_update.entries[0].update_available);
    }
}
