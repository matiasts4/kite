//! Core runtime orchestration for extensible plugins, sidecars, and loopback proxies.

pub mod catalog;
pub mod cli;
pub mod commands;
pub mod context;
pub mod hooks;
pub mod manifest;
pub mod mcp_apps;
pub mod mcp_bridge;
pub mod proxy;
pub mod registry;
pub mod scheduler;
pub mod sidecar;
pub mod types;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::logger::log_trace;
use crate::plugin_runtime::proxy::{
    global_sidecar_proxy_pool, ProxyEndpoint, SidecarProxyPool, UpstreamPortLookup,
};
use crate::plugin_runtime::registry::{
    discover_plugins, install_from_archive, install_from_folder, install_from_git,
    load_runtime_settings, save_runtime_settings, set_plugin_enabled, uninstall_plugin,
};
use crate::plugin_runtime::sidecar::{global_sidecar_supervisor, SidecarSupervisor};
use crate::plugin_runtime::types::{
    DiscoveredPlugin, PluginMcpSummaryDto, PluginMcpTransport, PluginRecordDto,
    PluginRuntimeSettings, PluginSkillSummaryDto, SidecarSpec, SidecarStateKind,
    SidecarStatusSnapshot,
};

static ACTIVE_PLUGINS: OnceLock<Mutex<Vec<DiscoveredPlugin>>> = OnceLock::new();
static ACTIVE_WORKSPACE_DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn active_plugins_lock() -> &'static Mutex<Vec<DiscoveredPlugin>> {
    ACTIVE_PLUGINS.get_or_init(|| Mutex::new(Vec::new()))
}

fn active_workspace_lock() -> &'static Mutex<Option<PathBuf>> {
    ACTIVE_WORKSPACE_DIR.get_or_init(|| Mutex::new(None))
}

pub fn current_workspace_dir() -> Option<PathBuf> {
    active_workspace_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

pub fn set_current_workspace_dir(workspace_dir: Option<&Path>) {
    if let Ok(mut guard) = active_workspace_lock().lock() {
        *guard = workspace_dir.map(Path::to_path_buf);
    }
}

pub fn cached_discovered_plugins() -> Vec<DiscoveredPlugin> {
    active_plugins_lock()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn global_upstream_port_lookup(namespaced_id: &str) -> UpstreamPortLookup {
    let key = namespaced_id.to_string();
    Arc::new(move || global_sidecar_supervisor().upstream_port(&key))
}

fn ensure_proxy_for_sidecar_on(
    spec: &SidecarSpec,
    pool: &SidecarProxyPool,
    lookup: UpstreamPortLookup,
) -> Option<ProxyEndpoint> {
    if !spec.has_web_ui || spec.builtin.is_some() {
        return None;
    }
    pool.ensure_proxy(&spec.namespaced_id, lookup).ok()
}

fn ensure_proxy_for_sidecar(spec: &SidecarSpec, view_path: Option<&str>) -> Option<ProxyEndpoint> {
    let _ = view_path;
    ensure_proxy_for_sidecar_on(
        spec,
        global_sidecar_proxy_pool(),
        global_upstream_port_lookup(&spec.namespaced_id),
    )
}

fn reconcile_proxies_with_lookup<F>(
    plugins: &[DiscoveredPlugin],
    supervisor: &SidecarSupervisor,
    pool: &SidecarProxyPool,
    make_lookup: F,
) where
    F: Fn(&str) -> UpstreamPortLookup,
{
    let mut keep_ui_ids = HashSet::new();
    for plugin in plugins {
        if !plugin.enabled {
            continue;
        }
        for spec in &plugin.sidecars {
            if !spec.has_web_ui || spec.builtin.is_some() {
                continue;
            }
            let current_state = supervisor
                .snapshot(&spec.namespaced_id)
                .map(|snap| snap.state);
            match current_state {
                Some(
                    SidecarStateKind::Starting
                    | SidecarStateKind::Running
                    | SidecarStateKind::Unhealthy,
                ) => {
                    keep_ui_ids.insert(spec.namespaced_id.clone());
                    let _ =
                        ensure_proxy_for_sidecar_on(spec, pool, make_lookup(&spec.namespaced_id));
                }
                Some(SidecarStateKind::Crashed | SidecarStateKind::Stopping)
                    if pool.get_endpoint(&spec.namespaced_id).is_some() =>
                {
                    keep_ui_ids.insert(spec.namespaced_id.clone());
                }
                _ => {}
            }
        }
    }

    // Remove proxies for disabled, uninstalled, or stopped sidecars.
    pool.retain_proxies(&keep_ui_ids);
}

fn enrich_snapshot(
    mut snap: SidecarStatusSnapshot,
    view_path_override: Option<&str>,
) -> SidecarStatusSnapshot {
    let default_view = snap
        .views
        .first()
        .map(|v| v.path.as_str())
        .filter(|p| !p.trim().is_empty())
        .unwrap_or("/");
    let effective_view = view_path_override
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or(default_view);

    if let Some(ep) = global_sidecar_proxy_pool().get_endpoint(&snap.namespaced_id) {
        snap.proxy_port = Some(ep.port);
        snap.proxy_url = Some(ep.proxy_url.clone());
        snap.entry_url = Some(ep.entry_url(effective_view));
    }
    snap
}

/// Discovers plugins for `workspace_dir` (or last known workspace), synchronizes
/// the sidecar supervisor and proxy pool, and caches the snapshot.
pub fn sync_runtime_with_workspace(workspace_dir: Option<&Path>) -> Vec<DiscoveredPlugin> {
    if let Some(ws) = workspace_dir {
        set_current_workspace_dir(Some(ws));
    }
    let resolved_ws = workspace_dir.map(Path::to_path_buf).or_else(current_workspace_dir);
    let settings = load_runtime_settings();
    let plugins = discover_plugins(resolved_ws.as_deref());

    if let Ok(mut guard) = active_plugins_lock().lock() {
        *guard = plugins.clone();
    }

    let supervisor = global_sidecar_supervisor();
    supervisor.sync_plugins(&plugins, settings.auto_start_ui_sidecars);
    crate::plugin_runtime::mcp_bridge::sync_plugin_mcp_hub(&plugins);

    reconcile_proxies_with_lookup(
        &plugins,
        supervisor,
        global_sidecar_proxy_pool(),
        global_upstream_port_lookup,
    );

    plugins
}

fn find_plugin_for_dir<'a>(
    plugins: &'a [DiscoveredPlugin],
    dir_id: &str,
) -> Option<&'a DiscoveredPlugin> {
    plugins
        .iter()
        .find(|p| p.dir_id == dir_id)
        .or_else(|| plugins.iter().find(|p| p.dir_id.eq_ignore_ascii_case(dir_id)))
}

