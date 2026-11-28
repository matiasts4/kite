use crate::agent_mind::memory::{load_agent_mind_at, revision_matches, sync_agent_instructions};
use crate::agent_mind::types::{
    AgentMindError, LinkedSkillContent, SkillFrontmatter, MAX_SKILLS, SKILL_BYTE_LIMIT,
    SKILL_DESCRIPTION_LIMIT, SKILL_NAME_LIMIT,
};
use crate::agent_mind::utils::{
    display_ok, ensure_agent_id, ensure_skill_id, has_disallowed_control, issue, modified_ms,
    prepare_file, read_regular, sha256_hex, skill_id_ok,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillMeta {
    #[serde(default = "default_skill_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub uses: u64,
    #[serde(default)]
    pub last_used: Option<i64>,
    #[serde(default)]
    pub last_outcome: Option<String>,
}

fn default_skill_enabled() -> bool {
    true
}

impl Default for SkillMeta {
    fn default() -> Self {
        Self {
            enabled: true,
            uses: 0,
            last_used: None,
            last_outcome: None,
        }
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn skills_meta_path(agent_dir: &Path) -> PathBuf {
    agent_dir.join("skills-meta.json")
}

pub(crate) fn read_skills_meta(agent_dir: &Path) -> BTreeMap<String, SkillMeta> {
    let path = skills_meta_path(agent_dir);
    let Ok(raw) = fs::read_to_string(&path) else {
        return BTreeMap::new();
    };
    serde_json::from_str::<BTreeMap<String, SkillMeta>>(&raw).unwrap_or_default()
}

pub(crate) fn write_skills_meta(
    root: &Path,
    agent_id: &str,
    meta: &BTreeMap<String, SkillMeta>,
) -> Result<(), AgentMindError> {
    ensure_agent_id(agent_id)?;
    let path = skills_meta_path(&root.join(agent_id));
    prepare_file(root, &path)?;
    let serialized = serde_json::to_string_pretty(meta).map_err(|_| {
        AgentMindError::new("agent_data_failed", "Kite could not store this agent data.")
    })?;
    fs::write(&path, serialized).map_err(|_| {
        AgentMindError::new("agent_data_failed", "Kite could not store this agent data.")
    })
}

pub(crate) fn is_skill_enabled(meta: &BTreeMap<String, SkillMeta>, skill_id: &str) -> bool {
    meta.get(skill_id).map(|m| m.enabled).unwrap_or(true)
}

pub(crate) fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn push_unique_trimmed(target: &mut Vec<String>, raw: &str) {
    let cleaned = unquote(raw);
    let trimmed = cleaned.trim();
    if !trimmed.is_empty() && !target.iter().any(|existing| existing == trimmed) {
        target.push(trimmed.to_string());
    }
}

fn parse_yaml_bool(value: &str) -> Option<bool> {
    match unquote(value).trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" => Some(true),
        "false" | "no" | "0" => Some(false),
        _ => None,
    }
}

fn parse_inline_yaml_list(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    let inner = trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(trimmed);
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in inner.chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            current.push(ch);
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            current.push(ch);
        } else if ch == ',' {
            push_unique_trimmed(&mut out, &current);
            current.clear();
        } else {
            current.push(ch);
        }
    }
    push_unique_trimmed(&mut out, &current);
    out
}

