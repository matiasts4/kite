use super::*;

#[test]
fn parses_usage_payload_windows() {
    let payload = json!({
        "usage": {
            "rolling": { "status": "ok", "percent": 12, "resetsAt": "2026-10-22T23:02:11.000Z" },
            "weekly": { "status": "ok", "percent": 34, "resetsAt": "2026-10-26T00:00:00.000Z" },
            "monthly": { "status": "ok", "percent": 56, "resetsAt": "2026-11-22T17:06:30.000Z" }
        }
    });

    let windows = parse_usage_payload(&payload).expect("valid payload");
    assert_eq!(windows.len(), 3);
    assert_eq!(windows[0].usage_percent, 12.0);
    assert_eq!(windows[1].usage_percent, 34.0);
    assert_eq!(windows[2].usage_percent, 56.0);
    assert!(!windows[0].exhausted);
}

#[test]
fn rate_limited_window_is_exhausted() {
    let payload = json!({
        "usage": {
            "rolling": { "status": "rate-limited", "percent": 42, "resetsAt": "2026-10-22T23:02:11.000Z" },
            "weekly": { "status": "ok", "percent": 10, "resetsAt": "2026-10-26T00:00:00.000Z" },
            "monthly": { "status": "ok", "percent": 10, "resetsAt": "2026-11-22T17:06:30.000Z" }
        }
    });

    let windows = parse_usage_payload(&payload).expect("valid payload");
    assert_eq!(windows[0].usage_percent, 100.0);
    assert!(windows[0].exhausted);
}

#[test]
fn rejects_invalid_percent() {
    let payload = json!({
        "usage": {
            "rolling": { "status": "ok", "percent": 120, "resetsAt": "2026-10-22T23:02:11.000Z" },
            "weekly": { "status": "ok", "percent": 10, "resetsAt": "2026-10-26T00:00:00.000Z" },
            "monthly": { "status": "ok", "percent": 10, "resetsAt": "2026-11-22T17:06:30.000Z" }
        }
    });

    assert!(parse_usage_payload(&payload).is_err());
}

#[test]
fn parses_timestamps_with_offsets() {
    let utc = parse_rfc3339_ms("2026-10-22T23:02:11.000Z").expect("utc timestamp");
    let offset = parse_rfc3339_ms("2026-10-23T01:02:11+02:00").expect("offset timestamp");
    assert_eq!(utc, offset);
}

#[test]
fn reads_api_key_from_kite_config_shape() {
    let value = json!({ "apiKey": "  sk-test  " });
    assert_eq!(api_key_from_flat_config(&value).as_deref(), Some("sk-test"));
}

#[test]
fn reads_api_key_from_opencode_config() {
    let value = json!({
        "provider": {
            "opencode-go": { "options": { "apiKey": "sk-config" } }
        }
    });
    assert_eq!(api_key_from_opencode_config(&value).as_deref(), Some("sk-config"));
}

#[test]
fn detects_entitlement_error() {
    let outcome = api_error(
        403,
        r#"{"type":"error","error":{"type":"EntitlementError"}}"#,
        "sk-secret",
    );
    assert!(!outcome.unauthorized);
    assert!(
        outcome.entitlement_error,
        "a 403 EntitlementError means no Go subscription"
    );
    assert!(outcome
        .error
        .unwrap_or_default()
        .contains("no tiene una suscripción"));

    let record = build_connection_record(
        &go_credential("oc_sk_live"),
        &EndpointProbe {
            endpoint_id: OPENCODE_GO_USAGE_ENDPOINT.to_string(),
            ok: false,
            http_status: Some(403),
            session_header_sent: false,
            entitlement_error: true,
        },
        None,
    );
    assert_eq!(record.status, "entitlement_error");
    assert!(record.endpoints.iter().all(|endpoint| !endpoint.ok));
}

