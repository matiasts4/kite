use super::auth::{
    constant_time_eq, parse_tailscale_ipv4_from_text, sha256_hex, AuthStore, PairError,
    DEFAULT_REMOTE_PORT,
};
use super::events::RemoteEventBus;
use super::server::{start_server, ServerHandle};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use uuid::Uuid;

struct TempDirGuard(PathBuf);
impl TempDirGuard {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("kite-remote-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }
    fn config_path(&self) -> PathBuf {
        self.0.join("remote-gateway.json")
    }
}
impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct RemoveThreadGuard(Option<String>);
impl Drop for RemoveThreadGuard {
    fn drop(&mut self) {
        if let Some(tid) = self.0.take() {
            crate::chat::remove_thread(&tid);
        }
    }
}

struct ServerGuard(Option<ServerHandle>);
impl Drop for ServerGuard {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            let _ = h.shutdown_tx.send(true);
            h.join_handle.abort();
        }
    }
}

async fn spawn_test_gateway(dir: &TempDirGuard) -> (Arc<AuthStore>, Arc<RemoteEventBus>, SocketAddr, ServerGuard) {
    let auth = Arc::new(AuthStore::new(dir.config_path()));
    let events = RemoteEventBus::new();
    let handle = start_server(
        SocketAddr::from(([127, 0, 0, 1], 0)),
        Arc::clone(&auth),
        Arc::clone(&events),
    )
    .await
    .expect("start loopback remote server");
    let addr = handle.local_addr;
    (auth, events, addr, ServerGuard(Some(handle)))
}

#[test]
fn config_persistence_and_validation_isolated() {
    let dir = TempDirGuard::new();
    let cfg_path = dir.config_path();

    let store = AuthStore::new(cfg_path.clone());
    let initial = store.config_snapshot();
    assert!(!initial.enabled);
    assert_eq!(initial.port, DEFAULT_REMOTE_PORT);
    assert_eq!(initial.bind_mode, "lan");
    assert!(!initial.auto_start);

    assert!(store.configure(None, Some(0), None, None).is_err());
    assert!(store.configure(None, None, Some("wan".into()), None).is_err());

    let updated = store
        .configure(Some(true), Some(18420), Some("loopback".into()), Some(true))
        .expect("configure valid");
    assert!(updated.enabled);
    assert_eq!(updated.port, 18420);
    assert_eq!(updated.bind_mode, "loopback");
    assert!(updated.auto_start);

    let reloaded = AuthStore::new(cfg_path);
    let snap = reloaded.config_snapshot();
    assert!(snap.enabled);
    assert_eq!(snap.port, 18420);
    assert_eq!(snap.bind_mode, "loopback");
    assert!(snap.auto_start);
}

#[test]
fn pairing_code_ttl_single_use_and_uri() {
    let dir = TempDirGuard::new();
    let store = AuthStore::new(dir.config_path());
    store.configure(Some(true), Some(17420), Some("loopback".into()), None).unwrap();
    assert_eq!(super::auth::detect_candidate_hosts("loopback"), vec!["127.0.0.1".to_string()]);

    let pairing = store.create_pairing(Some(17420)).expect("create pairing");
    assert_eq!(pairing.code.len(), 6);
    assert!(pairing.code.chars().all(|c| c.is_ascii_digit()));
    assert_eq!(pairing.secret.len(), 32);
    assert!(pairing.secret.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(pairing.uri.starts_with("kite-remote://pair?v=1&host="));
    assert!(pairing.uri.contains("&port=17420&hosts="));
    assert!(pairing.uri.contains(&format!("&code={}", pairing.code)));
    assert!(pairing.uri.contains(&format!("&secret={}", pairing.secret)));
    assert!(store.has_active_pairing());

    let err_bad = store
        .verify_and_consume_pairing("000000", &pairing.secret, "Pixel 9", "android")
        .unwrap_err();
    assert!(matches!(err_bad, PairError::Unauthorized(_)));

    let (device, token) = store
        .verify_and_consume_pairing(&pairing.code, &pairing.secret, "Pixel 9", "android")
        .expect("pair success");
    assert_eq!(device.name, "Pixel 9");
    assert_eq!(device.platform, "android");
    assert_eq!(token.len(), 64);
    assert!(!store.has_active_pairing());

    let reuse = store
        .verify_and_consume_pairing(&pairing.code, &pairing.secret, "Pixel 9", "android")
        .unwrap_err();
    assert!(matches!(reuse, PairError::Gone(_)));

    let pairing2 = store.create_pairing(Some(17420)).unwrap();
    store.expire_active_pairing_for_test();
    assert!(!store.has_active_pairing());
    let expired = store
        .verify_and_consume_pairing(&pairing2.code, &pairing2.secret, "iPhone", "ios")
        .unwrap_err();
    assert!(matches!(expired, PairError::Gone(_)));
}

#[test]
fn constant_time_token_verification_and_revocation() {
    let dir = TempDirGuard::new();
    let cfg_path = dir.config_path();
    let store = AuthStore::new(cfg_path.clone());
    let pairing = store.create_pairing(Some(17420)).unwrap();
    let (device, token) = store
        .verify_and_consume_pairing(&pairing.code, &pairing.secret, "Galaxy S25", "android")
        .unwrap();

    assert!(constant_time_eq(b"abc123", b"abc123"));
    assert!(!constant_time_eq(b"abc123", b"abc124"));
    assert!(!constant_time_eq(b"abc", b"abcd"));

    let raw_disk = std::fs::read_to_string(&cfg_path).unwrap();
    assert!(!raw_disk.contains(&token), "raw token must never be stored on disk");
    assert!(raw_disk.contains(&sha256_hex(token.as_bytes())));

    assert!(store.verify_device_token(&token).is_some());
    assert!(store.verify_device_token("wrong-token").is_none());
    assert!(store.verify_device_token("").is_none());

    assert!(store.revoke_device(&device.id).expect("revoke"));
    assert!(store.verify_device_token(&token).is_none());
    assert!(store.list_devices().is_empty());
}

#[test]
fn tailscale_cgnat_ipconfig_parser() {
    let sample = r#"
Adaptador de Ethernet Ethernet:
   Dirección IPv4. . . . . . . . . . . . . . : 192.168.1.44(Preferido)
Adaptador desconocido Tailscale:
   IPv4 Address. . . . . . . . . . . : 100.88.14.22(Preferred)
   IPv4 Address. . . . . . . . . . . : 100.63.1.2
   IPv4 Address. . . . . . . . . . . : 100.128.0.1
   IPv4 Address. . . . . . . . . . . : 100.127.255.10
"#;
    let found = parse_tailscale_ipv4_from_text(sample);
    assert_eq!(found, vec!["100.88.14.22", "100.127.255.10"]);
}

#[tokio::test]
async fn argos_turn_registry_resolves_and_cancels() {
    let bus = RemoteEventBus::new();
    let rx = bus.register_argos_turn("req-1".into());
    assert!(bus.resolve_argos_turn("req-1", json!({ "reply": "Listo" })));
    let val = rx.await.unwrap();
    assert_eq!(val["reply"], "Listo");
    assert!(!bus.resolve_argos_turn("req-1", json!({})));

    let rx2 = bus.register_argos_turn("req-2".into());
    bus.cancel_argos_turn("req-2");
    assert!(rx2.await.is_err());
}

#[tokio::test]
async fn http_health_pair_errors_and_cors() {
    let dir = TempDirGuard::new();
    let (auth, _events, addr, _srv) = spawn_test_gateway(&dir).await;
    let client = reqwest::Client::new();
    let base = format!("http://{addr}");

    let health = client.get(format!("{base}/api/v1/health")).send().await.unwrap();
    assert_eq!(health.status(), reqwest::StatusCode::OK);
    assert_eq!(health.headers().get("access-control-allow-origin").unwrap(), "*");
    let hjson: Value = health.json().await.unwrap();
    assert_eq!(hjson["ok"], true);
    assert_eq!(hjson["protocol"], "kite-remote/v1");
    assert_eq!(hjson["pairingActive"], false);

    let preflight = client.request(reqwest::Method::OPTIONS, format!("{base}/api/v1/pair")).send().await.unwrap();
    assert_eq!(preflight.status(), reqwest::StatusCode::NO_CONTENT);
    assert_eq!(preflight.headers().get("access-control-allow-origin").unwrap(), "*");

    let no_session = client.post(format!("{base}/api/v1/pair"))
        .json(&json!({ "code": "123456", "secret": "abc", "deviceName": "Phone", "platform": "android" }))
        .send().await.unwrap();
    assert_eq!(no_session.status(), reqwest::StatusCode::GONE);

    let pairing = auth.create_pairing(Some(addr.port())).unwrap();
    let bad_req = client.post(format!("{base}/api/v1/pair"))
        .json(&json!({ "code": pairing.code, "secret": pairing.secret, "deviceName": "", "platform": "android" }))
        .send().await.unwrap();
    assert_eq!(bad_req.status(), reqwest::StatusCode::BAD_REQUEST);

    let bad_code = client.post(format!("{base}/api/v1/pair"))
        .json(&json!({ "code": "999999", "secret": pairing.secret, "deviceName": "Pixel", "platform": "android" }))
        .send().await.unwrap();
    assert_eq!(bad_code.status(), reqwest::StatusCode::UNAUTHORIZED);

    let oversized = "x".repeat(70 * 1024);
    let too_big = client.post(format!("{base}/api/v1/pair")).body(oversized).send().await.unwrap();
    assert_eq!(too_big.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);

    let ok_pair = client.post(format!("{base}/api/v1/pair"))
        .json(&json!({ "code": pairing.code, "secret": pairing.secret, "deviceName": "Pixel 9", "platform": "android" }))
        .send().await.unwrap();
    assert_eq!(ok_pair.status(), reqwest::StatusCode::OK);
    let pjson: Value = ok_pair.json().await.unwrap();
    assert_eq!(pjson["protocol"], "kite-remote/v1");
    assert_eq!(pjson["wsPath"], "/ws");
    let tok = pjson["deviceToken"].as_str().unwrap().to_string();
    assert!(!tok.is_empty());

    let sess_unauth = client.get(format!("{base}/api/v1/session")).send().await.unwrap();
    assert_eq!(sess_unauth.status(), reqwest::StatusCode::UNAUTHORIZED);
    let sess_ok = client
        .get(format!("{base}/api/v1/session"))
        .bearer_auth(&tok)
        .send()
        .await
        .unwrap();
    assert_eq!(sess_ok.status(), reqwest::StatusCode::OK);
    let sjson: Value = sess_ok.json().await.unwrap();
    assert_eq!(sjson["ok"], true);

    let reused = client.post(format!("{base}/api/v1/pair"))
        .json(&json!({ "code": pairing.code, "secret": pairing.secret, "deviceName": "Pixel 9", "platform": "android" }))
        .send().await.unwrap();
    assert_eq!(reused.status(), reqwest::StatusCode::GONE);

    let pairing2 = auth.create_pairing(Some(addr.port())).unwrap();
    auth.expire_active_pairing_for_test();
    let expired = client.post(format!("{base}/api/v1/pair"))
        .json(&json!({ "code": pairing2.code, "secret": pairing2.secret, "deviceName": "Pixel 9", "platform": "android" }))
        .send().await.unwrap();
    assert_eq!(expired.status(), reqwest::StatusCode::GONE);
}

#[tokio::test]
async fn ws_rejects_unauthorized_with_401() {
    let dir = TempDirGuard::new();
    let (_auth, _events, addr, _srv) = spawn_test_gateway(&dir).await;

    for url in [format!("ws://{addr}/ws"), format!("ws://{addr}/ws?token=invalid-token")] {
        let err = tokio_tungstenite::connect_async(url).await.unwrap_err();
        match err {
            WsError::Http(resp) => assert_eq!(resp.status(), StatusCode::UNAUTHORIZED),
            other => panic!("expected HTTP 401 error, got {other:?}"),
        }
    }
}

async fn ws_rpc_call(
    ws_tx: &mut futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>,
    ws_rx: &mut futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>,
    id: &str,
    method: &str,
    params: Value,
) -> Value {
    ws_tx
        .send(Message::Text(json!({ "type": "req", "id": id, "method": method, "params": params }).to_string()))
        .await
        .expect("send req");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let next = tokio::time::timeout_at(deadline, ws_rx.next())
            .await
            .expect("rpc timeout")
            .expect("ws stream open")
            .expect("ws message");
        if let Message::Text(txt) = next {
            let v: Value = serde_json::from_str(&txt).unwrap();
            if v.get("type").and_then(Value::as_str) == Some("res")
                && v.get("id").and_then(Value::as_str) == Some(id)
            {
                return v;
            }
        }
    }
}

