//! Console CLI companion binary (`SUBSYSTEM:CONSOLE`) for Kite Code.
//! Ensures synchronous terminal execution, clean UTF-8 stdout, and exact exit codes.

#[path = "../dispatch/cli_wire.rs"]
mod cli_wire;
#[path = "../ctx_cli.rs"]
mod ctx_cli;

mod persist {
    use std::path::PathBuf;

    pub fn app_data_folder() -> &'static str {
        if cfg!(debug_assertions) {
            "Kite Code Dev"
        } else {
            "Kite Code"
        }
    }

    pub fn roaming_app_dir() -> PathBuf {
        let base = std::env::var("APPDATA")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .map(|home| PathBuf::from(home).join("AppData").join("Roaming"))
                    .unwrap_or_else(|| std::env::temp_dir().join("kite-appdata"))
            });
        base.join(app_data_folder())
    }
}

mod tickets {
    #[path = "../../tickets/document.rs"]
    pub mod document;
    #[path = "../../tickets/storage.rs"]
    pub mod storage;
    #[path = "../../tickets/mcp.rs"]
    pub mod mcp;
}

fn sibling_gui_binary() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let parent = exe.parent()?;
    let name = if cfg!(windows) {
        "kite-code.exe"
    } else {
        "kite-code"
    };
    let candidate = parent.join(name);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("dispatch") {
        let code = cli_wire::run_cli(&args[2..], None);
        std::process::exit(code);
    }
    if args.get(1).map(String::as_str) == Some("ctx") {
        let code = ctx_cli::run_ctx_cli(&args[2..]);
        std::process::exit(code);
    }
    if matches!(
        args.get(1).map(String::as_str),
        Some("mcp" | "mcp-tasks" | "kite-tasks")
    ) {
        tickets::mcp::run_mcp_server(&args[1..]);
        return;
    }

    if let Some(gui) = sibling_gui_binary() {
        let status = std::process::Command::new(&gui).args(&args[1..]).spawn();
        match status {
            Ok(_) => std::process::exit(0),
            Err(err) => {
                eprintln!("Failed to launch Kite Code ({}): {err}", gui.display());
                std::process::exit(1);
            }
        }
    }

    eprintln!("Usage: kite <dispatch|ctx|mcp> ...");
    std::process::exit(2);
}
