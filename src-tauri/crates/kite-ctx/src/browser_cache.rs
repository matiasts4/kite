use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ccr_store::CcrStore;
use crate::error::Result;
use crate::ledger::{LedgerEventInput, SavingsLedger};
use crate::store::{now_unix_secs, ContextStore};
use crate::tokens::{estimate_tokens, short_hash};

const CHROME_LANDMARKS: &[&str] = &["banner", "navigation", "contentinfo", "complementary"];
const ALL_LANDMARKS: &[&str] = &[
    "banner",
    "navigation",
    "main",
    "contentinfo",
    "complementary",
    "form",
    "search",
    "region",
];

/// Canonical Accessibility Tree node extracted from a browser page snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AxNode {
    pub ref_id: Option<String>,
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub landmark: Option<String>,
    pub frame_id: String,
    pub depth: usize,
    pub sibling_ordinal: usize,
    pub interactive: bool,
    pub disabled: bool,
    pub checked: Option<bool>,
    pub expanded: Option<bool>,
    pub stable_key: String,
}

impl AxNode {
    pub fn compute_stable_key(
        frame_id: &str,
        landmark: Option<&str>,
        role: &str,
        name: &str,
        sibling_ordinal: usize,
    ) -> String {
        let norm_name = normalize_volatile_ax_text(name);
        let lm = landmark.unwrap_or("root");
        short_hash(&format!("{frame_id}|{lm}|{role}|{norm_name}|{sibling_ordinal}"))
    }
}

/// Snapshot read strategy controlling caching, delta emission, and filtering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserReadMode {
    Auto,
    Full,
    Diff,
    InteractiveOnly,
    Summary,
}

impl BrowserReadMode {
    pub fn from_str_lossy(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "full" | "raw" => Self::Full,
            "diff" | "delta" => Self::Diff,
            "interactive" | "interactive_only" | "interactive-only" => Self::InteractiveOnly,
            "summary" | "outline" => Self::Summary,
            _ => Self::Auto,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Full => "full",
            Self::Diff => "diff",
            Self::InteractiveOnly => "interactive_only",
            Self::Summary => "summary",
        }
    }
}

/// Input payload for [`BrowserReadCache::ingest_snapshot`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserSnapshotInput {
    pub session_id: String,
    pub tab_id: String,
    pub url: String,
    pub title: Option<String>,
    pub raw_text: String,
    pub nodes: Option<Vec<AxNode>>,
    pub mode: BrowserReadMode,
    pub fresh: bool,
    pub agent: String,
    pub provider: String,
    pub model: String,
}

/// Optimization outcome emitted by [`BrowserReadCache::ingest_snapshot`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserSnapshotOutcome {
    UnchangedStub,
    SemanticDelta,
    ChromeStrippedFull,
    Full,
}

/// Result returned by [`BrowserReadCache::ingest_snapshot`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrowserSnapshotResult {
    pub outcome: BrowserSnapshotOutcome,
    pub text: String,
    pub origin: String,
    pub canonical_route: String,
    pub full_hash: String,
    pub structure_hash: String,
    pub chrome_hash: Option<String>,
    pub ccr_hash: Option<String>,
    pub raw_tokens: usize,
    pub delivered_tokens: usize,
    pub tokens_saved: usize,
    pub turn_index: usize,
    pub node_count: usize,
}

struct PriorSnapshot {
    id: i64,
    full_hash: String,
    turn_index: usize,
    ccr_hash: Option<String>,
    nodes_json: String,
}

struct PriorChrome {
    chrome_hash: String,
    compact_text: String,
    summary_label: String,
}

fn react_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r":r[0-9a-zA-Z]{1,8}:").unwrap())
}

fn mui_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\bmui-[0-9a-zA-Z_-]+\b").unwrap())
}

fn radix_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\bradix-[:0-9a-zA-Z_-]+\b").unwrap())
}

fn ref_handle_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:^|\s)\[?(?:ref=)?@?e\d+\]?(?:\s|$)").unwrap())
}

fn jwt_secret_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b").unwrap()
    })
}

fn auth_header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\b(authorization|x-api-key|api[-_]?key|set-cookie|cookie)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+(?:\s+[^\s,;}\]]+)?)"#,
        )
        .unwrap()
    })
}

fn bearer_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*").unwrap())
}

fn sensitive_kv_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\b(password|passwd|pwd|secret|token|cc-number|cc-csc|cc-exp|cvv|cvc|credit[_-]?card)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)"#,
        )
        .unwrap()
    })
}

fn api_token_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,})\b")
            .unwrap()
    })
}

fn pan_card_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(?:\d{4}[- ]?){3}\d{4}\b").unwrap())
}

fn ax_sensitive_field_value_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?im)^([^\n]*(?:password|passwd|passcode|pin|cc-number|cc-csc|cc-exp|credit[- ]card|card[- ]number|cvv|cvc|secret|api[- ]key|token)[^\n]*\b(?:value|val)=)("[^"]*"|'[^']*'|\S+)"#,
        )
        .unwrap()
    })
}

/// Scrub passwords, credit card inputs/PANs, Authorization/Cookie headers, JWTs, and API keys.
pub fn redact_sensitive_browser_text(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let s0 = ax_sensitive_field_value_re().replace_all(input, |caps: &regex::Captures| {
        let prefix = &caps[1];
        let val = &caps[2];
        if val.starts_with('"') {
            format!("{prefix}\"[REDACTED]\"")
        } else if val.starts_with('\'') {
            format!("{prefix}'[REDACTED]'")
        } else {
            format!("{prefix}[REDACTED]")
        }
    });
    let s1 = jwt_secret_re().replace_all(&s0, "[REDACTED]");
    let s2 = bearer_re().replace_all(&s1, "$1 [REDACTED]");
    let s3 = auth_header_re().replace_all(&s2, "$1$2[REDACTED]");
    let s4 = sensitive_kv_re().replace_all(&s3, |caps: &regex::Captures| {
        let key = &caps[1];
        let sep = &caps[2];
        let whole = &caps[0];
        let val_part = &whole[key.len() + sep.len()..];
        if val_part.starts_with('"') {
            format!("{key}{sep}\"[REDACTED]\"")
        } else if val_part.starts_with('\'') {
            format!("{key}{sep}'[REDACTED]'")
        } else {
            format!("{key}{sep}[REDACTED]")
        }
    });
    let s5 = api_token_prefix_re().replace_all(&s4, "[REDACTED]");
    pan_card_re().replace_all(&s5, "[REDACTED]").into_owned()
}