fn split_top_level_inline_entries(raw: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut bracket_depth = 0usize;
    let mut quote: Option<char> = None;
    for ch in raw.chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            current.push(ch);
            continue;
        }
        match ch {
            '"' | '\'' => {
                quote = Some(ch);
                current.push(ch);
            }
            '[' => {
                bracket_depth += 1;
                current.push(ch);
            }
            ']' => {
                bracket_depth = bracket_depth.saturating_sub(1);
                current.push(ch);
            }
            ',' if bracket_depth == 0 => {
                let s = current.trim();
                if !s.is_empty() {
                    parts.push(s.to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let s = current.trim();
    if !s.is_empty() {
        parts.push(s.to_string());
    }
    parts
}

fn parse_inline_requires(value: &str, bins: &mut Vec<String>, env: &mut Vec<String>) {
    let trimmed = value.trim();
    let Some(inner) = trimmed.strip_prefix('{').and_then(|s| s.strip_suffix('}')) else {
        return;
    };
    for entry in split_top_level_inline_entries(inner) {
        let Some((k, v)) = entry.split_once(':') else {
            continue;
        };
        match k.trim() {
            "bins" => {
                for item in parse_inline_yaml_list(v) {
                    push_unique_trimmed(bins, &item);
                }
            }
            "env" => {
                for item in parse_inline_yaml_list(v) {
                    push_unique_trimmed(env, &item);
                }
            }
            _ => {}
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReqListKind {
    Bins,
    Env,
}

pub fn parse_skill_frontmatter(source: &str) -> (SkillFrontmatter, String) {
    let normalized = source.strip_prefix('\u{feff}').unwrap_or(source);
    let lines: Vec<&str> = normalized.split('\n').collect();
    let Some(first) = lines.first() else {
        return (SkillFrontmatter::default(), String::new());
    };
    if first.trim_end_matches('\r').trim() != "---" {
        return (SkillFrontmatter::default(), normalized.trim().to_string());
    }
    let mut end_idx = None;
    for (idx, line) in lines.iter().enumerate().skip(1) {
        let trimmed = line.trim_end_matches('\r').trim();
        if trimmed == "---" || trimmed == "..." {
            end_idx = Some(idx);
            break;
        }
    }
    let Some(end_idx) = end_idx else {
        return (SkillFrontmatter::default(), normalized.trim().to_string());
    };

    let mut fm = SkillFrontmatter::default();
    let mut disable_model_invocation: Option<bool> = None;
    let mut manual_only_flag: Option<bool> = None;
    let mut in_requires = false;
    let mut req_list: Option<ReqListKind> = None;

    for raw_line in &lines[1..end_idx] {
        let line_no_cr = raw_line.trim_end_matches('\r');
        let trimmed = line_no_cr.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line_no_cr.len() - line_no_cr.trim_start().len();

        if indent == 0 {
            in_requires = false;
            req_list = None;
            let Some((key, value)) = trimmed.split_once(':') else {
                continue;
            };
            let key = key.trim();
            let value = value.trim();
            match key {
                "name" if fm.name.is_none() => fm.name = Some(unquote(value)),
                "description" if fm.description.is_none() => fm.description = Some(unquote(value)),
                "disable-model-invocation" => {
                    if let Some(b) = parse_yaml_bool(value) {
                        disable_model_invocation = Some(b);
                    }
                }
                "manual-only" | "manual_only" => {
                    if let Some(b) = parse_yaml_bool(value) {
                        manual_only_flag = Some(b);
                    }
                }
                "context" | "context_mode" => {
                    let mode = unquote(value).trim().to_ascii_lowercase();
                    fm.context_mode = if mode == "fork" {
                        "fork".to_string()
                    } else {
                        "inline".to_string()
                    };
                }
                "requires" => {
                    if value.is_empty() {
                        in_requires = true;
                    } else if value.starts_with('{') {
                        parse_inline_requires(value, &mut fm.requires_bins, &mut fm.requires_env);
                    }
                }
                _ => {}
            }
            continue;
        }

        if !in_requires {
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix('-') {
            if rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t') {
                match req_list {
                    Some(ReqListKind::Bins) => push_unique_trimmed(&mut fm.requires_bins, rest),
                    Some(ReqListKind::Env) => push_unique_trimmed(&mut fm.requires_env, rest),
                    None => {}
                }
                continue;
            }
        }

        let Some((sub_key, sub_val)) = trimmed.split_once(':') else {
            continue;
        };
        let sub_key = sub_key.trim();
        let sub_val = sub_val.trim();
        match sub_key {
            "bins" => {
                if sub_val.is_empty() {
                    req_list = Some(ReqListKind::Bins);
                } else {
                    req_list = None;
                    for item in parse_inline_yaml_list(sub_val) {
                        push_unique_trimmed(&mut fm.requires_bins, &item);
                    }
                }
            }
            "env" => {
                if sub_val.is_empty() {
                    req_list = Some(ReqListKind::Env);
                } else {
                    req_list = None;
                    for item in parse_inline_yaml_list(sub_val) {
                        push_unique_trimmed(&mut fm.requires_env, &item);
                    }
                }
            }
            _ => {
                req_list = None;
            }
        }
    }

    fm.manual_only = disable_model_invocation.unwrap_or(false) || manual_only_flag.unwrap_or(false);
    let body = lines[end_idx + 1..]
        .join("\n")
        .replace('\r', "")
        .trim()
        .to_string();
    (fm, body)
}

pub fn check_skill_eligibility(meta: &SkillFrontmatter) -> (bool, Vec<String>) {
    let mut missing = Vec::new();
    for bin in &meta.requires_bins {
        let trimmed = bin.trim();
        if trimmed.is_empty() {
            continue;
        }
        let found = if trimmed.contains('/') || trimmed.contains('\\') {
            Path::new(trimmed).is_file()
        } else {
            crate::chat::utils::find_in_path(trimmed).is_some()
        };
        if !found {
            missing.push(format!("bin:{trimmed}"));
        }
    }
    for env_key in &meta.requires_env {
        let trimmed = env_key.trim();
        if trimmed.is_empty() {
            continue;
        }
        let present = std::env::var_os(trimmed).is_some_and(|v| !v.is_empty());
        if !present {
            missing.push(format!("env:{trimmed}"));
        }
    }
    (missing.is_empty(), missing)
}

pub(crate) fn skill_summary(skill_id: &str, source: &str, path: &Path) -> (Value, Option<Value>) {
    let meta = path
        .parent()
        .and_then(|skills_dir| skills_dir.parent())
        .map(read_skills_meta)
        .unwrap_or_default();
    let entry = meta.get(skill_id).cloned().unwrap_or_default();
    skill_summary_with_meta(skill_id, source, path, &entry)
}

pub(crate) fn skill_summary_with_meta(
    skill_id: &str,
    source: &str,
    path: &Path,
    entry: &SkillMeta,
) -> (Value, Option<Value>) {
    let (fm, _) = parse_skill_frontmatter(source);
    let (eligible, missing_requirements) = check_skill_eligibility(&fm);
    let mut invalid = false;
    let name = match fm.name {
        Some(name) if display_ok(&name, SKILL_NAME_LIMIT) && !name.is_empty() => name,
        Some(_) => {
            invalid = true;
            if display_ok(skill_id, SKILL_NAME_LIMIT) {
                skill_id.to_string()
            } else {
                "Skill".to_string()
            }
        }
        None => skill_id.to_string(),
    };
    let description = match fm.description {
        Some(description) if display_ok(&description, SKILL_DESCRIPTION_LIMIT) => description,
        Some(_) => {
            invalid = true;
            String::new()
        }
        None => String::new(),
    };
    let last_used = entry
        .last_used
        .map(|ms| json!(ms.to_string()))
        .unwrap_or(Value::Null);
    let summary = json!({
        "id": skill_id,
        "name": name,
        "description": description,
        "updatedAtUnixMs": modified_ms(path).unwrap_or(0),
        "revision": sha256_hex(source.as_bytes()),
        "enabled": entry.enabled,
        "uses": entry.uses,
        "lastUsed": last_used,
        "lastOutcome": entry.last_outcome,
        "manualOnly": fm.manual_only,
        "contextMode": fm.context_mode,
        "requiresBins": fm.requires_bins,
        "requiresEnv": fm.requires_env,
        "eligible": eligible,
        "missingRequirements": missing_requirements,
    });
    let issue = if invalid {
        Some(issue("skillInvalid", Some(skill_id), None))
    } else {
        None
    };
    (summary, issue)
}

pub(crate) fn safe_issue_id(skill_id: &str) -> Option<&str> {
    if skill_id.len() <= 128 && !has_disallowed_control(skill_id) {
        Some(skill_id)
    } else {
        None
    }
}

pub(crate) fn read_skills(dir: &Path) -> (Vec<Value>, Vec<Value>) {
    if !dir.exists() {
        return (Vec::new(), Vec::new());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return (Vec::new(), vec![issue("skillsUnreadable", None, None)]),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            return (Vec::new(), vec![issue("skillsUnreadable", None, None)]);
        };
        paths.push(entry.path());
    }
    paths.sort();
    let mut meta_map = dir.parent().map(read_skills_meta).unwrap_or_default();
    let mut skills = Vec::new();
    let mut issues = Vec::new();
    let mut truncated = false;
    for path in paths {
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            issues.push(issue("skillPathRejected", None, None));
            continue;
        };
        if !file_name.ends_with(".md") {
            continue;
        }
        let skill_id = &file_name[..file_name.len() - 3];
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => {
                issues.push(issue("skillUnreadable", safe_issue_id(skill_id), None));
                continue;
            }
        };
        if !meta.file_type().is_file() || !skill_id_ok(skill_id) {
            issues.push(issue(
                "skillPathRejected",
                safe_issue_id(skill_id),
                None,
            ));
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => {
                issues.push(issue(
                    "skillUnreadable",
                    Some(skill_id),
                    None,
                ));
                continue;
            }
        };
        if bytes.len() > SKILL_BYTE_LIMIT {
            issues.push(issue(
                "skillUnreadable",
                Some(skill_id),
                Some(&sha256_hex(&bytes)),
            ));
            continue;
        }
        let Ok(source) = String::from_utf8(bytes) else {
            issues.push(issue("skillUnreadable", Some(skill_id), None));
            continue;
        };
        if skills.len() >= MAX_SKILLS {
            truncated = true;
            continue;
        }
        let skill_meta = meta_map.remove(skill_id).unwrap_or_default();
        let (summary, skill_issue) = skill_summary_with_meta(skill_id, &source, &path, &skill_meta);
        skills.push(summary);
        if let Some(skill_issue) = skill_issue {
            issues.push(skill_issue);
        }
    }
    if truncated {
        issues.push(issue("skillsTruncated", None, None));
    }
    (skills, issues)
}


pub(crate) fn skill_path(root: &Path, agent_id: &str, skill_id: &str) -> PathBuf {
    root.join(agent_id)
        .join("skills")
        .join(format!("{skill_id}.md"))
}

pub(crate) fn read_skill_source(path: &Path) -> Result<Option<String>, AgentMindError> {
    match read_regular(path) {
        Ok(None) => Ok(None),
        Ok(Some(bytes)) if bytes.len() > SKILL_BYTE_LIMIT => Err(AgentMindError::new(
            "agent_data_too_large",
            "The agent data exceeds Kite's safe limit.",
        )),
        Ok(Some(bytes)) => String::from_utf8(bytes).map(Some).map_err(|_| {
            AgentMindError::new(
                "agent_data_unreadable",
                "Agent data could not be read, so Kite left it unchanged.",
            )
        }),
        Err(_) => Err(AgentMindError::new(
            "agent_data_unreadable",
            "Agent data could not be read, so Kite left it unchanged.",
        )),
    }
}


pub(crate) fn store_skill_file(
    root: &Path,
    agent_id: &str,
    skill_id: &str,
    source: &str,
) -> Result<(), AgentMindError> {
    ensure_agent_id(agent_id)?;
    ensure_skill_id(skill_id)?;
    if source.len() > SKILL_BYTE_LIMIT {
        return Err(AgentMindError::new(
            "agent_data_too_large",
            "The agent data exceeds Kite's safe limit.",
        ));
    }
    let path = skill_path(root, agent_id, skill_id);
    prepare_file(root, &path)?;
    fs::write(&path, source).map_err(|_| {
        AgentMindError::new(
            "agent_data_failed",
            "Kite could not store this agent data.",
        )
    })?;
    let _ = sync_agent_instructions(root, agent_id);
    Ok(())
}

pub(crate) fn skill_document(skill_id: &str, source: &str, path: &Path) -> Value {
    let (summary, _) = skill_summary(skill_id, source, path);
    let mut document = summary;
    if let Some(object) = document.as_object_mut() {
        object.insert("schemaVersion".to_string(), json!(1));
        object.insert("source".to_string(), json!(source));
    }
    document
}

pub(crate) fn load_agent_skill_at(root: &Path, agent_id: &str, skill_id: &str) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    ensure_skill_id(skill_id)?;
    let path = skill_path(root, agent_id, skill_id);
    let Some(source) = read_skill_source(&path)? else {
        return Err(AgentMindError::new(
            "agent_data_unreadable",
            "That skill does not exist.",
        ));
    };
    Ok(skill_document(skill_id, &source, &path))
}

pub(crate) fn write_agent_skill_at(
    root: &Path,
    agent_id: &str,
    skill_id: &str,
    source: &str,
    expected_revision: Option<&str>,
) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    ensure_skill_id(skill_id)?;
    let path = skill_path(root, agent_id, skill_id);
    if source.trim().is_empty() {
        if let Some(existing) = read_skill_source(&path)? {
            if !existing.trim().is_empty() {
                return Err(AgentMindError::new(
                    "empty_skill_overwrite",
                    "Re-open the skill before replacing it with an empty draft.",
                ));
            }
        }
    }
    revision_matches(&path, expected_revision)?;
    store_skill_file(root, agent_id, skill_id, source)?;
    load_agent_mind_at(root, agent_id)
}

pub(crate) fn remove_agent_skill_at(
    root: &Path,
    agent_id: &str,
    skill_id: &str,
    expected_revision: &str,
) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    ensure_skill_id(skill_id)?;
    let path = skill_path(root, agent_id, skill_id);
    let Some(source) = read_skill_source(&path)? else {
        return Err(AgentMindError::new(
            "agent_data_unreadable",
            "That skill does not exist.",
        ));
    };
    if sha256_hex(source.as_bytes()) != expected_revision {
        return Err(AgentMindError::new(
            "agent_data_conflict",
            "This agent data changed. Reload it before saving again.",
        ));
    }
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(AgentMindError::new(
            "agent_data_unsafe",
            "Agent data could not be opened safely.",
        ));
    }
    fs::remove_file(&path).map_err(|_| {
        AgentMindError::new(
            "agent_data_failed",
            "Kite could not complete the agent data operation.",
        )
    })?;
    let agent_dir = root.join(agent_id);
    let mut meta = read_skills_meta(&agent_dir);
    if meta.remove(skill_id).is_some() {
        let _ = write_skills_meta(root, agent_id, &meta);
    }
    let _ = sync_agent_instructions(root, agent_id);
    let mind = load_agent_mind_at(root, agent_id)?;
    Ok(json!({
        "removed": true,
        "mind": mind,
    }))
}

