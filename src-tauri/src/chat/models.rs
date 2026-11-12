use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::chat::normalize::catalog_cache_key;
use crate::chat::utils::{binary_exists, resolve_bin};
pub use super::provider_agents::provider_agents;

/// `missing-binary` when the launcher is absent, `signed-out` when a known
/// auth file is absent, otherwise `ready`. An unknown sign-in signal stays
/// `ready` so the picker does not invent a signed-out state.
pub fn classify_catalog_availability(binary_present: bool, signed_in: Option<bool>) -> &'static str {
    if !binary_present {
        "missing-binary"
    } else if signed_in == Some(false) {
        "signed-out"
    } else {
        "ready"
    }
}

fn provider_binary_present(canon: &str) -> bool {
    match canon {
        "antigravity" => binary_exists("agy") || binary_exists("antigravity"),
        "codex" => binary_exists("codex"),
        "cursor" => binary_exists("cursor") || binary_exists("agent"),
        "grok" => binary_exists("grok"),
        "opencode" => binary_exists("opencode"),
        "claude" => binary_exists("claude"),
        "gemini" => binary_exists("gemini"),
        _ => true,
    }
}

fn provider_signed_in(canon: &str) -> Option<bool> {
    let home = crate::quota::utils::user_home_dir();
    match canon {
        "grok" => Some(
            home.join(".grok").join("auth.json").exists()
                || home.join(".grok").join("models_cache.json").exists(),
        ),
        "antigravity" => Some(crate::account_switcher::probe_live_provider_identity("agy").is_some()),
        "codex" => Some(home.join(".codex").join("auth.json").exists()),
        "claude" => Some(
            home.join(".claude.json").exists()
                || home.join(".claude").join(".credentials.json").exists(),
        ),
        "gemini" => Some(
            home.join(".gemini").join("oauth_creds.json").exists()
                || home.join(".gemini").join("google_accounts.json").exists(),
        ),
        _ => None,
    }
}

fn catalog_payload(canon: &str, models: &[Value], cached: bool) -> Value {
    let state = if models.is_empty() {
        classify_catalog_availability(provider_binary_present(canon), provider_signed_in(canon))
    } else {
        "ready"
    };
    json!({
        "provider": canon,
        "models": models,
        "cached": cached,
        "catalogState": state,
    })
}

pub(crate) struct CachedProviderModels {
    pub(crate) models: Vec<Value>,
    pub(crate) cached_at: Instant,
}

static MODEL_CACHE: std::sync::OnceLock<Mutex<HashMap<String, CachedProviderModels>>> =
    std::sync::OnceLock::new();

pub(crate) fn model_cache() -> &'static Mutex<HashMap<String, CachedProviderModels>> {
    MODEL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) const MODEL_CACHE_TTL: Duration = Duration::from_secs(900); // 15 minutes in-memory TTL
pub(crate) const DISK_CACHE_TTL_MS: i64 = 4 * 3600 * 1000; // 4 hours disk TTL

fn models_cache_path() -> std::path::PathBuf {
    crate::persist::roaming_app_dir().join("provider_models_cache.json")
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn load_provider_models_from_disk(provider: &str) -> Option<Vec<Value>> {
    let path = models_cache_path();
    let bytes = std::fs::read(&path).ok()?;
    let val: Value = serde_json::from_slice(&bytes).ok()?;
    let entry = val.get(provider)?;
    let cached_at = entry.get("cachedAtUnixMs").and_then(|v| v.as_i64())?;
    if now_unix_ms().saturating_sub(cached_at) > DISK_CACHE_TTL_MS {
        return None;
    }
    let models = entry.get("models")?.as_array()?.clone();
    if models.is_empty() {
        return None;
    }
    Some(models)
}

fn save_provider_models_to_disk(provider: &str, models: &[Value]) {
    if models.is_empty() {
        return;
    }
    let path = models_cache_path();
    let mut root: Value = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}));

    if let Some(obj) = root.as_object_mut() {
        obj.insert(
            provider.to_string(),
            json!({
                "models": models,
                "cachedAtUnixMs": now_unix_ms(),
            }),
        );
        if let Ok(serialized) = serde_json::to_vec_pretty(&root) {
            let _ = std::fs::create_dir_all(crate::persist::roaming_app_dir());
            let _ = std::fs::write(&path, serialized);
        }
    }
}

pub fn provider_models(provider: &str, force_refresh: bool) -> Value {
    provider_models_for(provider, None, force_refresh)
}

pub const THREAD_PROVIDERS: [&str; 7] = [
    "antigravity",
    "grok",
    "codex",
    "claude",
    "cursor",
    "opencode",
    "gemini",
];

