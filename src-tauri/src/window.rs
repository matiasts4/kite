use crate::logger::log_trace;

#[tauri::command]
pub fn app_window_minimize(window: tauri::Window) {
    let _ = window.minimize();
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
    crate::terminal::snapshot_and_shutdown_all_terminals("app_window_close");
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
