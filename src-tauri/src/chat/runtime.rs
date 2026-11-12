pub mod pipeline;
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

pub use settle::{finish_run, settle_routine, settle_turn_notification};

#[tauri::command]
pub fn continue_turn_with_handoff(request: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    settle::continue_turn_with_handoff(request)
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