fn is_sensitive_field_label(role: &str, name: &str) -> bool {
    let lower_name = name.to_ascii_lowercase();
    let lower_role = role.to_ascii_lowercase();
    if lower_role.contains("password") {
        return true;
    }
    [
        "password",
        "passcode",
        "pin",
        "cc-number",
        "cc-csc",
        "cc-exp",
        "credit card",
        "card number",
        "cvv",
        "cvc",
        "secret",
        "api key",
        "token",
    ]
    .iter()
    .any(|kw| lower_name.contains(kw))
}

fn normalize_volatile_ax_text(text: &str) -> String {
    let s1 = react_id_re().replace_all(text, "");
    let s2 = mui_id_re().replace_all(&s1, "");
    let s3 = radix_id_re().replace_all(&s2, "");
    let s4 = ref_handle_re().replace_all(&s3, " ");
    s4.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract normalized origin (`scheme://host[:port]`) from a URL.
pub fn extract_origin(url: &str) -> String {
    let trimmed = url.trim();
    let Some(scheme_idx) = trimmed.find("://") else {
        return "local".to_string();
    };
    let scheme = trimmed[..scheme_idx].to_ascii_lowercase();
    let rest = &trimmed[scheme_idx + 3..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = rest[..authority_end].to_ascii_lowercase();
    let normalized_auth = match scheme.as_str() {
        "http" => authority.strip_suffix(":80").unwrap_or(&authority).to_string(),
        "https" => authority
            .strip_suffix(":443")
            .unwrap_or(&authority)
            .to_string(),
        _ => authority,
    };
    if normalized_auth.is_empty() {
        "local".to_string()
    } else {
        format!("{scheme}://{normalized_auth}")
    }
}

/// Canonicalize a URL into a deterministic route key by normalizing origin casing,
/// trimming trailing slashes, stripping volatile cache-buster/UTM params, and sorting queries.
pub fn canonicalize_route(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return "/".to_string();
    }

    let (without_frag, hash_route) = match trimmed.find('#') {
        Some(idx) => {
            let frag = &trimmed[idx..];
            let keep_hash = frag.starts_with("#/") || frag.starts_with("#!/");
            (&trimmed[..idx], if keep_hash { Some(frag) } else { None })
        }
        None => (trimmed, None),
    };

    let (origin_prefix, path_and_query) = if let Some(scheme_idx) = without_frag.find("://") {
        let rest = &without_frag[scheme_idx + 3..];
        let auth_end = rest.find(['/', '?']).unwrap_or(rest.len());
        let origin = extract_origin(without_frag);
        (Some(origin), &rest[auth_end..])
    } else {
        (None, without_frag)
    };

    let (raw_path, raw_query) = match path_and_query.find('?') {
        Some(idx) => (&path_and_query[..idx], Some(&path_and_query[idx + 1..])),
        None => (path_and_query, None),
    };

    // Collapse duplicate slashes and strip trailing slash except on root `/`.
    let mut norm_path = String::with_capacity(raw_path.len().max(1));
    let mut prev_slash = false;
    for ch in raw_path.chars() {
        if ch == '/' {
            if !prev_slash {
                norm_path.push('/');
            }
            prev_slash = true;
        } else {
            prev_slash = false;
            norm_path.push(ch);
        }
    }
    if norm_path.is_empty() {
        norm_path.push('/');
    } else if !norm_path.starts_with('/') {
        norm_path.insert(0, '/');
    }
    while norm_path.len() > 1 && norm_path.ends_with('/') {
        norm_path.pop();
    }

    let mut params_vec: Vec<(String, String)> = Vec::new();
    if let Some(q) = raw_query {
        for pair in q.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (k, v) = match pair.split_once('=') {
                Some((k, v)) => (k, v),
                None => (pair, ""),
            };
            let kl = k.to_ascii_lowercase();
            if matches!(
                kl.as_str(),
                "t" | "ts" | "_" | "cb" | "cachebust" | "fbclid" | "gclid" | "mc_cid" | "mc_eid"
            ) || kl.starts_with("utm_")
            {
                continue;
            }
            params_vec.push((k.to_string(), v.to_string()));
        }
    }
    params_vec.sort();

    let mut out = match origin_prefix {
        Some(origin) => format!("{origin}{norm_path}"),
        None => norm_path,
    };
    if !params_vec.is_empty() {
        let query_str: Vec<String> = params_vec
            .into_iter()
            .map(|(k, v)| if v.is_empty() { k } else { format!("{k}={v}") })
            .collect();
        out.push('?');
        out.push_str(&query_str.join("&"));
    }
    if let Some(hr) = hash_route {
        out.push_str(hr);
    }
    out
}

fn is_interactive_role(role: &str) -> bool {
    matches!(
        role.to_ascii_lowercase().as_str(),
        "button"
            | "link"
            | "textbox"
            | "searchbox"
            | "combobox"
            | "listbox"
            | "option"
            | "checkbox"
            | "radio"
            | "switch"
            | "slider"
            | "spinbutton"
            | "menuitem"
            | "menuitemcheckbox"
            | "menuitemradio"
            | "tab"
            | "treeitem"
    )
}

fn canonical_landmark_role(role: &str) -> Option<&'static str> {
    match role.to_ascii_lowercase().as_str() {
        "banner" | "header" => Some("banner"),
        "navigation" | "nav" => Some("navigation"),
        "main" => Some("main"),
        "contentinfo" | "footer" => Some("contentinfo"),
        "complementary" | "aside" => Some("complementary"),
        "form" => Some("form"),
        "search" => Some("search"),
        "region" => Some("region"),
        _ => None,
    }
}

fn is_chrome_landmark(landmark: Option<&str>) -> bool {
    landmark.is_some_and(|lm| CHROME_LANDMARKS.contains(&lm))
}