pub(crate) fn set_agent_skill_enabled_at(
    root: &Path,
    agent_id: &str,
    skill_id: &str,
    enabled: bool,
) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    ensure_skill_id(skill_id)?;
    let path = skill_path(root, agent_id, skill_id);
    if read_skill_source(&path)?.is_none() {
        return Err(AgentMindError::new(
            "agent_data_unreadable",
            "That skill does not exist.",
        ));
    }
    let agent_dir = root.join(agent_id);
    let mut meta = read_skills_meta(&agent_dir);
    let entry = meta.entry(skill_id.to_string()).or_default();
    entry.enabled = enabled;
    write_skills_meta(root, agent_id, &meta)?;
    let _ = sync_agent_instructions(root, agent_id);
    load_agent_mind_at(root, agent_id)
}

pub fn record_skills_used_at(
    root: &Path,
    agent_id: &str,
    skill_ids: &[String],
    outcome: Option<&str>,
) {
    if skill_ids.is_empty() || ensure_agent_id(agent_id).is_err() {
        return;
    }
    let agent_dir = root.join(agent_id);
    if !agent_dir.exists() {
        return;
    }
    let mut meta = read_skills_meta(&agent_dir);
    let now = now_unix_ms();
    let mut changed = false;
    for skill_id in skill_ids {
        if ensure_skill_id(skill_id).is_err() {
            continue;
        }
        let entry = meta.entry(skill_id.clone()).or_default();
        if !entry.enabled {
            continue;
        }
        entry.uses = entry.uses.saturating_add(1);
        entry.last_used = Some(now);
        if let Some(out) = outcome {
            entry.last_outcome = Some(out.to_string());
        }
        changed = true;
    }
    if changed {
        let _ = write_skills_meta(root, agent_id, &meta);
    }
}

