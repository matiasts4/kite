// Kite Code — Tauri 2 native backend
// Product: Kite Code (dev.kite.code)

#![windows_subsystem = "windows"]

use std::sync::OnceLock;

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn get_app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

pub mod logger;
pub mod hidden_exec;
pub mod persist;
pub mod window;
pub mod session;
pub mod session_resolver;
pub mod terminal;
pub mod agents;
pub mod agent_mind;
pub mod workspaces;
pub mod chat;
pub mod chat_attachments;
pub mod chat_commands;
pub mod browser;
pub mod files;
pub mod routines;
pub mod notifications;
pub mod dictation;
pub mod local_tasks;
pub mod local_autopilot;
pub mod git;
pub mod misc;
pub mod tickets;
pub mod quota;
pub mod updater;
pub mod account_switcher;
pub mod handoff;
pub mod system_metrics;
pub mod acp;
pub mod odd_tasks;
pub mod operator_runtime;
pub mod audio_ducking;
pub mod agent_inbox;
pub mod credentials;
pub mod connections;
pub mod plugins;

use logger::log_trace;
use tauri::Manager;

use acp::*;
use odd_tasks::*;
use operator_runtime::*;
use audio_ducking::*;
use agent_inbox::*;
use connections::*;
use credentials::*;

use account_switcher::*;
use agents::*;
use agent_mind::*;
use browser::*;
use chat::*;
use chat_commands::*;
use dictation::*;
use handoff::*;
use files::*;
use git::*;
use misc::*;
use notifications::*;
use quota::*;
use routines::*;
use session::*;
use system_metrics::*;
use terminal::*;
use tickets::*;
use updater::*;
use window::*;
use workspaces::*;

#[cfg(windows)]
fn register_windows_shutdown_handler() {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler_routine: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }

    unsafe extern "system" fn ctrl_handler(ctrl_type: u32) -> i32 {
        if ctrl_type == 2 || ctrl_type == 5 || ctrl_type == 6 {
            crate::terminal::snapshot_and_shutdown_all_terminals("windows_ctrl_shutdown");
            if let Ok(mut manager) = crate::chat::runtime::session_manager().lock() {
                manager.stop_all();
            }
        }
        0
    }

    unsafe {
        let _ = SetConsoleCtrlHandler(Some(ctrl_handler), 1);
    }
}

