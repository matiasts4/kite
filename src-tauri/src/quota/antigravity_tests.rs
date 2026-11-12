use super::*;
use crate::connections::{connection_id_for, ConnectionRegistry};

struct TempAppData(PathBuf);

impl TempAppData {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "kite-antigravity-connections-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp app data");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempAppData {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn account(email: &str) -> AccountIdentity {
    AccountIdentity {
        email: Some(email.to_string()),
        org_id: None,
        account_id: None,
    }
}

/// RPC success is quota evidence for the language server only. The chat
/// route stays unverified even though both talk to the same product.
#[test]
fn rpc_quota_success_does_not_verify_the_cli_chat_endpoint() {
    let temp = TempAppData::new();
    let identity = account("rpc@example.com");
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

    let recorded = record_local_rpc_probe(&mut registry, &identity).expect("record RPC probe");

    assert_eq!(recorded.auth_method, "local_rpc");
    assert_eq!(recorded.status, "verified");
    assert!(recorded
        .endpoints
        .iter()
        .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_RPC_QUOTA_ENDPOINT && endpoint.ok));
    assert!(!recorded
        .endpoints
        .iter()
        .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_CLI_CHAT_ENDPOINT));
    assert!(!recorded
        .endpoints
        .iter()
        .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_CLI_QUOTA_ENDPOINT));

    let stored = registry
        .load(&connection_id_for("antigravity", "local_rpc", &identity))
        .expect("load connection")
        .expect("stored connection");
    assert_eq!(stored, recorded);

    for connection in registry.list().expect("list connections") {
        assert!(
            !connection
                .endpoints
                .iter()
                .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_CLI_CHAT_ENDPOINT && endpoint.ok),
            "{} must not claim CLI chat",
            connection.connection_id
        );
    }
}

/// Selecting the ACP auth method is not an ACP session. Endpoints stay
/// unverified until a handshake actually succeeds.
#[test]
fn selecting_acp_without_a_session_leaves_endpoints_unverified() {
    let temp = TempAppData::new();
    let identity = account("acp@example.com");
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

    let selected = record_acp_selected(&mut registry, &identity).expect("select ACP");

    assert_eq!(selected.auth_method, "acp");
    assert_eq!(selected.billing_mode.as_deref(), Some("subscription"));
    assert_eq!(selected.status, "unverified");
    assert!(selected.endpoints.iter().all(|endpoint| !endpoint.ok));
    assert!(!selected
        .endpoints
        .iter()
        .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_ACP_CHAT_ENDPOINT && endpoint.ok));

    let stored = registry
        .load(&selected.connection_id)
        .expect("load connection")
        .expect("stored connection");
    assert_eq!(stored, selected);
}

/// A real ACP session is the only path that verifies the ACP endpoint, and
/// re-selecting the method must not drop that verification.
#[test]
fn only_an_established_acp_session_verifies_the_acp_endpoint() {
    let temp = TempAppData::new();
    let identity = account("acp@example.com");
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

    record_acp_selected(&mut registry, &identity).expect("select ACP");
    let verified =
        record_acp_session_probe(&mut registry, &identity, "session-1").expect("record session");

    assert_eq!(verified.status, "verified");
    assert!(verified
        .endpoints
        .iter()
        .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_ACP_CHAT_ENDPOINT && endpoint.ok));

    let reselected = record_acp_selected(&mut registry, &identity).expect("select again");
    assert!(reselected
        .endpoints
        .iter()
        .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_ACP_CHAT_ENDPOINT && endpoint.ok));
    assert_eq!(reselected.status, "verified");
    assert!(record_acp_session_probe(&mut registry, &identity, "  ").is_err());
}

