use crate::remote::events::RemoteEventBus;
use crate::remote::rpc::{blocking, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

pub const APK_DOWNLOAD_PATH: &str = "/api/v1/mobile/update/apk";
const UPDATE_WATCHER_INTERVAL_SECS: u64 = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileUpdateManifest {
    pub version_name: String,
    pub version_code: u32,
    pub filename: String,
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub release_notes: Option<String>,
    #[serde(default)]
    pub published_at_unix_ms: Option<i64>,
}

pub fn resolve_feed_dir() -> PathBuf {
    if let Ok(raw) = std::env::var("KITE_MOBILE_UPDATE_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    crate::persist::roaming_app_dir().join("mobile-updates")
}

pub fn is_safe_apk_filename(name: &str) -> bool {
    if name.is_empty() || name.trim() != name {
        return false;
    }
    if name.starts_with('.') {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    if name.contains('\0')
        || name.contains(':')
        || name.contains('"')
        || name.chars().any(|c| c.is_control())
    {
        return false;
    }
    name.to_ascii_lowercase().ends_with(".apk")
}

pub fn read_latest_manifest_in(dir: &Path) -> Option<(MobileUpdateManifest, PathBuf)> {
    let manifest_path = dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path).ok()?;
    let mut manifest = serde_json::from_str::<MobileUpdateManifest>(&raw).ok()?;
    if !is_safe_apk_filename(&manifest.filename) {
        return None;
    }
    let apk_path = dir.join(&manifest.filename);
    if !apk_path.is_file() {
        return None;
    }
    if manifest.size_bytes == 0 {
        if let Ok(meta) = std::fs::metadata(&apk_path) {
            manifest.size_bytes = meta.len();
        }
    }
    Some((manifest, apk_path))
}

pub fn read_latest_manifest() -> Option<(MobileUpdateManifest, PathBuf)> {
    read_latest_manifest_in(&resolve_feed_dir())
}

pub fn manifest_to_wire_json(m: &MobileUpdateManifest) -> Value {
    json!({
        "versionName": m.version_name,
        "versionCode": m.version_code,
        "filename": m.filename,
        "sha256": m.sha256,
        "sizeBytes": m.size_bytes,
        "releaseNotes": m.release_notes,
        "publishedAtUnixMs": m.published_at_unix_ms,
        "downloadPath": APK_DOWNLOAD_PATH,
    })
}

pub fn latest_manifest_wire_json() -> Option<Value> {
    read_latest_manifest().map(|(m, _)| manifest_to_wire_json(&m))
}

pub fn check_mobile_update_in(dir: &Path, current_version_code: Option<u32>) -> Value {
    let feed_dir = dir.to_string_lossy().to_string();
    match read_latest_manifest_in(dir) {
        Some((manifest, _)) => {
            let update_available = manifest.version_code > current_version_code.unwrap_or(0);
            let wire = manifest_to_wire_json(&manifest);
            json!({
                "available": true,
                "updateAvailable": update_available,
                "feedDir": feed_dir,
                "currentVersionCode": current_version_code,
                "downloadPath": APK_DOWNLOAD_PATH,
                "manifest": wire,
                "latest": wire,
            })
        }
        None => json!({
            "available": false,
            "updateAvailable": false,
            "feedDir": feed_dir,
            "currentVersionCode": current_version_code,
            "downloadPath": APK_DOWNLOAD_PATH,
            "manifest": Value::Null,
            "latest": Value::Null,
        }),
    }
}

pub fn check_mobile_update(current_version_code: Option<u32>) -> Value {
    check_mobile_update_in(&resolve_feed_dir(), current_version_code)
}

pub fn status_json_in(dir: &Path) -> Value {
    let feed_dir = dir.to_string_lossy().to_string();
    match read_latest_manifest_in(dir) {
        Some((m, _)) => json!({
            "available": true,
            "feedDir": feed_dir,
            "versionName": m.version_name,
            "versionCode": m.version_code,
            "filename": m.filename,
            "sha256": m.sha256,
            "sizeBytes": m.size_bytes,
            "releaseNotes": m.release_notes,
            "publishedAtUnixMs": m.published_at_unix_ms,
            "downloadPath": APK_DOWNLOAD_PATH,
        }),
        None => json!({
            "available": false,
            "feedDir": feed_dir,
            "versionName": Value::Null,
            "versionCode": Value::Null,
            "filename": Value::Null,
            "sha256": Value::Null,
            "sizeBytes": Value::Null,
            "releaseNotes": Value::Null,
            "publishedAtUnixMs": Value::Null,
            "downloadPath": APK_DOWNLOAD_PATH,
        }),
    }
}

pub fn status_json() -> Value {
    status_json_in(&resolve_feed_dir())
}

pub async fn handle_mobile_rpc(method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        "mobile.update.check" => {
            let current_version_code = match params.get("currentVersionCode") {
                None | Some(Value::Null) => None,
                Some(v) => {
                    let n = v
                        .as_u64()
                        .and_then(|u| u32::try_from(u).ok())
                        .ok_or_else(|| {
                            RpcError::invalid_params(
                                "currentVersionCode must be an unsigned 32-bit integer.",
                            )
                        })?;
                    Some(n)
                }
            };
            blocking(move || check_mobile_update(current_version_code)).await
        }
        _ => Err(RpcError::new(
            "method_not_found",
            format!("Unknown method '{method}'."),
        )),
    }
}

pub fn spawn_update_watcher(
    events: Arc<RemoteEventBus>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_seen: Option<(u32, String)> = tokio::task::spawn_blocking(|| {
            read_latest_manifest().map(|(m, _)| (m.version_code, m.sha256))
        })
        .await
        .ok()
        .flatten();

        let mut ticker = tokio::time::interval(Duration::from_secs(UPDATE_WATCHER_INTERVAL_SECS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await;

        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = ticker.tick() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                    if events.connected_clients() == 0 {
                        continue;
                    }
                    let current = tokio::task::spawn_blocking(read_latest_manifest)
                        .await
                        .ok()
                        .flatten();
                    if *shutdown_rx.borrow() {
                        break;
                    }
                    if let Some((manifest, _)) = current {
                        let key = (manifest.version_code, manifest.sha256.clone());
                        if last_seen.as_ref() != Some(&key) {
                            last_seen = Some(key);
                            events.publish("mobile.update_available", manifest_to_wire_json(&manifest));
                        }
                    } else {
                        last_seen = None;
                    }
                }
            }
        }
    })
}