fn to_record_dto(plugin: &DiscoveredPlugin) -> PluginRecordDto {
    let supervisor = global_sidecar_supervisor();
    let mut sidecars = Vec::with_capacity(plugin.sidecars.len());

    for spec in &plugin.sidecars {
        let raw_snap = if plugin.enabled && spec.builtin.is_none() {
            supervisor
                .snapshot(&spec.namespaced_id)
                .unwrap_or_else(|| fallback_snapshot(spec))
        } else {
            fallback_snapshot(spec)
        };
        sidecars.push(enrich_snapshot(raw_snap, None));
    }

    PluginRecordDto {
        dir_id: plugin.dir_id.clone(),
        name: plugin.name.clone(),
        display_name: plugin.display_name.clone(),
        description: plugin.description.clone(),
        version: plugin.version.clone(),
        author: plugin.author.clone(),
        homepage: plugin.homepage.clone(),
        repository: plugin.repository.clone(),
        license: plugin.license.clone(),
        keywords: plugin.keywords.clone(),
        suggested_prompts: plugin.suggested_prompts.clone(),
        logo_data_uri: plugin.logo_data_uri.clone(),
        source: plugin.source,
        format: plugin.format,
        root_path: plugin.root_path.to_string_lossy().to_string(),
        enabled: plugin.enabled,
        can_uninstall: plugin.can_uninstall,
        has_hooks: plugin.has_hooks,
        skills: plugin
            .skills
            .iter()
            .map(|s| PluginSkillSummaryDto {
                id: s.id.clone(),
                name: s.name.clone(),
                description: s.description.clone(),
            })
            .collect(),
        rule_names: plugin.rules.iter().map(|r| r.name.clone()).collect(),
        agent_slugs: plugin.agents.iter().map(|a| a.slug.clone()).collect(),
        mcp_servers: plugin
            .mcp_servers
            .iter()
            .map(|m| PluginMcpSummaryDto {
                id: m.id.clone(),
                server_name: m.server_name.clone(),
                transport: match &m.config {
                    PluginMcpTransport::Stdio { .. } => "stdio".to_string(),
                    PluginMcpTransport::Http { .. } => "http".to_string(),
                },
            })
            .collect(),
        sidecars,
    }
}

