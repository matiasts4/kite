use crate::logger::log_trace;
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

#[tauri::command]
pub fn app_window_minimize(window: tauri::Window) {
    use tauri::Emitter;
    let _ = window.minimize();
    let _ = window.emit(
        "kite:window-state",
        serde_json::json!({ "minimized": true, "focused": false }),
    );
}

#[tauri::command]
pub fn app_window_toggle_maximize(window: tauri::Window) {
    if let Ok(max) = window.is_maximized() {
        if max {
            let _ = window.unmaximize();
        } else {
            let _ = window.maximize();
        }
    }
}

#[tauri::command]
pub fn app_window_close(window: tauri::Window) {
    log_trace("Invoked: app_window_close()");
    // Detach the GUI from the persistent core instead of killing live PTYs.
    crate::core_daemon::on_client_window_close();
    let _ = window.close();
}

#[tauri::command]
pub fn app_window_start_dragging(window: tauri::Window) {
    let _ = window.start_dragging();
}

#[tauri::command]
pub fn app_window_is_maximized(window: tauri::Window) -> bool {
    window.is_maximized().unwrap_or(false)
}

// ---------------------------------------------------------------------------
// S8 — OS-Level Global Companion Shortcut (`Alt+Space` default)
// ---------------------------------------------------------------------------

pub const DEFAULT_COMPANION_SHORTCUT: &str = "Alt+Space";
pub const COMPANION_HOTKEY_EVENT: &str = "kite:companion-global-hotkey";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedGlobalShortcut {
    pub normalized: String,
    pub modifiers: u32,
    pub vk: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionShortcutRegistrationStatus {
    pub shortcut: String,
    pub registered: bool,
    pub supported: bool,
    pub fallback: String,
    pub error: Option<String>,
}

struct GlobalShortcutRuntimeState {
    shortcut: String,
    registered: bool,
    app_handle: Option<tauri::AppHandle>,
    #[cfg(windows)]
    thread_id: Option<u32>,
    #[cfg(windows)]
    join_handle: Option<std::thread::JoinHandle<()>>,
}

static SHORTCUT_STATE: OnceLock<Mutex<GlobalShortcutRuntimeState>> = OnceLock::new();

fn shortcut_state() -> &'static Mutex<GlobalShortcutRuntimeState> {
    SHORTCUT_STATE.get_or_init(|| {
        Mutex::new(GlobalShortcutRuntimeState {
            shortcut: DEFAULT_COMPANION_SHORTCUT.to_string(),
            registered: false,
            app_handle: None,
            #[cfg(windows)]
            thread_id: None,
            #[cfg(windows)]
            join_handle: None,
        })
    })
}

const MOD_ALT_FLAG: u32 = 0x0001;
const MOD_CONTROL_FLAG: u32 = 0x0002;
const MOD_SHIFT_FLAG: u32 = 0x0004;
const MOD_WIN_FLAG: u32 = 0x0008;
const MOD_NOREPEAT_FLAG: u32 = 0x4000;

pub fn parse_global_shortcut(spec: &str) -> Result<ParsedGlobalShortcut, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("Shortcut cannot be empty".to_string());
    }

    let mut modifiers: u32 = 0;
    let mut mod_labels: Vec<&'static str> = Vec::new();
    let mut key_vk: Option<u32> = None;
    let mut key_label: Option<String> = None;

    for raw_part in trimmed.split('+') {
        let part = raw_part.trim();
        if part.is_empty() {
            continue;
        }
        let lower = part.to_ascii_lowercase();
        match lower.as_str() {
            "alt" | "option" => {
                if modifiers & MOD_ALT_FLAG == 0 {
                    modifiers |= MOD_ALT_FLAG;
                    mod_labels.push("Alt");
                }
            }
            "ctrl" | "control" => {
                if modifiers & MOD_CONTROL_FLAG == 0 {
                    modifiers |= MOD_CONTROL_FLAG;
                    mod_labels.push("Ctrl");
                }
            }
            "shift" => {
                if modifiers & MOD_SHIFT_FLAG == 0 {
                    modifiers |= MOD_SHIFT_FLAG;
                    mod_labels.push("Shift");
                }
            }
            "meta" | "win" | "super" | "cmd" => {
                if modifiers & MOD_WIN_FLAG == 0 {
                    modifiers |= MOD_WIN_FLAG;
                    mod_labels.push("Meta");
                }
            }
            _ => {
                if key_vk.is_some() {
                    return Err(format!("Multiple primary keys in shortcut '{spec}'"));
                }
                let (vk, label) = parse_primary_key(&lower)?;
                key_vk = Some(vk);
                key_label = Some(label);
            }
        }
    }

    let vk = key_vk.ok_or_else(|| format!("Shortcut '{spec}' is missing a primary key"))?;
    let label = key_label.unwrap_or_default();
    if modifiers == 0 && !(0x70..=0x7B).contains(&vk) {
        return Err(format!(
            "Shortcut '{spec}' must include a modifier (Alt, Ctrl, Shift, or Meta)"
        ));
    }

    let mut parts: Vec<String> = mod_labels.into_iter().map(str::to_string).collect();
    parts.push(label);

    Ok(ParsedGlobalShortcut {
        normalized: parts.join("+"),
        modifiers: modifiers | MOD_NOREPEAT_FLAG,
        vk,
    })
}