fn parse_ax_json(raw: &str) -> Option<Vec<AxNode>> {
    let val: Value = serde_json::from_str(raw.trim()).ok()?;
    let arr = match &val {
        Value::Array(items) => items,
        Value::Object(obj) => obj.get("nodes")?.as_array()?,
        _ => return None,
    };
    let mut nodes = Vec::with_capacity(arr.len());
    let mut ordinals: HashMap<(String, String, String, String), usize> = HashMap::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let role = obj
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("generic")
            .to_string();
        let raw_name = obj
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let name = redact_sensitive_browser_text(&raw_name);
        let raw_value = obj
            .get("value")
            .and_then(Value::as_str)
            .map(redact_sensitive_browser_text);
        let value = if is_sensitive_field_label(&role, &name)
            && raw_value.as_ref().is_some_and(|v| !v.is_empty())
        {
            Some("[REDACTED]".to_string())
        } else {
            raw_value
        };
        let frame_id = obj
            .get("frame_id")
            .and_then(Value::as_str)
            .unwrap_or("main")
            .to_string();
        let landmark = obj
            .get("landmark")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .or_else(|| canonical_landmark_role(&role).map(str::to_string));
        let ref_id = obj
            .get("ref_id")
            .or_else(|| obj.get("ref"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let depth = obj.get("depth").and_then(Value::as_u64).unwrap_or(0) as usize;
        let disabled = obj.get("disabled").and_then(Value::as_bool).unwrap_or(false);
        let checked = obj.get("checked").and_then(Value::as_bool);
        let expanded = obj.get("expanded").and_then(Value::as_bool);
        let interactive = obj
            .get("interactive")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| is_interactive_role(&role));

        let norm_name = normalize_volatile_ax_text(&name);
        let ord_key = (
            frame_id.clone(),
            landmark.clone().unwrap_or_default(),
            role.clone(),
            norm_name,
        );
        let sibling_ordinal = obj
            .get("sibling_ordinal")
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .unwrap_or_else(|| {
                let entry = ordinals.entry(ord_key).or_insert(0);
                let cur = *entry;
                *entry += 1;
                cur
            });
        let stable_key =
            AxNode::compute_stable_key(&frame_id, landmark.as_deref(), &role, &name, sibling_ordinal);

        nodes.push(AxNode {
            ref_id,
            role,
            name,
            value,
            landmark,
            frame_id,
            depth,
            sibling_ordinal,
            interactive,
            disabled,
            checked,
            expanded,
            stable_key,
        });
    }
    Some(nodes)
}

fn line_ref_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:\[(?:ref=)?(@?e\d+)\]|^(@e\d+)\s+|\((@e\d+)\))").unwrap())
}

fn line_value_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\b(?:value|val)=("([^"]*)"|'([^']*)'|(\S+))"#).unwrap())
}

fn quoted_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#""([^"]*)""#).unwrap())
}

/// Parse indented or ref-tagged accessibility tree snapshots into canonical [`AxNode`] records.
pub fn parse_ax_snapshot_text(raw: &str) -> Vec<AxNode> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if (trimmed.starts_with('[') || trimmed.starts_with('{')) && !trimmed.starts_with("[@e") {
        if let Some(parsed) = parse_ax_json(trimmed) {
            return parsed;
        }
    }

    let mut nodes = Vec::new();
    let mut landmark_stack: Vec<(usize, String)> = Vec::new();
    let mut ordinals: HashMap<(String, String, String, String), usize> = HashMap::new();
    let mut current_frame = "main".to_string();

    for raw_line in raw.lines() {
        if raw_line.trim().is_empty() {
            continue;
        }
        let leading_ws: usize = raw_line
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .map(|c| if c == '\t' { 2 } else { 1 })
            .sum();
        let depth = leading_ws / 2;

        let mut work = raw_line.trim().trim_start_matches("- ").trim().to_string();
        if work.is_empty() || work.starts_with("[chrome:") {
            continue;
        }
        if let Some(rest) = work.strip_prefix("[frame:") {
            if let Some(end) = rest.find(']') {
                current_frame = rest[..end].trim().to_string();
                continue;
            }
        }

        while let Some((d, _)) = landmark_stack.last() {
            if *d >= depth {
                landmark_stack.pop();
            } else {
                break;
            }
        }

        let mut ref_id = None;
        if let Some(caps) = line_ref_re().captures(&work) {
            let token = caps
                .get(1)
                .or_else(|| caps.get(2))
                .or_else(|| caps.get(3))
                .map(|m| m.as_str())
                .unwrap_or("");
            if !token.is_empty() {
                ref_id = Some(if token.starts_with('@') {
                    token.to_string()
                } else {
                    format!("@{token}")
                });
            }
            work = line_ref_re().replace(&work, " ").trim().to_string();
        }

        let mut value = None;
        if let Some(caps) = line_value_re().captures(&work) {
            let raw_val = caps
                .get(2)
                .or_else(|| caps.get(3))
                .or_else(|| caps.get(4))
                .map(|m| m.as_str())
                .unwrap_or("");
            value = Some(redact_sensitive_browser_text(raw_val));
            work = line_value_re().replace(&work, " ").trim().to_string();
        }

        let lower_work = work.to_ascii_lowercase();
        let disabled = lower_work.contains("[disabled]") || lower_work.contains(" disabled");
        let checked = if lower_work.contains("[checked=true]") || lower_work.contains("[checked]") {
            Some(true)
        } else if lower_work.contains("[checked=false]") {
            Some(false)
        } else {
            None
        };
        let expanded = if lower_work.contains("[expanded=true]") || lower_work.contains("[expanded]")
        {
            Some(true)
        } else if lower_work.contains("[expanded=false]") {
            Some(false)
        } else {
            None
        };

        let cleaned_for_role = work
            .replace("[disabled]", "")
            .replace("[checked=true]", "")
            .replace("[checked=false]", "")
            .replace("[checked]", "")
            .replace("[expanded=true]", "")
            .replace("[expanded=false]", "")
            .replace("[expanded]", "");

        let name = if let Some(caps) = quoted_name_re().captures(&cleaned_for_role) {
            redact_sensitive_browser_text(&caps[1])
        } else {
            String::new()
        };

        let without_quotes = quoted_name_re().replace(&cleaned_for_role, " ");
        let role_token = without_quotes
            .split_whitespace()
            .find(|tok| !tok.starts_with('['))
            .unwrap_or("generic")
            .trim_matches(|c| c == '[' || c == ']' || c == ':')
            .to_string();

        if let Some(lm) = canonical_landmark_role(&role_token) {
            landmark_stack.push((depth, lm.to_string()));
        }
        let landmark = landmark_stack.last().map(|(_, lm)| lm.clone());

        if is_sensitive_field_label(&role_token, &name)
            && value.as_ref().is_some_and(|v| !v.is_empty())
        {
            value = Some("[REDACTED]".to_string());
        }

        let norm_name = normalize_volatile_ax_text(&name);
        let ord_key = (
            current_frame.clone(),
            landmark.clone().unwrap_or_default(),
            role_token.clone(),
            norm_name,
        );
        let sibling_ordinal = {
            let entry = ordinals.entry(ord_key).or_insert(0);
            let cur = *entry;
            *entry += 1;
            cur
        };

        let stable_key = AxNode::compute_stable_key(
            &current_frame,
            landmark.as_deref(),
            &role_token,
            &name,
            sibling_ordinal,
        );

        nodes.push(AxNode {
            ref_id,
            interactive: is_interactive_role(&role_token),
            role: role_token,
            name,
            value,
            landmark,
            frame_id: current_frame.clone(),
            depth,
            sibling_ordinal,
            disabled,
            checked,
            expanded,
            stable_key,
        });
    }

    nodes
}