fn fallback_snapshot(spec: &SidecarSpec) -> SidecarStatusSnapshot {
    let log_path = crate::persist::roaming_app_dir()
        .join("sidecar_data")
        .join(&spec.plugin_id)
        .join(&spec.id)
        .join("logs")
        .join("sidecar.log")
        .to_string_lossy()
        .to_string();
    SidecarStatusSnapshot {
        namespaced_id: spec.namespaced_id.clone(),
        sidecar_id: spec.id.clone(),
        plugin_id: spec.plugin_id.clone(),
        plugin_name: spec.plugin_name.clone(),
        display_name: spec.display_name.clone(),
        description: spec.description.clone(),
        has_web_ui: spec.has_web_ui,
        views: spec.views.clone(),
        state: crate::plugin_runtime::types::SidecarStateKind::Stopped,
        pid: None,
        upstream_port: None,
        proxy_port: None,
        proxy_url: None,
        entry_url: None,
        log_path,
        restart_count: 0,
        last_error: None,
        started_at_ms: None,
        builtin: spec.builtin.clone(),
    }
}

pub fn plugin_records_for(workspace_dir: Option<&Path>, refresh: bool) -> Vec<PluginRecordDto> {
    let plugins = if refresh || cached_discovered_plugins().is_empty() {
        sync_runtime_with_workspace(workspace_dir)
    } else if let Some(ws) = workspace_dir {
        if current_workspace_dir().as_deref() != Some(ws) {
            sync_runtime_with_workspace(Some(ws))
        } else {
            cached_discovered_plugins()
        }
    } else {
        cached_discovered_plugins()
    };

    plugins.iter().map(to_record_dto).collect()
}

pub fn set_plugin_enabled_and_sync(
    dir_id: &str,
    enabled: bool,
    workspace_dir: Option<&Path>,
) -> Result<Vec<PluginRecordDto>, String> {
    set_plugin_enabled(dir_id, enabled)?;
    let plugins = sync_runtime_with_workspace(workspace_dir);
    Ok(plugins.iter().map(to_record_dto).collect())
}

pub fn install_folder_and_sync(
    path: &Path,
    workspace_dir: Option<&Path>,
) -> Result<PluginRecordDto, String> {
    let installed = install_from_folder(path)?;
    let plugins = sync_runtime_with_workspace(workspace_dir);
    let record = find_plugin_for_dir(&plugins, &installed.dir_id).unwrap_or(&installed);
    Ok(to_record_dto(record))
}

pub fn install_git_and_sync(
    repo_url: &str,
    git_ref: Option<&str>,
    subdir: Option<&str>,
    workspace_dir: Option<&Path>,
) -> Result<PluginRecordDto, String> {
    let installed = install_from_git(repo_url, git_ref, subdir)?;
    let plugins = sync_runtime_with_workspace(workspace_dir);
    let record = find_plugin_for_dir(&plugins, &installed.dir_id).unwrap_or(&installed);
    Ok(to_record_dto(record))
}

pub fn install_archive_and_sync(
    archive_path: &Path,
    workspace_dir: Option<&Path>,
) -> Result<PluginRecordDto, String> {
    let installed = install_from_archive(archive_path)?;
    let plugins = sync_runtime_with_workspace(workspace_dir);
    let record = find_plugin_for_dir(&plugins, &installed.dir_id).unwrap_or(&installed);
    Ok(to_record_dto(record))
}

pub fn uninstall_plugin_and_sync(
    dir_id: &str,
    workspace_dir: Option<&Path>,
) -> Result<(), String> {
    let supervisor = global_sidecar_supervisor();
    let pool = global_sidecar_proxy_pool();
    let current = cached_discovered_plugins();
    if let Some(plugin) = find_plugin_for_dir(&current, dir_id) {
        for spec in &plugin.sidecars {
            let _ = supervisor.stop_sidecar(&spec.namespaced_id);
            pool.remove_proxy(&spec.namespaced_id);
        }
    }
    let resolved_ws = workspace_dir.map(Path::to_path_buf).or_else(current_workspace_dir);
    uninstall_plugin(dir_id, resolved_ws.as_deref())?;
    let _ = sync_runtime_with_workspace(resolved_ws.as_deref());
    Ok(())
}