fn parse_primary_key(lower: &str) -> Result<(u32, String), String> {
    match lower {
        "space" | "spacebar" => Ok((0x20, "Space".to_string())),
        "enter" | "return" => Ok((0x0D, "Enter".to_string())),
        "tab" => Ok((0x09, "Tab".to_string())),
        "esc" | "escape" => Ok((0x1B, "Escape".to_string())),
        _ if lower.len() == 1 => {
            let ch = lower.chars().next().unwrap();
            if ch.is_ascii_alphanumeric() {
                let upper = ch.to_ascii_uppercase();
                Ok((upper as u32, upper.to_string()))
            } else {
                Err(format!("Unsupported key '{lower}'"))
            }
        }
        _ if lower.starts_with("key") && lower.len() == 4 => {
            let ch = lower.chars().nth(3).unwrap();
            if ch.is_ascii_alphabetic() {
                let upper = ch.to_ascii_uppercase();
                Ok((upper as u32, upper.to_string()))
            } else {
                Err(format!("Unsupported key '{lower}'"))
            }
        }
        _ if lower.starts_with('f') && lower.len() >= 2 && lower.len() <= 3 => {
            let num: u32 = lower[1..]
                .parse()
                .map_err(|_| format!("Unsupported function key '{lower}'"))?;
            if (1..=12).contains(&num) {
                Ok((0x6F + num, format!("F{num}")))
            } else {
                Err(format!("Unsupported function key '{lower}'"))
            }
        }
        _ => Err(format!("Unsupported key '{lower}'")),
    }
}

#[cfg(windows)]
mod win_hotkey {
    use super::{COMPANION_HOTKEY_EVENT, ParsedGlobalShortcut};
    use std::ffi::c_void;
    use std::sync::mpsc;
    use tauri::{Emitter, Manager};

    const HOTKEY_ID: i32 = 0x4B49; // "KI"
    const WM_HOTKEY: u32 = 0x0312;
    const WM_QUIT: u32 = 0x0012;

    #[repr(C)]
    #[derive(Default)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct Msg {
        hwnd: *mut c_void,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt: Point,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterHotKey(hwnd: *mut c_void, id: i32, fs_modifiers: u32, vk: u32) -> i32;
        fn UnregisterHotKey(hwnd: *mut c_void, id: i32) -> i32;
        fn GetMessageW(lp_msg: *mut Msg, hwnd: *mut c_void, min: u32, max: u32) -> i32;
        fn PostThreadMessageW(id_thread: u32, msg: u32, wparam: usize, lparam: isize) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
        fn GetLastError() -> u32;
    }

    pub fn post_quit_to_thread(thread_id: u32) {
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
        }
    }

    pub fn spawn_hotkey_listener(
        app: tauri::AppHandle,
        parsed: ParsedGlobalShortcut,
    ) -> Result<(u32, std::thread::JoinHandle<()>), String> {
        let (tx, rx) = mpsc::channel::<Result<u32, String>>();
        let shortcut_label = parsed.normalized.clone();

        let join_handle = std::thread::Builder::new()
            .name("kite-companion-hotkey".to_string())
            .spawn(move || unsafe {
                let tid = GetCurrentThreadId();
                let ok = RegisterHotKey(
                    std::ptr::null_mut(),
                    HOTKEY_ID,
                    parsed.modifiers,
                    parsed.vk,
                );
                if ok == 0 {
                    let err = GetLastError();
                    let _ = tx.send(Err(format!("hotkey_in_use (win32 error {err})")));
                    return;
                }
                let _ = tx.send(Ok(tid));

                let mut msg = Msg::default();
                while GetMessageW(&mut msg as *mut Msg, std::ptr::null_mut(), 0, 0) > 0 {
                    if msg.message == WM_HOTKEY && msg.wparam == HOTKEY_ID as usize {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                        let _ = app.emit(
                            COMPANION_HOTKEY_EVENT,
                            serde_json::json!({
                                "shortcut": shortcut_label,
                                "source": "os-global-hotkey",
                            }),
                        );
                    }
                }

                let _ = UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
            })
            .map_err(|e| format!("Failed to spawn hotkey listener thread: {e}"))?;

        match rx.recv() {
            Ok(Ok(tid)) => Ok((tid, join_handle)),
            Ok(Err(err)) => {
                let _ = join_handle.join();
                Err(err)
            }
            Err(_) => {
                let _ = join_handle.join();
                Err("Hotkey listener exited before reporting status".to_string())
            }
        }
    }
}

fn stop_existing_hotkey_listener_locked(state: &mut GlobalShortcutRuntimeState) {
    #[cfg(windows)]
    {
        if let Some(tid) = state.thread_id.take() {
            win_hotkey::post_quit_to_thread(tid);
        }
        if let Some(handle) = state.join_handle.take() {
            let _ = handle.join();
        }
    }
    state.registered = false;
}

