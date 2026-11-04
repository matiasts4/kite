//! Role files. Header is `command` plus optional `description`. The body is the brief.

use std::fs;
use std::path::{Path, PathBuf};

use super::address::is_alias_name;
use super::types::DispatchError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleFile {
    pub command: String,
    pub description: Option<String>,
    pub body: String,
}

pub const SAMPLE_ROLE_NAME: &str = "reviewer";

pub const SAMPLE_ROLE: &str = "\
command: codex
description: Review a task and report findings.

Review the task. Report defects, risks, and a recommendation.
Do not take irreversible actions. Those wait for the person.
";

pub fn parse_role(text: &str) -> Result<RoleFile, DispatchError> {
    let (header, body) = match text.find("\n\n") {
        Some(idx) => (&text[..idx], text[idx + 2..].trim()),
        None => (text.trim(), ""),
    };
    let mut command: Option<String> = None;
    let mut description: Option<String> = None;
    for line in header.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "command" => command = Some(value.trim().to_string()),
            "description" => {
                let value = value.trim();
                if !value.is_empty() {
                    description = Some(value.to_string());
                }
            }
            _ => {}
        }
    }
    let command = command.filter(|c| !c.is_empty()).ok_or(DispatchError::RoleNotFound)?;
    Ok(RoleFile {
        command,
        description,
        body: body.to_string(),
    })
}

pub fn roles_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("dispatch").join("roles")
}

fn write_sample(dir: &Path, name: &str) -> Result<PathBuf, DispatchError> {
    let path = dir.join(format!("{name}.md"));
    if !path.exists() {
        fs::write(&path, SAMPLE_ROLE).map_err(|_| DispatchError::RoleNotFound)?;
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

pub fn load_role(config_dir: &Path, name: &str) -> Result<RoleFile, DispatchError> {
    if !is_alias_name(name) {
        return Err(DispatchError::RoleNotFound);
    }
    let path = roles_dir(config_dir).join(format!("{name}.md"));
    let text = fs::read_to_string(&path).map_err(|_| DispatchError::RoleNotFound)?;
    parse_role(&text)
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
        assert_eq!(loaded.command, "codex");
        let _ = fs::remove_dir_all(&dir);
    }
}
