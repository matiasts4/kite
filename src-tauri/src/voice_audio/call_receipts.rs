use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCallReceipt {
    pub call_id: String,
    pub started_at: u64,
    pub ended_at: u64,
    pub duration_ms: u64,
    pub turn_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttfa_p50_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_hit_ratio: Option<f64>,
    #[serde(default)]
    pub tools_executed: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_thread_id: Option<String>,
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

fn default_transport() -> String {
    "cascaded".to_string()
}

pub fn sanitize_call_id(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("callId must not be empty".to_string());
    }
    if trimmed.len() > 120 {
        return Err("callId exceeds maximum length".to_string());
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("callId contains invalid characters".to_string());
    }
    Ok(trimmed.to_string())
}

fn voice_calls_dir() -> PathBuf {
    crate::persist::roaming_app_dir().join("voice-calls")
}

pub fn save_receipt_to_dir(dir: &Path, receipt: &VoiceCallReceipt) -> Result<PathBuf, String> {
    let safe_id = sanitize_call_id(&receipt.call_id)?;
    fs::create_dir_all(dir)
        .map_err(|e| format!("failed to create voice-calls directory: {}", e))?;
    let mut normalized = receipt.clone();
    normalized.call_id = safe_id.clone();
    let target = dir.join(format!("{}.json", safe_id));
    let tmp = dir.join(format!("{}.json.tmp", safe_id));
    let payload = serde_json::to_string_pretty(&normalized)
        .map_err(|e| format!("failed to serialize voice call receipt: {}", e))?;
    fs::write(&tmp, payload.as_bytes())
        .map_err(|e| format!("failed to write temporary voice call receipt: {}", e))?;
    fs::rename(&tmp, &target)
        .map_err(|e| format!("failed to persist voice call receipt: {}", e))?;
    Ok(target)
}

pub fn get_receipt_from_dir(dir: &Path, call_id: &str) -> Result<Option<VoiceCallReceipt>, String> {
    let safe_id = sanitize_call_id(call_id)?;
    let target = dir.join(format!("{}.json", safe_id));
    if !target.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&target)
        .map_err(|e| format!("failed to read voice call receipt: {}", e))?;
    let parsed: VoiceCallReceipt = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse voice call receipt: {}", e))?;
    Ok(Some(parsed))
}

pub fn list_receipts_from_dir(
    dir: &Path,
    limit: usize,
) -> Result<Vec<VoiceCallReceipt>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut receipts = Vec::new();
    let entries =
        fs::read_dir(dir).map_err(|e| format!("failed to read voice-calls dir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<VoiceCallReceipt>(&raw) {
                receipts.push(parsed);
            }
        }
    }
    receipts.sort_by(|a, b| {
        b.ended_at
            .cmp(&a.ended_at)
            .then_with(|| b.started_at.cmp(&a.started_at))
    });
    if limit > 0 && receipts.len() > limit {
        receipts.truncate(limit);
    }
    Ok(receipts)
}

#[tauri::command]
pub async fn voice_call_receipt_save(receipt: VoiceCallReceipt) -> Result<String, String> {
    let dir = voice_calls_dir();
    let saved = tauri::async_runtime::spawn_blocking(move || save_receipt_to_dir(&dir, &receipt))
        .await
        .map_err(|e| format!("task join error: {}", e))??;
    Ok(saved.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn voice_call_receipt_list(limit: Option<usize>) -> Result<Vec<VoiceCallReceipt>, String> {
    let dir = voice_calls_dir();
    let max_items = limit.unwrap_or(25).clamp(1, 200);
    tauri::async_runtime::spawn_blocking(move || list_receipts_from_dir(&dir, max_items))
        .await
        .map_err(|e| format!("task join error: {}", e))?
}

#[tauri::command]
pub async fn voice_call_receipt_get(call_id: String) -> Result<Option<VoiceCallReceipt>, String> {
    let dir = voice_calls_dir();
    tauri::async_runtime::spawn_blocking(move || get_receipt_from_dir(&dir, &call_id))
        .await
        .map_err(|e| format!("task join error: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_receipts_dir(label: &str) -> PathBuf {
        let unique = format!(
            "kite-voice-receipts-{}-{}",
            label,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        std::env::temp_dir().join(unique)
    }

    #[test]
    fn sanitize_rejects_traversal_and_empty_ids() {
        assert!(sanitize_call_id("").is_err());
        assert!(sanitize_call_id("../evil").is_err());
        assert!(sanitize_call_id("foo/bar").is_err());
        assert!(sanitize_call_id("foo\\bar").is_err());
        assert_eq!(sanitize_call_id("call-2026_01").unwrap(), "call-2026_01");
    }

    #[test]
    fn save_list_and_get_receipts_sorted_newest_first() {
        let dir = temp_receipts_dir("roundtrip");
        let older = VoiceCallReceipt {
            call_id: "call_older_1".to_string(),
            started_at: 1_000,
            ended_at: 4_000,
            duration_ms: 3_000,
            turn_count: 2,
            ttfa_p50_ms: Some(640.0),
            cache_hit_ratio: Some(0.62),
            tools_executed: vec!["peek_workspace".to_string()],
            bound_thread_id: Some("thr-1".to_string()),
            transport: "cascaded".to_string(),
            summary: Some("Revisión inicial".to_string()),
        };
        let newer = VoiceCallReceipt {
            call_id: "call_newer_2".to_string(),
            started_at: 5_000,
            ended_at: 9_500,
            duration_ms: 4_500,
            turn_count: 4,
            ttfa_p50_ms: Some(410.0),
            cache_hit_ratio: Some(0.78),
            tools_executed: vec!["manage_tasks".to_string(), "read_diff".to_string()],
            bound_thread_id: Some("thr-2".to_string()),
            transport: "realtime".to_string(),
            summary: Some("Sesión full-duplex".to_string()),
        };

        save_receipt_to_dir(&dir, &older).expect("save older");
        save_receipt_to_dir(&dir, &newer).expect("save newer");

        let listed = list_receipts_from_dir(&dir, 10).expect("list");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].call_id, "call_newer_2");
        assert_eq!(listed[1].call_id, "call_older_1");

        let loaded = get_receipt_from_dir(&dir, "call_older_1")
            .expect("get")
            .expect("some receipt");
        assert_eq!(loaded, older);

        let _ = fs::remove_dir_all(&dir);
    }
}
