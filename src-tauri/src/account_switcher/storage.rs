use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::registry::{canon_provider, now_ms, profile_storage_dir_in, profiles_root, user_home_dir};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Number of automatic pre-switch backups kept per provider.
const MAX_BACKUPS_PER_PROVIDER: usize = 5;

// ---------------------------------------------------------------------------
// Provider Files Definition for Snapshot / Restore
// ---------------------------------------------------------------------------

pub(crate) struct FileMapping {
    pub(crate) source: PathBuf,
    pub(crate) rel_dest: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveIdentityProbe {
    pub provider: String,
    pub email: String,
    pub name: Option<String>,
    pub source: String,
}

pub fn decode_jwt_payload(jwt: &str) -> Option<Value> {
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let mut payload_b64 = parts[1].replace('-', "+").replace('_', "/");
    while payload_b64.len() % 4 != 0 {
        payload_b64.push('=');
    }
    let bytes = crate::chat_attachments::decode_base64(&payload_b64)?;
    serde_json::from_slice(&bytes).ok()
}

pub fn probe_live_provider_identity(provider: &str) -> Option<LiveIdentityProbe> {
    let canon = canon_provider(provider);
    match canon.as_str() {
        "agy" => {
            if let Some((email, name)) = crate::quota::read_antigravity_credential() {
                return Some(LiveIdentityProbe {
                    provider: "agy".into(),
                    email,
                    name,
                    source: "gemini:antigravity".into(),
                });
            }
            if let Some((email, name)) = crate::quota::read_antigravity_ide_identity() {
                return Some(LiveIdentityProbe {
                    provider: "agy".into(),
                    email,
                    name,
                    source: "state.vscdb".into(),
                });
            }
            None
        }
        "gemini" => {
            let home = user_home_dir();
            let creds_file = home.join(".gemini").join("oauth_creds.json");
            if creds_file.exists() {
                if let Ok(bytes) = fs::read(&creds_file) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(id_tok) = val.get("id_token").and_then(|v| v.as_str()) {
                            if let Some(payload) = decode_jwt_payload(id_tok) {
                                let email = payload.get("email").and_then(|v| v.as_str()).map(String::from);
                                let name = payload.get("name").and_then(|v| v.as_str()).map(String::from);
                                if let Some(e) = email {
                                    return Some(LiveIdentityProbe {
                                        provider: "gemini".into(),
                                        email: e,
                                        name,
                                        source: "oauth_creds.json".into(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
            let accounts_file = home.join(".gemini").join("google_accounts.json");
            if accounts_file.exists() {
                if let Ok(bytes) = fs::read(&accounts_file) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(active) = val.get("active").and_then(|v| v.as_str()) {
                            if !active.trim().is_empty() {
                                return Some(LiveIdentityProbe {
                                    provider: "gemini".into(),
                                    email: active.trim().to_string(),
                                    name: None,
                                    source: "google_accounts.json".into(),
                                });
                            }
                        }
                    }
                }
            }
            None
        }
        "codex" => {
            let home = user_home_dir();
            let auth_file = home.join(".codex").join("auth.json");
            if auth_file.exists() {
                if let Ok(bytes) = fs::read(&auth_file) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(id_tok) = val.get("id_token").and_then(|v| v.as_str()) {
                            if let Some(payload) = decode_jwt_payload(id_tok) {
                                if let Some(e) = payload.get("email").and_then(|v| v.as_str()).map(String::from) {
                                    let name = payload.get("name").and_then(|v| v.as_str()).map(String::from);
                                    return Some(LiveIdentityProbe {
                                        provider: "codex".into(),
                                        email: e,
                                        name,
                                        source: "auth.json".into(),
                                    });
                                }
                            }
                        }
                        if let Some(tokens) = val.get("tokens").and_then(|v| v.as_object()) {
                            if let Some(id_tok) = tokens.get("id_token").and_then(|v| v.as_str()) {
                                if let Some(payload) = decode_jwt_payload(id_tok) {
                                    if let Some(e) = payload.get("email").and_then(|v| v.as_str()).map(String::from) {
                                        let name = payload.get("name").and_then(|v| v.as_str()).map(String::from);
                                        return Some(LiveIdentityProbe {
                                            provider: "codex".into(),
                                            email: e,
                                            name,
                                            source: "tokens.id_token".into(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            None
        }
        "claude" => {
            let home = user_home_dir();
            let claude_json = home.join(".claude.json");
            if claude_json.exists() {
                if let Ok(bytes) = fs::read(&claude_json) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(email) = val.pointer("/oauthAccount/emailAddress").and_then(|v| v.as_str()) {
                            if !email.trim().is_empty() {
                                return Some(LiveIdentityProbe {
                                    provider: "claude".into(),
                                    email: email.trim().to_string(),
                                    name: None,
                                    source: "claude.json".into(),
                                });
                            }
                        }
                    }
                }
            }
            None
        }
        "grok" => {
            let home = user_home_dir();
            let auth_file = home.join(".grok").join("auth.json");
            if auth_file.exists() {
                if let Ok(bytes) = fs::read(&auth_file) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(email) = val.get("email").and_then(|v| v.as_str()) {
                            if !email.trim().is_empty() {
                                return Some(LiveIdentityProbe {
                                    provider: "grok".into(),
                                    email: email.trim().to_string(),
                                    name: None,
                                    source: "auth.json".into(),
                                });
                            }
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

pub(crate) fn get_provider_file_mappings(provider: &str) -> Vec<FileMapping> {
    let home = user_home_dir();
    match canon_provider(provider).as_str() {
        "agy" => vec![
            FileMapping {
                source: home.join(".gemini").join("antigravity").join("antigravity_state.pbtxt"),
                rel_dest: "antigravity_state.pbtxt",
            },
            FileMapping {
                source: home.join(".gemini").join("antigravity-cli").join("jetski_state.pbtxt"),
                rel_dest: "jetski_state.pbtxt",
            },
        ],
        "gemini" => vec![
            FileMapping {
                source: home.join(".gemini").join("oauth_creds.json"),
                rel_dest: "oauth_creds.json",
            },
            FileMapping {
                source: home.join(".gemini").join("google_accounts.json"),
                rel_dest: "google_accounts.json",
            },
        ],
        "claude" => vec![
            FileMapping {
                source: home.join(".claude").join(".credentials.json"),
                rel_dest: "credentials.json",
            },
            FileMapping {
                source: home.join(".claude.json"),
                rel_dest: "claude.json",
            },
        ],
        "codex" => vec![
            FileMapping {
                source: home.join(".codex").join("auth.json"),
                rel_dest: "auth.json",
            },
            FileMapping {
                source: home.join(".codex").join("config.json"),
                rel_dest: "config.json",
            },
        ],
        "grok" => vec![
            FileMapping {
                source: home.join(".grok").join("auth.json"),
                rel_dest: "auth.json",
            },
            FileMapping {
                source: home.join(".grok").join("config.json"),
                rel_dest: "config.json",
            },
        ],
        "opencode" => vec![
            FileMapping {
                source: home.join(".local").join("share").join("opencode").join("auth.json"),
                rel_dest: "auth.json",
            },
            FileMapping {
                source: home.join(".config").join("opencode").join("config.json"),
                rel_dest: "config.json",
            },
        ],
        _ => Vec::new(),
    }
}

/// Sibling path used to stage a file next to its destination.
pub(crate) fn staged_path(dst: &Path) -> PathBuf {
    let mut name = dst.file_name().unwrap_or_default().to_os_string();
    name.push(".bm_new");
    dst.with_file_name(name)
}

/// Copy through a temp file + rename so a reader never observes a half-written file.
pub(crate) fn copy_atomic(src: &Path, dst: &Path) -> bool {
    if !src.exists() {
        return false;
    }
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = staged_path(dst);
    if fs::copy(src, &tmp).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    if fs::rename(&tmp, dst).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    true
}

pub(crate) trait AntigravityCredStore {
    fn read_raw(&self) -> Option<String>;
    fn write_checked(&self, blob_json: &str) -> Result<(), String>;
    fn delete(&self) -> bool;
}

pub(crate) struct LiveAntigravityCredStore;

impl AntigravityCredStore for LiveAntigravityCredStore {
    fn read_raw(&self) -> Option<String> {
        crate::quota::read_antigravity_raw_credential()
    }

    fn write_checked(&self, blob_json: &str) -> Result<(), String> {
        crate::quota::write_antigravity_credential_checked(blob_json)
    }

    fn delete(&self) -> bool {
        crate::quota::delete_antigravity_credential()
    }
}

pub(crate) fn write_bytes_atomic(dst: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear {}: {e}", parent.display()))?;
    }
    let tmp = staged_path(dst);
    if let Err(e) = fs::write(&tmp, data) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("No se pudo escribir {}: {e}", dst.display()));
    }
    if let Err(e) = fs::rename(&tmp, dst) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("No se pudo guardar {}: {e}", dst.display()));
    }
    Ok(())
}

pub(crate) fn snapshot_active_to_profile_with(
    root: &Path,
    provider: &str,
    account_id: &str,
    mappings: &[FileMapping],
    state_vscdb: Option<&Path>,
    cred_store: &dyn AntigravityCredStore,
) -> Result<bool, String> {
    let provider = canon_provider(provider);

    if provider == "agy" {
        let raw = cred_store.read_raw().ok_or_else(|| {
            "No se encontró una credencial activa de Antigravity en Windows Credential Manager (gemini:antigravity). Inicia sesión primero y vuelve a intentar.".to_string()
        })?;
        let ident = crate::quota::parse_antigravity_credential_with_tokens(&raw).map_err(|code| {
            match code {
                "missing_tokens" => "La sesión activa de Antigravity (gemini:antigravity) no contiene tokens OAuth válidos (access_token o refresh_token). Vuelve a iniciar sesión.".to_string(),
                _ => "La credencial activa de Antigravity (gemini:antigravity) está corrupta o no contiene un email válido.".to_string(),
            }
        })?;

        let dest_dir = profile_storage_dir_in(root, &provider, account_id);
        write_bytes_atomic(&dest_dir.join("gemini_antigravity_cred.json"), raw.as_bytes())?;

        for m in mappings {
            if m.source.exists() && !copy_atomic(&m.source, &dest_dir.join(m.rel_dest)) {
                return Err(format!(
                    "No se pudo respaldar {} al perfil {}.",
                    m.rel_dest, account_id
                ));
            }
        }

        let ide_snap_path = dest_dir.join("ide_auth_state.json");
        if let Some(db_path) = state_vscdb {
            match crate::quota::extract_ide_auth_state_from_db(db_path) {
                Ok(Some(ide_snap))
                    if ide_snap
                        .email
                        .as_deref()
                        .map_or(false, |e| e.eq_ignore_ascii_case(&ident.email)) =>
                {
                    let bytes = serde_json::to_vec_pretty(&ide_snap).map_err(|e| {
                        format!("No se pudo serializar ide_auth_state.json: {e}")
                    })?;
                    write_bytes_atomic(&ide_snap_path, &bytes)?;
                }
                _ => {
                    // Never keep an IDE snapshot belonging to a different account.
                    if ide_snap_path.exists() {
                        let _ = fs::remove_file(&ide_snap_path);
                    }
                }
            }
        }
        return Ok(true);
    }

    let dest_dir = profile_storage_dir_in(root, &provider, account_id);
    let mut copied_any = false;
    for m in mappings {
        if m.source.exists() {
            if !copy_atomic(&m.source, &dest_dir.join(m.rel_dest)) {
                return Err(format!(
                    "No se pudo copiar {} al perfil {}.",
                    m.rel_dest, account_id
                ));
            }
            copied_any = true;
        }
    }
    Ok(copied_any)
}

pub fn snapshot_active_to_profile(provider: &str, account_id: &str) -> Result<bool, String> {
    let canon = canon_provider(provider);
    let mappings = get_provider_file_mappings(&canon);
    let state_vscdb = if canon == "agy" {
        crate::quota::find_existing_state_vscdb()
    } else {
        None
    };
    snapshot_active_to_profile_with(
        &profiles_root(),
        &canon,
        account_id,
        &mappings,
        state_vscdb.as_deref(),
        &LiveAntigravityCredStore,
    )
}

// ---------------------------------------------------------------------------
// Process guard: never swap session files under a running client
// ---------------------------------------------------------------------------

/// Lower-cased image names of running processes, or `None` if they could not be listed.
pub(crate) fn running_process_names() -> Option<Vec<String>> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("tasklist");
        c.args(["/FO", "CSV", "/NH"]);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("ps");
        c.args(["-A", "-o", "comm="]);
        c
    };
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let names = text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            #[cfg(windows)]
            let name = line.trim_start_matches('"').split('"').next().unwrap_or("");
            #[cfg(not(windows))]
            let name = line.rsplit('/').next().unwrap_or(line);
            Some(name.to_lowercase())
        })
        .collect();
    Some(names)
}

pub(crate) fn is_blocking_process(provider: &str, name: &str) -> bool {
    // Only standalone external IDEs (e.g. Antigravity IDE window) outside Kite's PTY
    // ownership remain blocking; Kite-owned PTY processes are quiesced cleanly.
    match canon_provider(provider).as_str() {
        "agy" => matches!(name, "antigravity" | "antigravity.exe"),
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProcessRecord {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub command_line: Option<String>,
    pub has_visible_window: bool,
    pub window_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResidualProcessSummary {
    pub pid: u32,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProcessInspection {
    pub state: String,
    pub can_close_processes: bool,
    pub base_app_pids: Vec<u32>,
    pub base_app_titles: Vec<String>,
    pub residual_processes: Vec<ResidualProcessSummary>,
    pub message: String,
}

impl ExternalProcessInspection {
    pub(crate) fn idle() -> Self {
        Self {
            state: "idle".to_string(),
            can_close_processes: false,
            base_app_pids: Vec::new(),
            base_app_titles: Vec::new(),
            residual_processes: Vec::new(),
            message: String::new(),
        }
    }

    pub(crate) fn to_idle_result(&self) -> Result<(), String> {
        if self.state == "idle" {
            Ok(())
        } else {
            Err(self.message.clone())
        }
    }
}

fn classify_antigravity_residual_kind(cmd_lower: Option<&str>) -> Option<&'static str> {
    let cmd = cmd_lower?;
    if let Some(idx) = cmd.find("--type=") {
        let rest = &cmd[idx + 7..];
        let kind_tok = rest.split_whitespace().next().unwrap_or("");
        if kind_tok.starts_with("utility") {
            return Some("utility");
        }
        if kind_tok.starts_with("renderer") {
            return Some("renderer");
        }
        if kind_tok.starts_with("gpu-process") {
            return Some("gpu-process");
        }
        if kind_tok.starts_with("crashpad") {
            return Some("crashpad-handler");
        }
        return Some("helper");
    }
    if cmd.contains("--import=") || cmd.contains("sidecar_sdk") || cmd.contains("electron_run_as_node") {
        return Some("sidecar");
    }
    // Unflagged main executable processes (startup, splash, tray-minimized, or opaque)
    // must be treated conservatively as the base desktop app rather than killed as residuals.
    None
}

/// Inspects an injected snapshot of external OS processes and classifies whether a visible
/// desktop IDE window is open (`base_app_open`, never killable automatically) vs only
/// lingering background/helper processes remain (`residual_only`, safe to close).
pub(crate) fn inspect_external_provider_processes_with(
    provider: &str,
    records: Option<Vec<ExternalProcessRecord>>,
    excluded_pids: &HashSet<u32>,
) -> ExternalProcessInspection {
    let canon = canon_provider(provider);
    if canon != "agy" {
        return ExternalProcessInspection::idle();
    }

    let Some(procs) = records else {
        return ExternalProcessInspection {
            state: "unknown".to_string(),
            can_close_processes: false,
            base_app_pids: Vec::new(),
            base_app_titles: Vec::new(),
            residual_processes: Vec::new(),
            message: "No se pudo verificar si hay procesos externos abiertos del proveedor. Cierra manualmente la aplicación externa e intenta nuevamente.".to_string(),
        };
    };

    let mut base_app_pids = Vec::new();
    let mut base_app_titles = Vec::new();
    let mut residuals = Vec::new();

    for proc_rec in procs {
        if excluded_pids.contains(&proc_rec.pid) {
            continue;
        }
        let name_lower = proc_rec.name.to_ascii_lowercase();
        if !is_blocking_process(&canon, &name_lower) {
            continue;
        }

        let cmd_lower = proc_rec
            .command_line
            .as_deref()
            .map(|c| c.to_ascii_lowercase());
        let residual_kind = classify_antigravity_residual_kind(cmd_lower.as_deref());
        let is_open_base_window = proc_rec.has_visible_window || residual_kind.is_none();

        if is_open_base_window {
            base_app_pids.push(proc_rec.pid);
            if let Some(ref title) = proc_rec.window_title {
                let trimmed = title.trim();
                if !trimmed.is_empty() && !base_app_titles.iter().any(|t| t == trimmed) {
                    base_app_titles.push(trimmed.to_string());
                }
            }
        } else if let Some(kind) = residual_kind {
            residuals.push(ResidualProcessSummary {
                pid: proc_rec.pid,
                name: name_lower,
                kind: kind.to_string(),
            });
        }
    }

    if !base_app_pids.is_empty() {
        let message = if base_app_titles.is_empty() {
            "Antigravity IDE está abierto en el sistema. Cierra la ventana de Antigravity manualmente antes de cambiar de cuenta."
                .to_string()
        } else {
            format!(
                "Antigravity IDE está abierto («{}»). Cierra la aplicación manualmente antes de cambiar de cuenta.",
                base_app_titles.join(", ")
            )
        };
        return ExternalProcessInspection {
            state: "base_app_open".to_string(),
            can_close_processes: false,
            base_app_pids,
            base_app_titles,
            residual_processes: Vec::new(),
            message,
        };
    }

    if !residuals.is_empty() {
        let count = residuals.len();
        let pid_preview = residuals
            .iter()
            .take(4)
            .map(|r| r.pid.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let extra = if count > 4 { ", …" } else { "" };
        return ExternalProcessInspection {
            state: "residual_only".to_string(),
            can_close_processes: true,
            base_app_pids: Vec::new(),
            base_app_titles: Vec::new(),
            residual_processes: residuals,
            message: format!(
                "Quedaron {} proceso{} secundario{} de Antigravity activo{} en segundo plano tras cerrar la app (PID: {}{}).",
                count,
                if count == 1 { "" } else { "s" },
                if count == 1 { "" } else { "s" },
                if count == 1 { "" } else { "s" },
                pid_preview,
                extra
            ),
        };
    }

    ExternalProcessInspection::idle()
}

fn collect_kite_excluded_pids(
    parent_map: &HashMap<u32, u32>,
    children_map: &HashMap<u32, Vec<u32>>,
) -> HashSet<u32> {
    let mut excluded = HashSet::new();
    let self_pid = std::process::id();

    // 1. Walk UP from Kite itself so Kite and its host chain are never reported/terminated.
    let mut cursor = self_pid;
    for _ in 0..64 {
        if !excluded.insert(cursor) {
            break;
        }
        match parent_map.get(&cursor).copied() {
            Some(parent) if parent != 0 && parent != cursor => cursor = parent,
            _ => break,
        }
    }

    // 2. Walk DOWN from Kite and every active/daemon Kite-managed PTY root PID.
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(self_pid);
    for root_pid in crate::terminal::get_terminal_root_pids() {
        if root_pid != 0 {
            queue.push_back(root_pid);
        }
    }
    while let Some(pid) = queue.pop_front() {
        excluded.insert(pid);
        if let Some(kids) = children_map.get(&pid) {
            for &child_pid in kids {
                if child_pid != 0 && excluded.insert(child_pid) {
                    queue.push_back(child_pid);
                }
            }
        }
    }
    excluded
}

#[cfg(windows)]
fn collect_windows_process_snapshot(provider: &str) -> (Option<Vec<ExternalProcessRecord>>, HashSet<u32>) {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> isize;
        fn Process32FirstW(h_snapshot: isize, lppe: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(h_snapshot: isize, lppe: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(h_object: isize) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(
            lp_enum_func: unsafe extern "system" fn(isize, isize) -> i32,
            l_param: isize,
        ) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, lpdw_process_id: *mut u32) -> u32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn GetWindowTextLengthW(hwnd: isize) -> i32;
        fn GetWindowTextW(hwnd: isize, lp_string: *mut u16, n_max_count: i32) -> i32;
    }

    struct SnapshotHandle(isize);
    impl Drop for SnapshotHandle {
        fn drop(&mut self) {
            if self.0 != -1 && self.0 != 0 {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    let snap_raw = unsafe { CreateToolhelp32Snapshot(0x0000_0002, 0) };
    if snap_raw == -1 {
        return (None, HashSet::new());
    }
    let _snap = SnapshotHandle(snap_raw);

    let mut parent_map: HashMap<u32, u32> = HashMap::new();
    let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut matching: Vec<(u32, u32, String)> = Vec::new();
    let mut entry = ProcessEntry32W {
        dw_size: std::mem::size_of::<ProcessEntry32W>() as u32,
        cnt_usage: 0,
        th32_process_id: 0,
        th32_default_heap_id: 0,
        th32_module_id: 0,
        cnt_threads: 0,
        th32_parent_process_id: 0,
        pc_pri_class_base: 0,
        dw_flags: 0,
        sz_exe_file: [0; 260],
    };

    let mut ok = unsafe { Process32FirstW(snap_raw, &mut entry) };
    while ok != 0 {
        let len = entry.sz_exe_file.iter().position(|&c| c == 0).unwrap_or(entry.sz_exe_file.len());
        let name = OsString::from_wide(&entry.sz_exe_file[..len])
            .to_string_lossy()
            .to_ascii_lowercase();
        parent_map.insert(entry.th32_process_id, entry.th32_parent_process_id);
        children_map
            .entry(entry.th32_parent_process_id)
            .or_default()
            .push(entry.th32_process_id);
        if is_blocking_process(provider, &name) {
            matching.push((entry.th32_process_id, entry.th32_parent_process_id, name));
        }
        ok = unsafe { Process32NextW(snap_raw, &mut entry) };
    }

    let excluded = collect_kite_excluded_pids(&parent_map, &children_map);

    let candidate_pids: Vec<(u32, u32, String)> = matching
        .into_iter()
        .filter(|(pid, _, _)| !excluded.contains(pid))
        .collect();
    if candidate_pids.is_empty() {
        return (Some(Vec::new()), excluded);
    }

    // Collect visible top-level window titles for matching PIDs in < 1ms via Win32 EnumWindows.
    unsafe extern "system" fn enum_window_proc(hwnd: isize, l_param: isize) -> i32 {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let text_len = GetWindowTextLengthW(hwnd);
        if text_len <= 0 {
            return 1;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return 1;
        }
        let map = &mut *(l_param as *mut HashMap<u32, String>);
        if map.contains_key(&pid) {
            return 1;
        }
        let mut buf = vec![0u16; (text_len as usize).min(255) + 1];
        let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if copied > 0 {
            let title = String::from_utf16_lossy(&buf[..copied as usize]).trim().to_string();
            let ignored = title.is_empty()
                || matches!(
                    title.as_str(),
                    "OleMainThreadWndName" | "Default IME" | "MSCTFIME UI" | "GDI+ Window"
                );
            if !ignored {
                map.insert(pid, title);
            }
        }
        1
    }

    let mut visible_windows: HashMap<u32, String> = HashMap::new();
    unsafe {
        EnumWindows(
            enum_window_proc,
            &mut visible_windows as *mut HashMap<u32, String> as isize,
        );
    }

    // Fetch exact command lines ONLY when external Antigravity processes are active.
    let mut cmd_map: HashMap<u32, String> = HashMap::new();
    let ps_script = "Get-CimInstance Win32_Process -Filter \"Name LIKE 'antigravity%'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress";
    if let Ok(out) = crate::hidden_exec::run(
        Path::new("powershell.exe"),
        &["-NoProfile", "-NonInteractive", "-Command", ps_script],
        std::time::Duration::from_secs(5),
    ) {
        if out.success() {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !raw.is_empty() {
                if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                    let rows = match val {
                        Value::Array(arr) => arr,
                        obj @ Value::Object(_) => vec![obj],
                        _ => Vec::new(),
                    };
                    for row in rows {
                        if let Some(pid) = row.get("ProcessId").and_then(|v| v.as_u64()).map(|n| n as u32) {
                            if let Some(cmd) = row.get("CommandLine").and_then(|v| v.as_str()) {
                                cmd_map.insert(pid, cmd.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    let records = candidate_pids
        .into_iter()
        .map(|(pid, parent_pid, name)| {
            let win_title = visible_windows.get(&pid).cloned();
            let has_visible = win_title.is_some();
            ExternalProcessRecord {
                pid,
                parent_pid: Some(parent_pid),
                name,
                command_line: cmd_map.get(&pid).cloned(),
                has_visible_window: has_visible,
                window_title: win_title,
            }
        })
        .collect();

    (Some(records), excluded)
}

#[cfg(not(windows))]
fn collect_unix_process_snapshot(provider: &str) -> (Option<Vec<ExternalProcessRecord>>, HashSet<u32>) {
    let Ok(out) = Command::new("ps").args(["-A", "-o", "pid=,ppid=,comm=,args="]).output() else {
        return (None, HashSet::new());
    };
    if !out.status.success() {
        return (None, HashSet::new());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parent_map = HashMap::new();
    let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut candidates = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let mut parts = trimmed.split_whitespace();
        let Some(pid) = parts.next().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Some(ppid) = parts.next().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Some(comm) = parts.next() else {
            continue;
        };
        let args = parts.collect::<Vec<_>>().join(" ");
        let name = comm.rsplit('/').next().unwrap_or(comm).to_ascii_lowercase();
        parent_map.insert(pid, ppid);
        children_map.entry(ppid).or_default().push(pid);
        if is_blocking_process(provider, &name) {
            let args_lower = args.to_ascii_lowercase();
            let is_subproc = args_lower.contains("--type=")
                || args_lower.contains("--import=")
                || args_lower.contains("sidecar_sdk")
                || args_lower.contains("electron_run_as_node");
            candidates.push(ExternalProcessRecord {
                pid,
                parent_pid: Some(ppid),
                name,
                command_line: if args.is_empty() { None } else { Some(args) },
                // Treat non-helper desktop executables conservatively on Unix unless known helper
                has_visible_window: !is_subproc,
                window_title: None,
            });
        }
    }
    let excluded = collect_kite_excluded_pids(&parent_map, &children_map);
    (Some(candidates), excluded)
}

pub fn inspect_external_provider_processes(provider: &str) -> ExternalProcessInspection {
    let canon = canon_provider(provider);
    if canon != "agy" {
        return ExternalProcessInspection::idle();
    }
    #[cfg(windows)]
    let (records, excluded) = collect_windows_process_snapshot(&canon);
    #[cfg(not(windows))]
    let (records, excluded) = collect_unix_process_snapshot(&canon);
    inspect_external_provider_processes_with(&canon, records, &excluded)
}

#[cfg(windows)]
fn terminate_specific_pids_os(pids: &[u32]) -> Result<(), String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE,
    };

    let self_pid = std::process::id();
    let mut failures = Vec::new();

    for &pid in pids {
        if pid == 0 || pid == self_pid {
            continue;
        }
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, false, pid) else {
                // Process may have exited cleanly already; verification pass catches live survivors.
                continue;
            };
            if TerminateProcess(handle, 1).is_err() {
                failures.push(format!("PID {pid}"));
            } else {
                let _ = WaitForSingleObject(handle, 300);
            }
            let _ = CloseHandle(handle);
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "No se pudieron cerrar algunos procesos residuales ({}).",
            failures.join(", ")
        ))
    }
}

#[cfg(not(windows))]
fn terminate_specific_pids_os(pids: &[u32]) -> Result<(), String> {
    let self_pid = std::process::id();
    for &pid in pids {
        if pid == 0 || pid == self_pid {
            continue;
        }
        let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).output();
    }
    std::thread::sleep(std::time::Duration::from_millis(150));
    for &pid in pids {
        if pid == 0 || pid == self_pid {
            continue;
        }
        let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).output();
    }
    Ok(())
}

pub(crate) fn close_residual_provider_processes_with<F, K>(
    provider: &str,
    mut inspect_fn: F,
    mut kill_fn: K,
) -> Value
where
    F: FnMut() -> ExternalProcessInspection,
    K: FnMut(&[u32]) -> Result<(), String>,
{
    let canon = canon_provider(provider);
    if canon != "agy" {
        return json!({
            "success": true,
            "alreadyIdle": true,
            "closedCount": 0,
            "closedPids": [],
        });
    }

    let current = inspect_fn();
    match current.state.as_str() {
        "idle" => {
            return json!({
                "success": true,
                "alreadyIdle": true,
                "closedCount": 0,
                "closedPids": [],
            });
        }
        "base_app_open" => {
            return json!({
                "success": false,
                "code": "BASE_APP_OPEN",
                "providerBusyKind": "base_app_open",
                "canCloseProcesses": false,
                "error": current.message,
                "baseAppTitles": current.base_app_titles,
            });
        }
        "unknown" => {
            return json!({
                "success": false,
                "code": "PROCESS_ENUM_FAILED",
                "providerBusyKind": "unknown",
                "canCloseProcesses": false,
                "error": current.message,
            });
        }
        _ => {}
    }

    let target_pids: Vec<u32> = current.residual_processes.iter().map(|p| p.pid).collect();
    if let Err(err) = kill_fn(&target_pids) {
        return json!({
            "success": false,
            "code": "CLOSE_PROCESSES_FAILED",
            "canCloseProcesses": false,
            "error": err,
        });
    }

    let after = inspect_fn();
    if after.state == "idle" {
        return json!({
            "success": true,
            "alreadyIdle": false,
            "closedCount": target_pids.len(),
            "closedPids": target_pids,
        });
    }

    json!({
        "success": false,
        "code": "PROVIDER_BUSY",
        "providerBusyKind": after.state,
        "canCloseProcesses": after.can_close_processes,
        "residualProcessCount": after.residual_processes.len(),
        "residualProcesses": after.residual_processes,
        "baseAppTitles": after.base_app_titles,
        "error": if after.message.is_empty() {
            "Algunos procesos de Antigravity siguen activos."
                .to_string()
        } else {
            after.message
        },
    })
}

pub fn close_residual_provider_processes_direct(provider: String) -> Value {
    let canon = canon_provider(&provider);
    if canon != "agy" {
        return json!({
            "success": true,
            "alreadyIdle": true,
            "closedCount": 0,
            "closedPids": [],
        });
    }
    let mut calls = 0usize;
    close_residual_provider_processes_with(
        &canon,
        || {
            calls += 1;
            if calls == 1 {
                return inspect_external_provider_processes(&canon);
            }
            // Wait briefly for Windows/POSIX handle teardown after terminating residual PIDs.
            let mut latest = inspect_external_provider_processes(&canon);
            for _ in 0..10 {
                if matches!(latest.state.as_str(), "idle" | "base_app_open" | "unknown") {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(120));
                latest = inspect_external_provider_processes(&canon);
            }
            latest
        },
        terminate_specific_pids_os,
    )
}

/// Fail-closed check ensuring external processes (e.g., standalone Antigravity IDE)
/// are not holding locks on auth/SQLite files.
pub(crate) fn ensure_provider_idle_with(
    provider: &str,
    process_names: Option<Vec<String>>,
) -> Result<(), String> {
    let Some(names) = process_names else {
        return Err(
            "No se pudo verificar si hay procesos externos abiertos del proveedor. Cierra manualmente la aplicación externa e intenta nuevamente."
                .to_string(),
        );
    };
    let mut busy: Vec<String> = names
        .into_iter()
        .filter(|n| is_blocking_process(provider, n))
        .collect();
    busy.sort();
    busy.dedup();
    if busy.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Cierra la aplicación externa de {} antes de cambiar de cuenta (procesos activos: {}).",
            canon_provider(provider),
            busy.join(", ")
        ))
    }
}

/// Err(message) when an external client that owns session/IDE files is running,
/// or when process enumeration fails (fail-closed).
pub(crate) fn ensure_provider_idle(provider: &str) -> Result<(), String> {
    ensure_provider_idle_with(provider, running_process_names())
}

// ---------------------------------------------------------------------------
// Transactional restore (backup -> stage -> commit -> rollback on failure)
// ---------------------------------------------------------------------------

pub(crate) fn prune_backups_in(root: &Path, provider: &str) {
    let dir = root.join("_backups").join(provider);
    let Ok(read) = fs::read_dir(&dir) else { return };
    let mut entries: Vec<PathBuf> = read.filter_map(|e| e.ok().map(|e| e.path())).collect();
    entries.sort_by_key(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.parse::<i64>().ok())
            .unwrap_or(0)
    });
    if entries.len() > MAX_BACKUPS_PER_PROVIDER {
        for old in &entries[..entries.len() - MAX_BACKUPS_PER_PROVIDER] {
            let _ = fs::remove_dir_all(old);
        }
    }
}

fn restore_mappings_backup(mappings: &[FileMapping], existed: &[bool], backup_dir: &Path) {
    for (i, m) in mappings.iter().enumerate() {
        if existed.get(i).copied().unwrap_or(false) {
            let _ = copy_atomic(&backup_dir.join(m.rel_dest), &m.source);
        } else {
            let _ = fs::remove_file(&m.source);
        }
    }
}

pub(crate) fn apply_profile_to_active_with(
    root: &Path,
    provider: &str,
    account_id: &str,
    mappings: &[FileMapping],
    state_vscdb: Option<&Path>,
    cred_store: &dyn AntigravityCredStore,
) -> Result<(), String> {
    let provider = canon_provider(provider);
    let src_dir = profile_storage_dir_in(root, &provider, account_id);
    let is_agy = provider == "agy";
    let cred_file = src_dir.join("gemini_antigravity_cred.json");

    let mut agy_payload: Option<(
        String,
        crate::quota::AntigravityCredentialIdentity,
        Option<crate::quota::IdeAuthStateSnapshot>,
    )> = None;

    if is_agy {
        if !cred_file.exists() {
            return Err("El perfil seleccionado no contiene credenciales válidas de Antigravity (gemini_antigravity_cred.json). Vuelve a iniciar sesión con esa cuenta y guárdala.".to_string());
        }
        let raw = fs::read_to_string(&cred_file)
            .map_err(|e| format!("No se pudo leer gemini_antigravity_cred.json: {e}"))?;
        let expected_ident =
            crate::quota::parse_antigravity_credential_with_tokens(&raw).map_err(|code| match code {
                "missing_tokens" => "El perfil seleccionado no contiene tokens OAuth válidos (access_token o refresh_token). Vuelve a iniciar sesión con esa cuenta y guárdala.".to_string(),
                _ => "El archivo de credenciales de Antigravity está dañado o no contiene una identidad válida.".to_string(),
            })?;

        let ide_snap_path = src_dir.join("ide_auth_state.json");
        let ide_snapshot = if ide_snap_path.is_file() {
            let ide_raw = fs::read_to_string(&ide_snap_path)
                .map_err(|e| format!("No se pudo leer ide_auth_state.json: {e}"))?;
            let parsed: crate::quota::IdeAuthStateSnapshot = serde_json::from_str(&ide_raw)
                .map_err(|e| format!("ide_auth_state.json está corrupto: {e}"))?;
            Some(parsed)
        } else {
            None
        };

        agy_payload = Some((raw, expected_ident, ide_snapshot));
    } else if !mappings.iter().any(|m| src_dir.join(m.rel_dest).exists()) {
        return Err("El perfil guardado no contiene archivos de sesión.".to_string());
    }

    // 1. Back up the current live state (also protects an unsaved current session).
    let backup_dir = root
        .join("_backups")
        .join(&provider)
        .join(now_ms().to_string());
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("No se pudo crear directorio de respaldo: {e}"))?;

    let mut live_agy_backup: Option<String> = None;
    let mut live_ide_backup: Option<std::collections::BTreeMap<String, String>> = None;
    if is_agy {
        if let Some(raw) = cred_store.read_raw() {
            write_bytes_atomic(&backup_dir.join("gemini_antigravity_cred.json"), raw.as_bytes())?;
            live_agy_backup = Some(raw);
        }
        if let Some(db_path) = state_vscdb {
            if db_path.exists() {
                if let Ok(rows) = crate::quota::extract_ide_auth_rows_from_db(db_path) {
                    if !rows.is_empty() {
                        if let Ok(bytes) = serde_json::to_vec_pretty(&rows) {
                            let _ = write_bytes_atomic(&backup_dir.join("ide_auth_state_backup.json"), &bytes);
                        }
                    }
                    live_ide_backup = Some(rows);
                }
            }
        }
    }

    let mut existed: Vec<bool> = Vec::with_capacity(mappings.len());
    for m in mappings {
        let present = m.source.exists();
        if present && !copy_atomic(&m.source, &backup_dir.join(m.rel_dest)) {
            return Err(format!(
                "No se pudo respaldar {} (¿archivo en uso?). No se hizo ningún cambio.",
                m.rel_dest
            ));
        }
        existed.push(present);
    }

    // 2. Stage every new file next to its destination.
    let mut staged: Vec<Option<PathBuf>> = Vec::with_capacity(mappings.len());
    for m in mappings {
        let snap = src_dir.join(m.rel_dest);
        if !snap.exists() {
            staged.push(None);
            continue;
        }
        if let Some(parent) = m.source.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = staged_path(&m.source);
        if let Err(e) = fs::copy(&snap, &tmp) {
            let _ = fs::remove_file(&tmp);
            for t in staged.iter().flatten() {
                let _ = fs::remove_file(t);
            }
            return Err(format!(
                "No se pudo preparar {}: {e}. No se hizo ningún cambio.",
                m.rel_dest
            ));
        }
        staged.push(Some(tmp));
    }

    // 3. Commit.
    let mut failure: Option<String> = None;
    for (i, m) in mappings.iter().enumerate() {
        let res = match &staged[i] {
            Some(tmp) => fs::rename(tmp, &m.source),
            None if m.source.exists() => fs::remove_file(&m.source),
            None => Ok(()),
        };
        if let Err(e) = res {
            failure = Some(format!("{}: {e}", m.rel_dest));
            break;
        }
    }

    // 4. Roll back on any failure.
    if let Some(err) = failure {
        for tmp in staged.iter().flatten() {
            let _ = fs::remove_file(tmp);
        }
        restore_mappings_backup(mappings, &existed, &backup_dir);
        return Err(format!("Cambio revertido, falló {err}"));
    }

    // 5. Apply and strictly verify OS credential + sync/clean Antigravity IDE state.vscdb.
    if let Some((raw, expected_ident, ide_snapshot)) = agy_payload {
        if let Err(write_err) = cred_store.write_checked(&raw) {
            restore_mappings_backup(mappings, &existed, &backup_dir);
            return Err(write_err);
        }

        let expected_tokens = crate::quota::extract_antigravity_token_material(&raw);
        let verify_result = cred_store.read_raw().and_then(|verify_raw| {
            let verified_ident =
                crate::quota::parse_antigravity_credential_with_tokens(&verify_raw).ok()?;
            let actual_tokens = crate::quota::extract_antigravity_token_material(&verify_raw);
            if verified_ident.email.eq_ignore_ascii_case(&expected_ident.email)
                && actual_tokens == expected_tokens
                && (actual_tokens.0.is_some() || actual_tokens.1.is_some())
            {
                Some(())
            } else {
                None
            }
        });

        if verify_result.is_none() {
            if let Some(ref prev) = live_agy_backup {
                let _ = cred_store.write_checked(prev);
            }
            restore_mappings_backup(mappings, &existed, &backup_dir);
            return Err("No se pudo verificar la nueva credencial en gemini:antigravity tras escribirla (la identidad o los tokens no coincidieron). Se revirtió al perfil anterior.".to_string());
        }

        if let Some(db_path) = state_vscdb {
            if let Err(sql_err) = crate::quota::apply_ide_auth_state_to_db(
                db_path,
                &expected_ident.email,
                ide_snapshot.as_ref(),
            ) {
                if let Some(ref prev_rows) = live_ide_backup {
                    let _ = crate::quota::restore_ide_auth_rows_to_db(db_path, prev_rows);
                }
                if let Some(ref prev) = live_agy_backup {
                    let _ = cred_store.write_checked(prev);
                }
                restore_mappings_backup(mappings, &existed, &backup_dir);
                return Err(format!(
                    "Cambio revertido porque falló la sincronización de state.vscdb: {sql_err}"
                ));
            }
        }
    }

    prune_backups_in(root, &provider);
    Ok(())
}

pub(crate) fn apply_profile_to_active(provider: &str, account_id: &str) -> Result<(), String> {
    let canon = canon_provider(provider);
    let mappings = get_provider_file_mappings(&canon);
    let state_vscdb = if canon == "agy" {
        crate::quota::find_existing_state_vscdb()
    } else {
        None
    };
    apply_profile_to_active_with(
        &profiles_root(),
        &canon,
        account_id,
        &mappings,
        state_vscdb.as_deref(),
        &LiveAntigravityCredStore,
    )
}
