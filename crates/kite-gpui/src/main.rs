use kite_gpui::headless::{self, LaunchArgs};

fn main() {
    let args = LaunchArgs::parse(&std::env::args().skip(1).collect::<Vec<_>>());
    let wants_window = args.window && !args.headless;
    if !wants_window {
        if args.attach_session.is_some()
            || args.hold_seconds > 0
            || args.ensure_panes > 0
            || args.terminate_bench
        {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            if let Err(err) = runtime.block_on(headless::run_connected(args)) {
                eprintln!("{err}");
                std::process::exit(1);
            }
            return;
        }
        headless::run(args);
        return;
    }
    #[cfg(feature = "gpu")]
    {
        kite_gpui::gpu_app::run(args);
    }
    #[cfg(not(feature = "gpu"))]
    {
        eprintln!("This build has no GPU window. Re-run with --features gpu, or pass --headless.");
        headless::run(args);
    }
}