/// Compute `(full_hash, structure_hash)` over canonicalized AX nodes, ignoring volatile `@eN`
/// handles and generated framework IDs (`:r1a:`, `mui-*`) so unchanged pages match reliably.
pub fn compute_ax_hashes(nodes: &[AxNode]) -> (String, String) {
    let mut full_parts = Vec::with_capacity(nodes.len());
    let mut struct_parts = Vec::with_capacity(nodes.len());
    for n in nodes {
        let key = if n.stable_key.is_empty() {
            AxNode::compute_stable_key(
                &n.frame_id,
                n.landmark.as_deref(),
                &n.role,
                &n.name,
                n.sibling_ordinal,
            )
        } else {
            n.stable_key.clone()
        };
        let norm_name = normalize_volatile_ax_text(&n.name);
        let val_str = n.value.as_deref().unwrap_or("");
        full_parts.push(format!(
            "{key}|{}|{}|{}|{}|{:?}|{:?}",
            n.role, norm_name, val_str, n.disabled, n.checked, n.expanded
        ));
        struct_parts.push(format!("{key}|{}", n.role));
    }
    (
        short_hash(&full_parts.join("\n")),
        short_hash(&struct_parts.join("\n")),
    )
}

fn format_ax_node_line(n: &AxNode) -> String {
    let indent = "  ".repeat(n.depth.min(8));
    let mut line = format!("{indent}{}", n.role);
    if !n.name.is_empty() {
        line.push_str(&format!(" \"{}\"", n.name));
    }
    if let Some(ref_id) = &n.ref_id {
        line.push_str(&format!(" [{ref_id}]"));
    }
    if let Some(val) = &n.value {
        if !val.is_empty() {
            line.push_str(&format!(" value=\"{val}\""));
        }
    }
    if n.disabled {
        line.push_str(" [disabled]");
    }
    if let Some(c) = n.checked {
        line.push_str(&format!(" [checked={c}]"));
    }
    if let Some(e) = n.expanded {
        line.push_str(&format!(" [expanded={e}]"));
    }
    line
}