pub fn canonical_thread_provider_id(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "antigravity" | "agy" => Some("antigravity"),
        "claude" | "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "cursor" | "cursor-agent" => Some("cursor"),
        "gemini" => Some("gemini"),
        "grok" => Some("grok"),
        "opencode" | "open-code" => Some("opencode"),
        _ => None,
    }
}

pub fn provider_models_for(
    provider: &str,
    connection_id: Option<&str>,
    force_refresh: bool,
) -> Value {
    let canon = match provider {
        "agy" => "antigravity",
        "claude-code" => "claude",
        "open-code" => "opencode",
        "cursor-agent" => "cursor",
        other => other,
    };
    let cache_key = catalog_cache_key(canon, connection_id);

    // 1. Check in-memory cache first unless force_refresh is requested
    if !force_refresh {
        if let Ok(cache) = model_cache().lock() {
            if let Some(entry) = cache.get(&cache_key) {
                if entry.cached_at.elapsed() < MODEL_CACHE_TTL && !entry.models.is_empty() {
                    return catalog_payload(canon, &entry.models, true);
                }
            }
        }

        // 1b. Check disk cache if in-memory cache is cold
        if let Some(disk_models) = load_provider_models_from_disk(&cache_key) {
            if let Ok(mut cache) = model_cache().lock() {
                cache.insert(
                    cache_key.clone(),
                    CachedProviderModels {
                        models: disk_models.clone(),
                        cached_at: Instant::now(),
                    },
                );
            }
            return catalog_payload(canon, &disk_models, true);
        }

        // Skip spawning external CLIs when binary is absent or signed out.
        if !provider_binary_present(canon) || provider_signed_in(canon) == Some(false) {
            return catalog_payload(canon, &[], false);
        }
    }

    // 2. Fetch fresh dynamic models per provider
    let fresh_models = match canon {
        "antigravity" => fetch_antigravity_models_dynamic(),
        "codex" => fetch_codex_models_dynamic(),
        "cursor" => fetch_cursor_models_dynamic(),
        "grok" => fetch_grok_models_dynamic(),
        "opencode" => fetch_opencode_models_dynamic(),
        // Claude and Gemini have no list command wired here. An empty list
        // means the menu offers Automatic, not a stand-in catalog.
        "claude" | "gemini" => Vec::new(),
        _ => Vec::new(),
    };

    // 3. Cache the results if non-empty
    if !fresh_models.is_empty() {
        if let Ok(mut cache) = model_cache().lock() {
            cache.insert(
                cache_key.clone(),
                CachedProviderModels {
                    models: fresh_models.clone(),
                    cached_at: Instant::now(),
                },
            );
        }
        save_provider_models_to_disk(&cache_key, &fresh_models);
    }

    catalog_payload(canon, &fresh_models, false)
}

pub fn fetch_antigravity_models_dynamic() -> Vec<Value> {
    query_agy_models_cli().unwrap_or_default()
}