#[test]
fn parses_console_meters() {
    let payload = json!({
        "access": {
            "endsAt": "2026-11-22T17:06:30.000Z",
            "meters": {
                "fiveHour": {
                    "limitMicroCents": 1_000,
                    "usedMicroCents": 250,
                    "resetsAt": "2026-10-22T23:02:11.000Z"
                },
                "week": {
                    "limitMicroCents": "2000",
                    "usedMicroCents": "500",
                    "resetsAt": "2026-10-26T00:00:00.000Z"
                },
                "month": {
                    "limitMicroCents": 4_000,
                    "usedMicroCents": 1_000
                }
            }
        }
    });

    let windows = parse_console_payload(&payload).expect("valid console payload");
    assert_eq!(windows.len(), 3);
    assert_eq!(windows[0].usage_percent, 25.0);
    assert_eq!(windows[1].resets_at, "2026-10-26T00:00:00.000Z");
    assert_eq!(windows[2].resets_at, "2026-11-22T17:06:30.000Z");
}

#[test]
fn normalizes_plain_api_keys() {
    assert_eq!(normalize_api_key("  sk-test  ").as_deref(), Some("sk-test"));
    assert_eq!(normalize_api_key("   "), None);
}

#[test]
fn strips_jsonc_comments_and_trailing_commas() {
    let input = r#"
    {
      // line comment
      "provider": {
        "opencode-go": { "options": { "apiKey": "sk-jsonc" } },
      },
    }
    "#;
    let value: Value = serde_json::from_str(&strip_jsonc(input)).expect("valid jsonc");
    assert_eq!(
        value.pointer("/provider/opencode-go/options/apiKey").and_then(Value::as_str),
        Some("sk-jsonc")
    );
}

// --- OpenCode Go, Console, and pay-as-you-go endpoint rows (T3 / S3, S5) ---

use crate::connections::{
    connection_id_for, ConnectionRecord, ConnectionRegistry, EndpointVerification,
};

struct TempRegistry(PathBuf);

