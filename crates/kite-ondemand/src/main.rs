//! Short-lived WebView2 window. The process exits when the window closes.
//! The native deck stays up and does not link this host.

use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let panel = match parse_panel(&args) {
        Ok(panel) => panel,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(2);
        }
    };
    if let Err(err) = run(&panel) {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn parse_panel(args: &[String]) -> Result<String, String> {
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--panel" {
            let name = args.get(index + 1).map(String::as_str).unwrap_or("");
            return match name {
                "settings" | "browser" | "account" => Ok(name.to_string()),
                _ => Err(format!("unknown panel {name}")),
            };
        }
        index += 1;
    }
    Err("missing --panel".into())
}

fn run(panel: &str) -> wry::Result<()> {
    let title = match panel {
        "settings" => "Settings",
        "browser" => "Browser",
        "account" => "Account",
        _ => "Kite",
    };
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title(format!("Kite {title}"))
        .with_inner_size(LogicalSize::new(960.0, 640.0))
        .build(&event_loop)
        .expect("on-demand window");
    let html = panel_html(title, panel);
    let webview = WebViewBuilder::new().with_html(&html).build(&window)?;

    event_loop.run(move |event, _, control_flow| {
        let _keep_webview = &webview;
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}

fn panel_html(title: &str, panel: &str) -> String {
    let body = match panel {
        "settings" => "Settings opens in this window and closes with it. The native deck stays up.",
        "browser" => "The browser dock opens in this window and closes with it. The native deck stays up.",
        "account" => "Account opens in this window and closes with it. The native deck stays up.",
        _ => "This window closes on its own.",
    };
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>
<style>
body {{ margin: 0; background: #0e1116; color: #e6edf3; font: 14px/1.4 sans-serif; }}
main {{ padding: 24px; }}
h1 {{ font-size: 16px; font-weight: 600; margin: 0 0 12px; }}
</style></head><body><main><h1>{title}</h1><p>{body}</p></main></body></html>"#
    )
}