pub fn parse_agy_models(raw: &str) -> Vec<Value> {
    struct ModelEntry {
        base_id: String,
        clean_name: String,
        description: &'static str,
        tiers: Vec<String>,
        has_known_effort: bool,
    }

    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, ModelEntry> = HashMap::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("Fetching")
            || trimmed.starts_with("Available")
            || trimmed.starts_with('-')
        {
            continue;
        }

        let (raw_id, raw_name) = if let Some(idx) = trimmed.find('\t') {
            (trimmed[..idx].trim(), trimmed[idx + 1..].trim())
        } else if let Some(idx) = trimmed.find("  ") {
            (trimmed[..idx].trim(), trimmed[idx..].trim())
        } else {
            (trimmed, trimmed)
        };

        if raw_id.is_empty() {
            continue;
        }

        let (base_id, effort_tier) = if let Some(stripped) = raw_id.strip_suffix("-high") {
            (stripped, Some("high"))
        } else if let Some(stripped) = raw_id.strip_suffix("-medium") {
            (stripped, Some("medium"))
        } else if let Some(stripped) = raw_id.strip_suffix("-low") {
            (stripped, Some("low"))
        } else if let Some(stripped) = raw_id.strip_suffix("-xhigh") {
            (stripped, Some("xhigh"))
        } else if let Some(stripped) = raw_id.strip_suffix("-max") {
            (stripped, Some("max"))
        } else if let Some(stripped) = raw_id.strip_suffix("-minimal") {
            (stripped, Some("minimal"))
        } else if let Some(stripped) = raw_id.strip_suffix("-ultra") {
            (stripped, Some("ultra"))
        } else {
            (raw_id, None)
        };

        let clean_name = raw_name
            .replace(" (High)", "")
            .replace(" (Medium)", "")
            .replace(" (Low)", "")
            .replace(" (X-High)", "")
            .replace(" (Max)", "")
            .replace(" (Minimal)", "")
            .replace(" (Ultra)", "")
            .replace(" (Adaptive)", "");

        let id_lower = base_id.to_lowercase();
        let description = if id_lower.contains("gemini-4") || id_lower.contains("argon") {
            "Frontier reasoning & agentic coding (Google DeepMind)"
        } else if id_lower.contains("flash") {
            "Ultra-fast, lightweight agentic execution (Google DeepMind)"
        } else if id_lower.contains("opus") {
            "Frontier reasoning for long-horizon agentic work (Anthropic)"
        } else if id_lower.contains("sonnet") {
            "Balanced high-speed coding & design (Anthropic)"
        } else if id_lower.contains("120b") {
            "Open-weights 120B parameter model hosted on Antigravity"
        } else {
            "Antigravity live model"
        };

        let has_known_effort = effort_tier.is_some()
            || id_lower.contains("gemini")
            || id_lower.contains("claude")
            || id_lower.contains("argon")
            || id_lower.contains("flash");

        let entry = map.entry(base_id.to_string()).or_insert_with(|| {
            order.push(base_id.to_string());
            ModelEntry {
                base_id: base_id.to_string(),
                clean_name,
                description,
                tiers: Vec::new(),
                has_known_effort,
            }
        });

        if let Some(tier) = effort_tier {
            if !entry.tiers.iter().any(|t| t == tier) {
                entry.tiers.push(tier.to_string());
            }
        }
    }

    let mut result = Vec::new();
    for id in order {
        if let Some(mut entry) = map.remove(&id) {
            if entry.tiers.is_empty() && entry.has_known_effort {
                let id_lower = entry.base_id.to_lowercase();
                if id_lower.contains("gemini") || id_lower.contains("argon") {
                    entry.tiers = vec!["minimal".into(), "low".into(), "medium".into(), "high".into()];
                } else if id_lower.contains("claude") {
                    entry.tiers = vec!["low".into(), "medium".into(), "high".into(), "max".into()];
                } else {
                    entry.tiers = vec!["low".into(), "medium".into(), "high".into()];
                }
            }

            sort_effort_levels(&mut entry.tiers);

            let supports_effort = entry.tiers.len() >= 2;
            let default_effort: Option<String> = if !supports_effort {
                None
            } else if entry.tiers.iter().any(|t| t == "medium") {
                Some("medium".to_string())
            } else {
                entry.tiers.first().cloned()
            };

            result.push(model_row(
                &entry.base_id,
                &entry.clean_name,
                entry.description,
                supports_effort,
                if supports_effort { Some(entry.tiers) } else { None },
                default_effort.as_deref(),
            ));
        }
    }

    result
}