fn plain_display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    raw.strip_prefix(r"\\?\").unwrap_or(raw.as_ref()).to_string()
}

fn path_within_root(candidate_canon: &Path, root_canon: &Path) -> bool {
    if candidate_canon == root_canon || candidate_canon.starts_with(root_canon) {
        return true;
    }
    #[cfg(windows)]
    {
        let cand_lower = plain_display_path(candidate_canon).to_ascii_lowercase();
        let root_lower = plain_display_path(root_canon).to_ascii_lowercase();
        let root_trim = root_lower.trim_end_matches('\\');
        return cand_lower == root_trim || cand_lower.starts_with(&format!("{root_trim}\\"));
    }
    #[cfg(not(windows))]
    false
}

pub fn existing_global_skill_roots(home: &Path) -> Vec<PathBuf> {
    [
        home.join(".claude").join("skills"),
        home.join(".grok").join("skills"),
        home.join(".codex").join("skills"),
        home.join(".cursor").join("skills"),
        home.join(".gemini").join("antigravity-cli").join("skills"),
        home.join(".gemini").join("antigravity").join("skills"),
        home.join(".gemini").join("skills"),
        home.join(".agents").join("skills"),
        home.join(".config").join("agents").join("skills"),
        home.join(".config").join("opencode").join("skills"),
        home.join(".copilot").join("skills"),
        home.join(".kimi").join("skills"),
        home.join(".amp").join("skills"),
        home.join(".config").join("amp").join("skills"),
        home.join(".factory").join("skills"),
        home.join(".droid").join("skills"),
    ]
    .into_iter()
    .filter(|root| root.is_dir())
    .collect()
}

