pub mod auth;
pub mod events;
pub mod file_preview;
pub mod mobile_update;
pub mod rpc;
pub mod server;
pub mod tailscale;
pub mod voice;
#[cfg(test)]
pub mod tests;

use auth::{AuthStore, PairedDeviceInfo, PairingInfo};
use events::RemoteEventBus;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::watch;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGatewayStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub bind_mode: String,
    pub auto_start: bool,
    pub public_url: Option<String>,
    pub tailscale_mode: String,
    pub protocol: String,
    pub host_name: String,
    pub primary_host: String,
    pub candidate_hosts: Vec<String>,
    pub candidate_urls: Vec<String>,
    pub connected_clients: usize,
    pub device_count: usize,
    pub pairing_active: bool,
    pub last_error: Option<String>,
    pub mobile_update: Value,
    pub tailscale: tailscale::TailscaleStatus,
}

struct RunningServer {
    port: u16,
    bind_mode: String,
    shutdown_tx: watch::Sender<bool>,
    join_handle: tokio::task::JoinHandle<()>,
}

struct RemoteGatewayRuntime {
    auth: Arc<AuthStore>,
    events: Arc<RemoteEventBus>,
    server_gate: tokio::sync::Mutex<Option<RunningServer>>,
    sync_shutdown: Mutex<Option<watch::Sender<bool>>>,
    actual_port: AtomicU16,
    last_error: Mutex<Option<String>>,
    realtime_bridge_installed: AtomicBool,
}

static RUNTIME: OnceLock<Arc<RemoteGatewayRuntime>> = OnceLock::new();

fn runtime() -> &'static Arc<RemoteGatewayRuntime> {
    RUNTIME.get_or_init(|| {
        Arc::new(RemoteGatewayRuntime {
            auth: Arc::new(AuthStore::new(AuthStore::default_path())),
            events: RemoteEventBus::new(),
            server_gate: tokio::sync::Mutex::new(None),
            sync_shutdown: Mutex::new(None),
            actual_port: AtomicU16::new(0),
            last_error: Mutex::new(None),
            realtime_bridge_installed: AtomicBool::new(false),
        })
    })
}

fn ensure_realtime_event_bridge(rt: &RemoteGatewayRuntime) {
    if rt.realtime_bridge_installed.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(app) = crate::get_app_handle() else {
        rt.realtime_bridge_installed.store(false, Ordering::SeqCst);
        return;
    };
    use tauri::Listener;
    for event_name in [
        "voice:realtime-status",
        "voice:realtime-clear-audio",
        "voice:realtime-audio-delta",
        "voice:realtime-user-speech",
        "voice:realtime-transcript",
        "voice:realtime-tool-call",
    ] {
        let bus = Arc::clone(&rt.events);
        let name = event_name.to_string();
        let _id = app.listen(event_name, move |ev| {
            let payload = serde_json::from_str::<Value>(ev.payload())
                .unwrap_or_else(|_| Value::String(ev.payload().to_string()));
            bus.publish(
                "voice.realtime_event",
                json!({ "eventType": name, "payload": payload }),
            );
        });
    }
}