#[tokio::test]
async fn ws_rpc_end_to_end_revocation_and_clean_shutdown() {
    let dir = TempDirGuard::new();
    let (auth, events, addr, mut srv) = spawn_test_gateway(&dir).await;
    let pairing = auth.create_pairing(Some(addr.port())).unwrap();
    let (device, token) = auth
        .verify_and_consume_pairing(&pairing.code, &pairing.secret, "Android Test", "android")
        .unwrap();

    let mut req = format!("ws://{addr}/ws").into_client_request().unwrap();
    req.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    let (ws, _) = tokio_tungstenite::connect_async(req).await.expect("authorized WS");
    let (mut ws_tx, mut ws_rx) = ws.split();

    let ping = ws_rpc_call(&mut ws_tx, &mut ws_rx, "r1", "system.ping", json!({})).await;
    assert_eq!(ping["ok"], true);
    assert!(ping["result"]["connectedClients"].as_u64().unwrap() >= 1);

    let boot = ws_rpc_call(&mut ws_tx, &mut ws_rx, "r2", "system.bootstrap", json!({})).await;
    assert_eq!(boot["ok"], true);
    assert_eq!(boot["result"]["protocol"], "kite-remote/v1");
    assert!(boot["result"]["voiceCapabilities"].is_object());
    assert!(boot["result"]["candidateUrls"].as_array().is_some_and(|a| !a.is_empty()));

    let created = ws_rpc_call(&mut ws_tx, &mut ws_rx, "r3", "thread.create", json!({ "kind": "general" })).await;
    assert_eq!(created["ok"], true);
    let tid = created["result"]["id"].as_str().unwrap().to_string();
    let _cleanup = RemoveThreadGuard(Some(tid.clone()));

    let listed = ws_rpc_call(&mut ws_tx, &mut ws_rx, "r4", "thread.list", json!({})).await;
    assert_eq!(listed["ok"], true);
    let found = listed["result"]["summaries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s.get("id").and_then(Value::as_str) == Some(tid.as_str()));
    assert!(found, "created thread should appear in thread.list");

    let bad_voice = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "r5",
        "voice.transcribe",
        json!({ "audioBase64": "not!valid!b64" }),
    )
    .await;
    assert_eq!(bad_voice["ok"], false);
    assert_eq!(bad_voice["error"]["code"], "invalid_params");

    let empty_voice = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "r6",
        "voice.transcribe",
        json!({ "audioBase64": "" }),
    )
    .await;
    assert_eq!(empty_voice["ok"], false);
    assert_eq!(empty_voice["error"]["code"], "invalid_params");

    let no_gui_argos = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "r7",
        "voice.argos.turn",
        json!({ "transcript": "hola" }),
    )
    .await;
    assert_eq!(no_gui_argos["ok"], false);
    assert_eq!(no_gui_argos["error"]["code"], "argos_unavailable");

    // Revoking device disconnects live WS immediately and blocks reconnect.
    assert!(auth.revoke_device(&device.id).unwrap());
    events.disconnect_device(&device.id);

    let closed_cleanly = tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(msg) = ws_rx.next().await {
            if matches!(msg, Ok(Message::Close(_)) | Err(_)) {
                return true;
            }
        }
        true
    })
    .await
    .unwrap_or(false);
    assert!(closed_cleanly, "revoked WS should disconnect immediately");

    let err_after_revoke = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?token={token}"))
        .await
        .unwrap_err();
    match err_after_revoke {
        WsError::Http(resp) => assert_eq!(resp.status(), StatusCode::UNAUTHORIZED),
        other => panic!("expected 401 after revocation, got {other:?}"),
    }

    // Clean shutdown exits server task promptly.
    let handle = srv.0.take().unwrap();
    let _ = handle.shutdown_tx.send(true);
    tokio::time::timeout(Duration::from_secs(3), handle.join_handle)
        .await
        .expect("server join within timeout")
        .expect("server exited cleanly");
}

#[test]
fn normalize_subagent_runs_flattens_wrapped_entries() {
    let wrapped = json!({
        "ok": true,
        "runs": [
            {
                "run": {
                    "subagentId": "sub-1",
                    "role": "Researcher",
                    "status": "running",
                    "items": []
                },
                "threadId": "thr-parent-1",
                "threadTitle": "Main Thread",
                "workspaceId": "ws-1"
            }
        ]
    });
    let flat = super::rpc::normalize_subagent_snapshot_runs(wrapped, None);
    let runs = flat["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["subagentId"], "sub-1");
    assert_eq!(runs[0]["parentThreadId"], "thr-parent-1");
    assert_eq!(runs[0]["workspaceId"], "ws-1");
}

#[test]
fn readonly_snapshot_does_not_mutate_delivered_through() {
    use crate::chat::runtime::state::{live_turns, TurnRun};
    use std::collections::HashMap;

    let run_id = format!("run-ro-{}", Uuid::new_v4());
    {
        let mut live = live_turns().lock().unwrap();
        live.runs.insert(
            run_id.clone(),
            TurnRun {
                revision: "rev1".to_string(),
                events: vec![
                    json!({ "sequence": 1, "kind": "status", "status": "running" }),
                    json!({ "sequence": 2, "kind": "delta", "itemId": "a1", "text": "hola" }),
                ],
                next_sequence: 2,
                assistant_id: "a1".to_string(),
                assistant_text: "hola".to_string(),
                child: None,
                stdin: None,
                closing: false,
                finished: false,
                started_at_ms: 1000,
                finished_at_ms: None,
                routine_id: None,
                delivered_through: 0,
                file_baselines: HashMap::new(),
            },
        );
    }

    let (events, next_seq, has_more, finished, resync) =
        super::events::snapshot_turn_updates_readonly(&run_id, 0);
    assert_eq!(events.len(), 2);
    assert_eq!(next_seq, 2);
    assert!(!has_more);
    assert!(!finished);
    assert!(!resync);

    {
        let mut live = live_turns().lock().unwrap();
        let delivered = live.runs.get(&run_id).unwrap().delivered_through;
        assert_eq!(delivered, 0, "remote snapshot must never advance Desktop delivered_through");
        live.runs.remove(&run_id);
    }
}

static REMOTE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct EnvVarRestore {
    key: &'static str,
    prev: Option<std::ffi::OsString>,
}

impl EnvVarRestore {
    fn set(key: &'static str, value: &std::ffi::OsStr) -> Self {
        let prev = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, prev }
    }

    fn clear(key: &'static str) -> Self {
        let prev = std::env::var_os(key);
        std::env::remove_var(key);
        Self { key, prev }
    }
}

