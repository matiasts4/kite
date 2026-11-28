pub mod antigravity_fallback;
pub mod pipeline;
pub mod post_reply;
pub mod settle;
pub mod spawn;
pub mod state;
pub mod stream_json;
pub mod turn;

pub use pipeline::*;
pub use spawn::*;
pub use state::*;
pub use stream_json::*;
pub use turn::*;

pub use settle::{
    finish_run, finish_run_with_options, heal_orphaned_running_thread,
    heal_orphaned_thread_with_children, heal_orphaned_thread_with_options, settle_routine,
    settle_turn_notification,
};

#[tauri::command]
pub async fn continue_turn_with_handoff(request: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || settle::continue_turn_with_handoff(request))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