pub fn save_settings_and_sync(
    settings: PluginRuntimeSettings,
    workspace_dir: Option<&Path>,
) -> Result<PluginRuntimeSettings, String> {
    save_runtime_settings(&settings)?;
    let _ = sync_runtime_with_workspace(workspace_dir);
    Ok(settings)
}

fn resolve_sidecar_spec(
    namespaced_or_id: &str,
    workspace_dir: Option<&Path>,
) -> Result<SidecarSpec, String> {
    let mut plugins = cached_discovered_plugins();
    if plugins.is_empty() {
        plugins = sync_runtime_with_workspace(workspace_dir);
    }

    let trimmed = namespaced_or_id.trim();
    if trimmed.is_empty() {
        return Err("Sidecar identifier is required.".to_string());
    }

    for plugin in &plugins {
        for spec in &plugin.sidecars {
            if spec.namespaced_id.eq_ignore_ascii_case(trimmed)
                || spec.id.eq_ignore_ascii_case(trimmed)
            {
                return Ok(spec.clone());
            }
        }
    }

    // Refresh once on miss in case plugins changed on disk.
    let refreshed = sync_runtime_with_workspace(workspace_dir);
    for plugin in &refreshed {
        for spec in &plugin.sidecars {
            if spec.namespaced_id.eq_ignore_ascii_case(trimmed)
                || spec.id.eq_ignore_ascii_case(trimmed)
            {
                return Ok(spec.clone());
            }
        }
    }

    Err(format!("Sidecar '{trimmed}' was not found among active plugins."))
}

pub fn sidecar_action(
    namespaced_id: &str,
    action: &str,
    view_path: Option<&str>,
    workspace_dir: Option<&Path>,
) -> Result<SidecarStatusSnapshot, String> {
    let spec = resolve_sidecar_spec(namespaced_id, workspace_dir)?;
    if spec.builtin.is_some() {
        return Err(format!(
            "Sidecar '{}' uses a built-in scheduler and is not started interactively.",
            spec.namespaced_id
        ));
    }

    let plugins = cached_discovered_plugins();
    let plugin_enabled = plugins
        .iter()
        .find(|p| p.dir_id == spec.plugin_id)
        .map(|p| p.enabled)
        .unwrap_or(false);
    if !plugin_enabled && action != "stop" {
        return Err(format!(
            "Plugin '{}' is disabled. Enable it before starting '{}'.",
            spec.plugin_name, spec.display_name
        ));
    }

    let supervisor = global_sidecar_supervisor();
    let pool = global_sidecar_proxy_pool();

    let snap = match action.trim().to_ascii_lowercase().as_str() {
        "start" => {
            let _ = ensure_proxy_for_sidecar(&spec, view_path);
            match supervisor.start_sidecar(&spec.namespaced_id) {
                Ok(s) => s,
                Err(err) => {
                    pool.remove_proxy(&spec.namespaced_id);
                    return Err(err);
                }
            }
        }
        "stop" => {
            let s = supervisor.stop_sidecar(&spec.namespaced_id)?;
            pool.remove_proxy(&spec.namespaced_id);
            s
        }
        "restart" => {
            let _ = ensure_proxy_for_sidecar(&spec, view_path);
            match supervisor.restart_sidecar(&spec.namespaced_id) {
                Ok(s) => s,
                Err(err) => {
                    pool.remove_proxy(&spec.namespaced_id);
                    return Err(err);
                }
            }
        }
        "open" => {
            let _ = ensure_proxy_for_sidecar(&spec, view_path);
            let current = supervisor.snapshot(&spec.namespaced_id);
            match current {
                Some(s)
                    if matches!(
                        s.state,
                        crate::plugin_runtime::types::SidecarStateKind::Running
                            | crate::plugin_runtime::types::SidecarStateKind::Starting
                    ) =>
                {
                    s
                }
                _ => match supervisor.start_sidecar(&spec.namespaced_id) {
                    Ok(s) => s,
                    Err(err) => {
                        pool.remove_proxy(&spec.namespaced_id);
                        return Err(err);
                    }
                },
            }
        }
        other => {
            return Err(format!("Unknown sidecar action '{other}'."));
        }
    };

    Ok(enrich_snapshot(snap, view_path))
}