fn scan_skill_root(
    skills_dir: &Path,
    scope: &str,
    seen_slugs: &mut HashSet<String>,
    out: &mut Vec<Value>,
) {
    let Ok(entries) = fs::read_dir(skills_dir) else {
        return;
    };
    let Ok(root_canon) = skills_dir.canonicalize() else {
        return;
    };
    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(slug) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if slug == "kite-dispatch" || !skill_id_ok(slug) {
            continue;
        }
        if fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_dir())
            .unwrap_or(false)
        {
            dirs.push((slug.to_string(), path));
        }
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));

    for (slug, dir_path) in dirs {
        if seen_slugs.contains(&slug) {
            continue;
        }
        let skill_file = dir_path.join("SKILL.md");
        let Ok(file_canon) = skill_file.canonicalize() else {
            continue;
        };
        if !path_within_root(&file_canon, &root_canon) {
            continue;
        }
        let Ok(Some(source)) = read_skill_source(&skill_file) else {
            continue;
        };
        seen_slugs.insert(slug.clone());

        let (fm, _) = parse_skill_frontmatter(&source);
        let (eligible, missing_requirements) = check_skill_eligibility(&fm);
        let name = fm
            .name
            .filter(|n| !n.trim().is_empty() && display_ok(n, SKILL_NAME_LIMIT))
            .unwrap_or_else(|| slug.clone());
        let description = fm
            .description
            .filter(|d| display_ok(d, SKILL_DESCRIPTION_LIMIT))
            .unwrap_or_default();

        out.push(json!({
            "id": slug,
            "refKey": format!("{scope}:{slug}"),
            "name": name,
            "description": description,
            "scope": scope,
            "path": plain_display_path(&file_canon),
            "manualOnly": fm.manual_only,
            "contextMode": fm.context_mode,
            "requiresBins": fm.requires_bins,
            "requiresEnv": fm.requires_env,
            "eligible": eligible,
            "missingRequirements": missing_requirements,
        }));
    }
}