pub fn query_agy_models_cli() -> Option<Vec<Value>> {
    let program = resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"])?;
    if std::env::var("AGY_CLI_DISABLE_AUTO_UPDATE").is_err() {
        std::env::set_var("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    }
    let out = crate::hidden_exec::run(&program, &["models"], Duration::from_secs(8)).ok()?;
    if !out.success() {
        return None;
    }
    let raw = out.stdout_lossy();
    let models = parse_agy_models(&raw);
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

/// Codex has no model-list command wired here. The configured `model` key in
/// `config.toml` is one saved choice, not the catalog, so it is not expanded
/// into a menu.
pub fn fetch_codex_models_dynamic() -> Vec<Value> {
    Vec::new()
}

pub fn fetch_grok_models_dynamic() -> Vec<Value> {
    // The text `grok models` list is often empty on current CLIs
    // (`Default model: <id> (not in list below)` then no bullets). The
    // on-disk catalog is the account's live menu, so it is the first source.
    if let Some(raw) = read_grok_models_cache_raw() {
        let models = parse_grok_catalog_models(&raw);
        if !models.is_empty() {
            return models;
        }
    }
    if let Some(program) = resolve_bin("grok", &[]) {
        if let Ok(out) = crate::hidden_exec::run(&program, &["models"], Duration::from_secs(10)) {
            if out.success() {
                let mut models = parse_grok_models(&out.stdout_lossy());
                if !models.is_empty() {
                    if let Some(menus) = read_grok_effort_menus() {
                        apply_grok_effort_menus(&mut models, &menus);
                    }
                    return models;
                }
            }
        }
    }
    Vec::new()
}

fn grok_models_cache_path() -> std::path::PathBuf {
    crate::quota::utils::user_home_dir()
        .join(".grok")
        .join("models_cache.json")
}

fn read_grok_models_cache_raw() -> Option<String> {
    std::fs::read_to_string(grok_models_cache_path()).ok()
}

/// Reads the Grok CLI catalog (`~/.grok/models_cache.json`) that records each
/// model's `reasoning_efforts` menu. The text `grok models` list names ids
/// only. A missing file leaves those rows without levels.
fn read_grok_effort_menus() -> Option<HashMap<String, GrokEffortMenu>> {
    let raw = read_grok_models_cache_raw()?;
    let menus = parse_grok_effort_menus(&raw);
    if menus.is_empty() {
        None
    } else {
        Some(menus)
    }
}

pub struct GrokEffortMenu {
    pub levels: Vec<String>,
    pub default_effort: Option<String>,
}

/// Parses the CLI catalog. A model is included only when it advertises at
/// least two reasoning levels. Fewer than two leaves the control disabled.
pub fn parse_grok_effort_menus(raw: &str) -> HashMap<String, GrokEffortMenu> {
    let mut menus = HashMap::new();
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return menus;
    };
    let Some(models) = value.get("models").and_then(|entry| entry.as_object()) else {
        return menus;
    };
    for (id, entry) in models {
        let info = entry.get("info").unwrap_or(entry);
        if info
            .get("supports_reasoning_effort")
            .and_then(|flag| flag.as_bool())
            != Some(true)
        {
            continue;
        }
        let mut levels: Vec<String> = info
            .get("reasoning_efforts")
            .and_then(|rows| rows.as_array())
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.get("id").and_then(|value| value.as_str()))
                    .map(str::trim)
                    .filter(|level| !level.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        sort_effort_levels(&mut levels);
        levels.dedup();
        if levels.len() < 2 {
            continue;
        }
        let default_effort = info
            .get("reasoning_effort")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|level| levels.iter().any(|known| known == level))
            .map(str::to_string);
        menus.insert(
            id.clone(),
            GrokEffortMenu {
                levels,
                default_effort,
            },
        );
    }
    menus
}

pub fn apply_grok_effort_menus(models: &mut [Value], menus: &HashMap<String, GrokEffortMenu>) {
    for model in models.iter_mut() {
        let Some(id) = model.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(menu) = menus.get(id) else {
            continue;
        };
        model["supportsEffort"] = json!(true);
        model["effortLevels"] = json!(menu.levels);
        if let Some(default_effort) = &menu.default_effort {
            model["defaultEffort"] = json!(default_effort);
        }
    }
}

/// Parses the Grok CLI catalog into picker rows. Hidden models stay out.
/// Effort menus attach only when the catalog advertises at least two levels.
pub fn parse_grok_catalog_models(raw: &str) -> Vec<Value> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(models) = value.get("models").and_then(|entry| entry.as_object()) else {
        return Vec::new();
    };
    let menus = parse_grok_effort_menus(raw);
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (id, entry) in models {
        if !model_id_ok(id) || !seen.insert(id.clone()) {
            continue;
        }
        let info = entry.get("info").unwrap_or(entry);
        if info.get("hidden").and_then(|flag| flag.as_bool()) == Some(true) {
            continue;
        }
        let name = info
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(id);
        let description = info
            .get("description")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Listed by the Grok CLI");
        let menu = menus.get(id);
        rows.push(model_row(
            id,
            name,
            description,
            menu.is_some(),
            menu.map(|entry| entry.levels.clone()),
            menu.and_then(|entry| entry.default_effort.as_deref()),
        ));
    }
    rows
}

/// Parses `grok models`: the default-model line, then a bulleted list under
/// `Available models:`. Current CLIs often print the default as
/// `(not in list below)` with an empty bullet list.
pub fn parse_grok_models(raw: &str) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("Default model:") else {
            continue;
        };
        let id = rest.split_whitespace().next().unwrap_or("").trim();
        if id.is_empty() || !model_id_ok(id) || !seen.insert(id.to_string()) {
            break;
        }
        models.push(model_row(
            id,
            id,
            "Listed by the Grok CLI",
            false,
            None,
            None,
        ));
        break;
    }
    for line in raw.lines() {
        let trimmed = line.trim();
        let entry = trimmed
            .strip_prefix("* ")
            .or_else(|| trimmed.strip_prefix("- "));
        let Some(entry) = entry else {
            continue;
        };
        let id = entry.split_whitespace().next().unwrap_or("").trim();
        if id.is_empty() || !model_id_ok(id) || !seen.insert(id.to_string()) {
            continue;
        }
        models.push(model_row(
            id,
            id,
            "Listed by the Grok CLI",
            false,
            None,
            None,
        ));
    }
    models
}