impl RemoteGatewayRuntime {
    async fn sync_server_with_config(&self) -> Result<(), String> {
        let mut guard = self.server_gate.lock().await;
        let cfg = self.auth.config_snapshot();

        let needs_stop = guard.as_ref().is_some_and(|running| {
            !cfg.enabled || running.port != cfg.port || running.bind_mode != cfg.bind_mode
        });
        if needs_stop {
            if let Some(old) = guard.take() {
                self.actual_port.store(0, Ordering::Relaxed);
                *self.sync_shutdown.lock().unwrap_or_else(|e| e.into_inner()) = None;
                let _ = old.shutdown_tx.send(true);
                let _ = old.join_handle.await;
            }
        }

        if cfg.enabled && guard.is_none() {
            ensure_realtime_event_bridge(self);
            let bind_addr = if cfg.bind_mode == "loopback" {
                SocketAddr::from(([127, 0, 0, 1], cfg.port))
            } else {
                SocketAddr::from(([0, 0, 0, 0], cfg.port))
            };
            match server::start_server(bind_addr, Arc::clone(&self.auth), Arc::clone(&self.events)).await {
                Ok(handle) => {
                    let bound_port = handle.local_addr.port();
                    self.actual_port.store(bound_port, Ordering::Relaxed);
                    *self.sync_shutdown.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(handle.shutdown_tx.clone());
                    *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    *guard = Some(RunningServer {
                        port: cfg.port,
                        bind_mode: cfg.bind_mode,
                        shutdown_tx: handle.shutdown_tx,
                        join_handle: handle.join_handle,
                    });
                }
                Err(err) => {
                    self.actual_port.store(0, Ordering::Relaxed);
                    *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(err.clone());
                    return Err(err);
                }
            }
        } else if !cfg.enabled {
            *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        Ok(())
    }

    async fn status_snapshot(&self) -> RemoteGatewayStatus {
        self.status_snapshot_with_refresh(false).await
    }

    async fn status_snapshot_with_refresh(&self, force_tailscale_refresh: bool) -> RemoteGatewayStatus {
        let cfg = self.auth.config_snapshot();
        let actual_port = self.actual_port.load(Ordering::Relaxed);
        let running = actual_port > 0;
        let effective_port = if actual_port > 0 { actual_port } else { cfg.port };
        let bind_mode_c = cfg.bind_mode.clone();
        let ts_mode_c = cfg.tailscale_mode.clone();
        let (candidate_hosts, mobile_update, ts_status) = tokio::task::spawn_blocking(move || {
            (
                auth::detect_candidate_hosts(&bind_mode_c),
                mobile_update::status_json(),
                tailscale::probe_status(
                    effective_port,
                    &bind_mode_c,
                    &ts_mode_c,
                    force_tailscale_refresh,
                ),
            )
        })
        .await
        .unwrap_or_else(|_| {
            (
                vec!["127.0.0.1".to_string()],
                json!({ "available": false }),
                tailscale::probe_status(effective_port, &cfg.bind_mode, &cfg.tailscale_mode, false),
            )
        });
        let primary_host = candidate_hosts
            .first()
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let candidate_urls = auth::build_candidate_urls(
            &cfg.bind_mode,
            effective_port,
            &candidate_hosts,
            ts_status.https_url.as_deref(),
            cfg.public_url.as_deref(),
            ts_status.ipv4.as_deref(),
        );

        RemoteGatewayStatus {
            enabled: cfg.enabled,
            running,
            port: effective_port,
            bind_mode: cfg.bind_mode,
            auto_start: cfg.auto_start,
            public_url: cfg.public_url,
            tailscale_mode: cfg.tailscale_mode,
            protocol: "kite-remote/v1".to_string(),
            host_name: auth::host_name(),
            primary_host,
            candidate_hosts,
            candidate_urls,
            connected_clients: self.events.connected_clients(),
            device_count: cfg.devices.len(),
            pairing_active: self.auth.has_active_pairing(),
            last_error: self.last_error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            mobile_update,
            tailscale: ts_status,
        }
    }
}

pub fn current_candidate_urls() -> Vec<String> {
    let rt = runtime();
    let cfg = rt.auth.config_snapshot();
    let actual_port = rt.actual_port.load(Ordering::Relaxed);
    let effective_port = if actual_port > 0 { actual_port } else { cfg.port };
    let candidate_hosts = auth::detect_candidate_hosts(&cfg.bind_mode);
    let ts_status = tailscale::probe_status(effective_port, &cfg.bind_mode, &cfg.tailscale_mode, false);
    auth::build_candidate_urls(
        &cfg.bind_mode,
        effective_port,
        &candidate_hosts,
        ts_status.https_url.as_deref(),
        cfg.public_url.as_deref(),
        ts_status.ipv4.as_deref(),
    )
}

fn devices_snapshot_with_connected(rt: &RemoteGatewayRuntime) -> Vec<PairedDeviceInfo> {
    let connected_ids = rt.events.connected_device_ids();
    rt.auth
        .list_devices()
        .into_iter()
        .map(|mut d| {
            d.connected = connected_ids.contains(&d.id);
            d
        })
        .collect()
}

pub fn start_remote_gateway_if_enabled() {
    let rt = Arc::clone(runtime());
    ensure_realtime_event_bridge(&rt);
    if rt.auth.config_snapshot().enabled {
        tauri::async_runtime::spawn(async move {
            if let Err(err) = rt.sync_server_with_config().await {
                crate::logger::log_trace(&format!("remote gateway startup failed: {err}"));
            }
        });
    }
}

pub fn shutdown_remote_gateway() {
    let Some(rt) = RUNTIME.get() else {
        return;
    };
    if let Some(tx) = rt.sync_shutdown.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = tx.send(true);
    }
    rt.actual_port.store(0, Ordering::Relaxed);
    rt.events.disconnect_all();
}

#[tauri::command]
pub async fn remote_gateway_status() -> RemoteGatewayStatus {
    runtime().status_snapshot().await
}

#[tauri::command]
pub async fn remote_gateway_configure(
    enabled: Option<bool>,
    port: Option<u16>,
    bind_mode: Option<String>,
    auto_start: Option<bool>,
    public_url: Option<String>,
    tailscale_mode: Option<String>,
) -> Result<RemoteGatewayStatus, String> {
    let rt = runtime();
    let old_cfg = rt.auth.config_snapshot();
    let explicit_ts_mode = tailscale_mode.is_some();
    let auth = Arc::clone(&rt.auth);
    let updated_cfg = tokio::task::spawn_blocking(move || {
        auth.configure_full(enabled, port, bind_mode, auto_start, public_url, tailscale_mode)
    })
    .await
    .map_err(|e| format!("Failed updating remote gateway config: {e}"))??;
    rt.sync_server_with_config().await?;

    let actual_port = rt.actual_port.load(Ordering::Relaxed);
    let effective_port = if actual_port > 0 { actual_port } else { updated_cfg.port };
    if explicit_ts_mode || (old_cfg.port != updated_cfg.port && updated_cfg.tailscale_mode != "off") {
        let mode_c = updated_cfg.tailscale_mode.clone();
        let bind_c = updated_cfg.bind_mode.clone();
        let res = tokio::task::spawn_blocking(move || {
            tailscale::apply_tailscale_mode(&mode_c, effective_port, &bind_c)
        })
        .await
        .map_err(|e| format!("Failed applying Tailscale configuration: {e}"))?;
        if explicit_ts_mode {
            res?;
        }
    }

    let status = rt.status_snapshot_with_refresh(false).await;
    rt.events.publish(
        "gateway.endpoints_changed",
        json!({ "candidateUrls": status.candidate_urls }),
    );
    Ok(status)
}

