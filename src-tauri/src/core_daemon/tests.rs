use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::core_wire::{
    decode_rpc_payload, encode_credit_frame, encode_rpc_frame, Frame, FrameKind, FrameStreamDecoder,
};
use crate::terminal::get_terminals;

use super::client::*;
use super::server::*;
use super::*;

fn test_session(prefix: &str) -> String {
    format!("{}-{}", prefix, uuid::Uuid::new_v4())
}

fn start_test_terminal(session_id: &str, cols: u16, rows: u16) -> Value {
    crate::terminal::start_terminal_sync(json!({
        "sessionId": session_id,
        "engine": "powershell",
        "cols": cols,
        "rows": rows,
        "confirmedByBuilder": true
    }))
}

#[test]
fn development_build_uses_its_own_daemon_pipe() {
    let stem = core_pipe_stem();
    let other = if stem == "kite-core-v1-dev" {
        "kite-core-v1"
    } else {
        "kite-core-v1-dev"
    };
    let pipe = format!(r"\\.\pipe\{stem}-alice");
    let foreign = format!(r"\\.\pipe\{other}-alice");
    assert_ne!(pipe, foreign);
    assert!(pipe.contains(stem));
    if cfg!(debug_assertions) {
        assert_eq!(stem, "kite-core-v1-dev");
    } else {
        assert_eq!(stem, "kite-core-v1");
    }
}

#[test]
fn test_core_token_generation_and_validation() {
    let token = get_or_create_core_token();
    assert!(!token.is_empty());
    assert!(validate_core_token(&token));
    assert!(!validate_core_token("bad_token_12345"));
}

#[test]
fn test_control_rpc_session_list() {
    let mut channels = HashMap::new();
    let res = handle_control_rpc_request("session.list", None, &mut channels).unwrap();
    assert!(res.get("sessions").is_some());
}

#[test]
fn test_handshake_roundtrip_json() {
    let req = CoreHandshakeRequest {
        protocol: CORE_PROTOCOL_VERSION.to_string(),
        framed: true,
        client: "kite-desktop".to_string(),
        pid: 12345,
        auth_token: "test_token".to_string(),
    };
    let line = serde_json::to_string(&req).unwrap();
    let parsed: CoreHandshakeRequest = serde_json::from_str(&line).unwrap();
    assert_eq!(parsed.protocol, "kite-core/v1");
    assert_eq!(parsed.pid, 12345);
}

#[test]
fn session_rpc_reports_the_real_root_pid_and_terminate_is_idempotent() {
    let session_id = test_session("test-core-create");
    let mut channels = HashMap::new();
    let created = handle_control_rpc_request(
        "session.create",
        Some(json!({
            "sessionId": session_id,
            "engine": "powershell",
            "cols": 52,
            "rows": 14
        })),
        &mut channels,
    )
    .expect("session.create");

    let root_pid = created["rootPid"].as_u64().unwrap_or(0);
    assert!(root_pid > 0, "session.create must report the PTY root pid");
    assert!(created["spawnedAtUnixMs"].as_i64().unwrap_or(0) > 0);
    let channel_id = created["channelId"].as_u64().unwrap() as u32;
    assert!(channels.contains_key(&channel_id));

    let listed = handle_control_rpc_request("session.list", None, &mut channels).unwrap();
    let entry = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["sessionId"] == json!(session_id))
        .expect("session listed")
        .clone();
    assert_eq!(entry["rootPid"].as_u64().unwrap(), root_pid);

    let attached = handle_control_rpc_request(
        "session.attach",
        Some(json!({ "sessionId": session_id, "live": true })),
        &mut channels,
    )
    .expect("session.attach");
    assert_eq!(attached["rootPid"].as_u64().unwrap(), root_pid);

    let first = handle_control_rpc_request(
        "session.terminate",
        Some(json!({ "sessionId": session_id })),
        &mut channels,
    )
    .unwrap();
    assert_eq!(first["terminated"], true);

    let second = handle_control_rpc_request(
        "session.terminate",
        Some(json!({ "sessionId": session_id })),
        &mut channels,
    )
    .unwrap();
    assert_eq!(
        second["terminated"], false,
        "an idempotent second terminate must not report a termination"
    );
}