pub fn discover_available_skills_at(workspace_root: Option<&Path>, home: &Path) -> Vec<Value> {
    let mut seen_slugs = HashSet::new();
    let mut out = Vec::new();

    if let Some(ws) = workspace_root {
        let ws_agents = ws.join(".agents").join("skills");
        if ws_agents.is_dir() {
            scan_skill_root(&ws_agents, "workspace", &mut seen_slugs, &mut out);
        }
        let ws_claude = ws.join(".claude").join("skills");
        if ws_claude.is_dir() {
            scan_skill_root(&ws_claude, "workspace", &mut seen_slugs, &mut out);
        }
    }

    for global_root in existing_global_skill_roots(home) {
        scan_skill_root(&global_root, "global", &mut seen_slugs, &mut out);
    }

    out
}

fn read_contained_skill_file(
    ref_key: &str,
    id: &str,
    scope: &str,
    root: &Path,
    skill_file: &Path,
) -> Result<Option<LinkedSkillContent>, AgentMindError> {
    if !skill_file.exists() {
        return Ok(None);
    }
    let root_canon = root.canonicalize().map_err(|_| {
        AgentMindError::new("agent_data_unsafe", "Linked skill root is unavailable.")
    })?;
    let file_canon = skill_file.canonicalize().map_err(|_| {
        AgentMindError::new("agent_data_unsafe", "Linked skill path could not be resolved.")
    })?;
    if !path_within_root(&file_canon, &root_canon) {
        return Err(AgentMindError::new(
            "agent_data_unsafe",
            "Linked skill path escapes its authorized skill root.",
        ));
    }
    let Some(source) = read_skill_source(&file_canon)? else {
        return Ok(None);
    };
    let (frontmatter, body) = parse_skill_frontmatter(&source);
    Ok(Some(LinkedSkillContent {
        ref_key: ref_key.to_string(),
        id: id.to_string(),
        scope: scope.to_string(),
        path: plain_display_path(&file_canon),
        frontmatter,
        body,
        source,
    }))
}

pub(crate) fn validate_linked_skill_ref(raw: &str) -> Result<String, AgentMindError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || has_disallowed_control(trimmed) {
        return Err(AgentMindError::new(
            "agent_data_unsafe",
            "Invalid linked skill reference.",
        ));
    }
    if let Some(slug) = trimmed.strip_prefix("workspace:") {
        ensure_skill_id(slug)?;
        return Ok(trimmed.to_string());
    }
    if let Some(slug) = trimmed.strip_prefix("global:") {
        ensure_skill_id(slug)?;
        return Ok(trimmed.to_string());
    }
    if let Some(raw_path) = trimmed.strip_prefix("path:") {
        let path_str = raw_path.trim();
        let p = Path::new(path_str);
        if path_str.is_empty()
            || !p.is_absolute()
            || p.components().any(|c| matches!(c, Component::ParentDir))
        {
            return Err(AgentMindError::new(
                "agent_data_unsafe",
                "Linked skill path must be an absolute path without traversal.",
            ));
        }
        let is_markdown = p
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"));
        if !is_markdown {
            return Err(AgentMindError::new(
                "agent_data_unsafe",
                "Linked skill path must reference a markdown file.",
            ));
        }
        return Ok(format!("path:{path_str}"));
    }
    Err(AgentMindError::new(
        "agent_data_unsafe",
        "Unsupported linked skill reference prefix.",
    ))
}