pub fn init_companion_global_shortcut(app: tauri::AppHandle) {
    {
        let mut state = shortcut_state().lock().unwrap();
        state.app_handle = Some(app.clone());
    }
    let _ = apply_companion_global_shortcut(DEFAULT_COMPANION_SHORTCUT, Some(app));
}

fn apply_companion_global_shortcut(
    spec: &str,
    app_override: Option<tauri::AppHandle>,
) -> CompanionShortcutRegistrationStatus {
    let parsed = match parse_global_shortcut(spec) {
        Ok(p) => p,
        Err(err) => {
            return CompanionShortcutRegistrationStatus {
                shortcut: spec.to_string(),
                registered: false,
                supported: cfg!(windows),
                fallback: "window-local".to_string(),
                error: Some(err),
            };
        }
    };

    let mut state = shortcut_state().lock().unwrap();
    if let Some(app) = app_override {
        state.app_handle = Some(app);
    }
    stop_existing_hotkey_listener_locked(&mut state);
    state.shortcut = parsed.normalized.clone();

    #[cfg(windows)]
    {
        if let Some(app) = state.app_handle.clone() {
            match win_hotkey::spawn_hotkey_listener(app, parsed.clone()) {
                Ok((tid, handle)) => {
                    state.thread_id = Some(tid);
                    state.join_handle = Some(handle);
                    state.registered = true;
                    return CompanionShortcutRegistrationStatus {
                        shortcut: parsed.normalized,
                        registered: true,
                        supported: true,
                        fallback: "os-global".to_string(),
                        error: None,
                    };
                }
                Err(err) => {
                    return CompanionShortcutRegistrationStatus {
                        shortcut: parsed.normalized,
                        registered: false,
                        supported: true,
                        fallback: "window-local".to_string(),
                        error: Some(err),
                    };
                }
            }
        }
        return CompanionShortcutRegistrationStatus {
            shortcut: parsed.normalized,
            registered: false,
            supported: true,
            fallback: "window-local".to_string(),
            error: Some("app_handle_uninitialized".to_string()),
        };
    }

    #[cfg(not(windows))]
    {
        CompanionShortcutRegistrationStatus {
            shortcut: parsed.normalized,
            registered: false,
            supported: false,
            fallback: "window-local".to_string(),
            error: None,
        }
    }
}

#[tauri::command]
pub fn register_companion_global_shortcut(
    app: tauri::AppHandle,
    shortcut: Option<String>,
) -> CompanionShortcutRegistrationStatus {
    let spec = shortcut
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_COMPANION_SHORTCUT);
    apply_companion_global_shortcut(spec, Some(app))
}

#[tauri::command]
pub fn unregister_companion_global_shortcut() -> CompanionShortcutRegistrationStatus {
    let mut state = shortcut_state().lock().unwrap();
    stop_existing_hotkey_listener_locked(&mut state);
    CompanionShortcutRegistrationStatus {
        shortcut: state.shortcut.clone(),
        registered: false,
        supported: cfg!(windows),
        fallback: "window-local".to_string(),
        error: None,
    }
}

#[tauri::command]
pub fn get_companion_global_shortcut() -> CompanionShortcutRegistrationStatus {
    let state = shortcut_state().lock().unwrap();
    CompanionShortcutRegistrationStatus {
        shortcut: state.shortcut.clone(),
        registered: state.registered,
        supported: cfg!(windows),
        fallback: if state.registered {
            "os-global".to_string()
        } else {
            "window-local".to_string()
        },
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_global_shortcuts_and_normalizes_modifiers() {
        let alt_space = parse_global_shortcut("alt + space").expect("Alt+Space should parse");
        assert_eq!(alt_space.normalized, "Alt+Space");
        assert_eq!(alt_space.vk, 0x20);
        assert_eq!(alt_space.modifiers, MOD_ALT_FLAG | MOD_NOREPEAT_FLAG);

        let ctrl_shift_k = parse_global_shortcut("Control+Shift+k").expect("Ctrl+Shift+K should parse");
        assert_eq!(ctrl_shift_k.normalized, "Ctrl+Shift+K");
        assert_eq!(ctrl_shift_k.vk, 'K' as u32);
        assert_eq!(
            ctrl_shift_k.modifiers,
            MOD_CONTROL_FLAG | MOD_SHIFT_FLAG | MOD_NOREPEAT_FLAG
        );

        let f9 = parse_global_shortcut("F9").expect("Standalone F9 should parse");
        assert_eq!(f9.normalized, "F9");
        assert_eq!(f9.vk, 0x78);
    }

    #[test]
    fn rejects_empty_modifierless_or_multi_key_shortcuts() {
        assert!(parse_global_shortcut("").is_err());
        assert!(parse_global_shortcut("Alt+").is_err());
        assert!(parse_global_shortcut("Space").is_err());
        assert!(parse_global_shortcut("Alt+Ctrl+K+M").is_err());
    }

    #[test]
    fn get_companion_global_shortcut_reports_default_status_safely() {
        let status = get_companion_global_shortcut();
        assert!(!status.shortcut.is_empty());
        assert!(!status.fallback.is_empty());
    }
}