#[test]
fn replenish_terminal_credit_meters_a_session_until_the_next_grant() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let key = test_session("test-credit");

    let granted = runtime.block_on(replenish_terminal_credit(Some(json!({
        "sessionId": key,
        "amount": 1
    }))));
    assert_eq!(granted["granted"], 1);
    assert!(
        try_consume_session_snapshot_credit(&key),
        "the grant must arm exactly one snapshot"
    );
    assert!(
        !try_consume_session_snapshot_credit(&key),
        "a single grant must not arm a second snapshot"
    );
    assert!(!has_session_snapshot_credit(&key));

    let reopened = runtime.block_on(replenish_terminal_credit(Some(json!({
        "sessionId": key,
        "amount": 2
    }))));
    assert_eq!(reopened["woken"], true, "an exhausted tracker must wake");
    assert!(try_consume_session_snapshot_credit(&key));
    assert!(try_consume_session_snapshot_credit(&key));
    assert!(!try_consume_session_snapshot_credit(&key));
}

#[test]
fn legacy_unmetered_sessions_keep_emitting_snapshots() {
    let key = test_session("test-unmetered");
    for _ in 0..5 {
        assert!(try_consume_session_snapshot_credit(&key));
    }
    assert!(has_session_snapshot_credit(&key));
}

async fn read_line_async<R: AsyncRead + Unpin>(reader: &mut R) -> Result<String, String> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = reader.read(&mut byte).await.map_err(|err| err.to_string())?;
        if read == 0 || byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    String::from_utf8(line).map_err(|err| err.to_string())
}