pub(crate) fn read_linked_skill_content_in_roots(
    ref_key: &str,
    workspace_roots: &[PathBuf],
    home: &Path,
) -> Result<LinkedSkillContent, AgentMindError> {
    let normalized = validate_linked_skill_ref(ref_key)?;
    let trimmed = normalized.as_str();
    if let Some(slug) = trimmed.strip_prefix("workspace:") {
        ensure_skill_id(slug)?;
        if slug == "kite-dispatch" {
            return Err(AgentMindError::new(
                "skill_not_found",
                "Internal dispatch skill cannot be linked directly.",
            ));
        }
        for ws in workspace_roots {
            for rel_root in [ws.join(".agents").join("skills"), ws.join(".claude").join("skills")] {
                if !rel_root.is_dir() {
                    continue;
                }
                let candidate = rel_root.join(slug).join("SKILL.md");
                if let Some(loaded) =
                    read_contained_skill_file(trimmed, slug, "workspace", &rel_root, &candidate)?
                {
                    return Ok(loaded);
                }
            }
        }
        return Err(AgentMindError::new(
            "skill_not_found",
            "That workspace skill could not be found.",
        ));
    }

    if let Some(slug) = trimmed.strip_prefix("global:") {
        ensure_skill_id(slug)?;
        if slug == "kite-dispatch" {
            return Err(AgentMindError::new(
                "skill_not_found",
                "Internal dispatch skill cannot be linked directly.",
            ));
        }
        for global_root in existing_global_skill_roots(home) {
            let candidate = global_root.join(slug).join("SKILL.md");
            if let Some(loaded) =
                read_contained_skill_file(trimmed, slug, "global", &global_root, &candidate)?
            {
                return Ok(loaded);
            }
        }
        return Err(AgentMindError::new(
            "skill_not_found",
            "That global skill could not be found.",
        ));
    }

    if let Some(raw_path) = trimmed.strip_prefix("path:") {
        let p = Path::new(raw_path.trim());
        if raw_path.trim().is_empty()
            || !p.is_absolute()
            || p.components().any(|c| matches!(c, Component::ParentDir))
        {
            return Err(AgentMindError::new(
                "agent_data_unsafe",
                "Linked skill path must be an absolute path without traversal.",
            ));
        }
        let is_markdown = p
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"));
        if !is_markdown {
            return Err(AgentMindError::new(
                "agent_data_unsafe",
                "Linked skill path must reference a markdown file.",
            ));
        }
        let canon = p.canonicalize().map_err(|_| {
            AgentMindError::new("skill_not_found", "Linked skill file could not be found.")
        })?;
        let mut allowed_roots: Vec<PathBuf> = Vec::new();
        for ws in workspace_roots {
            if let Ok(c) = ws.canonicalize() {
                allowed_roots.push(c);
            }
        }
        for gr in existing_global_skill_roots(home) {
            if let Ok(c) = gr.canonicalize() {
                allowed_roots.push(c);
            }
        }
        if !allowed_roots
            .iter()
            .any(|root| path_within_root(&canon, root))
        {
            return Err(AgentMindError::new(
                "agent_data_unsafe",
                "Linked skill path is outside authorized skill roots.",
            ));
        }
        let Some(source) = read_skill_source(&canon)? else {
            return Err(AgentMindError::new(
                "skill_not_found",
                "Linked skill file could not be found.",
            ));
        };
        let id = canon
            .parent()
            .and_then(|parent| {
                if canon.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
                    parent.file_name().and_then(|n| n.to_str())
                } else {
                    canon.file_stem().and_then(|n| n.to_str())
                }
            })
            .filter(|s| skill_id_ok(s))
            .unwrap_or("linked-skill")
            .to_string();
        let (frontmatter, body) = parse_skill_frontmatter(&source);
        return Ok(LinkedSkillContent {
            ref_key: trimmed.to_string(),
            id,
            scope: "path".to_string(),
            path: plain_display_path(&canon),
            frontmatter,
            body,
            source,
        });
    }

    Err(AgentMindError::new(
        "agent_data_unsafe",
        "Unsupported linked skill reference prefix.",
    ))
}

pub fn read_linked_skill_content(
    ref_key: &str,
    workspace_root: Option<&Path>,
    home: &Path,
) -> Result<LinkedSkillContent, AgentMindError> {
    let roots = workspace_root
        .map(|p| vec![p.to_path_buf()])
        .unwrap_or_default();
    read_linked_skill_content_in_roots(ref_key, &roots, home)
}