impl Drop for EnvVarRestore {
    fn drop(&mut self) {
        match &self.prev {
            Some(v) => std::env::set_var(self.key, v),
            None => std::env::remove_var(self.key),
        }
    }
}

#[test]
fn mobile_update_manifest_safety_and_traversal_rejection() {
    use super::mobile_update::{
        check_mobile_update_in, is_safe_apk_filename, manifest_to_wire_json,
        read_latest_manifest_in, status_json_in, MobileUpdateManifest,
    };

    assert!(is_safe_apk_filename("kite-mobile-1.0.5.apk"));
    assert!(is_safe_apk_filename("KiteMobile.APK"));
    for unsafe_name in [
        "",
        ".apk",
        ".hidden.apk",
        "../evil.apk",
        "..\\evil.apk",
        "dir/app.apk",
        "dir\\app.apk",
        "foo..bar.apk",
        "app.zip",
        "app.apk ",
        " app.apk",
        "C:app.apk",
        "bad\"name.apk",
    ] {
        assert!(!is_safe_apk_filename(unsafe_name), "expected unsafe filename rejected: {unsafe_name:?}");
    }

    let dir = TempDirGuard::new();
    let outside_apk = dir.0.join("outside.apk");
    std::fs::write(&outside_apk, b"outside-apk-bytes").unwrap();
    let feed_dir = dir.0.join("feed");
    std::fs::create_dir_all(&feed_dir).unwrap();

    // Missing manifest -> None
    assert!(read_latest_manifest_in(&feed_dir).is_none());

    // Traversal attempt in manifest -> rejected
    std::fs::write(
        feed_dir.join("manifest.json"),
        json!({
            "versionName": "1.0.5",
            "versionCode": 5,
            "filename": "../outside.apk",
            "sha256": "deadbeef",
            "sizeBytes": 17
        })
        .to_string(),
    )
    .unwrap();
    assert!(read_latest_manifest_in(&feed_dir).is_none());

    // Non-existent APK file -> rejected
    std::fs::write(
        feed_dir.join("manifest.json"),
        json!({
            "versionName": "1.0.5",
            "versionCode": 5,
            "filename": "missing.apk",
            "sha256": "deadbeef",
            "sizeBytes": 17
        })
        .to_string(),
    )
    .unwrap();
    assert!(read_latest_manifest_in(&feed_dir).is_none());

    // Valid manifest + APK file -> accepted
    let apk_bytes = b"valid-apk-payload";
    std::fs::write(feed_dir.join("kite-mobile-1.0.5.apk"), apk_bytes).unwrap();
    std::fs::write(
        feed_dir.join("manifest.json"),
        json!({
            "versionName": "1.0.5",
            "versionCode": 5,
            "filename": "kite-mobile-1.0.5.apk",
            "sha256": sha256_hex(apk_bytes),
            "sizeBytes": apk_bytes.len(),
            "releaseNotes": "OTA fixes",
            "publishedAtUnixMs": 1791770000000i64
        })
        .to_string(),
    )
    .unwrap();

    let (parsed, path) = read_latest_manifest_in(&feed_dir).expect("valid manifest");
    assert_eq!(parsed.version_name, "1.0.5");
    assert_eq!(parsed.version_code, 5);
    assert_eq!(path, feed_dir.join("kite-mobile-1.0.5.apk"));

    let wire = manifest_to_wire_json(&parsed);
    assert_eq!(wire["downloadPath"], "/api/v1/mobile/update/apk");
    assert_eq!(wire["releaseNotes"], "OTA fixes");

    let newer = check_mobile_update_in(&feed_dir, Some(4));
    assert_eq!(newer["available"], true);
    assert_eq!(newer["updateAvailable"], true);
    assert_eq!(newer["currentVersionCode"], 4);
    assert_eq!(newer["manifest"]["versionCode"], 5);
    assert_eq!(newer["latest"]["versionCode"], 5);

    let same = check_mobile_update_in(&feed_dir, Some(5));
    assert_eq!(same["available"], true);
    assert_eq!(same["updateAvailable"], false);

    let status = status_json_in(&feed_dir);
    assert_eq!(status["available"], true);
    assert_eq!(status["versionName"], "1.0.5");
    assert_eq!(status["versionCode"], 5);

    let _dummy = MobileUpdateManifest {
        version_name: "1.0.0".into(),
        version_code: 1,
        filename: "app.apk".into(),
        sha256: "abc".into(),
        size_bytes: 1,
        release_notes: None,
        published_at_unix_ms: None,
    };
}

