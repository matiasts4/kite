//! Console CLI command handler for `kite plugin <subcommand>`.

use crate::persist::roaming_app_dir;
use crate::plugin_runtime::registry::{
    discover_plugins, install_from_archive, install_from_folder, install_from_git,
    set_plugin_enabled, uninstall_plugin,
};
use crate::plugin_runtime::types::DiscoveredPlugin;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

fn print_usage() {
    println!(
        "\
Usage: kite plugin <subcommand> [options]

Subcommands:
  list [--workspace <path>] [--json]                 Discover installed and shared plugin bundles
  install <folder|git-url|zip> [--ref <r>] [--subdir <s>]
                                                     Install a plugin bundle into Kite
  enable <dir-id>                                    Enable a discovered plugin
  disable <dir-id>                                   Disable a discovered plugin
  uninstall <dir-id> [--workspace <path>]            Uninstall a Kite-managed plugin bundle
  sidecars [--workspace <path>] [--json]             List sidecars declared by discovered plugins
  logs <plugin/sidecar> [--tail <n>]                 Print recent sidecar log lines"
    );
}

fn looks_like_git_url(source: &str) -> bool {
    let lower = source.trim().to_ascii_lowercase();
    lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("ssh://")
        || lower.starts_with("git@")
        || lower.ends_with(".git")
}

fn looks_like_archive(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
}

fn read_sidecar_log_tail(namespaced_id: &str, tail: usize) -> Result<Vec<String>, String> {
    let Some((plugin_id, sidecar_id)) = namespaced_id.split_once('/') else {
        return Err(format!(
            "Invalid sidecar ID '{namespaced_id}'. Expected '<plugin-dir>/<sidecar-id>'."
        ));
    };
    let log_path = roaming_app_dir()
        .join("sidecar_data")
        .join(plugin_id)
        .join(sidecar_id)
        .join("logs")
        .join("sidecar.log");
    if !log_path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&log_path)
        .map_err(|e| format!("Failed reading {}: {e}", log_path.display()))?;
    let lines: Vec<String> = raw.lines().map(str::to_string).collect();
    let skip = lines.len().saturating_sub(tail);
    Ok(lines.into_iter().skip(skip).collect())
}

fn format_plugin_line(p: &DiscoveredPlugin) -> String {
    let status = if p.enabled { "enabled" } else { "disabled" };
    let source = match p.source {
        crate::plugin_runtime::types::PluginSourceKind::Workspace => "workspace",
        crate::plugin_runtime::types::PluginSourceKind::GlobalKite => "kite",
        crate::plugin_runtime::types::PluginSourceKind::SharedSystem => "shared",
    };
    format!(
        "{} ({}) [{} | {}] sidecars={} mcp={} skills={} rules={}",
        p.dir_id,
        p.display_name,
        status,
        source,
        p.sidecars.len(),
        p.mcp_servers.len(),
        p.skills.len(),
        p.rules.len()
    )
}

pub fn run_plugin_cli(args: &[String]) -> i32 {
    let Some(sub) = args.first().map(String::as_str) else {
        print_usage();
        return 2;
    };

    if matches!(sub, "-h" | "--help" | "help") {
        print_usage();
        return 0;
    }

    match sub {
        "list" => cmd_list(&args[1..]),
        "install" => cmd_install(&args[1..]),
        "enable" => cmd_toggle(&args[1..], true),
        "disable" => cmd_toggle(&args[1..], false),
        "uninstall" => cmd_uninstall(&args[1..]),
        "sidecars" => cmd_sidecars(&args[1..]),
        "logs" => cmd_logs(&args[1..]),
        other => {
            eprintln!("Unknown plugin subcommand: '{other}'");
            print_usage();
            2
        }
    }
}

fn extract_workspace_and_json(args: &[String]) -> (Option<PathBuf>, bool) {
    let mut workspace: Option<PathBuf> = None;
    let mut as_json = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--workspace" | "-w" if i + 1 < args.len() => {
                workspace = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--json" => {
                as_json = true;
                i += 1;
            }
            _ => i += 1,
        }
    }
    (workspace, as_json)
}

fn cmd_list(args: &[String]) -> i32 {
    let (workspace, as_json) = extract_workspace_and_json(args);
    let plugins = discover_plugins(workspace.as_deref());
    if as_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&plugins).unwrap_or_else(|_| "[]".to_string())
        );
    } else if plugins.is_empty() {
        println!("No plugin bundles discovered.");
    } else {
        for p in &plugins {
            println!("{}", format_plugin_line(p));
        }
    }
    0
}