fn slugify_skill_name(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
        if slug.len() >= 56 {
            break;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "captured-skill".to_string()
    } else {
        trimmed
    }
}

fn yaml_scalar(raw: &str) -> String {
    let cleaned = raw
        .replace('\r', " ")
        .replace('\n', " ")
        .trim()
        .to_string();
    if cleaned.contains(':') || cleaned.contains('#') || cleaned.contains('"') {
        format!("\"{}\"", cleaned.replace('"', "\\\""))
    } else {
        cleaned
    }
}

fn extract_message_role_and_text(msg: &Value) -> Option<(String, String)> {
    if let Some(s) = msg.as_str() {
        let trimmed = s.trim();
        return (!trimmed.is_empty()).then(|| ("Step".to_string(), trimmed.to_string()));
    }
    let role_raw = msg
        .get("role")
        .or_else(|| msg.get("kind"))
        .or_else(|| msg.get("author"))
        .and_then(Value::as_str)
        .unwrap_or("Step")
        .trim();
    let role = match role_raw.to_ascii_lowercase().as_str() {
        "user" | "human" => "Request".to_string(),
        "assistant" | "agent" | "model" => "Procedure".to_string(),
        "tool" | "command" => "Command".to_string(),
        _ if !role_raw.is_empty() => role_raw.chars().take(24).collect(),
        _ => "Step".to_string(),
    };
    let text = msg
        .get("text")
        .or_else(|| msg.get("content"))
        .or_else(|| msg.get("body"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some((role, text.to_string()))
}

pub fn capture_skill_from_chat_at(
    root: &Path,
    agent_id: &str,
    name: &str,
    description: &str,
    messages: &[Value],
    manual_only: bool,
) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    let clean_name: String = name
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(SKILL_NAME_LIMIT)
        .collect();
    if clean_name.is_empty() || !display_ok(&clean_name, SKILL_NAME_LIMIT) {
        return Err(AgentMindError::new(
            "agent_data_failed",
            "Provide a valid skill name.",
        ));
    }

    let raw_desc = description
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let clean_desc: String = if raw_desc.is_empty() {
        format!("Captured workflow for {clean_name}.")
    } else {
        raw_desc
    }
    .chars()
    .take(SKILL_DESCRIPTION_LIMIT)
    .collect();
    if !display_ok(&clean_desc, SKILL_DESCRIPTION_LIMIT) {
        return Err(AgentMindError::new(
            "agent_data_failed",
            "Skill description contains disallowed control characters.",
        ));
    }

    let base_slug = slugify_skill_name(&clean_name);
    let mut skill_id = base_slug.clone();
    let mut suffix = 2usize;
    while skill_path(root, agent_id, &skill_id).exists() {
        let prefix: String = base_slug.chars().take(52).collect();
        skill_id = format!("{prefix}-{suffix}");
        suffix += 1;
    }
    ensure_skill_id(&skill_id)?;

    let mut steps = Vec::new();
    for msg in messages.iter().take(24) {
        let Some((role, text)) = extract_message_role_and_text(msg) else {
            continue;
        };
        let bounded: String = text.replace('\r', "").chars().take(2000).collect();
        if !bounded.trim().is_empty() {
            steps.push(format!("### {role}\n{}", bounded.trim()));
        }
    }
    if steps.is_empty() {
        return Err(AgentMindError::new(
            "agent_data_failed",
            "Provide at least one non-empty chat message to capture.",
        ));
    }

    let mut frontmatter = format!(
        "---\nname: {}\ndescription: {}\n",
        yaml_scalar(&clean_name),
        yaml_scalar(&clean_desc),
    );
    if manual_only {
        frontmatter.push_str("disable-model-invocation: true\n");
    }
    frontmatter.push_str("---\n\n## Captured Workflow\n\n");

    let mut body = steps.join("\n\n");
    let max_body_bytes = SKILL_BYTE_LIMIT.saturating_sub(frontmatter.len() + 2);
    if body.len() > max_body_bytes {
        let mut truncated = String::new();
        for ch in body.chars() {
            if truncated.len() + ch.len_utf8() > max_body_bytes {
                break;
            }
            truncated.push(ch);
        }
        body = truncated.trim_end().to_string();
    }
    let source = format!("{frontmatter}{body}\n");
    store_skill_file(root, agent_id, &skill_id, &source)?;
    let mut mind = load_agent_mind_at(root, agent_id)?;
    if let Some(obj) = mind.as_object_mut() {
        obj.insert("capturedSkillId".to_string(), json!(skill_id));
    }
    Ok(mind)
}