#[tokio::test]
async fn http_mobile_update_auth_streaming_and_rpc() {
    let _env_lock = REMOTE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = TempDirGuard::new();
    let feed_dir = dir.0.join("mobile-feed");
    std::fs::create_dir_all(&feed_dir).unwrap();
    let _feed_env = EnvVarRestore::set("KITE_MOBILE_UPDATE_DIR", feed_dir.as_os_str());
    let _xi_env1 = EnvVarRestore::clear("ELEVENLABS_API_KEY");
    let _xi_env2 = EnvVarRestore::clear("XI_API_KEY");

    let (auth, _events, addr, _srv) = spawn_test_gateway(&dir).await;
    let pairing = auth.create_pairing(Some(addr.port())).unwrap();
    let (_device, token) = auth
        .verify_and_consume_pairing(&pairing.code, &pairing.secret, "Pixel 9", "android")
        .unwrap();

    let client = reqwest::Client::new();
    let base = format!("http://{addr}");

    // Auth checks
    let unauth_meta = client.get(format!("{base}/api/v1/mobile/update")).send().await.unwrap();
    assert_eq!(unauth_meta.status(), reqwest::StatusCode::UNAUTHORIZED);
    let bad_meta = client
        .get(format!("{base}/api/v1/mobile/update?token=wrong"))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_meta.status(), reqwest::StatusCode::UNAUTHORIZED);
    let unauth_apk = client.get(format!("{base}/api/v1/mobile/update/apk")).send().await.unwrap();
    assert_eq!(unauth_apk.status(), reqwest::StatusCode::UNAUTHORIZED);

    // Empty feed -> available=false, APK -> 404
    let empty_meta = client
        .get(format!("{base}/api/v1/mobile/update?currentVersionCode=2"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(empty_meta.status(), reqwest::StatusCode::OK);
    let empty_json: Value = empty_meta.json().await.unwrap();
    assert_eq!(empty_json["available"], false);
    assert_eq!(empty_json["updateAvailable"], false);

    let missing_apk = client
        .get(format!("{base}/api/v1/mobile/update/apk"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(missing_apk.status(), reqwest::StatusCode::NOT_FOUND);

    // Multi-chunk APK (> 130 KiB to exercise 64 KiB streaming loop)
    let apk_payload: Vec<u8> = (0..(132 * 1024 + 17)).map(|i| (i % 251) as u8).collect();
    let apk_sha = sha256_hex(&apk_payload);
    let apk_name = "kite-mobile-1.2.0.apk";
    std::fs::write(feed_dir.join(apk_name), &apk_payload).unwrap();
    std::fs::write(
        feed_dir.join("manifest.json"),
        json!({
            "versionName": "1.2.0",
            "versionCode": 12,
            "filename": apk_name,
            "sha256": apk_sha,
            "sizeBytes": apk_payload.len(),
            "releaseNotes": "Streaming test build",
            "publishedAtUnixMs": 1791770100000i64
        })
        .to_string(),
    )
    .unwrap();

    // Update metadata check (newer)
    let update_resp = client
        .get(format!("{base}/api/v1/mobile/update?currentVersionCode=10"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(update_resp.status(), reqwest::StatusCode::OK);
    let ujson: Value = update_resp.json().await.unwrap();
    assert_eq!(ujson["available"], true);
    assert_eq!(ujson["updateAvailable"], true);
    assert_eq!(ujson["currentVersionCode"], 10);
    assert_eq!(ujson["manifest"]["versionCode"], 12);
    assert_eq!(ujson["latest"]["sha256"], apk_sha);

    // Query token auth + up-to-date check
    let uptodate_resp = client
        .get(format!("{base}/api/v1/mobile/update?token={token}&currentVersionCode=12"))
        .send()
        .await
        .unwrap();
    assert_eq!(uptodate_resp.status(), reqwest::StatusCode::OK);
    let utjson: Value = uptodate_resp.json().await.unwrap();
    assert_eq!(utjson["available"], true);
    assert_eq!(utjson["updateAvailable"], false);

    // Stream APK and verify headers + exact byte contents
    let apk_resp = client
        .get(format!("{base}/api/v1/mobile/update/apk?token={token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(apk_resp.status(), reqwest::StatusCode::OK);
    assert_eq!(
        apk_resp.headers().get("content-type").unwrap(),
        "application/vnd.android.package-archive"
    );
    assert_eq!(
        apk_resp.headers().get("content-length").unwrap().to_str().unwrap(),
        apk_payload.len().to_string()
    );
    assert_eq!(
        apk_resp.headers().get("content-disposition").unwrap(),
        "attachment; filename=\"kite-mobile-1.2.0.apk\""
    );
    assert_eq!(apk_resp.headers().get("x-kite-apk-sha256").unwrap(), &apk_sha);
    assert_eq!(apk_resp.headers().get("cache-control").unwrap(), "no-store");
    assert_eq!(apk_resp.headers().get("access-control-allow-origin").unwrap(), "*");
    let downloaded = apk_resp.bytes().await.unwrap();
    assert_eq!(downloaded.as_ref(), apk_payload.as_slice());

    // WS RPCs: mobile.update.check, system.bootstrap, voice.tts, voice.transcribe validation
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?token={token}"))
        .await
        .expect("authorized WS");
    let (mut ws_tx, mut ws_rx) = ws.split();

    let rpc_check = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "m1",
        "mobile.update.check",
        json!({ "currentVersionCode": 10 }),
    )
    .await;
    assert_eq!(rpc_check["ok"], true);
    assert_eq!(rpc_check["result"]["available"], true);
    assert_eq!(rpc_check["result"]["updateAvailable"], true);
    assert_eq!(rpc_check["result"]["manifest"]["filename"], apk_name);

    let rpc_bad = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "m2",
        "mobile.update.check",
        json!({ "currentVersionCode": "bad" }),
    )
    .await;
    assert_eq!(rpc_bad["ok"], false);
    assert_eq!(rpc_bad["error"]["code"], "invalid_params");

    let rpc_unknown = ws_rpc_call(&mut ws_tx, &mut ws_rx, "m3", "mobile.nope", json!({})).await;
    assert_eq!(rpc_unknown["ok"], false);
    assert_eq!(rpc_unknown["error"]["code"], "method_not_found");

    let boot = ws_rpc_call(&mut ws_tx, &mut ws_rx, "b1", "system.bootstrap", json!({})).await;
    assert_eq!(boot["ok"], true);
    assert_eq!(boot["result"]["mobileUpdate"]["versionCode"], 12);
    let vc = &boot["result"]["voiceCapabilities"];
    assert!(vc.get("cloudSttConfigured").is_some());
    assert!(vc.get("grokSttConfigured").is_some());
    assert!(vc.get("openaiSttConfigured").is_some());
    assert!(vc.get("offlineSttReady").is_some());
    assert!(vc.get("elevenLabsTtsConfigured").is_some());
    assert!(vc.get("realtimeConfigured").is_some());
    assert!(vc.get("realtimeProviders").is_some());
    assert_eq!(vc["defaultSttProvider"], "auto");
    assert!(vc["defaultTtsProvider"].is_string());
    assert!(vc["elevenLabsVoiceId"].is_string());
    assert!(vc["elevenLabsModel"].is_string());
    assert_eq!(vc["sttProviders"], json!(["auto", "grok", "openai", "offline"]));
    assert_eq!(vc["ttsProviders"], json!(["auto", "elevenlabs", "device"]));

    // voice.tts validation & device fallback
    let tts_missing_text = ws_rpc_call(&mut ws_tx, &mut ws_rx, "t1", "voice.tts", json!({})).await;
    assert_eq!(tts_missing_text["ok"], false);
    assert_eq!(tts_missing_text["error"]["code"], "invalid_params");

    let tts_bad_provider = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "t2",
        "voice.tts",
        json!({ "text": "Hola", "ttsProvider": "unknown" }),
    )
    .await;
    assert_eq!(tts_bad_provider["ok"], false);
    assert_eq!(tts_bad_provider["error"]["code"], "invalid_params");

    let tts_device = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "t3",
        "voice.tts",
        json!({ "text": "Hola", "ttsProvider": "device" }),
    )
    .await;
    assert_eq!(tts_device["ok"], true);
    assert_eq!(tts_device["result"]["provider"], "device");
    assert_eq!(tts_device["result"]["mimeType"], "text/plain");
    assert_eq!(tts_device["result"]["audioBase64"], "");

    if crate::credentials::resolve_provider_key("elevenlabs").is_none() {
        let tts_unavail = ws_rpc_call(
            &mut ws_tx,
            &mut ws_rx,
            "t4",
            "voice.tts",
            json!({ "text": "Hola", "ttsProvider": "elevenlabs" }),
        )
        .await;
        assert_eq!(tts_unavail["ok"], false);
        assert_eq!(tts_unavail["error"]["code"], "tts_unavailable");
    }

    let bad_stt_provider = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "s1",
        "voice.transcribe",
        json!({ "audioBase64": "AQID", "sttProvider": "invalid_provider" }),
    )
    .await;
    assert_eq!(bad_stt_provider["ok"], false);
    assert_eq!(bad_stt_provider["error"]["code"], "invalid_params");
}

#[test]
fn desktop_voice_settings_parsing_defaults_and_overrides() {
    use super::voice::{
        grok_stt_endpoints, normalize_stt_provider, normalize_tts_provider, DesktopVoiceSettings,
    };

    let def = DesktopVoiceSettings::from_json_str("{}");
    assert_eq!(def.grok_base_url, "https://api.x.ai/v1");
    assert_eq!(def.grok_model, "grok-voice-transcribe-2.0");
    assert_eq!(def.effective_grok_model(), "grok-voice-transcribe-2.0");
    assert_eq!(def.offline_stt_engine, None);
    assert_eq!(def.tts_engine, "auto");
    assert_eq!(def.default_tts_provider(), "auto");
    assert_eq!(def.elevenlabs_voice_id, "21m00Tcm4TlvDq8ikWAM");
    assert_eq!(def.elevenlabs_model, "eleven_v4_turbo");
    assert!((def.elevenlabs_stability - 0.5).abs() < 1e-6);
    assert!((def.elevenlabs_similarity - 0.8).abs() < 1e-6);

    let malformed = DesktopVoiceSettings::from_json_str("not-json");
    assert_eq!(malformed, def);

    let custom = DesktopVoiceSettings::from_json_str(
        &json!({
            "grokTranscriptionBaseUrl": "https://proxy.example/v1",
            "grokTranscriptionModel": "grok-stt-custom",
            "offlineSttEngine": "whisper",
            "ttsEngine": "web",
            "elevenlabsVoiceId": "customVoice123",
            "elevenlabsModel": "eleven_multilingual_v2",
            "elevenlabsStability": 1.4,
            "elevenlabsSimilarity": -0.2
        })
        .to_string(),
    );
    assert_eq!(custom.grok_base_url, "https://proxy.example/v1");
    assert_eq!(custom.grok_model, "grok-stt-custom");
    assert_eq!(custom.effective_grok_model(), "grok-stt-custom");
    assert_eq!(custom.offline_stt_engine.as_deref(), Some("whisper"));
    assert_eq!(custom.tts_engine, "web");
    assert_eq!(custom.default_tts_provider(), "device");
    assert_eq!(custom.elevenlabs_voice_id, "customVoice123");
    assert_eq!(custom.elevenlabs_model, "eleven_multilingual_v2");
    assert!((custom.elevenlabs_stability - 1.0).abs() < 1e-6);
    assert!((custom.elevenlabs_similarity - 0.0).abs() < 1e-6);

    let legacy_xai = DesktopVoiceSettings::from_json_str(
        &json!({
            "grokBaseUrl": "https://api.x.ai/v1",
            "grokTranscriptionModel": "whisper-large-v3"
        })
        .to_string(),
    );
    assert_eq!(legacy_xai.grok_base_url, "https://api.x.ai/v1");
    assert_eq!(legacy_xai.effective_grok_model(), "grok-voice-transcribe-2.0");

    let groq_custom = DesktopVoiceSettings::from_json_str(
        &json!({
            "grokTranscriptionBaseUrl": "https://api.groq.com/openai/v1",
            "grokTranscriptionModel": "whisper-large-v3"
        })
        .to_string(),
    );
    assert_eq!(groq_custom.effective_grok_model(), "whisper-large-v3");

    assert_eq!(
        grok_stt_endpoints("https://api.x.ai/v1/"),
        (
            "https://api.x.ai/v1/stt".to_string(),
            Some("https://api.x.ai/v1/audio/transcriptions".to_string())
        )
    );
    assert_eq!(
        grok_stt_endpoints("https://api.x.ai/v1/audio/transcriptions"),
        (
            "https://api.x.ai/v1/audio/transcriptions".to_string(),
            None
        )
    );
    assert_eq!(
        grok_stt_endpoints("https://api.groq.com/openai/v1"),
        (
            "https://api.groq.com/openai/v1/audio/transcriptions".to_string(),
            None
        )
    );

    let eleven = DesktopVoiceSettings::from_json_str(r#"{"ttsEngine":"elevenlabs"}"#);
    assert_eq!(eleven.default_tts_provider(), "elevenlabs");

    assert_eq!(normalize_stt_provider(None).unwrap(), "auto");
    assert_eq!(normalize_stt_provider(Some("GROK")).unwrap(), "grok");
    assert_eq!(normalize_stt_provider(Some("openai")).unwrap(), "openai");
    assert_eq!(normalize_stt_provider(Some("offline")).unwrap(), "offline");
    assert!(normalize_stt_provider(Some("other")).is_err());

    assert_eq!(normalize_tts_provider(None).unwrap(), "auto");
    assert_eq!(normalize_tts_provider(Some("elevenlabs")).unwrap(), "elevenlabs");
    assert_eq!(normalize_tts_provider(Some("device")).unwrap(), "device");
    assert!(normalize_tts_provider(Some("web")).is_err());
}

#[tokio::test]
async fn voice_stt_streaming_rpc_lifecycle_and_validation() {
    let dir = TempDirGuard::new();
    let (auth, _events, addr, _srv) = spawn_test_gateway(&dir).await;
    let pairing = auth.create_pairing(Some(addr.port())).unwrap();
    let (_device, token) = auth
        .verify_and_consume_pairing(&pairing.code, &pairing.secret, "Pixel 9", "android")
        .unwrap();

    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?token={token}"))
        .await
        .expect("authorized WS");
    let (mut ws_tx, mut ws_rx) = ws.split();

    // 1. Reject invalid sttProvider and out-of-range / non-numeric sampleRate.
    let bad_provider = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "stt-1",
        "voice.stt.start",
        json!({ "sttProvider": "bogus_provider" }),
    )
    .await;
    assert_eq!(bad_provider["ok"], false);
    assert_eq!(bad_provider["error"]["code"], "invalid_params");

    for bad_rate in [json!(4000), json!(96000), json!(-16000), json!("16000")] {
        let bad_rate_res = ws_rpc_call(
            &mut ws_tx,
            &mut ws_rx,
            "stt-rate",
            "voice.stt.start",
            json!({ "sampleRate": bad_rate }),
        )
        .await;
        assert_eq!(bad_rate_res["ok"], false);
        assert_eq!(bad_rate_res["error"]["code"], "invalid_params");
    }

    // 2. Start valid session -> chunk rejects unknown sessionId and odd-length PCM.
    let started = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "stt-2",
        "voice.stt.start",
        json!({ "sttProvider": "offline", "sampleRate": 16000, "language": "es-ES" }),
    )
    .await;
    assert_eq!(started["ok"], true);
    let session_id = started["result"]["sessionId"].as_str().unwrap().to_string();
    assert!(!session_id.is_empty());
    assert_eq!(started["result"]["streaming"], false);
    assert_eq!(started["result"]["provider"], "offline");
    assert_eq!(started["result"]["sampleRate"], 16000);

    let unknown_chunk = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "stt-3",
        "voice.stt.chunk",
        json!({ "sessionId": "missing-session", "pcm16Base64": "AQIDBA==" }),
    )
    .await;
    assert_eq!(unknown_chunk["ok"], false);
    assert_eq!(unknown_chunk["error"]["code"], "session_not_found");

    // "AQID" decodes to 3 bytes (odd length, invalid for 16-bit PCM).
    let odd_chunk = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "stt-4",
        "voice.stt.chunk",
        json!({ "sessionId": session_id, "pcm16Base64": "AQID" }),
    )
    .await;
    assert_eq!(odd_chunk["ok"], false);
    assert_eq!(odd_chunk["error"]["code"], "invalid_params");

    // 3. Valid even PCM16LE chunk -> stop with cancel: true returns { ok: true, cancelled: true }.
    let ok_chunk = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "stt-5",
        "voice.stt.chunk",
        json!({ "sessionId": session_id, "pcm16Base64": "AQIDBA==" }),
    )
    .await;
    assert_eq!(ok_chunk["ok"], true);
    assert_eq!(ok_chunk["result"]["ok"], true);

    let cancelled = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "stt-6",
        "voice.stt.stop",
        json!({ "sessionId": session_id, "cancel": true }),
    )
    .await;
    assert_eq!(cancelled["ok"], true);
    assert_eq!(cancelled["result"]["ok"], true);
    assert_eq!(cancelled["result"]["cancelled"], true);
    assert_eq!(cancelled["result"]["text"], "");
    assert_eq!(cancelled["result"]["backend"], "cancelled");

    // 4. Unknown or already-stopped sessionId on voice.stt.stop returns session_not_found.
    let unknown_stop = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "stt-7",
        "voice.stt.stop",
        json!({ "sessionId": session_id }),
    )
    .await;
    assert_eq!(unknown_stop["ok"], false);
    assert_eq!(unknown_stop["error"]["code"], "session_not_found");

    // Tiny non-cancelled session (< 1600 PCM bytes) settles cleanly with empty transcript.
    let started2 = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "stt-8",
        "voice.stt.start",
        json!({ "sttProvider": "offline" }),
    )
    .await;
    assert_eq!(started2["ok"], true);
    let sid2 = started2["result"]["sessionId"].as_str().unwrap().to_string();
    assert_eq!(started2["result"]["sampleRate"], 16000);

    let ok_chunk2 = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "stt-9",
        "voice.stt.chunk",
        json!({ "sessionId": sid2, "pcm16Base64": "AQIDBA==" }),
    )
    .await;
    assert_eq!(ok_chunk2["ok"], true);

    let stopped2 = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "stt-10",
        "voice.stt.stop",
        json!({ "sessionId": sid2 }),
    )
    .await;
    assert_eq!(stopped2["ok"], true);
    assert_eq!(stopped2["result"]["text"], "");
    assert_eq!(stopped2["result"]["backend"], "offline_stt");
}