pub fn fetch_cursor_models_dynamic() -> Vec<Value> {
    if let Some(program) = resolve_bin("cursor-agent", &[]) {
        if let Ok(out) = crate::hidden_exec::run(&program, &["models"], Duration::from_secs(10)) {
            if out.success() {
                let models = parse_cursor_models(&out.stdout_lossy());
                if !models.is_empty() {
                    return models;
                }
            }
        }
    }
    Vec::new()
}

/// Parses `cursor-agent models`: `id - Name` rows under an `Available models`
/// header.
pub fn parse_cursor_models(raw: &str) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("Available models") {
            continue;
        }
        let Some((id, name)) = trimmed.split_once(" - ") else {
            continue;
        };
        let id = id.split_whitespace().next().unwrap_or("").trim();
        if id.is_empty() || !model_id_ok(id) || !seen.insert(id.to_string()) {
            continue;
        }
        models.push(model_row(
            id,
            name.trim(),
            "Listed by the Cursor Agent CLI",
            false,
            None,
            None,
        ));
        if models.len() >= 400 {
            break;
        }
    }
    models
}

pub fn sort_effort_levels(levels: &mut [String]) {
    fn rank(s: &str) -> i32 {
        match s.to_lowercase().as_str() {
            "none" | "off" => 0,
            "minimal" | "min" => 1,
            "low" => 2,
            "medium" | "med" => 3,
            "high" => 4,
            "xhigh" | "extra-high" | "extra_high" | "very-high" => 5,
            "max" | "maximum" => 6,
            "ultra" => 7,
            _ => 10,
        }
    }
    levels.sort_by(|a, b| {
        let ra = rank(a);
        let rb = rank(b);
        if ra != rb {
            ra.cmp(&rb)
        } else {
            a.cmp(b)
        }
    });
}

pub fn model_row(
    id: &str,
    name: &str,
    description: &str,
    supports_effort: bool,
    effort_levels: Option<Vec<String>>,
    default_effort: Option<&str>,
) -> Value {
    let mut obj = json!({
        "id": id,
        "name": name,
        "description": description,
        "supportsEffort": supports_effort,
    });
    if let Some(levels) = effort_levels {
        if !levels.is_empty() {
            obj["effortLevels"] = json!(levels);
        }
    }
    if let Some(def) = default_effort {
        obj["defaultEffort"] = json!(def);
    }
    obj
}

pub fn fetch_opencode_models_dynamic() -> Vec<Value> {
    query_opencode_models_cli().unwrap_or_default()
}

pub fn read_opencode_config() -> Option<Value> {
    let mut candidates = Vec::new();
    if let Ok(user) = std::env::var("USERPROFILE") {
        candidates.push(std::path::PathBuf::from(&user).join(".config").join("opencode").join("opencode.json"));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(std::path::PathBuf::from(&home).join(".config").join("opencode").join("opencode.json"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(std::path::PathBuf::from(&local).join("opencode").join("opencode.json"));
    }
    candidates.push(std::path::PathBuf::from(".opencode").join("opencode.json"));

    for path in candidates {
        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    return Some(val);
                }
            }
        }
    }
    None
}

/// Parses the CLI's `provider/model` lines into catalog rows. Pure, so it is
/// testable without spawning the CLI.
pub fn parse_opencode_models(raw: &str) -> Vec<Value> {
    let config = read_opencode_config();
    parse_opencode_models_inner(raw, config.as_ref())
}