/// API key, CLI session, Google identity, RPC, and ACP for one account are
/// five connections, never one driver-wide row.
#[test]
fn antigravity_auth_methods_keep_separate_connections() {
    let temp = TempAppData::new();
    let identity = account("user@example.com");
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

    record_cli_quota_probe(&mut registry, &identity).expect("record CLI");
    record_local_rpc_probe(&mut registry, &identity).expect("record RPC");
    record_google_identity_probe(&mut registry, &identity).expect("record Google");
    record_acp_selected(&mut registry, &identity).expect("select ACP");
    record_api_key_selected(&mut registry, &AccountIdentity::default()).expect("record API key");

    let records = registry.list().expect("list connections");
    assert_eq!(records.len(), 5);
    let mut ids: Vec<&str> = records.iter().map(|record| record.connection_id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 5);

    for expected in ANTIGRAVITY_AUTH_METHODS {
        assert!(
            records.iter().any(|record| record.auth_method == *expected),
            "missing {expected} connection"
        );
    }

    let google = records
        .iter()
        .find(|record| record.auth_method == "google_oauth")
        .expect("google connection");
    assert!(google.endpoints.is_empty(), "identity must not verify an endpoint");
    let api_key = records
        .iter()
        .find(|record| record.auth_method == "api_key")
        .expect("api key connection");
    assert!(api_key.endpoints.is_empty());

    let cli = records
        .iter()
        .find(|record| record.auth_method == "cli_session")
        .expect("cli connection");
    assert!(cli
        .endpoints
        .iter()
        .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_CLI_QUOTA_ENDPOINT && endpoint.ok));
    assert!(!cli
        .endpoints
        .iter()
        .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_CLI_CHAT_ENDPOINT && endpoint.ok));

    let acp = records
        .iter()
        .find(|record| record.auth_method == "acp")
        .expect("acp connection");
    assert!(acp.endpoints.iter().all(|endpoint| !endpoint.ok));
}

#[test]
fn parse_antigravity_credential_blob_extracts_id_token_email() {
    let raw = r#"{
        "token": {
            "access_token": "ya29.test-access-token",
            "token_type": "Bearer",
            "refresh_token": "1//test-refresh-token",
            "expiry": "2026-10-30T19:13:14.8340187-03:00",
            "expires_in": 3599
        },
        "auth_method": "consumer",
        "id_token_email": "active-user@example.com"
    }"#;

    let parsed = parse_antigravity_credential_blob(raw).expect("should parse credential");
    assert_eq!(parsed.email, "active-user@example.com");
    assert_eq!(parsed.name, None);
    assert_eq!(parsed.auth_method.as_deref(), Some("consumer"));
    assert!(parsed.has_refresh_token);
    assert_eq!(parsed.source, "gemini:antigravity");
}

#[test]
fn parse_antigravity_credential_blob_extracts_jwt_claims() {
    // Base64Url for {"email":"jwt-user@example.com","name":"Test User"}
    let jwt = "header.eyJlbWFpbCI6Imp3dC11c2VyQGV4YW1wbGUuY29tIiwibmFtZSI6IlRlc3QgVXNlciJ9.signature";
    let raw = format!(
        r#"{{
            "token": {{
                "access_token": "ya29.test",
                "refresh_token": "1//refresh"
            }},
            "id_token": "{jwt}",
            "auth_method": "consumer"
        }}"#
    );

    let parsed = parse_antigravity_credential_blob(&raw).expect("should parse credential with jwt");
    assert_eq!(parsed.email, "jwt-user@example.com");
    assert_eq!(parsed.name.as_deref(), Some("Test User"));
    assert!(parsed.has_refresh_token);
}