#[test]
fn pipe_client_handshake_attach_and_delta_loop() {
    let session_id = test_session("test-core-pipe");
    let started = start_test_terminal(&session_id, 40, 10);
    assert!(started["rootPid"].as_u64().unwrap_or(0) > 0);
    // Let the PTY reader publish the first prompt.
    std::thread::sleep(Duration::from_millis(600));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();

    runtime.block_on(async {
        let (client, server) = tokio::io::duplex(512 * 1024);
        let token = get_or_create_core_token();
        let server_task = tokio::spawn(handle_stream_client(server, token.clone()));
        let (mut reader, mut writer) = tokio::io::split(client);

        let handshake = json!({
            "protocol": CORE_PROTOCOL_VERSION,
            "framed": true,
            "client": "kite-test",
            "pid": std::process::id(),
            "authToken": token,
        });
        writer
            .write_all(format!("{}\n", handshake).as_bytes())
            .await
            .unwrap();
        let reply_line = read_line_async(&mut reader).await.unwrap();
        let reply: CoreHandshakeResponse = serde_json::from_str(&reply_line).unwrap();
        assert_eq!(reply.protocol, CORE_PROTOCOL_VERSION);
        assert!(reply.active_sessions >= 1);

        let attach = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session.attach",
            "params": {
                "sessionId": session_id,
                "mode": "snapshot_bin",
                "cols": 40,
                "rows": 10,
                "live": true
            }
        });
        writer.write_all(&encode_rpc_frame(&attach).encode()).await.unwrap();

        let mut decoder = FrameStreamDecoder::new();
        let mut attach_reply: Option<Value> = None;
        let mut snapshots: Vec<(u8, Vec<u8>)> = Vec::new();
        let mut saw_facts = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        let mut chunk = [0u8; 8192];

        while tokio::time::Instant::now() < deadline {
            if snapshots.len() >= 2 && attach_reply.is_some() {
                break;
            }
            let read = tokio::time::timeout(Duration::from_millis(250), reader.read(&mut chunk)).await;
            if let Ok(Ok(0)) = read {
                break;
            }
            if let Ok(Ok(read)) = read {
                decoder.feed(&chunk[..read]);
            }
            while let Ok(Some(frame)) = decoder.next_frame() {
                match frame.kind {
                    FrameKind::Rpc => {
                        attach_reply = decode_rpc_payload(&frame.payload).ok();
                    }
                    FrameKind::Facts => {
                        saw_facts = true;
                    }
                    FrameKind::SnapshotBin => {
                        snapshots.push((frame.payload[17], frame.payload.clone()));
                        let channel_id = frame.channel_id;
                        if snapshots.len() == 1 {
                            // Publish one dirty row so the next frame is a delta.
                            if let Some(inst) = get_terminals()
                                .lock()
                                .ok()
                                .and_then(|map| map.get(&session_id).cloned())
                            {
                                if let Ok(mut vt) = inst.vt_engine.lock() {
                                    vt.feed(b"\r\nDELTA-ROW");
                                }
                            }
                        }
                        writer
                            .write_all(&encode_credit_frame(channel_id, 1).encode())
                            .await
                            .unwrap();
                    }
                    _ => {}
                }
            }
        }

        let attach_reply = attach_reply.expect("session.attach reply");
        assert!(
            attach_reply["result"]["rootPid"].as_u64().unwrap_or(0) > 0,
            "session.attach must report the real root pid"
        );
        assert!(saw_facts, "the first tick must publish FACTS metadata");
        assert_eq!(snapshots.len(), 2, "expected a full frame and a delta frame");
        assert_eq!(
            snapshots[0].0 & 0x01,
            0x01,
            "the first frame must be full"
        );
        assert_eq!(
            snapshots[1].0 & 0x01,
            0x00,
            "the second frame must be a dirty-row delta instead of a full repaint"
        );
        let first_seq = crate::vt_engine::snapshot_bin_seq(&snapshots[0].1).unwrap();
        let second_seq = crate::vt_engine::snapshot_bin_seq(&snapshots[1].1).unwrap();
        assert!(
            second_seq > first_seq,
            "the loop must advance last_seq instead of replaying seq 0"
        );

        // Killing the child must produce exactly one CLOSE frame.
        if let Some(inst) = get_terminals()
            .lock()
            .ok()
            .and_then(|map| map.get(&session_id).cloned())
        {
            if let Ok(mut child) = inst.child.lock() {
                let _ = child.kill();
            }
        }

        let mut close_frames = 0;
        let close_deadline = tokio::time::Instant::now() + Duration::from_secs(6);
        while tokio::time::Instant::now() < close_deadline && close_frames == 0 {
            let read = tokio::time::timeout(Duration::from_millis(250), reader.read(&mut chunk)).await;
            if let Ok(Ok(read)) = read {
                decoder.feed(&chunk[..read]);
            }
            while let Ok(Some(frame)) = decoder.next_frame() {
                if frame.kind == FrameKind::Close {
                    close_frames += 1;
                    let (exited, _) =
                        crate::core_wire::decode_close_payload(&frame.payload).unwrap();
                    assert!(exited);
                }
            }
        }
        assert_eq!(close_frames, 1, "process exit must emit one CLOSE frame");

        drop(writer);
        let _ = tokio::time::timeout(Duration::from_secs(2), server_task).await;
    });

    let _ = crate::terminal::terminate_terminal_sync(json!({ "sessionId": session_id }));
}

#[test]
fn oversized_frame_aborts_the_client_connection() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();

    runtime.block_on(async {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let token = get_or_create_core_token();
        let server_task = tokio::spawn(handle_stream_client(server, token.clone()));
        let (mut reader, mut writer) = tokio::io::split(client);

        let handshake = json!({
            "protocol": CORE_PROTOCOL_VERSION,
            "framed": true,
            "client": "kite-test",
            "pid": std::process::id(),
            "authToken": token,
        });
        writer
            .write_all(format!("{}\n", handshake).as_bytes())
            .await
            .unwrap();
        let reply_line = read_line_async(&mut reader).await.unwrap();
        let reply: CoreHandshakeResponse = serde_json::from_str(&reply_line).unwrap();
        assert_eq!(reply.protocol, CORE_PROTOCOL_VERSION);

        // A header declaring a 17 MiB payload exceeds the 16 MiB frame cap.
        let mut header = [0u8; crate::core_wire::FRAME_HEADER_LEN];
        header[0..4].copy_from_slice(&0u32.to_le_bytes());
        header[4] = FrameKind::Rpc as u8;
        header[5..9].copy_from_slice(&(17u32 * 1024 * 1024).to_le_bytes());
        writer.write_all(&header).await.unwrap();
        writer.flush().await.unwrap();

        // The daemon must abort the connection instead of leaving it open.
        let mut buf = [0u8; 64];
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => return true,
                    Ok(_) => continue,
                    Err(_) => return true,
                }
            }
        })
        .await;
        assert_eq!(
            closed,
            Ok(true),
            "an oversized frame must abort the client connection"
        );

        let _ = tokio::time::timeout(Duration::from_secs(2), server_task).await;
    });
}