pub fn parse_opencode_models_inner(raw: &str, config: Option<&Value>) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    let root_model = config.and_then(|c| c.get("model")).and_then(|v| v.as_str());
    let root_variant = config.and_then(|c| c.get("variant")).and_then(|v| v.as_str());

    for line in raw.lines() {
        let id = line.trim();
        if id.is_empty() || !id.contains('/') || id.chars().any(char::is_whitespace) {
            continue;
        }
        if !model_id_ok(id) || !seen.insert(id.to_string()) {
            continue;
        }
        let (provider, model_part) = id.split_once('/').unwrap_or(("", id));

        // Check if opencode.json defines this model under provider.<provider>.models.<model_part>
        let config_model_entry = config
            .and_then(|c| c.get("provider"))
            .and_then(|p| p.get(provider))
            .and_then(|p_obj| p_obj.get("models"))
            .and_then(|m_obj| m_obj.get(model_part));

        let display_name = config_model_entry
            .and_then(|m| m.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or(id);

        let mut variants = Vec::new();
        if let Some(variants_obj) = config_model_entry.and_then(|m| m.get("variants")).and_then(|v| v.as_object()) {
            for key in variants_obj.keys() {
                variants.push(key.clone());
            }
        }

        let is_root_configured = root_model == Some(id);
        let id_lower = id.to_lowercase();

        // If no explicit variants were configured, check if this is a known reasoning model
        if variants.is_empty() {
            if is_root_configured && root_variant.is_some() {
                variants.push(root_variant.unwrap().to_string());
                variants.push("low".to_string());
                variants.push("medium".to_string());
                variants.push("high".to_string());
            } else if id_lower.contains("o1") || id_lower.contains("o3") || id_lower.contains("o4") || id_lower.contains("reasoning") {
                variants = vec!["low".into(), "medium".into(), "high".into(), "xhigh".into()];
            } else if id_lower.contains("claude") && (id_lower.contains("thinking") || id_lower.contains("opus") || id_lower.contains("sonnet-4") || id_lower.contains("3-7")) {
                variants = vec!["low".into(), "medium".into(), "high".into(), "max".into()];
            } else if id_lower.contains("deepseek") || id_lower.contains("r1") {
                variants = vec!["low".into(), "medium".into(), "high".into(), "max".into()];
            } else if id_lower.contains("gemini") && (id_lower.contains("3") || id_lower.contains("4") || id_lower.contains("argon") || id_lower.contains("pro")) {
                variants = vec!["minimal".into(), "low".into(), "medium".into(), "high".into()];
            }
        }

        variants.sort();
        variants.dedup();
        sort_effort_levels(&mut variants);

        let supports_effort = variants.len() >= 2;
        let default_effort: Option<String> = if !supports_effort {
            None
        } else if let Some(rv) = root_variant {
            if is_root_configured || variants.iter().any(|v| v == rv) {
                Some(rv.to_string())
            } else if variants.iter().any(|v| v == "medium") {
                Some("medium".to_string())
            } else {
                variants.first().cloned()
            }
        } else if variants.iter().any(|v| v == "medium") {
            Some("medium".to_string())
        } else {
            variants.first().cloned()
        };

        models.push(model_row(
            id,
            display_name,
            &format!("{provider} through the OpenCode CLI"),
            supports_effort,
            if supports_effort { Some(variants) } else { None },
            default_effort.as_deref(),
        ));
        if models.len() >= 400 {
            break;
        }
    }
    models
}

/// Reads the CLI's own model list. Read-only: it never selects, downloads, or
/// authenticates a provider.
pub fn query_opencode_models_cli() -> Option<Vec<Value>> {
    let program = crate::chat::persistent::resolve_opencode_program().ok()?;
    let out = crate::hidden_exec::run(&program, &["models"], Duration::from_secs(10)).ok()?;
    if !out.success() {
        return None;
    }
    let raw = out.stdout_lossy();
    let models = parse_opencode_models(&raw);
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

pub fn provider_ok(provider: &str) -> bool {
    matches!(
        provider,
        "antigravity"
            | "agy"
            | "claude"
            | "claude-code"
            | "codex"
            | "cursor"
            | "cursor-agent"
            | "grok"
            | "opencode"
            | "open-code"
            | "gemini"
    )
}

pub fn mode_ok(provider: &str, mode: &str) -> bool {
    match provider {
        "codex" => matches!(mode, "acceptEdits" | "readOnly"),
        "claude"
        | "claude-code"
        | "cursor"
        | "cursor-agent"
        | "grok"
        | "opencode"
        | "open-code"
        | "antigravity"
        | "agy"
        | "gemini" => {
            matches!(mode, "acceptEdits" | "fullAccess" | "readOnly")
        }
        _ => false,
    }
}

pub fn default_mode(provider: &str) -> &'static str {
    if provider == "codex" {
        "acceptEdits"
    } else {
        "fullAccess"
    }
}

pub fn normalize_model(model: Option<&Value>) -> Value {
    match model {
        Some(Value::String(text)) if model_id_ok(text) => Value::String(text.clone()),
        _ => Value::Null,
    }
}

pub fn model_id_ok(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || chars.len() > 128 || !chars[0].is_ascii_alphanumeric() {
        return false;
    }
    chars[1..]
        .iter()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '/' | '-'))
}

