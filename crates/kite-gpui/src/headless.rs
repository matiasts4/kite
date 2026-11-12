//! Headless deck used by tests, benchmarks, and the process that has no GPU feature.

use std::time::{Duration, Instant};

use serde_json::json;

use crate::shell::NativeDeck;
use crate::terminal_view::GpuiTerminalView;

const BENCH_SESSION_PREFIX: &str = "gpui-bench-";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanePaint {
    pub session_id: String,
    pub title: String,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaintState {
    pub panes: Vec<PanePaint>,
    pub sessions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeckEvent {
    Paint(PaintState),
    Status(String),
}

pub fn paint_state(deck: &NativeDeck) -> PaintState {
    PaintState {
        sessions: deck.views.iter().map(|view| view.session_id.clone()).collect(),
        panes: deck
            .views
            .iter()
            .map(|view| PanePaint {
                session_id: view.session_id.clone(),
                title: view.title.clone().unwrap_or_else(|| view.session_id.clone()),
                lines: crate::terminal_view::pane_lines(view),
            })
            .collect(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamMode {
    Off,
    Spinner,
    Log,
}

#[derive(Clone, Debug)]
pub struct LaunchArgs {
    pub attach_session: Option<String>,
    pub workspace: String,
    pub headless: bool,
    pub hold_seconds: u64,
    pub paint_hz: u32,
    pub window: bool,
    pub ensure_panes: u32,
    pub stream: StreamMode,
    pub terminate_bench: bool,
}

impl LaunchArgs {
    pub fn parse(args: &[String]) -> Self {
        let mut parsed = Self {
            attach_session: None,
            workspace: String::new(),
            headless: false,
            hold_seconds: 0,
            paint_hz: 0,
            window: false,
            ensure_panes: 0,
            stream: StreamMode::Off,
            terminate_bench: false,
        };
        let mut index = 0;
        while index < args.len() {
            let arg = args[index].as_str();
            let next = args.get(index + 1).map(String::as_str);
            match arg {
                "--attach-session" => {
                    parsed.attach_session = next.map(str::to_string);
                    index += 2;
                }
                "--workspace" => {
                    parsed.workspace = next.unwrap_or("").to_string();
                    index += 2;
                }
                "--headless" => {
                    parsed.headless = true;
                    index += 1;
                }
                "--window" => {
                    parsed.window = true;
                    index += 1;
                }
                "--hold-seconds" => {
                    parsed.hold_seconds = next.and_then(|value| value.parse().ok()).unwrap_or(0);
                    index += 2;
                }
                "--paint-hz" => {
                    parsed.paint_hz = next.and_then(|value| value.parse().ok()).unwrap_or(0);
                    index += 2;
                }
                "--ensure-panes" => {
                    parsed.ensure_panes = next.and_then(|value| value.parse().ok()).unwrap_or(0);
                    index += 2;
                }
                "--stream" => {
                    parsed.stream = match next.unwrap_or("") {
                        "spinner" => StreamMode::Spinner,
                        "log" => StreamMode::Log,
                        _ => StreamMode::Off,
                    };
                    index += 2;
                }
                "--terminate-bench-sessions" => {
                    parsed.terminate_bench = true;
                    index += 1;
                }
                _ => index += 1,
            }
        }
        parsed
    }
}

fn stream_input(mode: StreamMode) -> Option<String> {
    match mode {
        StreamMode::Off => None,
        StreamMode::Spinner => Some(
            "1..2200 | ForEach-Object { Write-Host -NoNewline ([char]9608); Start-Sleep -Milliseconds 33 }\r"
                .to_string(),
        ),
        StreamMode::Log => Some(
            "1..200000 | ForEach-Object { Write-Host ('log {0:d6} {1}' -f $_, ('x'*80)) }\r".to_string(),
        ),
    }
}

pub fn run(args: LaunchArgs) {
    let mut deck = NativeDeck::new(&args.workspace);
    if let Some(session) = &args.attach_session {
        let _ = deck.attach_pane(GpuiTerminalView::new(1, session.clone(), 120, 36));
    }
    println!(
        "kite-gpui deck panes={} workspace={} headless={}",
        deck.views.len(),
        args.workspace,
        args.headless || args.hold_seconds > 0
    );

    if args.hold_seconds == 0 && args.paint_hz == 0 {
        return;
    }

    let started = Instant::now();
    let deadline = started + Duration::from_secs(args.hold_seconds.max(1));
    let frame = if args.paint_hz == 0 {
        Duration::from_secs(60)
    } else {
        Duration::from_millis((1000 / args.paint_hz.max(1)) as u64)
    };
    let mut paints = 0u64;
    let mut paint_us = Vec::new();
    while Instant::now() < deadline {
        if args.paint_hz > 0 {
            let sample = Instant::now();
            for view in &mut deck.views {
                view.note_typed(sample);
            }
            paints += 1;
            paint_us.push(sample.elapsed().as_micros());
            std::thread::sleep(frame);
        } else {
            let remaining = deadline.saturating_duration_since(Instant::now());
            std::thread::sleep(remaining.min(Duration::from_millis(250)));
        }
    }
    paint_us.sort_unstable();
    let p99 = paint_us.last().copied().unwrap_or(0);
    println!(
        "{{\"event\":\"kite-gpui-hold\",\"panes\":{},\"paints\":{paints},\"paintP99Us\":{p99}}}",
        deck.views.len()
    );
}

pub async fn run_connected(args: LaunchArgs) -> Result<(), String> {
    drive(args, |_| {}).await
}

pub async fn drive(args: LaunchArgs, mut on_event: impl FnMut(DeckEvent)) -> Result<(), String> {
    let mut deck = NativeDeck::new(&args.workspace);
    match crate::core_client::connect().await {
        Ok(mut client) => {
            eprintln!(
                "kite-gpui connected to core pid {} ({} sessions)",
                client.handshake.core_pid, client.handshake.active_sessions
            );
            let mut created: Vec<String> = Vec::new();
            if args.terminate_bench {
                if let Ok(sessions) = client.list_sessions().await {
                    for session in sessions {
                        if session.session_id.starts_with(BENCH_SESSION_PREFIX) {
                            match client
                                .call("session.terminate", json!({ "sessionId": session.session_id }))
                                .await
                            {
                                Ok(result) => eprintln!("terminated {}: {result}", session.session_id),
                                Err(err) => eprintln!("terminate {} failed: {err}", session.session_id),
                            }
                        }
                    }
                }
                return Ok(());
            }
            if args.ensure_panes > 0 {
                for index in 1..=args.ensure_panes {
                    let session_id = format!("{BENCH_SESSION_PREFIX}{index}");
                    match client
                        .create_session(json!({
                            "sessionId": session_id,
                            "cols": 120,
                            "rows": 36
                        }))
                        .await
                    {
                        Ok(result) => {
                            let channel_id = result.get("channelId").and_then(|value| value.as_u64()).unwrap_or(0);
                            eprintln!("created {session_id} channel={channel_id}");
                            if channel_id > 0 {
                                let _ = deck.attach_pane(GpuiTerminalView::new(
                                    channel_id as u32,
                                    session_id.clone(),
                                    120,
                                    36,
                                ));
                            }
                            created.push(session_id);
                        }
                        Err(err) => eprintln!("create {session_id} failed: {err}"),
                    }
                }
            } else if let Ok(sessions) = client.list_sessions().await {
                deck.sidebar.replace_sessions(&sessions);
                let wanted = args.attach_session.clone();
                let chosen: Vec<_> = sessions
                    .into_iter()
                    .filter(|session| wanted.as_ref().map(|id| &session.session_id == id).unwrap_or(true))
                    .take(3)
                    .collect();
                for session in &chosen {
                    match client.attach(&session.session_id, 120, 36, true).await {
                        Ok(attached) => {
                            let _ = deck.attach_pane(GpuiTerminalView::new(
                                attached.channel_id,
                                attached.session_id,
                                120,
                                36,
                            ));
                        }
                        Err(err) => eprintln!("attach {} failed: {err}", session.session_id),
                    }
                }
            }
            if let Some(input) = stream_input(args.stream) {
                tokio::time::sleep(Duration::from_millis(400)).await;
                for session_id in &created {
                    match client
                        .call(
                            "session.write",
                            json!({ "sessionId": session_id, "input": input }),
                        )
                        .await
                    {
                        Ok(_) => eprintln!("stream started {session_id}"),
                        Err(err) => eprintln!("stream {session_id} failed: {err}"),
                    }
                }
            }
            let emit_paint = args.window && !args.headless;
            eprintln!("kite-gpui panes={}", deck.views.len());
            if emit_paint {
                on_event(DeckEvent::Status(format!("{} panes", deck.views.len())));
                on_event(DeckEvent::Paint(paint_state(&deck)));
            }
            let hold_deadline = (args.hold_seconds > 0)
                .then(|| Instant::now() + Duration::from_secs(args.hold_seconds));
            loop {
                if hold_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    break;
                }
                let now = Instant::now();
                if deck.clock.due(now) {
                    let credits = deck.tick(now);
                    if !credits.is_empty() && emit_paint {
                        on_event(DeckEvent::Paint(paint_state(&deck)));
                    }
                    for reply in credits {
                        let _ = client.write_frame(&reply).await;
                    }
                }
                let credit_wait = deck.clock.wait_until(Instant::now());
                let hold_wait = hold_deadline.filter(|deadline| *deadline > Instant::now());
                tokio::select! {
                    frame = client.read_frame() => {
                        match frame {
                            Ok(frame) if frame.kind == crate::core_client::FrameKind::SnapshotBin => {
                                let now = Instant::now();
                                if let Ok(outbound) = deck.ingest(frame.channel_id, &frame.payload, now) {
                                    let immediate = !outbound.is_empty();
                                    for reply in outbound {
                                        let _ = client.write_frame(&reply).await;
                                    }
                                    if immediate && emit_paint {
                                        on_event(DeckEvent::Paint(paint_state(&deck)));
                                    }
                                }
                            }
                            Ok(_) => {}
                            Err(err) => {
                                let message = format!("kite-gpui read ended: {err}");
                                eprintln!("{message}");
                                if emit_paint {
                                    on_event(DeckEvent::Status(message));
                                }
                                break;
                            }
                        }
                    }
                    _ = tokio::time::sleep(credit_wait.map(|due| due.saturating_duration_since(Instant::now())).unwrap_or(Duration::from_secs(86_400))), if credit_wait.is_some() => {}
                    _ = tokio::time::sleep(hold_wait.map(|due| due.saturating_duration_since(Instant::now())).unwrap_or(Duration::from_secs(86_400))), if hold_wait.is_some() => {
                        break;
                    }
                }
            }
            eprintln!("kite-gpui hold ended panes={}", deck.views.len());
            for session_id in &created {
                match client
                    .call("session.terminate", json!({ "sessionId": session_id }))
                    .await
                {
                    Ok(result) => eprintln!("terminated {session_id}: {result}"),
                    Err(err) => eprintln!("terminate {session_id} failed: {err}"),
                }
            }
            Ok(())
        }
        Err(err) => {
            let message = format!("kite-gpui core connect: {err}");
            eprintln!("{message}");
            on_event(DeckEvent::Status(message));
            if !args.window {
                run(args);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{LaunchArgs, StreamMode};

    #[test]
    fn parse_bench_flags() {
        let args = LaunchArgs::parse(&[
            "--ensure-panes".to_string(),
            "3".to_string(),
            "--stream".to_string(),
            "log".to_string(),
            "--terminate-bench-sessions".to_string(),
        ]);
        assert_eq!(args.ensure_panes, 3);
        assert_eq!(args.stream, StreamMode::Log);
        assert!(args.terminate_bench);
    }
}