#[test]
fn gui_terminal_channel_rpcs_drive_the_daemon_pty_registry() {
    let session_id = test_session("test-core-gui-rpc");
    let mut channels = HashMap::new();
    let created = handle_control_rpc_request(
        "session.create",
        Some(json!({
            "sessionId": session_id,
            "engine": "powershell",
            "cols": 40,
            "rows": 10
        })),
        &mut channels,
    )
    .expect("session.create");
    assert!(created["rootPid"].as_u64().unwrap_or(0) > 0);

    let written = handle_control_rpc_request(
        "session.write",
        Some(json!({ "sessionId": session_id, "input": "echo kite\r\n" })),
        &mut channels,
    )
    .expect("session.write");
    assert_eq!(written["ok"], true);

    let missing = handle_control_rpc_request(
        "session.write",
        Some(json!({ "sessionId": "missing-gui-session", "input": "x" })),
        &mut channels,
    )
    .expect("session.write");
    assert_eq!(missing["ok"], false);
    assert_eq!(missing["error"], "Session not found");

    let resized = handle_control_rpc_request(
        "session.resize",
        Some(json!({ "sessionId": session_id, "columns": 52, "rows": 12 })),
        &mut channels,
    )
    .expect("session.resize");
    assert_eq!(resized["ok"], true);

    std::thread::sleep(Duration::from_millis(400));

    let polled = handle_control_rpc_request(
        "session.poll_snapshot",
        Some(json!({ "sessionId": session_id, "sinceSeq": 0 })),
        &mut channels,
    )
    .expect("session.poll_snapshot");
    assert!(
        polled.get("kind").and_then(|v| v.as_str()).is_some(),
        "session.poll_snapshot must answer with a snapshot poll response, got {polled:?}"
    );

    let bin = handle_control_rpc_request(
        "session.poll_snapshot_bin",
        Some(json!({ "sessionId": session_id })),
        &mut channels,
    )
    .expect("session.poll_snapshot_bin");
    let raw = crate::terminal::decode_base64(
        bin["bytesBase64"]
            .as_str()
            .expect("session.poll_snapshot_bin must return bytesBase64"),
    )
    .expect("bytesBase64 must decode");
    assert!(
        crate::vt_engine::snapshot_bin_seq(&raw).is_some(),
        "the forwarded binary frame must carry a SNAPSHOT_BIN header"
    );
    assert_eq!(raw[17] & 0x01, 0x01, "the first forwarded frame must be full");

    let attached = handle_control_rpc_request(
        "session.attach_rpc",
        Some(json!({ "sessionId": session_id, "live": true })),
        &mut channels,
    )
    .expect("session.attach_rpc");
    let channel_id = attached["channelId"]
        .as_u64()
        .expect("session.attach_rpc must bind a channelId") as u32;
    assert!(channels.contains_key(&channel_id));
    assert_eq!(attached["sessionId"], json!(session_id));

    let detached = handle_control_rpc_request(
        "session.detach",
        Some(json!({ "all": true })),
        &mut channels,
    )
    .expect("session.detach");
    assert_eq!(detached["detached"], true);
    assert!(
        channels.is_empty(),
        "session.detach with all=true must drop every attached channel"
    );

    let _ = handle_control_rpc_request(
        "session.terminate",
        Some(json!({ "sessionId": session_id })),
        &mut channels,
    );
}