#[test]
fn parse_antigravity_credential_with_tokens_rejects_tokenless_json_and_accepts_valid_oauth() {
    let tokenless = r#"{
        "token": {
            "access_token": "   ",
            "refresh_token": ""
        },
        "id_token_email": "empty@example.com",
        "auth_method": "consumer"
    }"#;
    assert_eq!(
        parse_antigravity_credential_with_tokens(tokenless),
        Err("missing_tokens")
    );
    assert!(!has_valid_antigravity_oauth_tokens(tokenless));

    let email_only = r#"{ "email": "only@example.com" }"#;
    assert_eq!(
        parse_antigravity_credential_with_tokens(email_only),
        Err("missing_tokens")
    );

    let corrupt = "{ not-json";
    assert_eq!(
        parse_antigravity_credential_with_tokens(corrupt),
        Err("corrupt")
    );

    let valid_access_only = r#"{
        "token": {
            "access_token": "ya29.only-access"
        },
        "id_token_email": "access@example.com"
    }"#;
    let parsed_access = parse_antigravity_credential_with_tokens(valid_access_only)
        .expect("access_token should satisfy valid token check");
    assert_eq!(parsed_access.email, "access@example.com");
    assert!(parsed_access.has_valid_tokens());
    assert!(has_valid_antigravity_oauth_tokens(valid_access_only));
}

#[test]
fn write_antigravity_credential_checked_rejects_oversized_blob_with_diagnostic() {
    let oversized_token = "x".repeat(2700);
    let blob = format!(
        r#"{{"token":{{"access_token":"{oversized_token}","refresh_token":"1//r"}},"id_token_email":"big@example.com"}}"#
    );
    let err = write_antigravity_credential_checked(&blob)
        .expect_err("blobs exceeding Win32 2560-byte limit must return diagnostic error");
    assert!(
        err.contains("2560"),
        "expected Win32 2560-byte limit diagnostic, got: {err}"
    );
}

#[test]
fn ide_auth_state_sqlite_roundtrip_restore_and_stale_key_cleanup() {
    let temp = TempAppData::new();
    let db_a = temp.path().join("state_a.vscdb");
    let db_b = temp.path().join("state_b.vscdb");

    {
        let conn = rusqlite::Connection::open(&db_a).expect("open db_a");
        conn.execute(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params![
                "antigravityAuthStatus",
                r#"{"email":"user-a@example.com","name":"User A"}"#
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params!["antigravityUnifiedStateSync.oauthToken", "oauth-a"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params!["antigravity.profileUrl", "https://example.com/a"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params!["workbench.colorTheme", "Default Dark+"],
        )
        .unwrap();
    }

    let snap = extract_ide_auth_state_from_db(&db_a)
        .expect("extract db_a")
        .expect("snapshot must exist");
    assert_eq!(snap.email.as_deref(), Some("user-a@example.com"));
    assert_eq!(snap.keys.len(), 3);
    assert!(!snap.keys.contains_key("workbench.colorTheme"));

    {
        let conn = rusqlite::Connection::open(&db_b).expect("open db_b");
        conn.execute(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params![
                "antigravityAuthStatus",
                r#"{"email":"old@example.com","name":"Old"}"#
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params!["antigravityUnifiedStateSync.userStatus", "stale-status"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params!["workbench.colorTheme", "KeepMe"],
        )
        .unwrap();
    }

    apply_ide_auth_state_to_db(&db_b, "user-a@example.com", Some(&snap))
        .expect("restore snap to db_b");

    {
        let conn = rusqlite::Connection::open(&db_b).expect("reopen db_b");
        let auth_raw: String = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(auth_raw.contains("user-a@example.com"));
        let theme: String = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = 'workbench.colorTheme'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(theme, "KeepMe");
        let stale_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.userStatus'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale_count, 0, "stale key not in restored snapshot must be cleared");
    }

    // Switching to another account without ide_auth_state.json clears mismatched auth keys
    // while keeping unrelated workbench keys intact.
    apply_ide_auth_state_to_db(&db_b, "user-c@example.com", None)
        .expect("clear mismatched IDE auth");
    {
        let conn = rusqlite::Connection::open(&db_b).expect("reopen db_b after clear");
        let auth_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ItemTable WHERE key = 'antigravityAuthStatus'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(auth_count, 0);
        let theme: String = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = 'workbench.colorTheme'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(theme, "KeepMe");
    }
}