#[test]
fn stt_session_pruning_evicts_stale_and_caps_at_four() {
    use super::voice::{prune_stt_sessions, SttLiveSession};
    use std::collections::HashMap;
    use std::time::Instant;

    let now = Instant::now();
    let stale_ts = now - Duration::from_secs(125);
    let mut map = HashMap::new();
    map.insert("stale-1".to_string(), SttLiveSession::dummy_for_test(stale_ts));
    map.insert("active-1".to_string(), SttLiveSession::dummy_for_test(now - Duration::from_secs(40)));
    map.insert("active-2".to_string(), SttLiveSession::dummy_for_test(now - Duration::from_secs(30)));
    map.insert("active-3".to_string(), SttLiveSession::dummy_for_test(now - Duration::from_secs(20)));
    map.insert("active-4".to_string(), SttLiveSession::dummy_for_test(now - Duration::from_secs(10)));

    let evicted = prune_stt_sessions(&mut map, now);
    // Stale entry plus oldest active ("active-1") evicted so inserting a new session leaves <= 4.
    assert_eq!(evicted.len(), 2);
    assert!(!map.contains_key("stale-1"));
    assert!(!map.contains_key("active-1"));
    assert_eq!(map.len(), 3);
}

#[tokio::test]
async fn voice_stt_grok_ws_stream_publishes_partials_and_flushes_audio_done() {
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let (req_tx, req_rx) = tokio::sync::oneshot::channel::<(String, String)>();
    let server_task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut req_tx = Some(req_tx);
        let ws_stream = tokio_tungstenite::accept_hdr_async(
            stream,
            move |req: &Request, resp: Response| {
                if let Some(tx) = req_tx.take() {
                    let uri = req.uri().to_string();
                    let auth = req
                        .headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let _ = tx.send((uri, auth));
                }
                Ok(resp)
            },
        )
        .await
        .unwrap();

        let (mut ws_tx, mut ws_rx) = ws_stream.split();
        let mut binary_frames = Vec::new();
        let mut saw_audio_done = false;

        if let Some(Ok(Message::Binary(bytes))) = ws_rx.next().await {
            binary_frames.push(bytes);
        }
        ws_tx
            .send(Message::Text(
                r#"{"type":"transcript","text":"hola","is_final":false}"#.to_string(),
            ))
            .await
            .unwrap();

        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(bytes) => binary_frames.push(bytes),
                Message::Text(txt) if txt.contains(r#""type":"audio.done""#) => {
                    saw_audio_done = true;
                    ws_tx
                        .send(Message::Text(
                            r#"{"type":"transcript","text":"hola mundo","is_final":true}"#.to_string(),
                        ))
                        .await
                        .unwrap();
                    ws_tx
                        .send(Message::Text(r#"{"type":"Done"}"#.to_string()))
                        .await
                        .unwrap();
                    break;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        (binary_frames, saw_audio_done)
    });

    let events = RemoteEventBus::new();
    let mut event_rx = events.subscribe_events();
    let (frame_tx, frame_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let base_url = format!("http://{addr}/v1");

    let task = tokio::spawn(super::voice::run_grok_stt_ws_stream(
        Arc::clone(&events),
        "sess-ws-1".to_string(),
        "xai-test-key".to_string(),
        base_url,
        "es-ES".to_string(),
        16000,
        frame_rx,
        stop_rx,
    ));

    let (uri, auth) = req_rx.await.unwrap();
    assert_eq!(
        uri,
        "/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true&language=es&endpointing=400"
    );
    assert_eq!(auth, "Bearer xai-test-key");

    frame_tx.try_send(vec![100u8, 0, 56, 255]).unwrap();
    let first_ev = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first_ev.event, "voice.stt_partial");
    assert_eq!(first_ev.payload["sessionId"], "sess-ws-1");
    assert_eq!(first_ev.payload["text"], "hola");
    assert_eq!(first_ev.payload["isFinal"], false);

    frame_tx.try_send(vec![44u8, 1, 112, 254]).unwrap();
    drop(frame_tx);
    stop_tx.send(true).unwrap();

    let final_ev = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(final_ev.event, "voice.stt_partial");
    assert_eq!(final_ev.payload["sessionId"], "sess-ws-1");
    assert_eq!(final_ev.payload["text"], "hola mundo");
    assert_eq!(final_ev.payload["isFinal"], true);

    let transcript = task.await.unwrap().unwrap();
    let (frames, saw_done) = server_task.await.unwrap();
    assert!(saw_done);
    assert_eq!(frames.len(), 2);
    assert_eq!(transcript, "hola mundo");
}

struct WorkspacePathGuard(String);
impl WorkspacePathGuard {
    fn register(dir: &std::path::Path) -> Self {
        let id = format!("ws-preview-{}", Uuid::new_v4());
        let plain = dir
            .canonicalize()
            .unwrap_or_else(|_| dir.to_path_buf())
            .to_string_lossy()
            .strip_prefix(r"\\?\")
            .map(str::to_string)
            .unwrap_or_else(|| dir.to_string_lossy().to_string());
        crate::persist::paths()
            .lock()
            .unwrap()
            .insert(id.clone(), plain);
        Self(id)
    }
}
impl Drop for WorkspacePathGuard {
    fn drop(&mut self) {
        crate::persist::paths().lock().unwrap().remove(&self.0);
    }
}

struct RemovePathGuard(PathBuf);
impl Drop for RemovePathGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        let _ = std::fs::remove_file(&self.0);
    }
}

