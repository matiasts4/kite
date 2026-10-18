// Auto-update commands (tauri-plugin-updater) with classified, user-visible errors.
// Every failure is logged to app.log and returned as { code, message, detail }.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::logger::log_trace;

#[derive(Serialize, Clone)]
pub struct UpdateError {
    /// network | signature | feed-not-found | no-asset | permissions | installer | unknown
    pub code: &'static str,
    /// Human readable explanation (shown in UI).
    pub message: String,
    /// Raw technical detail (copyable diagnostic).
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

fn classify(err: &tauri_plugin_updater::Error) -> UpdateError {
    let detail = format!("{err:?}");
    let lower = detail.to_lowercase();
    let (code, message) = if lower.contains("signature") || lower.contains("minisign") {
        ("signature", "La firma de la actualización no es válida. No se instaló por seguridad.")
    } else if lower.contains("404") || lower.contains("not found") {
        ("feed-not-found", "No se encontró el archivo de actualizaciones (latest.json). Revisa que la release esté publicada.")
    } else if lower.contains("platform") || lower.contains("target") {
        ("no-asset", "La release no incluye un instalador para este sistema.")
    } else if lower.contains("access is denied") || lower.contains("permission") {
        ("permissions", "Sin permisos para instalar la actualización. Cierra otras instancias e inténtalo de nuevo.")
    } else if lower.contains("reqwest") || lower.contains("dns") || lower.contains("connect") || lower.contains("timed out") || lower.contains("network") {
        ("network", "No se pudo conectar al servidor de actualizaciones. Revisa tu conexión.")
    } else if lower.contains("installer") || lower.contains("exit") {
        ("installer", "El instalador terminó con error.")
    } else {
        ("unknown", "Error desconocido al actualizar.")
    };
    log_trace(&format!("UPDATER ERROR [{code}]: {detail}"));
    UpdateError { code, message: message.into(), detail }
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Ensures local feed server is running if the configured target is localhost:9101.
fn ensure_local_feed_if_needed() {
    let local_addr = "127.0.0.1:9101";
    if let Ok(addr) = local_addr.parse::<std::net::SocketAddr>() {
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(60)).is_ok() {
            return;
        }
    }

    let candidates = [
        std::path::PathBuf::from(r"E:\kite\scripts\feed-server.mjs"),
        std::path::PathBuf::from(r"scripts\feed-server.mjs"),
        std::env::current_dir().unwrap_or_default().join("scripts").join("feed-server.mjs"),
    ];

    for script in &candidates {
        if script.exists() {
            log_trace(&format!("updater: auto-starting local feed server via {:?}", script));
            let mut cmd = std::process::Command::new("node");
            cmd.arg(script).arg("--serve");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            if let Ok(_child) = cmd.spawn() {
                for _ in 0..3 {
                    std::thread::sleep(std::time::Duration::from_millis(60));
                    if let Ok(addr) = local_addr.parse::<std::net::SocketAddr>() {
                        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(50)).is_ok() {
                            log_trace("updater: local feed server is now active on 9101");
                            break;
                        }
                    }
                }
            }
            break;
        }
    }
}

/// Builds the updater. `KITE_UPDATE_URL` overrides the configured feed endpoint
/// (e.g. to point an installed app at another host without rebuilding).
fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, UpdateError> {
    ensure_local_feed_if_needed();
    let mut builder = app.updater_builder();
    builder = builder.on_before_exit(|| {
        log_trace("updater: on_before_exit hook invoked, snapshotting terminals");
        crate::terminal::snapshot_and_shutdown_all_terminals("updater_on_before_exit");
    });
    if let Ok(raw) = std::env::var("KITE_UPDATE_URL") {
        let url: tauri::Url = raw.parse().map_err(|e| {
            let detail = format!("KITE_UPDATE_URL inválida ({raw}): {e}");
            log_trace(&format!("UPDATER ERROR [feed-not-found]: {detail}"));
            UpdateError { code: "feed-not-found", message: "La URL de actualizaciones configurada no es válida.".into(), detail }
        })?;
        log_trace(&format!("updater: feed override {url}"));
        builder = builder.endpoints(vec![url]).map_err(|e| classify(&e))?;
    }
    builder.build().map_err(|e| classify(&e))
}

#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<UpdateInfo, UpdateError> {
    let current_version = app.package_info().version.to_string();
    log_trace(&format!("updater: checking (current {current_version})"));
    let updater = build_updater(&app)?;
    match updater.check().await.map_err(|e| classify(&e))? {
        Some(u) => {
            log_trace(&format!("updater: update available {}", u.version));
            let info = UpdateInfo {
                available: true,
                current_version,
                version: Some(u.version.clone()),
                notes: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
            };
            let _ = app.emit("updater://available", &info);
            Ok(info)
        }
        None => {
            log_trace("updater: up to date");
            let info = UpdateInfo { available: false, current_version, version: None, notes: None, date: None };
            let _ = app.emit("updater://uptodate", &info);
            Ok(info)
        }
    }
}

/// Downloads + installs; emits `updater://progress` ({downloaded,total}) and
/// `updater://ready` once installed (the UI then calls `updater_restart`).
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<(), UpdateError> {
    let updater = build_updater(&app)?;
    let Some(update) = updater.check().await.map_err(|e| classify(&e))? else {
        return Ok(());
    };
    log_trace(&format!("updater: downloading {}", update.version));
    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(
                    "updater://progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {
                log_trace("updater: download finished, installing silently in background");
                crate::terminal::snapshot_and_shutdown_all_terminals("updater_download_finished");
            },
        )
        .await
        .map_err(|e| classify(&e))?;
    log_trace("updater: installed, waiting for restart");
    let _ = app.emit("updater://ready", ());
    Ok(())
}

#[tauri::command]
pub fn updater_restart(app: AppHandle) {
    log_trace("updater: restarting");
    crate::terminal::snapshot_and_shutdown_all_terminals("updater_restart");
    app.restart();
}

/// Downloads, installs and immediately restarts the app.
#[tauri::command]
pub async fn updater_update_and_restart(app: AppHandle) -> Result<(), UpdateError> {
    log_trace("updater: starting download and install");
    updater_install(app.clone()).await?;
    log_trace("updater: install complete, restarting now");
    crate::terminal::snapshot_and_shutdown_all_terminals("updater_update_and_restart");
    app.restart();
}

/// Background check on startup and periodic polling; emits `updater://available` whenever found.
/// If network is unreachable or feed is offline, fails silently in background.
pub fn spawn_startup_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Initial check 3s after startup
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if let Err(e) = updater_check(app.clone()).await {
            log_trace(&format!("updater: background initial check failed: {}", e.message));
        }

        // Periodic check every 2 minutes for faster detection of consecutive releases
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2 * 60));
        loop {
            interval.tick().await;
            if let Err(e) = updater_check(app.clone()).await {
                log_trace(&format!("updater: background periodic check failed: {}", e.message));
            }
        }
    });
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