fn cmd_install(args: &[String]) -> i32 {
    let mut source: Option<String> = None;
    let mut git_ref: Option<String> = None;
    let mut subdir: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--ref" if i + 1 < args.len() => {
                git_ref = Some(args[i + 1].clone());
                i += 2;
            }
            "--subdir" if i + 1 < args.len() => {
                subdir = Some(args[i + 1].clone());
                i += 2;
            }
            val if !val.starts_with('-') && source.is_none() => {
                source = Some(val.to_string());
                i += 1;
            }
            other => {
                eprintln!("Unexpected argument: '{other}'");
                return 2;
            }
        }
    }

    let Some(src) = source else {
        eprintln!("Usage: kite plugin install <folder|git-url|zip> [--ref <r>] [--subdir <s>]");
        return 2;
    };

    let result = if looks_like_git_url(&src) {
        install_from_git(&src, git_ref.as_deref(), subdir.as_deref())
    } else {
        let p = PathBuf::from(&src);
        if p.is_file() && looks_like_archive(&p) {
            install_from_archive(&p)
        } else {
            install_from_folder(&p)
        }
    };

    match result {
        Ok(installed) => {
            println!("Installed plugin '{}' ({})", installed.dir_id, installed.root_path.display());
            0
        }
        Err(err) => {
            eprintln!("Install failed: {err}");
            1
        }
    }
}

fn cmd_toggle(args: &[String], enabled: bool) -> i32 {
    let Some(dir_id) = args.first().map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        eprintln!(
            "Usage: kite plugin {} <dir-id>",
            if enabled { "enable" } else { "disable" }
        );
        return 2;
    };
    match set_plugin_enabled(dir_id, enabled) {
        Ok(()) => {
            println!(
                "Plugin '{}' is now {}.",
                dir_id,
                if enabled { "enabled" } else { "disabled" }
            );
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn cmd_uninstall(args: &[String]) -> i32 {
    let mut dir_id: Option<String> = None;
    let (workspace, _) = extract_workspace_and_json(args);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--workspace" | "-w" if i + 1 < args.len() => i += 2,
            val if !val.starts_with('-') && dir_id.is_none() => {
                dir_id = Some(val.to_string());
                i += 1;
            }
            _ => i += 1,
        }
    }
    let Some(id) = dir_id else {
        eprintln!("Usage: kite plugin uninstall <dir-id> [--workspace <path>]");
        return 2;
    };
    match uninstall_plugin(&id, workspace.as_deref()) {
        Ok(()) => {
            println!("Uninstalled plugin '{id}'.");
            0
        }
        Err(err) => {
            eprintln!("Uninstall failed: {err}");
            1
        }
    }
}

fn cmd_sidecars(args: &[String]) -> i32 {
    let (workspace, as_json) = extract_workspace_and_json(args);
    let plugins = discover_plugins(workspace.as_deref());
    let mut rows = Vec::new();
    for p in plugins {
        for s in p.sidecars {
            let log_path = roaming_app_dir()
                .join("sidecar_data")
                .join(&s.plugin_id)
                .join(&s.id)
                .join("logs")
                .join("sidecar.log");
            rows.push(json!({
                "namespacedId": s.namespaced_id,
                "pluginEnabled": p.enabled,
                "displayName": s.display_name,
                "hasWebUi": s.has_web_ui,
                "builtin": s.builtin,
                "logPath": log_path.to_string_lossy().to_string(),
            }));
        }
    }
    if as_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".to_string())
        );
    } else if rows.is_empty() {
        println!("No plugin sidecars declared.");
    } else {
        for r in &rows {
            println!(
                "{} (enabled={}, webUi={}) -> {}",
                r["namespacedId"].as_str().unwrap_or(""),
                r["pluginEnabled"].as_bool().unwrap_or(false),
                r["hasWebUi"].as_bool().unwrap_or(false),
                r["logPath"].as_str().unwrap_or("")
            );
        }
    }
    0
}

fn cmd_logs(args: &[String]) -> i32 {
    let mut target: Option<String> = None;
    let mut tail = 200usize;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--tail" if i + 1 < args.len() => {
                tail = args[i + 1].parse::<usize>().unwrap_or(200).clamp(1, 2000);
                i += 2;
            }
            val if !val.starts_with('-') && target.is_none() => {
                target = Some(val.to_string());
                i += 1;
            }
            _ => i += 1,
        }
    }
    let Some(id) = target else {
        eprintln!("Usage: kite plugin logs <plugin/sidecar> [--tail <n>]");
        return 2;
    };
    match read_sidecar_log_tail(&id, tail) {
        Ok(lines) => {
            if lines.is_empty() {
                println!("No logs found for '{id}'.");
            } else {
                for line in lines {
                    println!("{line}");
                }
            }
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_help_and_unknown_subcommand_exit_codes() {
        assert_eq!(run_plugin_cli(&["--help".to_string()]), 0);
        assert_eq!(run_plugin_cli(&[]), 2);
        assert_eq!(run_plugin_cli(&["unknown-op".to_string()]), 2);
    }

    #[test]
    fn classifies_git_and_archive_sources() {
        assert!(looks_like_git_url("https://github.com/example/plugin.git"));
        assert!(looks_like_git_url("git@github.com:example/plugin.git"));
        assert!(!looks_like_git_url("C:\\plugins\\my-plugin"));
        assert!(looks_like_archive(Path::new("bundle.ZIP")));
        assert!(!looks_like_archive(Path::new("bundle")));
    }
}