pub fn list_ui_sidecars(workspace_dir: Option<&Path>) -> Vec<SidecarStatusSnapshot> {
    let plugins = if cached_discovered_plugins().is_empty() {
        sync_runtime_with_workspace(workspace_dir)
    } else if let Some(ws) = workspace_dir {
        if current_workspace_dir().as_deref() != Some(ws) {
            sync_runtime_with_workspace(Some(ws))
        } else {
            cached_discovered_plugins()
        }
    } else {
        cached_discovered_plugins()
    };

    let supervisor = global_sidecar_supervisor();
    let mut out = Vec::new();
    for plugin in &plugins {
        if !plugin.enabled {
            continue;
        }
        for spec in &plugin.sidecars {
            if spec.has_web_ui && spec.builtin.is_none() {
                let snap = supervisor
                    .snapshot(&spec.namespaced_id)
                    .unwrap_or_else(|| fallback_snapshot(spec));
                out.push(enrich_snapshot(snap, None));
            }
        }
    }
    out
}

pub fn sidecar_logs(namespaced_id: &str, tail_lines: usize) -> Vec<String> {
    let tail = tail_lines.clamp(1, 500);
    let target = resolve_sidecar_spec(namespaced_id, None)
        .map(|s| s.namespaced_id)
        .unwrap_or_else(|_| namespaced_id.to_string());
    global_sidecar_supervisor().read_logs(&target, tail)
}

/// Initializes plugin discovery and any configured auto-started UI sidecars in a background thread.
pub fn init_plugin_runtime_background() {
    let _ = std::thread::Builder::new()
        .name("kite-plugin-runtime-init".to_string())
        .spawn(|| {
            let discovered = sync_runtime_with_workspace(None);
            log_trace(&format!(
                "[PluginRuntime] Discovered {} plugin bundle(s)",
                discovered.len()
            ));
        });
}