#[tauri::command]
pub async fn remote_gateway_tailscale_status(refresh: Option<bool>) -> tailscale::TailscaleStatus {
    let rt = runtime();
    let cfg = rt.auth.config_snapshot();
    let actual_port = rt.actual_port.load(Ordering::Relaxed);
    let effective_port = if actual_port > 0 { actual_port } else { cfg.port };
    let bind_c = cfg.bind_mode.clone();
    let mode_c = cfg.tailscale_mode.clone();
    let force = refresh.unwrap_or(false);
    tokio::task::spawn_blocking(move || tailscale::probe_status(effective_port, &bind_c, &mode_c, force))
        .await
        .unwrap_or_else(|_| tailscale::probe_status(effective_port, &cfg.bind_mode, &cfg.tailscale_mode, false))
}

#[tauri::command]
pub async fn remote_gateway_configure_tailscale(mode: String) -> Result<RemoteGatewayStatus, String> {
    let norm_mode = tailscale::normalize_tailscale_mode(&mode)?;
    let rt = runtime();
    let auth = Arc::clone(&rt.auth);
    let mode_for_cfg = norm_mode.clone();
    let cfg = tokio::task::spawn_blocking(move || {
        auth.configure_full(None, None, None, None, None, Some(mode_for_cfg))
    })
    .await
    .map_err(|e| format!("Failed saving Tailscale mode: {e}"))??;

    let actual_port = rt.actual_port.load(Ordering::Relaxed);
    let effective_port = if actual_port > 0 { actual_port } else { cfg.port };
    let bind_c = cfg.bind_mode.clone();
    let apply_res = tokio::task::spawn_blocking(move || {
        tailscale::apply_tailscale_mode(&norm_mode, effective_port, &bind_c)
    })
    .await
    .map_err(|e| format!("Failed applying Tailscale mode: {e}"))?;
    apply_res?;

    tailscale::invalidate_cache();
    let status = rt.status_snapshot_with_refresh(true).await;
    rt.events.publish(
        "gateway.endpoints_changed",
        json!({ "candidateUrls": status.candidate_urls }),
    );
    Ok(status)
}

#[tauri::command]
pub async fn remote_gateway_create_pairing() -> Result<PairingInfo, String> {
    let rt = runtime();
    let mut actual_port = rt.actual_port.load(Ordering::Relaxed);
    if actual_port == 0 {
        if rt.auth.config_snapshot().enabled {
            rt.sync_server_with_config().await?;
            actual_port = rt.actual_port.load(Ordering::Relaxed);
        }
        if actual_port == 0 {
            return Err("El gateway remoto está detenido. Actívalo antes de generar un código QR.".to_string());
        }
    }
    let cfg = rt.auth.config_snapshot();
    let auth = Arc::clone(&rt.auth);
    tokio::task::spawn_blocking(move || {
        let ts = tailscale::probe_status(actual_port, &cfg.bind_mode, &cfg.tailscale_mode, false);
        auth.create_pairing_with_urls(
            Some(actual_port),
            ts.https_url.as_deref(),
            cfg.public_url.as_deref(),
            ts.ipv4.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Failed creating pairing session: {e}"))?
}

#[tauri::command]
pub async fn remote_gateway_list_devices() -> Vec<PairedDeviceInfo> {
    devices_snapshot_with_connected(runtime())
}

#[tauri::command]
pub async fn remote_gateway_revoke_device(device_id: String) -> Result<Vec<PairedDeviceInfo>, String> {
    let rt = runtime();
    let auth = Arc::clone(&rt.auth);
    let id_c = device_id.clone();
    let removed = tokio::task::spawn_blocking(move || auth.revoke_device(&id_c))
        .await
        .map_err(|e| format!("Failed revoking remote device: {e}"))??;
    if removed {
        rt.events.disconnect_device(device_id.trim());
        rt.events.publish(
            "gateway.devices_changed",
            json!({ "count": rt.auth.device_count() }),
        );
    }
    Ok(devices_snapshot_with_connected(rt))
}

#[tauri::command]
pub async fn remote_argos_turn_reply(request_id: String, payload: Value) -> Result<bool, String> {
    let id = request_id.trim();
    if id.is_empty() {
        return Err("requestId is required.".to_string());
    }
    Ok(runtime().events.resolve_argos_turn(id, payload))
}