fn main() {
    // Load local .env file in development if present
    dotenvy::dotenv().ok();

    // Suppress background auto-updater in Antigravity CLI (`agy.exe`).
    //
    // Root cause analysis (2026-10-18):
    // When `agy` runs (quota check `/usage`, model discovery, etc.), it forks a
    // detached background daemon: `agy.exe --bg-updater`. That daemon in turn calls
    // `agy.exe --version` via standard Go `exec.Command` without `CREATE_NO_WINDOW`
    // (0x08000000). On Windows 11 (22H2+), launching a console subsystem binary from a
    // detached daemon triggers Windows Console Delegation, causing visible terminal/OpenConsole
    // windows to flash on screen.
    //
    // Setting `AGY_CLI_DISABLE_AUTO_UPDATE=true` instructs `agy` to completely bypass
    // the auto-updater check (Go compares `os.Getenv("AGY_CLI_DISABLE_AUTO_UPDATE") == "true"`),
    // eliminating `--bg-updater` and `agy.exe --version` invocations.
    std::env::set_var("AGY_CLI_DISABLE_AUTO_UPDATE", "true");

    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && (args[1] == "mcp" || args[1] == "mcp-tasks" || args[1] == "kite-tasks") {
        crate::tickets::run_mcp_server(&args[1..]);
        return;
    }

    std::panic::set_hook(Box::new(|info| {
        let payload = match info.payload().downcast_ref::<&str>() {
            Some(s) => (*s).to_string(),
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => s.clone(),
                None => format!("{:?}", info.payload()),
            },
        };
        log_trace(&format!("PANIC: {} at {:?}", payload, info.location()));
    }));

    #[cfg(windows)]
    register_windows_shutdown_handler();

    let pid = std::process::id();
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    log_trace(&format!(
        "{} (PID: {}, EXE: {}) main starting",
        if cfg!(debug_assertions) { "Kite Code (Dev)" } else { "Kite Code" },
        pid,
        exe
    ));

    // Ensure dev and release instances NEVER collide on the same WebView2 user data folder
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let identifier = if cfg!(debug_assertions) {
            "dev.kite.code.dev"
        } else {
            "dev.kite.code"
        };
        let webview_dir = std::path::PathBuf::from(&local_app_data)
            .join(identifier)
            .join("EBWebView");

        // Explicitly isolate WebView2 User Data Folder so Dev and Installed never freeze or conflict
        if std::env::var("WEBVIEW2_USER_DATA_FOLDER").is_err() {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_dir);
        }
        log_trace(&format!(
            "[PID {}] WEBVIEW2_USER_DATA_FOLDER = {:?}",
            pid,
            std::env::var("WEBVIEW2_USER_DATA_FOLDER").unwrap_or_default()
        ));

        // Prevent aggressive Chromium background suspension, timer throttling, and occlusion sleeping
        // which causes UI freeze (10s+) when switching back to Kite Code after 3+ minutes in background.
        let base_args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let anti_freeze_args = "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";
        if !base_args.contains("--disable-background-timer-throttling") {
            let merged_args = if base_args.is_empty() {
                anti_freeze_args.to_string()
            } else {
                format!("{base_args} {anti_freeze_args}")
            };
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &merged_args);
            log_trace(&format!("[PID {}] WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = {:?}", pid, merged_args));
        }

        let lock_path = webview_dir.join("Default").join("LOCK");
        if lock_path.exists() {
            // Attempt to remove stale lock only if not held by an active running process
            if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&lock_path) {
                drop(file);
                let res = std::fs::remove_file(&lock_path);
                log_trace(&format!("[PID {}] Removed stale lock {:?}: {:?}", pid, lock_path, res));
            } else {
                log_trace(&format!("[PID {}] Lock {:?} is actively held by a running process", pid, lock_path));
            }
        }
    }

    // The installed and dev builds share one connection registry. Whichever
    // opens first imports the per-install vaults and account profiles once.
    crate::connections::ensure_shared_registry();

    persist::workspaces();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log_trace("Single instance hook triggered: focusing main window");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            log_trace("Setup hook running");
            if let Some(w) = app.get_webview_window("main") {
                if cfg!(debug_assertions) {
                    let _ = w.set_title("Kite Code (Dev)");
                }
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            if !cfg!(debug_assertions) {
                updater::spawn_startup_check(app.handle().clone());
            }
            crate::chat::persistent::start_idle_reaper();
            let windows = app.webview_windows();
            log_trace(&format!("Windows count in setup: {}", windows.len()));
            for (label, w) in &windows {
                log_trace(&format!("Window label: {}, is_visible: {:?}", label, w.is_visible()));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                ) {
                    crate::terminal::snapshot_and_shutdown_all_terminals("main_window_close");
                    crate::audio_ducking::restore_audio_immediate();
                    if let Ok(mut manager) = crate::chat::runtime::session_manager().lock() {
                        manager.stop_all();
                    }
                }
            }
        })
        .on_page_load(|webview, payload| {
            log_trace(&format!("Page load on {}: {:?} -> {}", webview.label(), payload.event(), payload.url()));
        })
        .invoke_handler(tauri::generate_handler![
            abandon_agent_draft,
            accept_agent_draft,
            add_workspace,
            antigravity_list_google_accounts,
            antigravity_set_active_google_account,
            agent_install_open_docs,
            agent_message_inbox,
            agent_messaging_preference,
            set_agent_messaging_preference,
            send_agent_message,
            agent_pane_history,
            agent_pane_resume_choice,
            agent_resume_preferences_get,
            agent_resume_preferences_set,
            agent_usage_save_card,
            agent_usage_snapshot,
            app_window_close,
            app_window_is_maximized,
            app_window_minimize,
            app_window_start_dragging,
            app_window_toggle_maximize,
            apply_voice_import,
            archive_agent_chat_thread,
            archive_chat_thread,
            attach_terminal,
            auth_begin_sign_in,
            auth_bootstrap,
            auth_cancel_sign_in,
            auth_open_privacy,
            auth_open_signup,
            auth_open_terms,
            auth_open_upgrade,
            auth_prewarm_sign_in,
            auth_reopen_sign_in,
            auth_retry_entitlement,
            auth_sign_in_diagnostics,
            auth_sign_out,
            auth_snapshot,
            autopilot_next,
            bootstrap,
            zed_memory_reveal,
            cancel_agent_chat_turn,
            cancel_agent_draft,
            cancel_agent_voice_create,
            cancel_autopilot,
            cancel_chat_turn,
            cancel_dictation,
            cancel_transcript_search,
            close_browser_surface,
            close_files_resource,
            complete_agent_inbox,
            complete_agent_install,
            commit_workspace_changes,
            connect_ssh_workspace,
            control_browser_surface,
            copy_workspace_path,
            create_agent,
            create_agent_chat,
            create_browser_surface,
            create_general_chat,
            create_routine,
            credits_balance,
            delete_agent_chat_thread,
            delete_agent_profile,
            delete_chat_thread,
            delete_launch_preset,
            delete_routine,
            discard_workspace_changes,
            draft_agent_with_ai,
            ensure_files_resource,
            get_agent_availability,
            get_chat_session_status,
            get_subscription_quotas,
            opencode_go_credential_status,
            save_opencode_api_key,
            clear_opencode_api_key,
            insert_terminal_drop_paths,
            insert_terminal_files_entry,
            install_agent_starter,
            launch_workspace_terminals,
            legacy_agent_sessions,
            list_agent_arrangement,
            list_agent_chat_summaries,
            list_agent_profiles,
            list_agent_rail_activity,
            list_agent_starters,
            list_workspace_branches,
            switch_workspace_branch,
            create_workspace_branch,
            list_archived_chats,
            list_chat_provider_models,
            list_chat_summaries,
            list_connections,
            list_dictation_input_devices,
            list_files_directory,
            list_launch_presets,
            list_live_chat_runs,
            list_prompts,
            list_provider_mcp_servers,
            list_provider_agents,
            list_routines,
            list_terminal_profiles,
            load_agent_chat_thread,
            load_agent_mind,
            load_agent_profile,
            load_agent_skill,
            load_chat_thread,
            load_thread_grid,
            load_workspace_layout,
            log_client_message,
            move_agent,
            move_workspace,
            navigate_browser_surface,
            notifications_mark_all_read,
            notifications_mark_read,
            notifications_mark_reviewed,
            notifications_open_system_settings,
            notifications_play_sample,
            notifications_poll,
            notifications_refresh_authorization,
            notifications_report_attention,
            notifications_request_authorization,
            notifications_set_preferences,
            notifications_snapshot,
            open_external_link,
            pick_chat_attachments,
            preview_voice_import,
            poll_agent_inbox,
            probe_agent_availability,
            purge_archived_chat,
            pull_workspace_changes,
            push_workspace_changes,
            read_agent_chat_turn_updates,
            read_agent_voice_create,
            read_agent_voice_input_availability,
            read_browser_surface,
            read_chat_turn_updates,
            read_cwd_relative_text,
            read_dictation,
            read_dictation_availability,
            read_dictation_settings,
            read_files_preview,
            read_files_text,
            read_terminal_output,
            read_workspace_changes,
            read_workspace_file_diff,
            reconnect_ssh_workspace,
            recover_chat_thread,
            release_chat_attachment,
            remove_agent_skill,
            remove_workspace_from_list,
            rename_agent_chat_thread,
            rename_chat_thread,
            rename_workspace,
            reorder_agent_chat_tabs,
            reprobe_agent_availability,
            request_agent_voice_input_permission,
            request_dictation_permission,
            resize_terminal,
            report_terminal_agent_detected,
            resolve_file_link,
            respond_chat_approval,
            restart_agent_terminal_for_autopilot,
            restore_archived_chat,
            resume_prompt_get,
            resume_prompt_answer,
            retry_agent_draft_cleanup,
            reveal_workspace,
            reveal_file,
            open_file_default,
            run_routine_now,
            save_files_text,
            save_launch_preset,
            save_shell_state,
            save_thread_grid,
            save_workspace_layout,
            search_transcripts,
            select_dictation_whisper_model,
            set_agent_chat_model,
            set_agent_chat_plan,
            set_agent_pinned,
            set_app_menu_state,
            set_chat_thread_pinned,
            set_routine_enabled,
            set_workspace_pinned,
            stage_all_workspace_changes,
            stage_chat_blob,
            stage_dropped_chat_attachments,
            stage_terminal_clipboard_image,
            stage_workspace_changes,
            start_agent_chat_turn,
            start_agent_install,
            start_agent_voice_create,
            start_chat_turn,
            start_dictation,
            start_terminal,
            stop_agent_voice_create,
            stop_dictation,
            task_control,
            task_execute,
            task_execution_clear_error,
            task_execution_refresh,
            task_execution_snapshot,
            task_validate_selection,
            telemetry_identity,
            telemetry_preferences,
            terminal_host_status,
            terminal_host_sessions_list,
            terminal_host_session_kill,
            terminal_host_restart,
            terminal_host_set_persistence,
            terminal_host_set_keep_agents_running,
            terminal_host_clear_scrollback,
            terminate_terminal,
            ticket_call,
            ticket_snapshot,
            ticket_connect,
            ticket_configuration,
            ticket_revoke,
            ticket_recover,
            unstage_workspace_changes,
            update_agent_profile,
            update_browser_surface_presentation,
            update_chat_configuration,
            update_check,
            update_configure,
            update_dictation_settings,
            update_routine,
            voice_assistant_prompt,
            voice_context_read,
            voice_live_close,
            voice_live_connect,
            voice_live_send,
            voice_live_session,
            voice_resolve_work,
            write_agent_memory,
            write_agent_skill,
            write_terminal,
            updater_check,
            updater_install,
            updater_restart,
            updater_update_and_restart,
            get_app_version,
            list_saved_accounts,
            list_detected_cli_accounts,
            save_current_account_profile,
            switch_account_profile,
            delete_account_profile,
            get_active_account_profile,
            recommend_continuation_targets,
            get_handoff_preview,
            get_system_metrics,
            continue_turn_with_handoff,
            create_odd_task_file,
            list_odd_task_files,
            update_odd_task_status,
            get_odd_task_content,
            query_operator_agent,
            proxy_operator_http,
            operator_trace_path,
            operator_trace_append,
            operator_duck_audio,
            operator_restore_audio,
            operator_play_cue_sound,
            operator_on_recording_state_change,
            get_provider_credentials,
            get_active_provider_key,
            save_provider_credential,
            delete_provider_credential,
            migrate_localstorage_credentials,
            plugins::plugin_connections,
            plugins::plugin_connection_action,
            plugins::get_plugin_config,
            plugins::save_plugin_config,
        ]);
        let mut context = tauri::generate_context!();
        if cfg!(debug_assertions) {
            context.config_mut().identifier = "dev.kite.code.dev".to_string();
        }
        log_trace(&format!(
            "[PID {}] Building Tauri context with identifier = {}",
            pid,
            context.config().identifier
        ));

        let app = builder
            .build(context)
            .expect("error while building Kite Code application");

    log_trace(&format!("[PID {}] Tauri application built successfully, running event loop", pid));

    app.run(|_app_handle, event| {
        match event {
            tauri::RunEvent::ExitRequested { code, .. } => {
                log_trace(&format!("App ExitRequested with code: {:?}, exiting cleanly", code));
                crate::audio_ducking::restore_audio_immediate();
                crate::terminal::snapshot_and_shutdown_all_terminals("run_event_exit_requested");
                if let Ok(mut manager) = crate::chat::runtime::session_manager().lock() {
                    manager.stop_all();
                }
            }
            tauri::RunEvent::Exit => {
                log_trace("App RunEvent::Exit, ensuring all terminals are snapshotted");
                crate::audio_ducking::restore_audio_immediate();
                crate::terminal::snapshot_and_shutdown_all_terminals("run_event_exit");
                if let Ok(mut manager) = crate::chat::runtime::session_manager().lock() {
                    manager.stop_all();
                }
            }
            tauri::RunEvent::MainEventsCleared => {
                // Do NOT log MainEventsCleared. It triggers dozens of times per second,
                // and writing synchronously to app.log on disk blocks the main UI message pump.
            }
            _other => {}
        }
    });
}