impl TempRegistry {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "kite-opencode-connections-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp app data");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRegistry {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn go_credential(token: &str) -> Credential {
    api_key_credential(token.to_string(), "Kite (test)".to_string())
}

fn console_credential(token: &str, org_id: Option<&str>) -> Credential {
    Credential {
        token: token.to_string(),
        kind: CredentialKind::Console,
        source: "OpenCode Console (opencode)".to_string(),
        console_base: None,
        org_id: org_id.map(str::to_string),
        expires_ms: None,
    }
}

fn probe(endpoint_id: &str, ok: bool, session_header_sent: bool) -> EndpointProbe {
    EndpointProbe {
        endpoint_id: endpoint_id.to_string(),
        ok,
        http_status: Some(if ok { 200 } else { 401 }),
        session_header_sent,
        entitlement_error: false,
    }
}

#[test]
fn go_inference_resolver_rejects_console_oauth() {
    let console = console_credential("console-access-token", Some("org-42"));
    assert_eq!(
        go_api_key_from(Some(console)),
        None,
        "a Console OAuth access token must not become the Go inference credential"
    );

    let resolved = go_api_key_from(Some(go_credential("oc_sk_live")))
        .expect("an API key is the Go inference credential");
    assert_eq!(resolved.0, "oc_sk_live");
    assert_eq!(resolved.1, "Kite (test)");
}

#[test]
fn usage_probe_does_not_mark_a_payg_chat_endpoint_ok() {
    let temp = TempRegistry::new();
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");
    let credential = go_credential("oc_sk_live");
    let identity = credential.connection_identity();
    let connection_id = connection_id_for("opencode", "api_key", &identity);

    // A row from an older store that wrongly claims the pay-as-you-go chat
    // route for a Go key.
    registry
        .save(&ConnectionRecord {
            connection_id: connection_id.clone(),
            driver_kind: "opencode".into(),
            display_name: "OpenCode Go".into(),
            auth_method: "api_key".into(),
            account_identity: identity,
            credential_ref: "vault".into(),
            billing_mode: Some("subscription".into()),
            endpoints: vec![
                EndpointVerification {
                    endpoint_id: OPENCODE_GO_USAGE_ENDPOINT.into(),
                    ok: false,
                },
                EndpointVerification {
                    endpoint_id: "https://opencode.ai/inference/v1/chat/completions".into(),
                    ok: true,
                },
                EndpointVerification {
                    endpoint_id: "https://opencode.ai/inference/openai/v1/chat/completions"
                        .into(),
                    ok: true,
                },
            ],
            status: "imported".into(),
            last_checked_ms: None,
            expires_ms: None,
            last_http_status: None,
        })
        .expect("seed stale row");

    persist_probe(
        &mut registry,
        &credential,
        &probe(OPENCODE_GO_USAGE_ENDPOINT, true, false),
    )
    .expect("persist usage probe");

    let saved = registry
        .load(&connection_id)
        .expect("load connection")
        .expect("connection exists");
    let usage = saved
        .endpoints
        .iter()
        .find(|endpoint| endpoint.endpoint_id == OPENCODE_GO_USAGE_ENDPOINT)
        .expect("usage endpoint");
    assert!(usage.ok, "the verified usage endpoint stays ok");
    for payg in [
        "https://opencode.ai/inference/v1/chat/completions",
        "https://opencode.ai/inference/openai/v1/chat/completions",
    ] {
        assert!(
            saved
                .endpoints
                .iter()
                .all(|endpoint| endpoint.endpoint_id != payg),
            "a usage probe must not keep {payg} for a Go key"
        );
    }
    assert_eq!(saved.billing_mode.as_deref(), Some("subscription"));
    assert_eq!(saved.status, "verified");
}

#[test]
fn go_chat_endpoint_requires_an_opencode_session_header() {
    let credential = go_credential("oc_sk_live");

    let without_session = build_connection_record(
        &credential,
        &probe(OPENCODE_GO_CHAT_ENDPOINT, true, false),
        None,
    );
    assert!(
        without_session
            .endpoints
            .iter()
            .all(|endpoint| endpoint.endpoint_id != OPENCODE_GO_CHAT_ENDPOINT),
        "the Go chat endpoint cannot be verified without x-opencode-session"
    );

    let with_session = build_connection_record(
        &credential,
        &probe(OPENCODE_GO_CHAT_ENDPOINT, true, true),
        None,
    );
    let chat = with_session
        .endpoints
        .iter()
        .find(|endpoint| endpoint.endpoint_id == OPENCODE_GO_CHAT_ENDPOINT)
        .expect("chat endpoint");
    assert!(chat.ok);

    // The plan catalog does not need a session header, and it is a different
    // endpoint from the chat gateway.
    let models = build_connection_record(
        &credential,
        &probe(OPENCODE_GO_MODELS_ENDPOINT, true, false),
        None,
    );
    assert_eq!(
        models.endpoints,
        vec![EndpointVerification {
            endpoint_id: OPENCODE_GO_MODELS_ENDPOINT.into(),
            ok: true,
        }]
    );
}

#[test]
fn go_and_console_persist_as_separate_connections() {
    let temp = TempRegistry::new();
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

    let go = go_credential("oc_sk_live");
    persist_probe(
        &mut registry,
        &go,
        &probe(OPENCODE_GO_USAGE_ENDPOINT, true, false),
    )
    .expect("persist Go usage probe");

    let console = console_credential("console-access-token", Some("org-42"));
    let console_endpoint = console.console_status_url();
    persist_probe(
        &mut registry,
        &console,
        &probe(&console_endpoint, true, false),
    )
    .expect("persist Console status probe");
    // A Console OAuth token is not the Go inference credential, so probing a
    // Go endpoint with it records nothing.
    persist_probe(
        &mut registry,
        &console,
        &probe(OPENCODE_GO_USAGE_ENDPOINT, true, false),
    )
    .expect("reject Console probe of a Go endpoint");

    let records = registry.list().expect("list connections");
    assert_eq!(records.len(), 2, "Go and Console are different connections");

    let go_record = records
        .iter()
        .find(|record| record.auth_method == "api_key")
        .expect("Go connection");
    assert_eq!(go_record.account_identity.org_id, None);
    assert_eq!(go_record.billing_mode.as_deref(), Some("subscription"));
    assert_eq!(go_record.credential_ref, "kite_file");
    assert_eq!(
        go_record.endpoints,
        vec![EndpointVerification {
            endpoint_id: OPENCODE_GO_USAGE_ENDPOINT.into(),
            ok: true,
        }]
    );

    let console_record = records
        .iter()
        .find(|record| record.auth_method == "console_oauth")
        .expect("Console connection");
    assert_eq!(
        console_record.account_identity.org_id.as_deref(),
        Some("org-42")
    );
    assert_eq!(
        console_record.endpoints,
        vec![EndpointVerification {
            endpoint_id: console_endpoint,
            ok: true,
        }],
        "Console OAuth verifies only the Console status endpoint"
    );
    assert_ne!(go_record.connection_id, console_record.connection_id);
}

#[test]
fn a_failed_request_does_not_rewrite_an_endpoint_verification() {
    let timeout = FetchOutcome {
        http_status: None,
        windows: None,
        error: Some("temporal".to_string()),
        unauthorized: false,
        entitlement_error: false,
    };
    assert!(
        probe_from_outcome(OPENCODE_GO_USAGE_ENDPOINT, &timeout).is_none(),
        "a transport failure is not endpoint evidence"
    );

    let rejected = FetchOutcome {
        http_status: Some(401),
        windows: None,
        error: Some("unauthorized".to_string()),
        unauthorized: true,
        entitlement_error: false,
    };
    let probe = probe_from_outcome(OPENCODE_GO_USAGE_ENDPOINT, &rejected)
        .expect("an HTTP response is endpoint evidence");
    assert!(!probe.ok);
    assert_eq!(probe.http_status, Some(401));
}

#[test]
fn console_session_is_persisted_next_to_a_go_key() {
    let temp = TempRegistry::new();
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

    persist_probe(
        &mut registry,
        &go_credential("oc_sk_live"),
        &probe(OPENCODE_GO_USAGE_ENDPOINT, true, false),
    )
    .expect("persist Go usage probe");

    // A Console session is a different connection even when a Go key is the
    // credential the quota probe prefers.
    let console = console_credential("console-access-token", Some("org-42"));
    persist_known_console_connection(&mut registry, &console)
        .expect("record the Console session");

    let records = registry.list().expect("list connections");
    assert_eq!(records.len(), 2, "Go and Console stay separate connections");
    let console_id = connection_id_for(
        "opencode",
        "console_oauth",
        &console.connection_identity(),
    );
    let console_record = records
        .iter()
        .find(|record| record.connection_id == console_id)
        .expect("Console connection");
    assert_eq!(console_record.status, "unverified");
    assert!(
        console_record.endpoints.is_empty(),
        "a discovered Console session has no verified endpoint yet"
    );
    assert_eq!(
        console_record.account_identity.org_id.as_deref(),
        Some("org-42")
    );
    assert_eq!(console_record.credential_ref, "cli_file");

    // A later successful probe must survive the next discovery pass.
    persist_probe(
        &mut registry,
        &console,
        &probe(&console.console_status_url(), true, false),
    )
    .expect("persist Console status probe");
    persist_known_console_connection(&mut registry, &console)
        .expect("refresh the known row");

    let verified = registry
        .load(&console_id)
        .expect("load Console connection")
        .expect("Console connection exists");
    assert_eq!(verified.status, "verified");
    assert_eq!(verified.endpoints.len(), 1);
}
