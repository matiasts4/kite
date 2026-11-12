use serde_json::Value;

pub mod types;
pub mod benchmark;
pub mod sampler;
#[cfg(target_os = "windows")]
pub mod win_process;
#[cfg(target_os = "windows")]
pub mod win_metrics;
#[cfg(test)]
mod tests;

pub use types::*;
pub use benchmark::*;
pub use sampler::*;
#[cfg(target_os = "windows")]
pub use win_metrics::*;

#[tauri::command]
pub fn get_system_metrics(request: Option<Value>) -> Value {
    sampler::get_system_metrics_impl(request)
}

#[tauri::command]
pub fn start_terminal_benchmark(request: Option<Value>) -> Value {
    benchmark::start_terminal_benchmark_impl(request)
}

#[tauri::command]
pub fn stop_terminal_benchmark() -> Value {
    benchmark::stop_terminal_benchmark_impl()
}

#[tauri::command]
pub fn get_terminal_benchmark_sample(request: Option<Value>) -> Value {
    benchmark::get_terminal_benchmark_sample_impl(request)
}

#[tauri::command]
pub fn report_terminal_frontend_metrics(request: Value) -> Value {
    sampler::report_terminal_frontend_metrics_impl(request)
}