pub fn option_id_ok(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || chars.len() > 64 || !chars[0].is_ascii_alphabetic() {
        return false;
    }
    chars[1..].iter().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

pub fn option_value_ok(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || chars.len() > 64 || !chars[0].is_ascii_alphanumeric() {
        return false;
    }
    chars[1..]
        .iter()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

pub fn sanitize_options(options: &[Value]) -> Vec<Value> {
    options
        .iter()
        .filter_map(|option| {
            let id = option.get("id").and_then(|v| v.as_str())?;
            if !option_id_ok(id) {
                return None;
            }
            let value = option.get("value")?;
            if value.as_bool().is_some() {
                return Some(json!({ "id": id, "value": value }));
            }
            let text = value.as_str().filter(|text| option_value_ok(text))?;
            Some(json!({ "id": id, "value": text }))
        })
        .take(16)
        .collect()
}

pub fn validate_provider_connection_with_status(
    canon: &str,
    binary_present: bool,
    signed_in: Option<bool>,
) -> Result<(), String> {
    let state = classify_catalog_availability(binary_present, signed_in);
    match state {
        "missing-binary" => Err(format!(
            "Provider `{canon}` is not installed or its CLI binary was not found on PATH. Run `kite dispatch providers` to check connected providers."
        )),
        "signed-out" => Err(format!(
            "Provider `{canon}` is installed but not signed in. Sign in to `{canon}` first or run `kite dispatch providers` to choose another connected provider."
        )),
        _ => Ok(()),
    }
}

pub fn validate_provider_connection(provider: &str) -> Result<(), String> {
    let Some(canon) = canonical_thread_provider_id(provider) else {
        return Err(format!(
            "Unknown thread provider `{provider}`. Allowed thread providers: {}. Run `kite dispatch providers` to see available providers.",
            THREAD_PROVIDERS.join(", ")
        ));
    };
    if cfg!(test) {
        return Ok(());
    }
    validate_provider_connection_with_status(
        canon,
        provider_binary_present(canon),
        provider_signed_in(canon),
    )
}

pub fn validate_provider_model_with_catalog(
    canon: &str,
    model: &str,
    catalog: &Value,
) -> Result<(), String> {
    if !model_id_ok(model) {
        return Err(format!(
            "Invalid model id `{model}` for provider `{canon}`."
        ));
    }
    let state = catalog
        .get("catalogState")
        .and_then(Value::as_str)
        .unwrap_or("ready");
    if matches!(state, "missing-binary" | "signed-out") {
        return Err(format!(
            "Provider `{canon}` is `{state}`. Run `kite dispatch providers` to inspect connected providers."
        ));
    }
    let models = catalog
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !models.is_empty() {
        let matched = models.iter().any(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.eq_ignore_ascii_case(model))
        });
        if !matched {
            let sample: Vec<&str> = models
                .iter()
                .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                .take(8)
                .collect();
            let more = if models.len() > sample.len() {
                format!(" (+{} more)", models.len() - sample.len())
            } else {
                String::new()
            };
            return Err(format!(
                "Model `{model}` is not available for provider `{canon}`. Available models: {}{more}. Run `kite dispatch models {canon}` to list all or omit `--model`.",
                sample.join(", ")
            ));
        }
    }
    Ok(())
}

pub fn model_likely_belongs_to_another_provider(provider: &str, model: &str) -> bool {
    let canon = canonical_thread_provider_id(provider).unwrap_or(provider);
    let m = model.trim().to_ascii_lowercase();
    if m.is_empty() {
        return false;
    }
    let looks_claude = m.starts_with("claude-")
        || m.contains("sonnet")
        || m.contains("haiku")
        || m.contains("opus");
    let looks_gemini = m.starts_with("gemini-") || m.starts_with("models/gemini-");
    let looks_grok = m.starts_with("grok-");
    let looks_openai = m.starts_with("gpt-")
        || m.starts_with("o1")
        || m.starts_with("o3")
        || m.starts_with("o4")
        || m.contains("-codex");

    match canon {
        "grok" => looks_claude || looks_gemini || looks_openai,
        "claude" => looks_grok || looks_gemini || looks_openai,
        "gemini" => looks_grok || looks_claude || looks_openai,
        "codex" => looks_grok || looks_claude || looks_gemini,
        "antigravity" => looks_grok,
        _ => false,
    }
}

pub fn validate_provider_model_selection(provider: &str, model: &str) -> Result<(), String> {
    let Some(canon) = canonical_thread_provider_id(provider) else {
        return Err(format!(
            "Unknown thread provider `{provider}`. Allowed thread providers: {}.",
            THREAD_PROVIDERS.join(", ")
        ));
    };
    if cfg!(test) {
        if !model_id_ok(model) {
            return Err(format!("Invalid model id `{model}`."));
        }
        return Ok(());
    }
    let catalog = provider_models(canon, false);
    validate_provider_model_with_catalog(canon, model, &catalog)
}