#[tokio::test]
async fn workspace_file_preview_markdown_resolution_and_truncation() {
    let dir = TempDirGuard::new();
    let ws_dir = dir.0.join("ws");
    std::fs::create_dir_all(ws_dir.join("sub")).unwrap();
    std::fs::create_dir_all(ws_dir.join("docs").join("nested")).unwrap();
    std::fs::create_dir_all(ws_dir.join("deep").join("team")).unwrap();
    std::fs::create_dir_all(ws_dir.join(".git")).unwrap();
    std::fs::create_dir_all(ws_dir.join("node_modules").join("pkg")).unwrap();

    let space_md = ws_dir.join("sub").join("guide with spaces.md");
    std::fs::write(&space_md, "# Guide\nLine 10\n").unwrap();
    std::fs::write(ws_dir.join("shared.md"), "root shared").unwrap();
    std::fs::write(ws_dir.join("docs").join("nested").join("intro.md"), "intro").unwrap();
    std::fs::write(ws_dir.join("docs").join("nested").join("shared.md"), "nested shared").unwrap();
    std::fs::write(ws_dir.join("docs").join("parent.md"), "docs parent").unwrap();
    std::fs::write(ws_dir.join("deep").join("team").join("Architecture.MDX"), "# Arch\n").unwrap();
    std::fs::write(ws_dir.join(".git").join("ignored.md"), "secret git md").unwrap();
    std::fs::write(ws_dir.join("node_modules").join("pkg").join("ignored_nm.md"), "nm").unwrap();
    std::fs::write(ws_dir.join("c++_notes.md"), "C++ notes\n").unwrap();

    // >1 MiB Markdown file with a 4-byte UTF-8 char straddling MAX_MARKDOWN_BYTES (1_048_576).
    let max_md = super::file_preview::MAX_MARKDOWN_BYTES;
    let mut big_md = vec![b'a'; max_md - 2];
    big_md.extend_from_slice("🚀".as_bytes()); // 4 bytes at [max_md - 2 .. max_md + 2]
    big_md.extend_from_slice(&[b'b'; 128]);
    let big_md_path = ws_dir.join("large.markdown");
    std::fs::write(&big_md_path, &big_md).unwrap();

    let ws_guard = WorkspacePathGuard::register(&ws_dir);
    let (_auth, _events, addr, _srv) = spawn_test_gateway(&dir).await;
    let auth = &_auth;
    let pairing = auth.create_pairing(Some(addr.port())).unwrap();
    let (_dev, token) = auth
        .verify_and_consume_pairing(&pairing.code, &pairing.secret, "Pixel 9", "android")
        .unwrap();

    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?token={token}"))
        .await
        .expect("authorized WS");
    let (mut ws_tx, mut ws_rx) = ws.split();

    // 1. file:/// URI with %20 spaces, quotes, and #L10-L20 anchor.
    let space_uri = format!(
        "`file:///{}#L10-L20`",
        space_md.to_string_lossy().replace('\\', "/").replace(' ', "%20")
    );
    let res_uri = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "md-1",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": space_uri }),
    )
    .await;
    assert_eq!(res_uri["ok"], true, "res_uri={res_uri}");
    assert_eq!(res_uri["result"]["kind"], "markdown");
    assert_eq!(res_uri["result"]["workspaceId"], ws_guard.0);
    assert_eq!(res_uri["result"]["relativePath"], "sub/guide with spaces.md");
    assert_eq!(res_uri["result"]["displayName"], "guide with spaces.md");
    assert_eq!(res_uri["result"]["mimeType"], "text/markdown");
    assert_eq!(res_uri["result"]["truncated"], false);
    assert_eq!(res_uri["result"]["text"], "# Guide\nLine 10\n");
    assert_eq!(res_uri["result"]["sizeBytes"], "# Guide\nLine 10\n".len());
    assert!(res_uri["result"]["modifiedAtMs"].as_i64().unwrap() > 0);

    // 1b. Windows leading `/C:/...` (or `file://localhost/...` on Unix) + `?query` + `#anchor` preserves path.
    let space_fwd = space_md.to_string_lossy().replace('\\', "/");
    let leading_slash_path = if cfg!(windows) {
        format!("\"/{space_fwd}?raw=1#top\"")
    } else {
        format!("\"file://localhost{space_fwd}?raw=1#top\"")
    };
    let res_win_slash = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "md-1b",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": leading_slash_path }),
    )
    .await;
    assert_eq!(res_win_slash["ok"], true, "res_win_slash={res_win_slash}");
    assert_eq!(res_win_slash["result"]["relativePath"], "sub/guide with spaces.md");

    // 2. relativeTo parent resolution prioritizes sibling over root `shared.md`, and handles `../parent.md`.
    let res_rel = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "md-2",
        "workspace.file_preview",
        json!({
            "workspaceId": ws_guard.0,
            "path": "shared.md:12:4",
            "relativeTo": "docs/nested/intro.md"
        }),
    )
    .await;
    assert_eq!(res_rel["ok"], true);
    assert_eq!(res_rel["result"]["relativePath"], "docs/nested/shared.md");
    assert_eq!(res_rel["result"]["text"], "nested shared");

    let res_parent = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "md-3",
        "workspace.file_preview",
        json!({
            "workspaceId": ws_guard.0,
            "path": "../parent.md",
            "relativeTo": "docs/nested/intro.md"
        }),
    )
    .await;
    assert_eq!(res_parent["ok"], true);
    assert_eq!(res_parent["result"]["relativePath"], "docs/parent.md");
    assert_eq!(res_parent["result"]["text"], "docs parent");

    // 3. Bounded DFS case-insensitive bare filename & skipped `.git` / `node_modules`.
    let res_dfs = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "md-4",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": "architecture.mdx" }),
    )
    .await;
    assert_eq!(res_dfs["ok"], true);
    assert_eq!(res_dfs["result"]["relativePath"], "deep/team/Architecture.MDX");
    assert_eq!(res_dfs["result"]["mimeType"], "text/markdown");

    let res_git_skip = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "md-5",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": "ignored.md" }),
    )
    .await;
    assert_eq!(res_git_skip["ok"], false);
    assert_eq!(res_git_skip["error"]["code"], "not_found");

    // 4. Filenames containing literal `+` must not be corrupted to space.
    let res_plus = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "md-6",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": "c++_notes.md" }),
    )
    .await;
    assert_eq!(res_plus["ok"], true);
    assert_eq!(res_plus["result"]["text"], "C++ notes\n");

    // 5. >1 MiB Markdown truncation preserves UTF-8 boundary cleanly.
    let res_big = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "md-7",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": "large.markdown" }),
    )
    .await;
    assert_eq!(res_big["ok"], true);
    assert_eq!(res_big["result"]["truncated"], true);
    assert_eq!(res_big["result"]["sizeBytes"], big_md.len());
    let truncated_text = res_big["result"]["text"].as_str().unwrap();
    assert_eq!(truncated_text.len(), max_md - 2);
    assert!(!truncated_text.contains('\u{FFFD}'));
    assert!(truncated_text.ends_with('a'));
}

