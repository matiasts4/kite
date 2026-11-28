//! Dynamic MCP bridge synchronizing discovered plugin MCP servers with Kite's
//! Shared Stdio MCP Hub and exposing active stdio/HTTP endpoints to agents and UI.

use crate::dispatch::mcp_hub::{register_pooled_server, unregister_pooled_server, SharedStdioMcpHub};
use crate::plugin_runtime::types::{DiscoveredPlugin, PluginMcpTransport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpMcpEntry {
    pub id: String,
    pub plugin_id: String,
    pub server_name: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SyncedStdioServer {
    id: String,
    plugin_id: String,
    plugin_name: String,
    plugin_label: String,
    server_name: String,
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    source_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SyncedHttpServer {
    entry: PluginHttpMcpEntry,
    plugin_name: String,
    plugin_label: String,
    source_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SyncedCatalogEntry {
    Stdio(SyncedStdioServer),
    Http(SyncedHttpServer),
}

#[derive(Default)]
struct BridgeRegistryState {
    registered_stdio_ids: HashSet<String>,
    catalog: Vec<SyncedCatalogEntry>,
    http_servers: Vec<PluginHttpMcpEntry>,
}

/// Thread-safe registry reconciling plugin MCP server declarations with the
/// shared stdio pool and active HTTP MCP server catalog.
pub struct PluginMcpBridge {
    sync_lock: Mutex<()>,
    state: Mutex<BridgeRegistryState>,
}

impl Default for PluginMcpBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginMcpBridge {
    pub fn new() -> Self {
        Self {
            sync_lock: Mutex::new(()),
            state: Mutex::new(BridgeRegistryState::default()),
        }
    }

    pub fn sync_with_hub(&self, plugins: &[DiscoveredPlugin], hub: &SharedStdioMcpHub) {
        self.sync_with_ops(
            plugins,
            |name, command, args, env| hub.register_server(name, command, args, env),
            |name| {
                let _ = hub.unregister_server(name);
            },
        );
    }

    fn sync_with_ops<R, U>(&self, plugins: &[DiscoveredPlugin], mut register: R, mut unregister: U)
    where
        R: FnMut(&str, &str, &[String], &[(String, String)]),
        U: FnMut(&str),
    {
        let _sync_guard = self.sync_lock.lock().unwrap_or_else(|p| p.into_inner());

        let mut next_stdio_ids = HashSet::new();
        let mut seen_catalog_ids = HashSet::new();
        let mut desired_stdio = Vec::new();
        let mut desired_http = Vec::new();
        let mut desired_catalog = Vec::new();

        for plugin in plugins {
            if !plugin.enabled {
                continue;
            }
            let plugin_label = if !plugin.display_name.trim().is_empty() {
                plugin.display_name.trim().to_string()
            } else if !plugin.name.trim().is_empty() {
                plugin.name.trim().to_string()
            } else {
                plugin.dir_id.trim().to_string()
            };
            let source_path = plugin.root_path.to_string_lossy().to_string();

            for srv in &plugin.mcp_servers {
                let server_name = srv.server_name.trim().to_string();
                let plugin_id = if srv.plugin_id.trim().is_empty() {
                    plugin.dir_id.trim().to_string()
                } else {
                    srv.plugin_id.trim().to_string()
                };
                let id = {
                    let raw = srv.id.trim();
                    if raw.is_empty() {
                        format!("{plugin_id}_{server_name}")
                    } else {
                        raw.to_string()
                    }
                };
                if server_name.is_empty() || id.is_empty() || !seen_catalog_ids.insert(id.clone()) {
                    continue;
                }

                match &srv.config {
                    PluginMcpTransport::Stdio { command, args, env } => {
                        let clean_cmd = command.trim();
                        if clean_cmd.is_empty() {
                            seen_catalog_ids.remove(&id);
                            continue;
                        }
                        let env_vec: Vec<(String, String)> =
                            env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                        let entry = SyncedStdioServer {
                            id: id.clone(),
                            plugin_id,
                            plugin_name: plugin.name.clone(),
                            plugin_label: plugin_label.clone(),
                            server_name,
                            command: clean_cmd.to_string(),
                            args: args.clone(),
                            env: env_vec,
                            source_path: source_path.clone(),
                        };
                        next_stdio_ids.insert(id);
                        desired_stdio.push(entry.clone());
                        desired_catalog.push(SyncedCatalogEntry::Stdio(entry));
                    }
                    PluginMcpTransport::Http { url, headers } => {
                        let clean_url = url.trim();
                        if clean_url.is_empty() {
                            seen_catalog_ids.remove(&id);
                            continue;
                        }
                        let http_entry = PluginHttpMcpEntry {
                            id,
                            plugin_id,
                            server_name,
                            url: clean_url.to_string(),
                            headers: headers.clone(),
                        };
                        desired_http.push(http_entry.clone());
                        desired_catalog.push(SyncedCatalogEntry::Http(SyncedHttpServer {
                            entry: http_entry,
                            plugin_name: plugin.name.clone(),
                            plugin_label: plugin_label.clone(),
                            source_path: source_path.clone(),
                        }));
                    }
                }
            }
        }

        let prev_stdio_ids = {
            let guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
            guard.registered_stdio_ids.clone()
        };

        let mut stale_ids: Vec<String> = prev_stdio_ids
            .difference(&next_stdio_ids)
            .cloned()
            .collect();
        stale_ids.sort();
        for stale_id in &stale_ids {
            unregister(stale_id);
        }

        for stdio in &desired_stdio {
            register(&stdio.id, &stdio.command, &stdio.args, &stdio.env);
        }

        let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        guard.registered_stdio_ids = next_stdio_ids;
        guard.catalog = desired_catalog;
        guard.http_servers = desired_http;
    }

    pub fn list_active_servers(&self, disabled_plugin_ids: &[String]) -> Vec<Value> {
        let guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut out = Vec::new();
        for item in &guard.catalog {
            match item {
                SyncedCatalogEntry::Stdio(srv) => {
                    if is_server_disabled(
                        disabled_plugin_ids,
                        &srv.id,
                        &srv.plugin_id,
                        &srv.plugin_name,
                    ) {
                        continue;
                    }
                    out.push(json!({
                        "id": srv.id,
                        "name": srv.server_name,
                        "provider": "kite",
                        "providerLabel": "Extension",
                        "transport": "stdio",
                        "status": "configured",
                        "enabled": true,
                        "builtin": false,
                        "pluginId": srv.plugin_id,
                        "description": format!("Extension '{}' stdio MCP server ({})", srv.plugin_label, srv.command),
                        "toolCount": 0,
                        "tools": [],
                        "sourcePath": srv.source_path,
                    }));
                }
                SyncedCatalogEntry::Http(srv) => {
                    if is_server_disabled(
                        disabled_plugin_ids,
                        &srv.entry.id,
                        &srv.entry.plugin_id,
                        &srv.plugin_name,
                    ) {
                        continue;
                    }
                    out.push(json!({
                        "id": srv.entry.id,
                        "name": srv.entry.server_name,
                        "provider": "kite",
                        "providerLabel": "Extension",
                        "transport": "http",
                        "status": "configured",
                        "enabled": true,
                        "builtin": false,
                        "pluginId": srv.entry.plugin_id,
                        "description": format!("Extension '{}' HTTP MCP server ({})", srv.plugin_label, srv.entry.url),
                        "toolCount": 0,
                        "tools": [],
                        "sourcePath": srv.source_path,
                    }));
                }
            }
        }
        out
    }

    pub fn http_servers_for(&self, disabled_plugin_ids: &[String]) -> Vec<PluginHttpMcpEntry> {
        let guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        guard
            .catalog
            .iter()
            .filter_map(|item| match item {
                SyncedCatalogEntry::Http(srv)
                    if !is_server_disabled(
                        disabled_plugin_ids,
                        &srv.entry.id,
                        &srv.entry.plugin_id,
                        &srv.plugin_name,
                    ) =>
                {
                    Some(srv.entry.clone())
                }
                _ => None,
            })
            .collect()
    }
}

fn is_server_disabled(
    disabled_plugin_ids: &[String],
    server_id: &str,
    plugin_id: &str,
    plugin_name: &str,
) -> bool {
    crate::plugins::is_plugin_disabled(disabled_plugin_ids, plugin_id)
        || (!plugin_name.trim().is_empty()
            && crate::plugins::is_plugin_disabled(disabled_plugin_ids, plugin_name))
        || crate::plugins::is_plugin_disabled(disabled_plugin_ids, server_id)
}

static GLOBAL_PLUGIN_MCP_BRIDGE: OnceLock<PluginMcpBridge> = OnceLock::new();

pub fn global_plugin_mcp_bridge() -> &'static PluginMcpBridge {
    GLOBAL_PLUGIN_MCP_BRIDGE.get_or_init(PluginMcpBridge::new)
}

/// Reconciles active enabled plugin Stdio servers with `SharedStdioMcpHub` and
/// updates the active HTTP MCP server list.
pub fn sync_plugin_mcp_hub(plugins: &[DiscoveredPlugin]) {
    global_plugin_mcp_bridge().sync_with_ops(
        plugins,
        register_pooled_server,
        |name| {
            let _ = unregister_pooled_server(name);
        },
    );
}

/// Lists active plugin MCP servers in `list_provider_mcp_servers_with_home` shape,
/// excluding any plugin disabled in `disabled_plugin_ids`.
pub fn list_active_plugin_mcp_servers(disabled_plugin_ids: &[String]) -> Vec<Value> {
    global_plugin_mcp_bridge().list_active_servers(disabled_plugin_ids)
}

/// Returns active HTTP MCP endpoints for enabled plugins not excluded by `disabled_plugin_ids`.
pub fn http_mcp_servers_for(disabled_plugin_ids: &[String]) -> Vec<PluginHttpMcpEntry> {
    global_plugin_mcp_bridge().http_servers_for(disabled_plugin_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::mcp_hub::test_support::{make_mock_spawner, MockUpstreamMetrics};
    use crate::plugin_runtime::types::{
        PluginManifestFormat, PluginMcpServer, PluginSourceKind,
    };
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::Duration;

    static GLOBAL_BRIDGE_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct GlobalBridgeResetGuard;
    impl Drop for GlobalBridgeResetGuard {
        fn drop(&mut self) {
            sync_plugin_mcp_hub(&[]);
        }
    }

    fn make_plugin(
        dir_id: &str,
        name: &str,
        enabled: bool,
        mcp_servers: Vec<PluginMcpServer>,
    ) -> DiscoveredPlugin {
        DiscoveredPlugin {
            dir_id: dir_id.to_string(),
            name: name.to_string(),
            display_name: name.to_string(),
            description: format!("{name} description"),
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
            mcp_servers,
            skills: Vec::new(),
            rules: Vec::new(),
            agents: Vec::new(),
        }
    }

    fn stdio_server(plugin_id: &str, name: &str, cmd: &str) -> PluginMcpServer {
        PluginMcpServer {
            id: format!("{plugin_id}_{name}"),
            server_name: name.to_string(),
            plugin_id: plugin_id.to_string(),
            config: PluginMcpTransport::Stdio {
                command: cmd.to_string(),
                args: vec!["--stdio".to_string()],
                env: BTreeMap::from([("TOKEN".to_string(), "abc".to_string())]),
            },
        }
    }

    fn http_server(plugin_id: &str, name: &str, url: &str) -> PluginMcpServer {
        PluginMcpServer {
            id: format!("{plugin_id}_{name}"),
            server_name: name.to_string(),
            plugin_id: plugin_id.to_string(),
            config: PluginMcpTransport::Http {
                url: url.to_string(),
                headers: BTreeMap::from([("Authorization".to_string(), "Bearer tok".to_string())]),
            },
        }
    }

    #[test]
    fn syncs_stdio_servers_with_hub_and_unregisters_disabled_or_removed() {
        let metrics = Arc::new(MockUpstreamMetrics::default());
        let hub = SharedStdioMcpHub::with_spawner(make_mock_spawner(Arc::clone(&metrics), 0));
        let bridge = PluginMcpBridge::new();

        let plugins_v1 = vec![
            make_plugin(
                "alpha",
                "Alpha",
                true,
                vec![
                    stdio_server("alpha", "tools", "alpha-bin"),
                    http_server("alpha", "remote", "http://127.0.0.1:9001/mcp"),
                ],
            ),
            make_plugin(
                "beta",
                "Beta",
                false,
                vec![stdio_server("beta", "hidden", "beta-bin")],
            ),
        ];

        bridge.sync_with_hub(&plugins_v1, &hub);
        assert!(hub.has_registered_server("alpha_tools"));
        assert!(!hub.has_registered_server("beta_hidden"));
        assert_eq!(hub.registered_server_count(), 1);

        // Spawn upstream to verify unregister cleanly shuts down live child.
        let resp = hub
            .forward_jsonrpc_blocking(
                "alpha_tools",
                "c1",
                &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
                Duration::from_secs(5),
            )
            .unwrap()
            .unwrap();
        assert_eq!(resp["id"], 1);
        assert_eq!(hub.active_upstream_count(), 1);

        let listed = bridge.list_active_servers(&[]);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0]["id"], "alpha_tools");
        assert_eq!(listed[0]["name"], "tools");
        assert_eq!(listed[0]["provider"], "kite");
        assert_eq!(listed[0]["providerLabel"], "Extension");
        assert_eq!(listed[0]["transport"], "stdio");
        assert_eq!(listed[0]["status"], "configured");
        assert_eq!(listed[0]["builtin"], false);
        assert_eq!(listed[0]["pluginId"], "alpha");
        assert_eq!(listed[1]["id"], "alpha_remote");
        assert_eq!(listed[1]["transport"], "http");

        // Disable alpha and enable beta -> alpha_tools is unregistered + shut down, beta_hidden registered.
        let plugins_v2 = vec![
            make_plugin(
                "alpha",
                "Alpha",
                false,
                vec![
                    stdio_server("alpha", "tools", "alpha-bin"),
                    http_server("alpha", "remote", "http://127.0.0.1:9001/mcp"),
                ],
            ),
            make_plugin(
                "beta",
                "Beta",
                true,
                vec![stdio_server("beta", "hidden", "beta-bin")],
            ),
        ];

        bridge.sync_with_hub(&plugins_v2, &hub);
        assert!(!hub.has_registered_server("alpha_tools"));
        assert!(hub.has_registered_server("beta_hidden"));
        assert_eq!(hub.active_upstream_count(), 0);
        assert_eq!(metrics.shutdown_count.load(Ordering::SeqCst), 1);
        assert!(bridge.http_servers_for(&[]).is_empty());

        let listed_v2 = bridge.list_active_servers(&[]);
        assert_eq!(listed_v2.len(), 1);
        assert_eq!(listed_v2[0]["id"], "beta_hidden");
    }

    #[test]
    fn disabled_plugin_filtering_excludes_matching_plugin_and_server_ids() {
        let _lock = GLOBAL_BRIDGE_TEST_LOCK.lock().unwrap();
        let _reset = GlobalBridgeResetGuard;

        let plugins = vec![
            make_plugin(
                "android-cli",
                "Android CLI",
                true,
                vec![
                    stdio_server("android-cli", "adb", "adb-mcp"),
                    http_server("android-cli", "studio", "http://127.0.0.1:7777/mcp"),
                ],
            ),
            make_plugin(
                "figma-ext",
                "Figma",
                true,
                vec![http_server("figma-ext", "api", "https://mcp.figma.com/mcp")],
            ),
        ];

        sync_plugin_mcp_hub(&plugins);
        assert!(crate::dispatch::mcp_hub::global_stdio_mcp_hub().has_registered_server("android-cli_adb"));
        assert_eq!(list_active_plugin_mcp_servers(&[]).len(), 3);
        assert_eq!(http_mcp_servers_for(&[]).len(), 2);

        // Filtering by plugin.dir_id excludes both stdio and http servers for that plugin.
        let without_android = list_active_plugin_mcp_servers(&["android-cli".to_string()]);
        assert_eq!(without_android.len(), 1);
        assert_eq!(without_android[0]["id"], "figma-ext_api");

        let http_without_android = http_mcp_servers_for(&["android-cli".to_string()]);
        assert_eq!(http_without_android.len(), 1);
        assert_eq!(http_without_android[0].id, "figma-ext_api");

        // Filtering by plugin.name (case-insensitive) also excludes it.
        let without_figma = http_mcp_servers_for(&["figma".to_string()]);
        assert_eq!(without_figma.len(), 1);
        assert_eq!(without_figma[0].id, "android-cli_studio");

        // Filtering by individual server id hides only that server.
        let without_single = list_active_plugin_mcp_servers(&["android-cli_studio".to_string()]);
        assert_eq!(without_single.len(), 2);
        assert!(without_single.iter().any(|v| v["id"] == "android-cli_adb"));
        assert!(without_single.iter().any(|v| v["id"] == "figma-ext_api"));
    }
}