pub fn discover_thread_providers(refresh: bool) -> Value {
    let mut rows = Vec::with_capacity(THREAD_PROVIDERS.len());
    for canon in THREAD_PROVIDERS {
        let binary_present = provider_binary_present(canon);
        let signed_in = provider_signed_in(canon);
        let state = classify_catalog_availability(binary_present, signed_in);
        let catalog = if state == "ready" {
            provider_models(canon, refresh)
        } else {
            catalog_payload(canon, &[], false)
        };
        let models: Vec<Value> = catalog
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let sample_ids: Vec<String> = models
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
            .take(5)
            .collect();
        let supports_discovery = !matches!(canon, "claude" | "gemini");
        rows.push(json!({
            "provider": canon,
            "state": state,
            "binaryPresent": binary_present,
            "signedIn": signed_in,
            "supportsModelDiscovery": supports_discovery,
            "modelCount": models.len(),
            "sampleModels": sample_ids,
        }));
    }
    json!({
        "providers": rows,
    })
}

pub fn format_providers_text(discovery: &Value) -> String {
    let rows = discovery
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut lines = vec![
        "Thread providers (use with `--via thread --provider <name>` or `kite dispatch swarm add`):"
            .to_string(),
    ];
    for row in rows {
        let provider = row.get("provider").and_then(Value::as_str).unwrap_or("");
        let state = row.get("state").and_then(Value::as_str).unwrap_or("unknown");
        let count = row.get("modelCount").and_then(Value::as_u64).unwrap_or(0);
        let supports = row
            .get("supportsModelDiscovery")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let samples: Vec<&str> = row
            .get("sampleModels")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let detail = if state != "ready" {
            format!("({})", state)
        } else if count > 0 {
            format!("{count} models (e.g. {})", samples.join(", "))
        } else if !supports {
            "CLI manages default model (omit `--model` or pass an explicit id)".to_string()
        } else {
            "0 cached models (run with `--refresh` or omit `--model`)".to_string()
        };
        lines.push(format!("  {provider:<12} {state:<14} {detail}"));
    }
    lines.join("\n")
}

pub fn format_models_text(catalog: &Value) -> String {
    let provider = catalog.get("provider").and_then(Value::as_str).unwrap_or("");
    let state = catalog
        .get("catalogState")
        .and_then(Value::as_str)
        .unwrap_or("ready");
    let models = catalog
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if models.is_empty() {
        if state != "ready" {
            return format!("{provider} ({state}): provider is unavailable on this machine.");
        }
        return format!(
            "{provider} (ready): provider CLI manages its default model dynamically; omit `--model` or pass a known account model id."
        );
    }
    let mut lines = vec![format!("{provider} ({state}, {} models):", models.len())];
    for entry in models {
        let id = entry.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let name = entry.get("name").and_then(Value::as_str).unwrap_or(id);
        let efforts: Vec<&str> = entry
            .get("effortLevels")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let effort_suffix = if efforts.is_empty() {
            String::new()
        } else {
            format!(" [effort: {}]", efforts.join(","))
        };
        if name != id {
            lines.push(format!("  {id}  ({name}){effort_suffix}"));
        } else {
            lines.push(format!("  {id}{effort_suffix}"));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;

/// Returns true when a cache key (plain provider, `"provider:suffix"`, or `"provider|conn"` from
/// `catalog_cache_key`) belongs to `provider`, normalizing `"agy"` <-> `"antigravity"` aliases.
pub(crate) fn provider_cache_key_matches(key: &str, provider: &str) -> bool {
    let k = key.trim().to_ascii_lowercase();
    let target = provider.trim().to_ascii_lowercase();
    let matches_single = |canon: &str| {
        k == canon
            || k.starts_with(&format!("{canon}:"))
            || k.starts_with(&format!("{canon}|"))
    };
    if target == "agy" || target == "antigravity" {
        matches_single("agy") || matches_single("antigravity")
    } else {
        matches_single(&target)
    }
}

/// Clears cached model catalogs for `provider` (including `"agy"` <-> `"antigravity"` aliases)
/// from memory and the given disk cache file so a newly activated account's models are discovered cleanly.
pub(crate) fn invalidate_provider_model_cache_in(path: &std::path::Path, provider: &str) {
    if let Ok(mut guard) = model_cache().lock() {
        guard.retain(|k, _| !provider_cache_key_matches(k, provider));
    }

    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(mut root) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(obj) = root.as_object_mut() {
                let before = obj.len();
                obj.retain(|k, _| !provider_cache_key_matches(k, provider));
                if obj.len() != before {
                    if let Ok(serialized) = serde_json::to_vec_pretty(&root) {
                        let _ = std::fs::write(path, serialized);
                    }
                }
            }
        }
    }
}

/// Clears cached model catalogs for `provider` (including `"agy"` <-> `"antigravity"` aliases)
/// from memory and disk so a newly activated account's models are discovered cleanly.
pub(crate) fn invalidate_provider_model_cache(provider: &str) {
    let path = models_cache_path();
    invalidate_provider_model_cache_in(&path, provider);
}