#[test]
fn agent_dispatch_records_an_inbox_state_entry() {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let cwd = std::env::temp_dir().join(format!("kite-core-inbox-{stamp}"));
    std::fs::create_dir_all(&cwd).unwrap();

    let mut channels = HashMap::new();
    let result = handle_control_rpc_request(
        "agent.dispatch",
        Some(json!({
            "action": "ls",
            "id": "dispatch-audit-1",
            "cwd": cwd.to_string_lossy(),
        })),
        &mut channels,
    )
    .expect("agent.dispatch");
    assert!(
        result.get("op").is_some() || result.get("error").is_some(),
        "agent.dispatch must answer with a receipt, got {result:?}"
    );

    let recorded = cwd
        .join(".kite")
        .join("inbox")
        .join("dispatch-audit-1.result.json");
    assert!(
        recorded.is_file(),
        "a daemon-owned dispatch must record its state in the agent inbox"
    );
    let body = std::fs::read_to_string(&recorded).unwrap();
    assert!(body.contains("kite-core"));

    let _ = std::fs::remove_dir_all(&cwd);
}

#[test]
fn persistent_client_routes_early_frames_and_extended_rpcs() {
    let session_id = test_session("core-client-routes");
    let mut channels = HashMap::new();

    let created = handle_control_rpc_request(
        "session.create",
        Some(json!({
            "sessionId": session_id,
            "engine": "powershell",
            "cols": 80,
            "rows": 24,
        })),
        &mut channels,
    )
    .expect("session.create");
    let channel_id = created["channelId"].as_u64().unwrap() as u32;

    // Verify extended Channel 0 RPCs (`set_presentation`, `find_text`, `recent_text`, `clear_vt`, `core.status`)
    let pres = handle_control_rpc_request(
        "session.set_presentation",
        Some(json!({ "sessionId": session_id, "live": true })),
        &mut channels,
    )
    .expect("session.set_presentation");
    assert_eq!(pres["ok"], true);
    assert_eq!(pres["live"], true);

    let found = handle_control_rpc_request(
        "session.find_text",
        Some(json!({ "sessionId": session_id, "query": "ps", "limit": 10 })),
        &mut channels,
    )
    .expect("session.find_text");
    assert!(found.get("hits").is_some());

    let recent = handle_control_rpc_request(
        "session.recent_text",
        Some(json!({ "sessionId": session_id })),
        &mut channels,
    )
    .expect("session.recent_text");
    assert!(recent.get("text").is_some());

    let status = handle_control_rpc_request("core.status", None, &mut channels)
        .expect("core.status");
    assert_eq!(status["protocol"], CORE_PROTOCOL_VERSION);
    assert!(status.get("dataPlane").is_some(), "core.status must carry dataPlane");

    // Verify provider quiesce and respawn RPCs over Channel 0
    let quiesced = handle_control_rpc_request(
        "session.quiesce_provider",
        Some(json!({ "provider": "isolated_test_provider" })),
        &mut channels,
    )
    .expect("session.quiesce_provider");
    assert!(quiesced.as_array().is_some());

    let _ = handle_control_rpc_request(
        "session.respawn_provider",
        Some(json!({
            "provider": "isolated_test_provider",
            "newAccountLabel": "Test",
            "quiesced": quiesced,
        })),
        &mut channels,
    )
    .expect("session.respawn_provider");

    let _ = handle_control_rpc_request(
        "session.clear_vt",
        Some(json!({ "sessionId": session_id })),
        &mut channels,
    )
    .expect("session.clear_vt");

    // Verify `ClientRoutes` early frame buffering and O(1) push cache extraction
    let snap_bytes = crate::terminal::poll_terminal_snapshot_bin_local_bytes(&session_id, None);
    assert!(!snap_bytes.is_empty());
    let mut client_routes = ClientRoutes::default();
    client_routes
        .early_frames
        .entry(channel_id)
        .or_default()
        .push(Frame::new(channel_id, FrameKind::SnapshotBin, snap_bytes.clone()));

    client_routes.channels.insert(channel_id, session_id.clone());
    if let Some(early) = client_routes.early_frames.remove(&channel_id) {
        for f in early {
            let act = apply_pushed_channel_frame_locked(&mut client_routes, &session_id, f);
            assert!(act.is_some());
        }
    }
    let cached = client_routes
        .sessions
        .get_mut(&session_id)
        .and_then(|s| s.latest_snapshot_bin.take())
        .expect("pushed SNAPSHOT_BIN must be cached in ClientSessionSlot");
    assert_eq!(cached, snap_bytes);

    let _ = handle_control_rpc_request(
        "session.terminate",
        Some(json!({ "sessionId": session_id })),
        &mut channels,
    );
}