fn render_nodes_canonical(nodes: &[AxNode]) -> String {
    nodes
        .iter()
        .map(format_ax_node_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn sanitize_and_key_nodes(raw_nodes: Vec<AxNode>) -> Vec<AxNode> {
    let mut ordinals: HashMap<(String, String, String, String), usize> = HashMap::new();
    raw_nodes
        .into_iter()
        .map(|mut n| {
            n.name = redact_sensitive_browser_text(&n.name);
            n.value = n.value.map(|v| redact_sensitive_browser_text(&v));
            if is_sensitive_field_label(&n.role, &n.name)
                && n.value.as_ref().is_some_and(|v| !v.is_empty())
            {
                n.value = Some("[REDACTED]".to_string());
            }
            if n.stable_key.is_empty() {
                let norm_name = normalize_volatile_ax_text(&n.name);
                let key = (
                    n.frame_id.clone(),
                    n.landmark.clone().unwrap_or_default(),
                    n.role.clone(),
                    norm_name,
                );
                let ord = if n.sibling_ordinal > 0 {
                    n.sibling_ordinal
                } else {
                    let entry = ordinals.entry(key).or_insert(0);
                    let cur = *entry;
                    *entry += 1;
                    cur
                };
                n.sibling_ordinal = ord;
                n.stable_key = AxNode::compute_stable_key(
                    &n.frame_id,
                    n.landmark.as_deref(),
                    &n.role,
                    &n.name,
                    n.sibling_ordinal,
                );
            }
            n
        })
        .collect()
}

fn compute_semantic_delta(prior: &[AxNode], current: &[AxNode]) -> (String, usize, usize, usize) {
    let prior_map: HashMap<&str, &AxNode> =
        prior.iter().map(|n| (n.stable_key.as_str(), n)).collect();
    let current_keys: HashSet<&str> = current.iter().map(|n| n.stable_key.as_str()).collect();

    let mut lines = Vec::new();
    let mut added = 0usize;
    let mut modified = 0usize;
    let mut removed = 0usize;

    for node in current {
        match prior_map.get(node.stable_key.as_str()) {
            None => {
                added += 1;
                lines.push(format!("+ {}", format_ax_node_line(node).trim_start()));
            }
            Some(prev) => {
                let changed = prev.name != node.name
                    || prev.value != node.value
                    || prev.disabled != node.disabled
                    || prev.checked != node.checked
                    || prev.expanded != node.expanded;
                if changed {
                    modified += 1;
                    lines.push(format!("~ {}", format_ax_node_line(node).trim_start()));
                }
            }
        }
    }

    for prev in prior {
        if !current_keys.contains(prev.stable_key.as_str()) {
            removed += 1;
            lines.push(format!("- {}", format_ax_node_line(prev).trim_start()));
        }
    }

    (lines.join("\n"), added, modified, removed)
}

fn filter_nodes_for_mode(nodes: &[AxNode], mode: BrowserReadMode) -> Vec<AxNode> {
    match mode {
        BrowserReadMode::InteractiveOnly => nodes.iter().filter(|n| n.interactive).cloned().collect(),
        _ => nodes.to_vec(),
    }
}

fn render_summary_outline(nodes: &[AxNode]) -> String {
    let mut sections: BTreeMap<String, (Vec<String>, usize)> = BTreeMap::new();
    for n in nodes {
        let lm = n.landmark.clone().unwrap_or_else(|| "root".to_string());
        let entry = sections.entry(lm).or_insert_with(|| (Vec::new(), 0));
        if n.role == "heading" && !n.name.is_empty() {
            entry.0.push(n.name.clone());
        }
        if n.interactive {
            entry.1 += 1;
        }
    }
    sections
        .into_iter()
        .map(|(lm, (headings, interactive_cnt))| {
            let h_str = if headings.is_empty() {
                String::new()
            } else {
                format!(" headings=[{}]", headings.join(", "))
            };
            format!("landmark:{lm} interactive={interactive_cnt}{h_str}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Persistent browser AX snapshot cache with semantic delta diffing and per-origin chrome factoring.
#[derive(Clone)]
pub struct BrowserReadCache {
    store: ContextStore,
}

impl BrowserReadCache {
    pub fn new(store: ContextStore) -> Self {
        Self { store }
    }

    /// Invalidate all fresh snapshots for `(session_id, tab_id)` (e.g. on reload/navigation).
    pub fn invalidate_tab(&self, session_id: &str, tab_id: &str) -> Result<usize> {
        let updated = self.store.with_conn(|conn| {
            let count = conn.execute(
                "UPDATE browser_snapshots
                 SET status = 'stale'
                 WHERE session_id = ?1 AND tab_id = ?2 AND status = 'fresh'",
                params![session_id, tab_id],
            )?;
            Ok(count)
        })?;
        Ok(updated)
    }

    /// Ingest an accessibility snapshot, returning an unchanged stub, semantic delta,
    /// origin-chrome-stripped view, or full snapshot while storing full recovery in CCR.
    pub fn ingest_snapshot(
        &self,
        input: &BrowserSnapshotInput,
        ccr: &CcrStore,
        ledger: &SavingsLedger,
    ) -> Result<BrowserSnapshotResult> {
        let start = std::time::Instant::now();
        let origin = extract_origin(&input.url);
        let canonical_route = canonicalize_route(&input.url);
        let redacted_raw = redact_sensitive_browser_text(&input.raw_text);

        let nodes = match &input.nodes {
            Some(pre) => sanitize_and_key_nodes(pre.clone()),
            None => parse_ax_snapshot_text(&redacted_raw),
        };
        let canonical_text = if redacted_raw.trim().is_empty() {
            render_nodes_canonical(&nodes)
        } else {
            redacted_raw.clone()
        };
        let raw_tokens = estimate_tokens(&canonical_text);
        let (full_hash, structure_hash) = compute_ax_hashes(&nodes);

        let ccr_hash = if !canonical_text.trim().is_empty() {
            let preview: String = canonical_text.chars().take(240).collect();
            Some(ccr.put(
                &canonical_text,
                &preview,
                "browser_snapshot",
                &canonical_route,
            )?)
        } else {
            None
        };

        let prior = self.latest_fresh_snapshot(
            &input.session_id,
            &input.tab_id,
            &origin,
            &canonical_route,
        )?;
        let next_turn = prior.as_ref().map_or(1, |p| p.turn_index + 1);

        // 1. Unchanged stub (~18-25 tokens) when full_hash matches.
        if !input.fresh && input.mode != BrowserReadMode::Full {
            if let Some(ref prev) = prior {
                if prev.full_hash == full_hash {
                    let ccr_ref = prev
                        .ccr_hash
                        .clone()
                        .or_else(|| ccr_hash.clone())
                        .unwrap_or_default();
                    let short_h = &full_hash[..8.min(full_hash.len())];
                    let stub = if ccr_ref.is_empty() {
                        format!("[Unchanged #{} ({}) h:{short_h}]", prev.turn_index, canonical_route)
                    } else {
                        format!(
                            "[Unchanged #{} ({}) h:{short_h} — <<ccr:{ccr_ref}>>]",
                            prev.turn_index, canonical_route
                        )
                    };
                    let delivered_tokens = estimate_tokens(&stub);
                    let _ = ledger.record(&LedgerEventInput {
                        session_id: input.session_id.clone(),
                        agent: input.agent.clone(),
                        provider: input.provider.clone(),
                        model: input.model.clone(),
                        category: "browser".to_string(),
                        command_or_tool: "browser:snapshot_stub".to_string(),
                        raw_tokens,
                        compressed_tokens: delivered_tokens,
                        cache_hit: true,
                        overhead_ms: start.elapsed().as_millis() as u64,
                    });
                    return Ok(BrowserSnapshotResult {
                        outcome: BrowserSnapshotOutcome::UnchangedStub,
                        text: stub,
                        origin,
                        canonical_route,
                        full_hash,
                        structure_hash,
                        chrome_hash: None,
                        ccr_hash: Some(ccr_ref).filter(|s| !s.is_empty()),
                        raw_tokens,
                        delivered_tokens,
                        tokens_saved: raw_tokens.saturating_sub(delivered_tokens),
                        turn_index: prev.turn_index,
                        node_count: nodes.len(),
                    });
                }
            }
        }

        // 2. Semantic delta on mutated same-route snapshots (with >45% & break-even fallback).
        if !input.fresh && matches!(input.mode, BrowserReadMode::Auto | BrowserReadMode::Diff) {
            if let Some(ref prev) = prior {
                if prev.full_hash != full_hash {
                    if let Ok(prev_nodes) = serde_json::from_str::<Vec<AxNode>>(&prev.nodes_json) {
                        let (delta_body, added, modified, removed) =
                            compute_semantic_delta(&prev_nodes, &nodes);
                        let changed = added + modified + removed;
                        let denom = prev_nodes.len().max(nodes.len()).max(1);
                        let ccr_tag = ccr_hash
                            .as_deref()
                            .map(|h| format!(" — <<ccr:{h}>>"))
                            .unwrap_or_default();
                        let delta_text = format!(
                            "[AX delta vs #{} ({}) +{added} ~{modified} -{removed}{ccr_tag}]\n{delta_body}",
                            prev.turn_index, canonical_route
                        );
                        let delta_tokens = estimate_tokens(&delta_text);
                        if changed * 100 <= denom * 45 && delta_tokens < raw_tokens {
                            self.mark_snapshot_status(prev.id, "stale")?;
                            self.insert_snapshot_row(
                                &input.session_id,
                                &input.tab_id,
                                &origin,
                                &canonical_route,
                                &full_hash,
                                &structure_hash,
                                None,
                                next_turn,
                                ccr_hash.as_deref(),
                                &nodes,
                                delta_tokens,
                            )?;
                            let _ = ledger.record(&LedgerEventInput {
                                session_id: input.session_id.clone(),
                                agent: input.agent.clone(),
                                provider: input.provider.clone(),
                                model: input.model.clone(),
                                category: "browser".to_string(),
                                command_or_tool: "browser:ax_diff".to_string(),
                                raw_tokens,
                                compressed_tokens: delta_tokens,
                                cache_hit: false,
                                overhead_ms: start.elapsed().as_millis() as u64,
                            });
                            return Ok(BrowserSnapshotResult {
                                outcome: BrowserSnapshotOutcome::SemanticDelta,
                                text: delta_text,
                                origin,
                                canonical_route,
                                full_hash,
                                structure_hash,
                                chrome_hash: None,
                                ccr_hash,
                                raw_tokens,
                                delivered_tokens: delta_tokens,
                                tokens_saved: raw_tokens.saturating_sub(delta_tokens),
                                turn_index: next_turn,
                                node_count: nodes.len(),
                            });
                        }
                    }
                }
            }
        }

        // 3. Full / Summary / InteractiveOnly / Origin-Chrome-Stripped rendering.
        let (delivered_text, chrome_hash, chrome_stripped) = match input.mode {
            BrowserReadMode::Full => (canonical_text.clone(), None, false),
            BrowserReadMode::Summary => {
                let outline = render_summary_outline(&nodes);
                (outline, None, false)
            }
            BrowserReadMode::InteractiveOnly => {
                let filtered = filter_nodes_for_mode(&nodes, BrowserReadMode::InteractiveOnly);
                (render_nodes_canonical(&filtered), None, false)
            }
            BrowserReadMode::Auto | BrowserReadMode::Diff => {
                self.render_with_origin_chrome_factoring(&input.session_id, &origin, &nodes, ccr)?
            }
        };

        if let Some(ref prev) = prior {
            let status = if prev.full_hash == full_hash {
                "superseded"
            } else {
                "stale"
            };
            self.mark_snapshot_status(prev.id, status)?;
        }

        let delivered_tokens = estimate_tokens(&delivered_text);
        self.insert_snapshot_row(
            &input.session_id,
            &input.tab_id,
            &origin,
            &canonical_route,
            &full_hash,
            &structure_hash,
            chrome_hash.as_deref(),
            next_turn,
            ccr_hash.as_deref(),
            &nodes,
            delivered_tokens,
        )?;

        let outcome = if chrome_stripped && delivered_tokens < raw_tokens {
            BrowserSnapshotOutcome::ChromeStrippedFull
        } else {
            BrowserSnapshotOutcome::Full
        };

        let feature_label = if outcome == BrowserSnapshotOutcome::ChromeStrippedFull {
            "browser:chrome_strip"
        } else {
            "browser:snapshot_full"
        };
        let _ = ledger.record(&LedgerEventInput {
            session_id: input.session_id.clone(),
            agent: input.agent.clone(),
            provider: input.provider.clone(),
            model: input.model.clone(),
            category: "browser".to_string(),
            command_or_tool: feature_label.to_string(),
            raw_tokens,
            compressed_tokens: delivered_tokens,
            cache_hit: false,
            overhead_ms: start.elapsed().as_millis() as u64,
        });

        Ok(BrowserSnapshotResult {
            outcome,
            text: delivered_text,
            origin,
            canonical_route,
            full_hash,
            structure_hash,
            chrome_hash,
            ccr_hash,
            raw_tokens,
            delivered_tokens,
            tokens_saved: raw_tokens.saturating_sub(delivered_tokens),
            turn_index: next_turn,
            node_count: nodes.len(),
        })
    }

    fn render_with_origin_chrome_factoring(
        &self,
        session_id: &str,
        origin: &str,
        nodes: &[AxNode],
        ccr: &CcrStore,
    ) -> Result<(String, Option<String>, bool)> {
        if nodes.is_empty() {
            return Ok((String::new(), None, false));
        }

        // Group contiguous runs of nodes by whether they belong to a chrome landmark.
        let mut out_lines: Vec<String> = Vec::new();
        let mut chrome_hashes: Vec<String> = Vec::new();
        let mut chrome_stripped = false;

        let mut i = 0usize;
        while i < nodes.len() {
            let lm = nodes[i].landmark.as_deref();
            if is_chrome_landmark(lm) {
                let role = lm.unwrap();
                let start = i;
                while i < nodes.len() && nodes[i].landmark.as_deref() == Some(role) {
                    i += 1;
                }
                let subtree = &nodes[start..i];
                let subtree_text = render_nodes_canonical(subtree);
                let lm_hash = short_hash(&subtree_text);
                chrome_hashes.push(format!("{role}:{lm_hash}"));

                let summary_label = subtree
                    .iter()
                    .find(|n| !n.name.is_empty())
                    .map(|n| n.name.clone())
                    .unwrap_or_else(|| role.to_string());

                let prior = self.lookup_chrome(session_id, origin, role)?;
                match prior {
                    Some(prev) if prev.chrome_hash == lm_hash => {
                        out_lines.push(format!(
                            "[chrome:{role}:{lm_hash} \"{}\" (unchanged, {} nodes)]",
                            prev.summary_label,
                            subtree.len()
                        ));
                        chrome_stripped = true;
                    }
                    Some(prev) => {
                        let prev_nodes = parse_ax_snapshot_text(&prev.compact_text);
                        let (delta_body, added, modified, removed) =
                            compute_semantic_delta(&prev_nodes, subtree);
                        let changed = added + modified + removed;
                        let chrome_ccr = if !subtree_text.is_empty() {
                            ccr.put(&subtree_text, &summary_label, "browser_chrome", origin)
                                .ok()
                        } else {
                            None
                        };
                        self.upsert_chrome(
                            session_id,
                            origin,
                            role,
                            &lm_hash,
                            chrome_ccr.as_deref(),
                            &subtree_text,
                            &summary_label,
                        )?;
                        if changed > 0 && changed <= 2 && changed * 100 <= subtree.len().max(1) * 45
                        {
                            out_lines.push(format!(
                                "[chrome:{role}:{lm_hash} \"{summary_label}\" delta]\n{delta_body}"
                            ));
                            chrome_stripped = true;
                        } else {
                            out_lines.push(format!("[chrome:{role}:{lm_hash}]"));
                            out_lines.push(subtree_text);
                        }
                    }
                    None => {
                        let chrome_ccr = if !subtree_text.is_empty() {
                            ccr.put(&subtree_text, &summary_label, "browser_chrome", origin)
                                .ok()
                        } else {
                            None
                        };
                        self.upsert_chrome(
                            session_id,
                            origin,
                            role,
                            &lm_hash,
                            chrome_ccr.as_deref(),
                            &subtree_text,
                            &summary_label,
                        )?;
                        out_lines.push(format!("[chrome:{role}:{lm_hash}]"));
                        out_lines.push(subtree_text);
                    }
                }
            } else {
                out_lines.push(format_ax_node_line(&nodes[i]));
                i += 1;
            }
        }

        let combined_chrome_hash = if chrome_hashes.is_empty() {
            None
        } else {
            Some(short_hash(&chrome_hashes.join("|")))
        };

        Ok((out_lines.join("\n"), combined_chrome_hash, chrome_stripped))
    }

    fn latest_fresh_snapshot(
        &self,
        session_id: &str,
        tab_id: &str,
        origin: &str,
        canonical_route: &str,
    ) -> Result<Option<PriorSnapshot>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT id, full_hash, turn_index, ccr_hash, nodes_json
                 FROM browser_snapshots
                 WHERE session_id = ?1 AND tab_id = ?2 AND origin = ?3
                   AND canonical_route = ?4 AND status = 'fresh'
                 ORDER BY id DESC LIMIT 1",
                params![session_id, tab_id, origin, canonical_route],
                |r| {
                    Ok(PriorSnapshot {
                        id: r.get(0)?,
                        full_hash: r.get(1)?,
                        turn_index: r.get::<_, i64>(2)? as usize,
                        ccr_hash: r.get(3)?,
                        nodes_json: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
        })
    }

    fn mark_snapshot_status(&self, id: i64, status: &str) -> Result<()> {
        self.store.with_conn(|conn| {
            conn.execute(
                "UPDATE browser_snapshots SET status = ?1 WHERE id = ?2",
                params![status, id],
            )?;
            Ok(())
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_snapshot_row(
        &self,
        session_id: &str,
        tab_id: &str,
        origin: &str,
        canonical_route: &str,
        full_hash: &str,
        structure_hash: &str,
        chrome_hash: Option<&str>,
        turn_index: usize,
        ccr_hash: Option<&str>,
        nodes: &[AxNode],
        tokens: usize,
    ) -> Result<()> {
        let nodes_json = serde_json::to_string(nodes)?;
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO browser_snapshots (
                    session_id, tab_id, origin, canonical_route, full_hash, structure_hash,
                    chrome_hash, turn_index, status, ccr_hash, nodes_json, tokens, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'fresh', ?9, ?10, ?11, ?12)",
                params![
                    session_id,
                    tab_id,
                    origin,
                    canonical_route,
                    full_hash,
                    structure_hash,
                    chrome_hash,
                    turn_index as i64,
                    ccr_hash,
                    nodes_json,
                    tokens as i64,
                    now
                ],
            )?;
            Ok(())
        })
    }

    fn lookup_chrome(
        &self,
        session_id: &str,
        origin: &str,
        landmark_role: &str,
    ) -> Result<Option<PriorChrome>> {
        self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT chrome_hash, compact_text, summary_label
                 FROM browser_chrome
                 WHERE session_id = ?1 AND origin = ?2 AND landmark_role = ?3",
                params![session_id, origin, landmark_role],
                |r| {
                    Ok(PriorChrome {
                        chrome_hash: r.get(0)?,
                        compact_text: r.get(1)?,
                        summary_label: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert_chrome(
        &self,
        session_id: &str,
        origin: &str,
        landmark_role: &str,
        chrome_hash: &str,
        ccr_hash: Option<&str>,
        compact_text: &str,
        summary_label: &str,
    ) -> Result<()> {
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO browser_chrome (
                    session_id, origin, landmark_role, chrome_hash, ccr_hash,
                    compact_text, summary_label, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(session_id, origin, landmark_role) DO UPDATE SET
                    chrome_hash = excluded.chrome_hash,
                    ccr_hash = excluded.ccr_hash,
                    compact_text = excluded.compact_text,
                    summary_label = excluded.summary_label,
                    created_at = excluded.created_at",
                params![
                    session_id,
                    origin,
                    landmark_role,
                    chrome_hash,
                    ccr_hash,
                    compact_text,
                    summary_label,
                    now
                ],
            )?;
            Ok(())
        })
    }
}

/// Ensure landmark helper list is used consistently.
pub fn is_known_landmark(role: &str) -> bool {
    ALL_LANDMARKS.contains(&role)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_input(session: &str, url: &str, raw_text: &str) -> BrowserSnapshotInput {
        BrowserSnapshotInput {
            session_id: session.to_string(),
            tab_id: "tab-1".to_string(),
            url: url.to_string(),
            title: Some("App".to_string()),
            raw_text: raw_text.to_string(),
            nodes: None,
            mode: BrowserReadMode::Auto,
            fresh: false,
            agent: "Orion".to_string(),
            provider: "google".to_string(),
            model: "gemini-4".to_string(),
        }
    }

    #[test]
    fn canonicalizes_routes_and_ignores_volatile_ids_in_ax_hashes() {
        assert_eq!(
            canonicalize_route("https://App.Example.COM:443/users/list/?b=2&utm_source=x&t=12345&a=1#sec"),
            "https://app.example.com/users/list?a=1&b=2"
        );
        assert_eq!(
            canonicalize_route("http://localhost:5173/dashboard/"),
            canonicalize_route("http://localhost:5173/dashboard?t=999999")
        );

        let snap_a = r#"
RootWebArea "Workspace"
  main
    button "Save :r1a:" [@e1]
    textbox "Project mui-12345" [@e2] value="kite"
"#;
        let snap_b = r#"
RootWebArea "Workspace"
  main
    button "Save :r9z:" [@e42]
    textbox "Project mui-99999" [@e43] value="kite"
"#;
        let nodes_a = parse_ax_snapshot_text(snap_a);
        let nodes_b = parse_ax_snapshot_text(snap_b);
        assert_eq!(nodes_a[2].stable_key, nodes_b[2].stable_key);
        assert_eq!(compute_ax_hashes(&nodes_a), compute_ax_hashes(&nodes_b));
    }

    #[test]
    fn returns_unchanged_stub_then_semantic_delta_then_breakeven_full_and_invalidates() {
        let store = ContextStore::open_in_memory().unwrap();
        let ccr = CcrStore::new(store.clone());
        let ledger = SavingsLedger::new(store.clone());
        let cache = BrowserReadCache::new(store);

        let mut base = String::from("RootWebArea \"Dashboard\"\n  main\n    heading \"Projects\"\n");
        for i in 0..18 {
            base.push_str(&format!("    button \"Action {i}\" [@e{}]\n", i + 1));
        }

        let r1 = cache
            .ingest_snapshot(&mk_input("s1", "http://localhost:5173/projects", &base), &ccr, &ledger)
            .unwrap();
        assert_eq!(r1.outcome, BrowserSnapshotOutcome::Full);
        assert!(r1.ccr_hash.is_some());

        // Identical re-snapshot returns ~18-25 token stub
        let r2 = cache
            .ingest_snapshot(&mk_input("s1", "http://localhost:5173/projects", &base), &ccr, &ledger)
            .unwrap();
        assert_eq!(r2.outcome, BrowserSnapshotOutcome::UnchangedStub);
        assert!(r2.delivered_tokens <= 28, "stub too large: {}", r2.delivered_tokens);
        assert!(r2.tokens_saved > 0);

        // Mutate 1 button -> semantic delta
        let mutated = base.replace("button \"Action 3\" [@e4]", "button \"Action 3\" [@e4] [disabled]");
        let r3 = cache
            .ingest_snapshot(&mk_input("s1", "http://localhost:5173/projects", &mutated), &ccr, &ledger)
            .unwrap();
        assert_eq!(r3.outcome, BrowserSnapshotOutcome::SemanticDelta);
        assert!(r3.text.contains("~ button \"Action 3\""));
        assert!(r3.delivered_tokens < r3.raw_tokens);

        // Massive rewrite (>45%) -> break-even full fallback
        let mut rewritten = String::from("RootWebArea \"Billing\"\n  main\n");
        for i in 0..20 {
            rewritten.push_str(&format!("    link \"Invoice #{i}\" [@e{}]\n", i + 100));
        }
        let r4 = cache
            .ingest_snapshot(&mk_input("s1", "http://localhost:5173/projects", &rewritten), &ccr, &ledger)
            .unwrap();
        assert_eq!(r4.outcome, BrowserSnapshotOutcome::Full);

        // Invalidate tab -> next snapshot is NOT an UnchangedStub
        let invalidated = cache.invalidate_tab("s1", "tab-1").unwrap();
        assert!(invalidated >= 1);
        let r5 = cache
            .ingest_snapshot(&mk_input("s1", "http://localhost:5173/projects", &rewritten), &ccr, &ledger)
            .unwrap();
        assert_eq!(r5.outcome, BrowserSnapshotOutcome::Full);
    }

    #[test]
    fn factors_origin_chrome_across_routes_and_redacts_secrets() {
        let store = ContextStore::open_in_memory().unwrap();
        let ccr = CcrStore::new(store.clone());
        let ledger = SavingsLedger::new(store.clone());
        let cache = BrowserReadCache::new(store);

        let route_a = r#"
RootWebArea "Home"
  banner "Top Bar"
    link "Kite" [@e1]
    button "Notifications (1)" [@e2]
  navigation "Sidebar"
    link "Overview" [@e3]
    link "Settings" [@e4]
    link "Billing" [@e5]
  main
    heading "Home Page"
    textbox "Password" [@e6] value="super-secret-pw"
    textbox "Token" [@e7] value="Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig_1234567890"
"#;

        let r1 = cache
            .ingest_snapshot(&mk_input("s2", "http://localhost:5173/home", route_a), &ccr, &ledger)
            .unwrap();
        assert_eq!(r1.outcome, BrowserSnapshotOutcome::Full);
        assert!(!r1.text.contains("super-secret-pw"));
        assert!(!r1.text.contains("eyJhbGciOiJIUzI1NiJ9"));
        assert!(r1.text.contains("[REDACTED]"));

        // Verify CCR never persisted unredacted password
        let recovered = ccr.retrieve(r1.ccr_hash.as_deref().unwrap()).unwrap();
        assert!(!recovered.original_text.contains("super-secret-pw"));

        let route_b = r#"
RootWebArea "Settings"
  banner "Top Bar"
    link "Kite" [@e1]
    button "Notifications (1)" [@e2]
  navigation "Sidebar"
    link "Overview" [@e3]
    link "Settings" [@e4]
    link "Billing" [@e5]
  main
    heading "Settings Page"
    button "Save Changes" [@e8]
"#;
        let r2 = cache
            .ingest_snapshot(&mk_input("s2", "http://localhost:5173/settings", route_b), &ccr, &ledger)
            .unwrap();
        assert_eq!(r2.outcome, BrowserSnapshotOutcome::ChromeStrippedFull);
        assert!(r2.text.contains("[chrome:banner:"));
        assert!(r2.text.contains("[chrome:navigation:"));
        assert!(r2.text.contains("unchanged"));
        assert!(r2.delivered_tokens < r2.raw_tokens);
    }
}
