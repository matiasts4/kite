//! Console CLI companion binary (`SUBSYSTEM:CONSOLE`) for Kite Code.
//! Ensures synchronous terminal execution, clean UTF-8 stdout, and exact exit codes.

#[path = "../dispatch/cli_wire.rs"]
mod cli_wire;

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

    eprintln!("Usage: kite dispatch <ls|programs|providers|models|run|send|wait|read|report|swarm|kill|interrupt|keys|attach|skill> ...");
    std::process::exit(2);
}