#[tokio::test]
async fn workspace_file_preview_image_rpc_and_http_raw_streaming() {
    let dir = TempDirGuard::new();
    let ws_dir = dir.0.join("ws");
    std::fs::create_dir_all(ws_dir.join("assets")).unwrap();

    // >130 KiB image payload to exercise multi-chunk 64 KiB streaming and `+` in filename.
    let mut png_bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png_bytes.extend((0..(132 * 1024 + 19)).map(|i| (i % 251) as u8));
    std::fs::write(ws_dir.join("assets").join("chart+1.png"), &png_bytes).unwrap();
    std::fs::write(ws_dir.join("assets").join("photo.JPG"), b"fake-jpeg").unwrap();

    // Also place a previewable file inside `roaming_app_dir()` to test allowed non-workspace root.
    let roaming_sub = crate::persist::roaming_app_dir().join(format!("preview-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&roaming_sub).unwrap();
    let _roaming_cleanup = RemovePathGuard(roaming_sub.clone());
    let roaming_webp = roaming_sub.join("avatar.webp");
    std::fs::write(&roaming_webp, b"RIFFwebpbytes").unwrap();

    let ws_guard = WorkspacePathGuard::register(&ws_dir);
    let (auth, _events, addr, _srv) = spawn_test_gateway(&dir).await;
    let pairing = auth.create_pairing(Some(addr.port())).unwrap();
    let (_dev, token) = auth
        .verify_and_consume_pairing(&pairing.code, &pairing.secret, "Pixel 9", "android")
        .unwrap();

    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?token={token}"))
        .await
        .expect("authorized WS");
    let (mut ws_tx, mut ws_rx) = ws.split();

    let img_rpc = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "img-1",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": "assets/chart+1.png" }),
    )
    .await;
    assert_eq!(img_rpc["ok"], true, "img_rpc={img_rpc}");
    assert_eq!(img_rpc["result"]["kind"], "image");
    assert_eq!(img_rpc["result"]["workspaceId"], ws_guard.0);
    assert_eq!(img_rpc["result"]["relativePath"], "assets/chart+1.png");
    assert_eq!(img_rpc["result"]["displayName"], "chart+1.png");
    assert_eq!(img_rpc["result"]["mimeType"], "image/png");
    assert_eq!(img_rpc["result"]["sizeBytes"], png_bytes.len());
    let raw_path = img_rpc["result"]["rawPath"].as_str().unwrap().to_string();
    assert!(raw_path.starts_with("/api/v1/workspace/file/raw?path="));
    assert!(raw_path.contains("%2B"), "expected '+' encoded as %2B in {raw_path}");
    assert!(raw_path.contains(&format!("&workspaceId={}", ws_guard.0)));

    let client = reqwest::Client::new();
    let base = format!("http://{addr}");

    // Unauthorized request must return 401.
    let unauth = client.get(format!("{base}{raw_path}")).send().await.unwrap();
    assert_eq!(unauth.status(), reqwest::StatusCode::UNAUTHORIZED);

    // Authorized Bearer request streams exact PNG bytes and strict security headers.
    let ok_resp = client
        .get(format!("{base}{raw_path}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(ok_resp.status(), reqwest::StatusCode::OK);
    assert_eq!(ok_resp.headers().get("content-type").unwrap(), "image/png");
    assert_eq!(
        ok_resp.headers().get("content-length").unwrap().to_str().unwrap(),
        png_bytes.len().to_string()
    );
    assert_eq!(ok_resp.headers().get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(
        ok_resp.headers().get("content-security-policy").unwrap(),
        "default-src 'none'"
    );
    assert_eq!(
        ok_resp.headers().get("cache-control").unwrap(),
        "private, max-age=30"
    );
    assert_eq!(
        ok_resp.headers().get("access-control-allow-origin").unwrap(),
        "*"
    );
    let body = ok_resp.bytes().await.unwrap();
    assert_eq!(body.as_ref(), png_bytes.as_slice());

    // Query token auth + JPG mime type.
    let jpg_rpc = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "img-2",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": "assets/photo.JPG" }),
    )
    .await;
    assert_eq!(jpg_rpc["ok"], true);
    assert_eq!(jpg_rpc["result"]["mimeType"], "image/jpeg");
    let jpg_raw = jpg_rpc["result"]["rawPath"].as_str().unwrap();
    let jpg_resp = client
        .get(format!("{base}{jpg_raw}&token={token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(jpg_resp.status(), reqwest::StatusCode::OK);
    assert_eq!(jpg_resp.headers().get("content-type").unwrap(), "image/jpeg");
    assert_eq!(jpg_resp.bytes().await.unwrap().as_ref(), b"fake-jpeg");

    // Non-workspace allowed root (`roaming_app_dir`) resolves with `workspaceId: null` and streams cleanly.
    let roaming_rpc = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "img-3",
        "workspace.file_preview",
        json!({ "path": roaming_webp.to_string_lossy().to_string() }),
    )
    .await;
    assert_eq!(roaming_rpc["ok"], true, "roaming_rpc={roaming_rpc}");
    assert!(roaming_rpc["result"]["workspaceId"].is_null());
    assert_eq!(roaming_rpc["result"]["mimeType"], "image/webp");
    let roaming_raw = roaming_rpc["result"]["rawPath"].as_str().unwrap();
    assert!(!roaming_raw.contains("workspaceId="));
    let roaming_http = client
        .get(format!("{base}{roaming_raw}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(roaming_http.status(), reqwest::StatusCode::OK);
    assert_eq!(roaming_http.headers().get("content-type").unwrap(), "image/webp");
    assert_eq!(roaming_http.bytes().await.unwrap().as_ref(), b"RIFFwebpbytes");
}

#[tokio::test]
async fn workspace_file_preview_security_rejections() {
    let dir = TempDirGuard::new();
    let ws_dir = dir.0.join("ws");
    std::fs::create_dir_all(ws_dir.join("src")).unwrap();
    std::fs::write(dir.0.join("outside.md"), "outside secret").unwrap();
    std::fs::write(ws_dir.join("src").join("main.rs"), "fn main() {}").unwrap();
    std::fs::write(ws_dir.join(".env"), "API_KEY=secret").unwrap();
    std::fs::write(ws_dir.join("icon.svg"), "<svg></svg>").unwrap();
    std::fs::write(ws_dir.join("README"), "no ext").unwrap();

    // Oversized image (> 15 MiB) created sparsely via set_len.
    let huge_png = ws_dir.join("huge.png");
    {
        let f = std::fs::File::create(&huge_png).unwrap();
        f.set_len(super::file_preview::MAX_IMAGE_BYTES + 1).unwrap();
    }

    let ws_guard = WorkspacePathGuard::register(&ws_dir);
    let (auth, _events, addr, _srv) = spawn_test_gateway(&dir).await;
    let pairing = auth.create_pairing(Some(addr.port())).unwrap();
    let (_dev, token) = auth
        .verify_and_consume_pairing(&pairing.code, &pairing.secret, "Pixel 9", "android")
        .unwrap();

    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws?token={token}"))
        .await
        .expect("authorized WS");
    let (mut ws_tx, mut ws_rx) = ws.split();
    let client = reqwest::Client::new();
    let base = format!("http://{addr}");

    // 1. Path traversal (`../../outside.md`) rejected on both RPC and HTTP.
    let trav_rpc = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "sec-1",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": "../../outside.md" }),
    )
    .await;
    assert_eq!(trav_rpc["ok"], false);
    assert_eq!(trav_rpc["error"]["code"], "invalid_params");

    let trav_http = client
        .get(format!(
            "{base}/api/v1/workspace/file/raw?path=..%2F..%2Foutside.md&workspaceId={}",
            ws_guard.0
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(trav_http.status(), reqwest::StatusCode::BAD_REQUEST);

    // 2. Disallowed extensions (`.rs`, `.env`, `.svg`, no extension) -> `unsupported_file_type` and HTTP 415.
    for (idx, bad_file) in ["src/main.rs", ".env", "icon.svg", "README"].iter().enumerate() {
        let rpc_res = ws_rpc_call(
            &mut ws_tx,
            &mut ws_rx,
            &format!("ext-{idx}"),
            "workspace.file_preview",
            json!({ "workspaceId": ws_guard.0, "path": bad_file }),
        )
        .await;
        assert_eq!(rpc_res["ok"], false, "expected rejection for {bad_file}");
        assert_eq!(rpc_res["error"]["code"], "unsupported_file_type");
        assert_eq!(
            rpc_res["error"]["message"],
            "Only Markdown and image files can be previewed on mobile."
        );

        let http_res = client
            .get(format!(
                "{base}/api/v1/workspace/file/raw?path={}&workspaceId={}",
                super::auth::percent_encode(bad_file),
                ws_guard.0
            ))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(
            http_res.status(),
            reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "expected HTTP 415 for {bad_file}"
        );
    }

    // 3. Oversized image (>15 MiB) -> `payload_too_large` RPC and HTTP 413.
    let big_rpc = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "sec-big",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": "huge.png" }),
    )
    .await;
    assert_eq!(big_rpc["ok"], false);
    assert_eq!(big_rpc["error"]["code"], "payload_too_large");

    let big_http = client
        .get(format!(
            "{base}/api/v1/workspace/file/raw?path=huge.png&workspaceId={}",
            ws_guard.0
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(big_http.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);

    // 4. Empty path / NUL byte -> invalid_params / HTTP 400.
    let nul_rpc = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "sec-nul",
        "workspace.file_preview",
        json!({ "workspaceId": ws_guard.0, "path": "notes\0.md" }),
    )
    .await;
    assert_eq!(nul_rpc["ok"], false);
    assert_eq!(nul_rpc["error"]["code"], "invalid_params");

    let empty_http = client
        .get(format!("{base}/api/v1/workspace/file/raw?path="))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(empty_http.status(), reqwest::StatusCode::BAD_REQUEST);

    // 5. Arbitrary absolute path outside allowed roots (repo README.md, unregistered in test) -> 404 / not_found.
    let repo_readme = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("README.md");
    assert!(repo_readme.is_file());
    let outside_abs_rpc = ws_rpc_call(
        &mut ws_tx,
        &mut ws_rx,
        "sec-abs",
        "workspace.file_preview",
        json!({ "path": repo_readme.to_string_lossy().to_string() }),
    )
    .await;
    assert_eq!(outside_abs_rpc["ok"], false);
    assert_eq!(outside_abs_rpc["error"]["code"], "not_found");

    let outside_abs_http = client
        .get(format!(
            "{base}/api/v1/workspace/file/raw?path={}",
            super::auth::percent_encode(&repo_readme.to_string_lossy())
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(outside_abs_http.status(), reqwest::StatusCode::NOT_FOUND);
}


#[test]
fn tailscale_status_json_parser_extracts_dns_ipv4_and_funnel_capability() {
    let raw = r#"{
        "BackendState": "Running",
        "Self": {
            "DNSName": "desktop-kite.tail1234.ts.net.",
            "TailscaleIPs": ["fd7a:115c:a1e0::1", "100.88.14.9"],
            "Capabilities": ["https://tailscale.com/cap/funnel"]
        },
        "CurrentTailnet": {
            "MagicDNSSuffix": "tail1234.ts.net."
        }
    }"#;
    let parsed = super::tailscale::parse_tailscale_status_json(raw);
    assert_eq!(parsed.backend_state, "Running");
    assert!(parsed.running);
    assert_eq!(parsed.dns_name.as_deref(), Some("desktop-kite.tail1234.ts.net"));
    assert_eq!(parsed.ipv4.as_deref(), Some("100.88.14.9"));
    assert_eq!(parsed.magic_dns_suffix.as_deref(), Some("tail1234.ts.net"));
    assert!(parsed.funnel_capable);

    let stopped = super::tailscale::parse_tailscale_status_json(
        r#"{ "BackendState": "NeedsLogin", "Self": { "TailscaleIPs": [] } }"#,
    );
    assert_eq!(stopped.backend_state, "NeedsLogin");
    assert!(!stopped.running);
    assert!(!stopped.funnel_capable);
}

#[test]
fn tailscale_serve_status_json_parser_detects_serve_and_funnel_modes() {
    let serve_only = r#"{
        "Web": {
            "desktop-kite.tail1234.ts.net:443": {
                "Handlers": { "/": { "Proxy": "http://127.0.0.1:17420" } }
            }
        }
    }"#;
    assert_eq!(
        super::tailscale::parse_serve_status_json(serve_only, 17420, None),
        ("serve".to_string(), Some("https://desktop-kite.tail1234.ts.net".to_string()))
    );
    assert_eq!(
        super::tailscale::parse_serve_status_json(serve_only, 18420, None),
        ("off".to_string(), None)
    );

    let funnel_on = r#"{
        "Web": {
            "${TS_CERT_DOMAIN}:443": {
                "Handlers": { "/": { "Proxy": "http://localhost:17420/" } }
            }
        },
        "AllowFunnel": {
            "${TS_CERT_DOMAIN}:443": true
        }
    }"#;
    assert_eq!(
        super::tailscale::parse_serve_status_json(
            funnel_on,
            17420,
            Some("desktop-kite.tail1234.ts.net.")
        ),
        ("funnel".to_string(), Some("https://desktop-kite.tail1234.ts.net".to_string()))
    );
}

#[test]
fn tailscale_approval_url_and_public_url_validation() {
    let cli_err = "Funnel is not enabled. Enable it here: https://login.tailscale.com/f/funnel?node=n12345abc.";
    assert_eq!(
        super::tailscale::extract_tailscale_approval_url(cli_err).as_deref(),
        Some("https://login.tailscale.com/f/funnel?node=n12345abc")
    );
    assert_eq!(
        super::tailscale::extract_tailscale_approval_url("no link here"),
        None
    );

    assert_eq!(super::tailscale::validate_public_url("   ").unwrap(), None);
    assert_eq!(
        super::tailscale::validate_public_url("HTTPS://desktop.tail1234.ts.net/").unwrap().as_deref(),
        Some("https://desktop.tail1234.ts.net")
    );
    assert_eq!(
        super::tailscale::validate_public_url("http://100.77.1.5:17420").unwrap().as_deref(),
        Some("http://100.77.1.5:17420")
    );
    assert!(super::tailscale::validate_public_url("ftp://example.com").is_err());
    assert!(super::tailscale::validate_public_url("https://user:pass@example.com").is_err());
    assert!(super::tailscale::validate_public_url("https://example.com/path").is_err());
    assert!(super::tailscale::validate_public_url("https://example.com?a=1").is_err());
    assert!(super::tailscale::validate_public_url("https://bad host.ts.net").is_err());
}

#[test]
fn candidate_urls_and_pairing_uri_preserve_https_tailscale_alongside_lan() {
    let urls = super::auth::build_candidate_urls(
        "lan",
        17420,
        &["192.168.1.50".to_string(), "100.64.0.12".to_string()],
        Some("https://desktop-kite.tail1234.ts.net"),
        Some("https://kite-custom.example.com"),
        Some("100.64.0.12"),
    );
    assert_eq!(
        urls,
        vec![
            "http://192.168.1.50:17420",
            "https://desktop-kite.tail1234.ts.net",
            "https://kite-custom.example.com",
            "http://100.64.0.12:17420",
        ]
    );

    let loopback_urls = super::auth::build_candidate_urls(
        "loopback",
        17420,
        &["127.0.0.1".to_string()],
        Some("https://desktop-kite.tail1234.ts.net"),
        None,
        None,
    );
    assert_eq!(
        loopback_urls,
        vec![
            "https://desktop-kite.tail1234.ts.net",
            "http://127.0.0.1:17420",
        ]
    );

    let dir = TempDirGuard::new();
    let store = AuthStore::new(dir.config_path());
    store
        .configure_full(
            Some(true),
            Some(17420),
            Some("loopback".into()),
            None,
            Some("https://custom.tail1234.ts.net".into()),
            Some("funnel".into()),
        )
        .unwrap();
    let pairing = store
        .create_pairing_with_urls(
            Some(17420),
            Some("https://desktop-kite.tail1234.ts.net"),
            Some("https://custom.tail1234.ts.net"),
            Some("100.64.0.12"),
        )
        .unwrap();
    assert!(pairing.hosts.contains(&"https://desktop-kite.tail1234.ts.net".to_string()));
    assert!(pairing.uri.contains("https%3A%2F%2Fdesktop-kite.tail1234.ts.net"));
    assert!(pairing.candidate_urls.contains(&"https://desktop-kite.tail1234.ts.net".to_string()));
}

#[test]
fn config_persists_public_url_and_tailscale_mode() {
    let dir = TempDirGuard::new();
    let cfg_path = dir.config_path();
    let store = AuthStore::new(cfg_path.clone());
    assert_eq!(store.config_snapshot().public_url, None);
    assert_eq!(store.config_snapshot().tailscale_mode, "off");

    assert!(store
        .configure_full(None, None, None, None, Some("notaurl".into()), None)
        .is_err());
    assert!(store
        .configure_full(None, None, None, None, None, Some("bogus".into()))
        .is_err());

    let updated = store
        .configure_full(
            Some(true),
            None,
            None,
            None,
            Some("https://pc.tail55.ts.net/".into()),
            Some("serve".into()),
        )
        .unwrap();
    assert_eq!(updated.public_url.as_deref(), Some("https://pc.tail55.ts.net"));
    assert_eq!(updated.tailscale_mode, "serve");

    let reloaded = AuthStore::new(cfg_path.clone());
    assert_eq!(
        reloaded.config_snapshot().public_url.as_deref(),
        Some("https://pc.tail55.ts.net")
    );
    assert_eq!(reloaded.config_snapshot().tailscale_mode, "serve");

    let cleared = reloaded
        .configure_full(None, None, None, None, Some("".into()), Some("off".into()))
        .unwrap();
    assert_eq!(cleared.public_url, None);
    assert_eq!(cleared.tailscale_mode, "off");
}

#[tokio::test]
async fn rpc_bootstrap_includes_provider_models_and_provider_models_rpc_validates() {
    let dir = TempDirGuard::new();
    let auth = Arc::new(AuthStore::new(dir.config_path()));
    let events = RemoteEventBus::new();
    let ctx = super::rpc::RpcContext {
        auth,
        events,
        subscribed_threads: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
    };

    let boot_raw = super::rpc::dispatch_frame(
        &ctx,
        &json!({ "type": "req", "id": "boot-1", "method": "system.bootstrap", "params": {} }).to_string(),
    )
    .await
    .expect("bootstrap response");
    let boot: Value = serde_json::from_str(&boot_raw).unwrap();
    assert_eq!(boot["ok"], true);
    assert!(boot["result"]["providerModels"].is_object());

    let missing_raw = super::rpc::dispatch_frame(
        &ctx,
        &json!({ "type": "req", "id": "pm-1", "method": "provider.models", "params": {} }).to_string(),
    )
    .await
    .expect("missing provider error");
    let missing: Value = serde_json::from_str(&missing_raw).unwrap();
    assert_eq!(missing["ok"], false);
    assert_eq!(missing["error"]["code"], "invalid_params");

    let bad_raw = super::rpc::dispatch_frame(
        &ctx,
        &json!({ "type": "req", "id": "pm-2", "method": "provider.models", "params": { "provider": "nonexistent-engine" } }).to_string(),
    )
    .await
    .expect("unsupported provider error");
    let bad: Value = serde_json::from_str(&bad_raw).unwrap();
    assert_eq!(bad["ok"], false);
    assert_eq!(bad["error"]["code"], "invalid_params");

    let claude_raw = super::rpc::dispatch_frame(
        &ctx,
        &json!({ "type": "req", "id": "pm-3", "method": "provider.models", "params": { "provider": "claude" } }).to_string(),
    )
    .await
    .expect("claude models response");
    let claude: Value = serde_json::from_str(&claude_raw).unwrap();
    assert_eq!(claude["ok"], true);
    assert_eq!(claude["result"]["provider"], "claude");
    assert!(claude["result"]["models"].is_array());
    assert!(claude["result"]["catalogState"].is_string());
}