/// Shuts down all managed sidecars and loopback reverse proxies cleanly.
pub fn shutdown_plugin_runtime() {
    crate::plugin_runtime::mcp_bridge::sync_plugin_mcp_hub(&[]);
    global_sidecar_supervisor().shutdown_all();
    global_sidecar_proxy_pool().shutdown_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_runtime::types::SidecarStateKind;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::{Duration, Instant};

    #[test]
    fn end_to_end_supervisor_and_proxy_entry_url_serving() {
        let temp_root = std::env::temp_dir().join(format!(
            "kite-plugin-rt-e2e-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let plugin_dir = temp_root.join("plugins").join("echo-plugin");
        let sidecar_dir = plugin_dir.join("sidecars").join("echo-ui");
        fs_create_dir_all(&sidecar_dir);

        let server_js = r#"
import http from 'node:http';
const port = Number(process.env.KITE_SIDECAR_WEB_PORT || 0);
const server = http.createServer((req, res) => {
  if (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:' + port) {
    res.writeHead(403);
    res.end('forbidden origin');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Frame-Options': 'DENY' });
  res.end(JSON.stringify({ ok: true, url: req.url, envAlias: process.env.ANTIGRAVITY_SIDECAR_WEB_PORT }));
});
server.listen(port, '127.0.0.1');
setInterval(() => {}, 1000);
"#;
        std::fs::write(sidecar_dir.join("server.mjs"), server_js).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"echo-plugin","description":"Test UI plugin"}"#,
        )
        .unwrap();
        std::fs::write(
            sidecar_dir.join("sidecar.json"),
            r#"{
              "command": "node",
              "args": ["server.mjs"],
              "restart_policy": "never",
              "display_name": "Echo UI",
              "has_web_ui": true,
              "ui_config": {
                "display_name": "Echo UI",
                "views": [{ "title": "Echo UI", "path": "/", "entrypoint": "SIDECAR_UI_ENTRYPOINT_AUX_PANE" }]
              }
            }"#,
        )
        .unwrap();

        let data_root = temp_root.join("plugin_data");
        let plugin = crate::plugin_runtime::manifest::parse_plugin_bundle(
            &plugin_dir,
            &data_root,
            crate::plugin_runtime::types::PluginSourceKind::GlobalKite,
        )
        .expect("bundle parses");

        let supervisor = Arc::new(crate::plugin_runtime::sidecar::SidecarSupervisor::with_data_root(
            temp_root.join("data"),
        ));
        let pool = crate::plugin_runtime::proxy::SidecarProxyPool::new();

        supervisor.sync_plugins(&[plugin], true);
        let sup_for_lookup = Arc::clone(&supervisor);
        let ep = pool
            .ensure_proxy(
                "echo-plugin/echo-ui",
                Arc::new(move || sup_for_lookup.upstream_port("echo-plugin/echo-ui")),
            )
            .expect("proxy starts");

        let deadline = Instant::now() + Duration::from_secs(8);
        let mut became_running = false;
        while Instant::now() < deadline {
            if let Some(s) = supervisor.snapshot("echo-plugin/echo-ui") {
                if s.state == SidecarStateKind::Running {
                    became_running = true;
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        assert!(became_running, "sidecar should reach Running state");

        let entry = ep.entry_url("/");
        assert!(entry.contains("__kite_token="));

        // 1) Request with query token receives 302 + Set-Cookie.
        let mut conn = TcpStream::connect(("127.0.0.1", ep.port)).unwrap();
        let req_path = entry
            .strip_prefix(&format!("http://127.0.0.1:{}", ep.port))
            .unwrap();
        let req1 = format!(
            "GET {req_path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://tauri.localhost\r\nConnection: close\r\n\r\n",
            ep.port
        );
        conn.write_all(req1.as_bytes()).unwrap();
        let mut resp1 = String::new();
        conn.read_to_string(&mut resp1).unwrap();
        assert!(resp1.starts_with("HTTP/1.1 302"), "got: {resp1}");
        assert!(
            resp1.contains(&format!(
                "Set-Cookie: kite_sidecar_auth={}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/",
                ep.token
            )),
            "expected cross-site iframe auth cookie in: {resp1}"
        );

        // 2) Authenticated request with cookie gets 200 OK with X-Frame-Options stripped and Origin rewritten.
        let mut conn2 = TcpStream::connect(("127.0.0.1", ep.port)).unwrap();
        let req2 = format!(
            "GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://tauri.localhost\r\nCookie: kite_sidecar_auth={}\r\nConnection: close\r\n\r\n",
            ep.port, ep.token
        );
        conn2.write_all(req2.as_bytes()).unwrap();
        let mut resp2 = String::new();
        conn2.read_to_string(&mut resp2).unwrap();
        assert!(resp2.starts_with("HTTP/1.1 200"), "got: {resp2}");
        assert!(!resp2.to_ascii_lowercase().contains("x-frame-options"));
        assert!(resp2.contains(r#""ok":true"#), "body: {resp2}");

        supervisor.shutdown_all();
        pool.shutdown_all();
        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    #[ignore = "Requires host shared android-cli-plugin installation"]
    fn live_android_cli_device_hub_proxy_smoke() {
        let app_dir = crate::persist::roaming_app_dir();
        let home = std::env::var("USERPROFILE").map(PathBuf::from).ok();
        let settings = PluginRuntimeSettings {
            enable_shared_system_roots: true,
            extra_plugin_dirs: Vec::new(),
            auto_start_ui_sidecars: false,
        };
        let plugins = crate::plugin_runtime::registry::discover_plugins_at(
            &app_dir,
            home.as_deref(),
            None,
            &settings,
        );
        let android = plugins
            .iter()
            .find(|p| p.dir_id == "android-cli-plugin")
            .expect("android-cli-plugin discovered on host");
        assert!(
            android.sidecars.iter().any(|s| s.id == "device-hub"),
            "device-hub sidecar should be parsed"
        );

        let supervisor = Arc::new(crate::plugin_runtime::sidecar::SidecarSupervisor::new());
        let pool = crate::plugin_runtime::proxy::SidecarProxyPool::new();
        supervisor.sync_plugins(&plugins, false);

        let sup_ref = Arc::clone(&supervisor);
        let ep = pool
            .ensure_proxy(
                "android-cli-plugin/device-hub",
                Arc::new(move || sup_ref.upstream_port("android-cli-plugin/device-hub")),
            )
            .expect("proxy bound");
        let started = supervisor
            .start_sidecar("android-cli-plugin/device-hub")
            .expect("device-hub started");
        assert!(started.upstream_port.is_some());

        let deadline = Instant::now() + Duration::from_secs(12);
        let mut resp_body = String::new();
        while Instant::now() < deadline {
            if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", ep.port)) {
                let req = format!(
                    "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://tauri.localhost\r\nCookie: kite_sidecar_auth={}\r\nConnection: close\r\n\r\n",
                    ep.port, ep.token
                );
                if stream.write_all(req.as_bytes()).is_ok() {
                    let mut buf = String::new();
                    let _ = stream.read_to_string(&mut buf);
                    if buf.starts_with("HTTP/1.1 200") {
                        resp_body = buf;
                        break;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }

        assert!(
            resp_body.starts_with("HTTP/1.1 200"),
            "Expected 200 OK from android device-hub through proxy; logs: {:?}",
            supervisor.read_logs("android-cli-plugin/device-hub", 40)
        );
        assert!(!resp_body.to_ascii_lowercase().contains("x-frame-options"));

        supervisor.shutdown_all();
        pool.shutdown_all();
    }

    #[test]
    fn default_settings_do_not_auto_start_ui_sidecars() {
        let defaults = PluginRuntimeSettings::default();
        assert!(defaults.enable_shared_system_roots);
        assert!(!defaults.auto_start_ui_sidecars);

        let parsed: PluginRuntimeSettings =
            serde_json::from_str("{}").expect("empty JSON deserializes with defaults");
        assert!(parsed.enable_shared_system_roots);
        assert!(!parsed.auto_start_ui_sidecars);
    }

    #[test]
    fn stopped_ui_sidecars_do_not_bind_loopback_proxies_until_started() {
        let temp_root = std::env::temp_dir().join(format!(
            "kite-plugin-lazy-proxy-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let plugin_dir = temp_root.join("plugins").join("echo-plugin");
        let sidecar_dir = plugin_dir.join("sidecars").join("echo-ui");
        fs_create_dir_all(&sidecar_dir);

        let server_js = r#"
import http from 'node:http';
const port = Number(process.env.KITE_SIDECAR_WEB_PORT || 0);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
});
server.listen(port, '127.0.0.1');
setInterval(() => {}, 1000);
"#;
        std::fs::write(sidecar_dir.join("server.mjs"), server_js).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"echo-plugin","description":"Lazy UI plugin"}"#,
        )
        .unwrap();
        std::fs::write(
            sidecar_dir.join("sidecar.json"),
            r#"{
              "command": "node",
              "args": ["server.mjs"],
              "restart_policy": "never",
              "display_name": "Echo UI",
              "has_web_ui": true,
              "ui_config": {
                "display_name": "Echo UI",
                "views": [{ "title": "Echo UI", "path": "/", "entrypoint": "SIDECAR_UI_ENTRYPOINT_AUX_PANE" }]
              }
            }"#,
        )
        .unwrap();

        let plugin = crate::plugin_runtime::manifest::parse_plugin_bundle(
            &plugin_dir,
            &temp_root.join("plugin_data"),
            crate::plugin_runtime::types::PluginSourceKind::GlobalKite,
        )
        .expect("bundle parses");
        let plugins = vec![plugin];

        let supervisor = Arc::new(
            crate::plugin_runtime::sidecar::SidecarSupervisor::with_data_root(
                temp_root.join("data"),
            ),
        );
        let pool = crate::plugin_runtime::proxy::SidecarProxyPool::new();
        let make_lookup = |id: &str| {
            let sup = Arc::clone(&supervisor);
            let key = id.to_string();
            Arc::new(move || sup.upstream_port(&key)) as UpstreamPortLookup
        };

        // When auto_start_ui_sidecars is false, syncing plugins keeps sidecar stopped and binds no proxy.
        supervisor.sync_plugins(&plugins, false);
        reconcile_proxies_with_lookup(&plugins, &supervisor, &pool, &make_lookup);
        assert!(pool.get_endpoint("echo-plugin/echo-ui").is_none());

        // Starting the sidecar and reconciling binds its proxy lazily.
        supervisor
            .start_sidecar("echo-plugin/echo-ui")
            .expect("sidecar starts");
        reconcile_proxies_with_lookup(&plugins, &supervisor, &pool, &make_lookup);
        assert!(pool.get_endpoint("echo-plugin/echo-ui").is_some());

        // Stopping the sidecar and reconciling tears down its loopback proxy.
        supervisor
            .stop_sidecar("echo-plugin/echo-ui")
            .expect("sidecar stops");
        reconcile_proxies_with_lookup(&plugins, &supervisor, &pool, &make_lookup);
        assert!(pool.get_endpoint("echo-plugin/echo-ui").is_none());

        supervisor.shutdown_all();
        pool.shutdown_all();
        let _ = std::fs::remove_dir_all(&temp_root);
    }

    fn fs_create_dir_all(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
    }
}
