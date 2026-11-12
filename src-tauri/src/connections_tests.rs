use super::*;

fn identity(org_id: &str) -> AccountIdentity {
    AccountIdentity {
        email: None,
        org_id: Some(org_id.to_string()),
        account_id: None,
    }
}

#[test]
fn two_opencode_auth_methods_get_two_connection_ids() {
    let go_key = build_connection(ConnectionDraft {
        driver_kind: "opencode".into(),
        auth_method: "api_key".into(),
        account_identity: identity("org-1"),
        billing_mode: Some("subscription".into()),
        endpoints: vec![],
    });
    let console = build_connection(ConnectionDraft {
        driver_kind: "opencode".into(),
        auth_method: "console_oauth".into(),
        account_identity: identity("org-1"),
        billing_mode: Some("payg".into()),
        endpoints: vec![],
    });

    assert_ne!(go_key.connection_id, console.connection_id);
    assert!(go_key.rejected.is_empty());
    assert!(console.rejected.is_empty());
}

#[test]
fn go_key_is_not_stored_as_valid_for_payg_chat() {
    let stored = build_connection(ConnectionDraft {
        driver_kind: "opencode".into(),
        auth_method: "api_key".into(),
        account_identity: identity("org-1"),
        billing_mode: Some("subscription".into()),
        endpoints: vec![EndpointVerification {
            endpoint_id: OPENCODE_PAYG_CHAT_ENDPOINT.into(),
            ok: true,
        }],
    });

    assert!(stored.rejected.contains(&OPENCODE_PAYG_CHAT_ENDPOINT.to_string()));
    assert!(stored
        .endpoints
        .iter()
        .all(|endpoint| endpoint.endpoint_id != OPENCODE_PAYG_CHAT_ENDPOINT));
}

// --- Shared registry across the installed and dev installs (T2 / S6) ----

use serde_json::Value;

struct TempAppData(PathBuf);

impl TempAppData {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "kite-connections-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create temp app data");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempAppData {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_legacy_vault(path: &Path, rows: &[(&str, &str)]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create legacy vault dir");
    }
    let conn = Connection::open(path).expect("create legacy vault");
    conn.execute_batch(
        "CREATE TABLE credentials_vault (
             provider TEXT PRIMARY KEY,
             ciphertext TEXT NOT NULL,
             updated_at_unix_ms INTEGER NOT NULL
         );",
    )
    .expect("create credentials_vault");
    for (provider, secret) in rows {
        conn.execute(
            "INSERT INTO credentials_vault (provider, ciphertext, updated_at_unix_ms)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![provider, crate::credentials::encrypt_secret(secret), 1i64],
        )
        .expect("insert legacy credential");
    }
    drop(conn);
}

fn write_legacy_profiles(root: &Path, profiles: &[(&str, &str, &str)]) {
    fs::create_dir_all(root).expect("create legacy profiles root");
    let items: Vec<Value> = profiles
        .iter()
        .map(|(provider, id, email)| {
            serde_json::json!({
                "id": id,
                "provider": provider,
                "label": format!("{provider} {id}"),
                "email": email,
                "planName": Value::Null,
                "isActive": true,
                "lastUsedUnixMs": 1,
                "primaryRemainingPercent": Value::Null,
                "primaryResetAt": Value::Null,
                "timeUntilResetMs": Value::Null
            })
        })
        .collect();
    let registry = serde_json::json!({ "profiles": items });
    fs::write(
        root.join("profiles.json"),
        serde_json::to_vec_pretty(&registry).expect("serialize profiles"),
    )
    .expect("write legacy profiles");
}

#[test]
fn shared_connections_root_ignores_the_dev_flag() {
    let base = std::env::temp_dir().join(format!(
        "kite-connections-path-{}",
        uuid::Uuid::new_v4()
    ));
    let dev = shared_connections_root_for(&base, true);
    let installed = shared_connections_root_for(&base, false);

    assert_eq!(dev, installed, "dev and installed must resolve the same root");
    let normalized = dev.to_string_lossy().replace('\\', "/");
    assert!(
        normalized.ends_with("Kite Code/connections"),
        "unexpected shared root: {normalized}"
    );
    assert_eq!(
        registry_path_for(&base, true),
        dev.join(REGISTRY_FILE_NAME)
    );
}

#[test]
fn import_reads_both_legacy_vaults_and_keeps_sources_byte_identical() {
    let temp = TempAppData::new();
    let installed_root = temp.path().join(SHARED_INSTALL_FOLDER);
    let dev_root = temp.path().join(DEV_INSTALL_FOLDER);

    let installed_vault = installed_root.join("kite.sqlite");
    let dev_vault = dev_root.join("kite.sqlite");
    write_legacy_vault(
        &installed_vault,
        &[("claude", "sk-ant-installed"), ("opencode", "oc_sk_installed")],
    );
    write_legacy_vault(&dev_vault, &[("codex", "codex-dev-secret")]);

    let installed_profiles = installed_root.join(ACCOUNT_PROFILES_FOLDER);
    write_legacy_profiles(
        &installed_profiles,
        &[("claude", "installed-claude", "installed@example.com")],
    );
    let installed_snapshot = installed_profiles.join("claude").join("installed-claude");
    fs::create_dir_all(&installed_snapshot).expect("create installed snapshot dir");
    fs::write(
        installed_snapshot.join("session.json"),
        b"installed-claude-session",
    )
    .expect("write installed snapshot");

    let dev_profiles = dev_root.join(ACCOUNT_PROFILES_FOLDER);
    write_legacy_profiles(
        &dev_profiles,
        &[("codex", "dev-codex", "dev@example.com")],
    );

    let cli_auth = temp.path().join("user-home").join(".codex").join("auth.json");
    fs::create_dir_all(cli_auth.parent().unwrap()).expect("create cli fixture dir");
    fs::write(&cli_auth, br#"{"token":"cli-fixture"}"#).expect("write cli fixture");

    let installed_vault_before = fs::read(&installed_vault).expect("read installed vault");
    let dev_vault_before = fs::read(&dev_vault).expect("read dev vault");
    let cli_auth_before = fs::read(&cli_auth).expect("read cli fixture");

    let report = import_legacy_connections(temp.path());
    assert!(report.error.is_none(), "import error: {:?}", report.error);
    assert!(!report.already_imported);
    assert_eq!(report.sources.len(), 2);
    for source in &report.sources {
        assert!(
            source.error.is_none(),
            "source {} failed: {:?}",
            source.source,
            source.error
        );
    }

    let registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
    let records = registry.list().expect("list connections");
    assert_eq!(records.len(), 3);

    let claude_id = connection_id_for("claude", "api_key", &AccountIdentity::default());
    let opencode_id = connection_id_for("opencode", "api_key", &AccountIdentity::default());
    let codex_id = connection_id_for("codex", "api_key", &AccountIdentity::default());

    let claude = registry
        .load(&claude_id)
        .expect("load claude")
        .expect("claude connection");
    assert_eq!(claude.driver_kind, "claude");
    assert_eq!(claude.auth_method, "api_key");
    assert_eq!(claude.credential_ref, "vault");
    assert!(claude.endpoints.is_empty());
    assert_eq!(
        registry.get_secret(&claude_id).as_deref(),
        Some("sk-ant-installed")
    );
    assert_eq!(
        registry.get_secret(&opencode_id).as_deref(),
        Some("oc_sk_installed")
    );
    assert_eq!(
        registry.get_secret(&codex_id).as_deref(),
        Some("codex-dev-secret")
    );

    let shared_profiles =
        shared_connections_root_for(temp.path(), false).join(ACCOUNT_PROFILES_FOLDER);
    let profiles: Value = serde_json::from_slice(
        &fs::read(shared_profiles.join("profiles.json")).expect("read shared profiles"),
    )
    .expect("parse shared profiles");
    let profiles = profiles["profiles"].as_array().expect("profiles array");
    assert_eq!(profiles.len(), 2);
    let ids: Vec<&str> = profiles.iter().filter_map(|p| p["id"].as_str()).collect();
    assert!(ids.contains(&"installed-claude"));
    assert!(ids.contains(&"dev-codex"));
    assert_eq!(
        fs::read(
            shared_profiles
                .join("claude")
                .join("installed-claude")
                .join("session.json")
        )
        .expect("read shared snapshot"),
        b"installed-claude-session"
    );

    assert_eq!(fs::read(&installed_vault).unwrap(), installed_vault_before);
    assert_eq!(fs::read(&dev_vault).unwrap(), dev_vault_before);
    assert_eq!(fs::read(&cli_auth).unwrap(), cli_auth_before);

    let second = import_legacy_connections(temp.path());
    assert!(second.already_imported, "import marker must stop a second copy");
}

#[test]
fn partial_import_leaves_sources_and_cli_auth_byte_identical() {
    let temp = TempAppData::new();
    let installed_root = temp.path().join(SHARED_INSTALL_FOLDER);
    let dev_root = temp.path().join(DEV_INSTALL_FOLDER);

    let installed_vault = installed_root.join("kite.sqlite");
    write_legacy_vault(&installed_vault, &[("gemini", "gemini-installed")]);

    let dev_vault = dev_root.join("kite.sqlite");
    fs::create_dir_all(&dev_root).expect("create dev root");
    fs::write(&dev_vault, b"not a sqlite database").expect("write invalid vault");

    let cli_auth = temp.path().join("user-home").join(".codex").join("auth.json");
    fs::create_dir_all(cli_auth.parent().unwrap()).expect("create cli fixture dir");
    fs::write(&cli_auth, br#"{"token":"cli-fixture"}"#).expect("write cli fixture");

    let installed_before = fs::read(&installed_vault).unwrap();
    let dev_before = fs::read(&dev_vault).unwrap();
    let cli_before = fs::read(&cli_auth).unwrap();

    let report = import_legacy_connections(temp.path());
    assert!(
        report.sources.iter().any(|source| source.error.is_some()),
        "an unreadable dev vault must be reported"
    );
    assert_eq!(fs::read(&installed_vault).unwrap(), installed_before);
    assert_eq!(fs::read(&dev_vault).unwrap(), dev_before);
    assert_eq!(fs::read(&cli_auth).unwrap(), cli_before);

    let gemini_id = connection_id_for("gemini", "api_key", &AccountIdentity::default());
    let registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
    assert_eq!(registry.list().unwrap().len(), 1);
    assert_eq!(
        registry.get_secret(&gemini_id).as_deref(),
        Some("gemini-installed")
    );

    let retry = import_legacy_connections(temp.path());
    assert!(
        retry.sources.iter().any(|source| source.error.is_some()),
        "a partial import must not mark the registry complete"
    );

    fs::remove_file(&dev_vault).expect("replace invalid vault");
    write_legacy_vault(&dev_vault, &[("codex", "codex-dev")]);
    let recovered = import_legacy_connections(temp.path());
    assert!(
        recovered.sources.iter().all(|source| source.error.is_none()),
        "retry after fixing the dev vault must succeed: {:?}",
        recovered.sources
    );
    assert_eq!(registry.list().unwrap().len(), 2);
    assert_eq!(fs::read(&cli_auth).unwrap(), cli_before);
}

#[test]
fn saved_connections_land_in_the_shared_registry() {
    let temp = TempAppData::new();
    let identity = AccountIdentity::default();
    let record = ConnectionRecord {
        connection_id: connection_id_for("opencode", "api_key", &identity),
        driver_kind: "opencode".into(),
        display_name: "OpenCode Go".into(),
        auth_method: "api_key".into(),
        account_identity: identity,
        credential_ref: "vault".into(),
        billing_mode: Some("subscription".into()),
        endpoints: vec![EndpointVerification {
            endpoint_id: "https://opencode.ai/zen/go/v1/usage".into(),
            ok: true,
        }],
        status: "verified".into(),
        last_checked_ms: Some(7),
        expires_ms: None,
        last_http_status: Some(200),
    };

    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
    registry.save(&record).expect("save connection");
    registry
        .set_secret(&record.connection_id, "oc_sk_test")
        .expect("save secret");

    assert_eq!(
        registry.path(),
        registry_path_for(temp.path(), false).as_path()
    );
    assert_eq!(
        registry.load(&record.connection_id).unwrap(),
        Some(record.clone())
    );
    assert_eq!(
        registry.get_secret(&record.connection_id).as_deref(),
        Some("oc_sk_test")
    );
    assert_eq!(registry.list().unwrap().len(), 1);
}

#[test]
fn connection_record_projects_endpoint_rows_without_a_driver_flag() {
    let identity = AccountIdentity::default();
    let record = ConnectionRecord {
        connection_id: connection_id_for("opencode", "api_key", &identity),
        driver_kind: "opencode".into(),
        display_name: "OpenCode Go".into(),
        auth_method: "api_key".into(),
        account_identity: identity,
        credential_ref: "vault".into(),
        billing_mode: Some("subscription".into()),
        endpoints: vec![
            EndpointVerification {
                endpoint_id: "https://opencode.ai/zen/go/v1/usage".into(),
                ok: true,
            },
            EndpointVerification {
                endpoint_id: "https://opencode.ai/inference/go/openai/v1/chat/completions"
                    .into(),
                ok: false,
            },
        ],
        status: "verified".into(),
        last_checked_ms: Some(7),
        expires_ms: None,
        last_http_status: Some(200),
    };

    let value = serde_json::to_value(&record).expect("serialize connection");
    assert_eq!(value["connectionId"], record.connection_id);
    assert_eq!(value["driverKind"], "opencode");
    assert_eq!(
        value["endpoints"][0]["endpointId"],
        "https://opencode.ai/zen/go/v1/usage"
    );
    assert_eq!(value["endpoints"][0]["ok"], true);
    assert_eq!(value["endpoints"][1]["ok"], false);
    assert!(
        value.get("connected").is_none(),
        "a connection never exposes a driver-wide connected flag"
    );
    assert!(
        value.get("provider").is_none(),
        "the driver id is not the connection key"
    );
}

// --- A provider-key save writes the shared registry (T11 / S5, S6) ------

#[test]
fn saving_an_api_key_creates_a_shared_connection_without_endpoints() {
    let temp = TempAppData::new();
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");

    persist_api_key_connection(&mut registry, "opencode", "oc_sk_saved")
        .expect("record the saved key");

    let identity = AccountIdentity::default();
    let connection_id = connection_id_for("opencode", "api_key", &identity);
    let record = registry
        .load(&connection_id)
        .expect("load connection")
        .expect("a saved key must create a connection");

    assert_eq!(record.driver_kind, "opencode");
    assert_eq!(record.display_name, "opencode");
    assert_eq!(record.auth_method, "api_key");
    assert_eq!(record.account_identity, identity);
    assert_eq!(record.credential_ref, "vault");
    assert_eq!(record.status, "unverified");
    assert!(
        record.endpoints.is_empty(),
        "saving a key verifies no endpoint: {:?}",
        record.endpoints
    );
    assert_eq!(
        registry.get_secret(&connection_id).as_deref(),
        Some("oc_sk_saved")
    );

    // The other build opens the same shared file by app-data root.
    let other_build =
        ConnectionRegistry::open_at(temp.path()).expect("reopen the shared registry");
    assert!(
        other_build.load(&connection_id).unwrap().is_some(),
        "both builds must see the saved key connection"
    );
}

#[test]
fn re_saving_an_api_key_keeps_a_verified_endpoint_and_replaces_the_secret() {
    let temp = TempAppData::new();
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
    let identity = AccountIdentity::default();
    let connection_id = connection_id_for("opencode", "api_key", &identity);
    let verified_endpoint = "https://opencode.ai/zen/go/v1/usage";

    registry
        .save(&ConnectionRecord {
            connection_id: connection_id.clone(),
            driver_kind: "opencode".into(),
            display_name: "OpenCode Go".into(),
            auth_method: "api_key".into(),
            account_identity: identity.clone(),
            credential_ref: "vault".into(),
            billing_mode: Some("subscription".into()),
            endpoints: vec![EndpointVerification {
                endpoint_id: verified_endpoint.into(),
                ok: true,
            }],
            status: "verified".into(),
            last_checked_ms: Some(11),
            expires_ms: Some(22),
            last_http_status: Some(200),
        })
        .expect("seed a verified connection");
    registry
        .set_secret(&connection_id, "oc_sk_old")
        .expect("seed the old secret");

    persist_api_key_connection(&mut registry, "opencode", "oc_sk_new")
        .expect("re-save the api key");

    assert_eq!(
        registry.get_secret(&connection_id).as_deref(),
        Some("oc_sk_new"),
        "re-saving a key must replace the stored secret"
    );
    let record = registry
        .load(&connection_id)
        .expect("load connection")
        .expect("the connection still exists");
    assert!(
        record
            .endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == verified_endpoint && endpoint.ok),
        "re-saving a key must not erase an endpoint a probe already verified: {:?}",
        record.endpoints
    );
    assert!(
        record.endpoints.iter().filter(|endpoint| endpoint.ok).count() == 1,
        "re-saving a key must not mark any new endpoint ok: {:?}",
        record.endpoints
    );
    assert_eq!(record.display_name, "OpenCode Go");
    assert_eq!(record.account_identity, identity);
    assert_eq!(record.billing_mode.as_deref(), Some("subscription"));
    assert_eq!(record.status, "verified");
    assert_eq!(record.last_checked_ms, Some(11));
    assert_eq!(record.expires_ms, Some(22));
    assert_eq!(record.last_http_status, Some(200));
}

#[test]
fn saving_an_opencode_key_never_leaves_a_payg_chat_endpoint_ok() {
    let temp = TempAppData::new();
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
    let identity = AccountIdentity::default();
    let connection_id = connection_id_for("opencode", "api_key", &identity);

    // A row from an older store that wrongly claims pay-as-you-go chat for
    // a Go key.
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
                    endpoint_id: OPENCODE_PAYG_CHAT_ENDPOINT.into(),
                    ok: true,
                },
                EndpointVerification {
                    endpoint_id: "https://opencode.ai/inference/openai/v1/chat/completions"
                        .into(),
                    ok: true,
                },
            ],
            status: "verified".into(),
            last_checked_ms: Some(1),
            expires_ms: None,
            last_http_status: Some(200),
        })
        .expect("seed stale row");

    persist_api_key_connection(&mut registry, "opencode", "oc_sk_go_key")
        .expect("record the saved key");

    let record = registry
        .load(&connection_id)
        .unwrap()
        .expect("connection exists");
    assert!(
        record.endpoints.iter().all(|endpoint| !endpoint.ok),
        "a key save must not leave any endpoint verified: {:?}",
        record.endpoints
    );
    for endpoint_id in [
        OPENCODE_PAYG_CHAT_ENDPOINT,
        "https://opencode.ai/inference/openai/v1/chat/completions",
    ] {
        assert!(
            !record
                .endpoints
                .iter()
                .any(|endpoint| endpoint.endpoint_id == endpoint_id && endpoint.ok),
            "pay-as-you-go chat endpoint {endpoint_id} must not be ok after a key save"
        );
    }
}

#[test]
fn saving_a_grok_key_uses_its_own_api_key_connection() {
    let temp = TempAppData::new();
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");

    persist_api_key_connection(&mut registry, "grok", "xai-test-key")
        .expect("record the saved key");

    let identity = AccountIdentity::default();
    let grok_id = connection_id_for("grok", "api_key", &identity);
    let record = registry
        .load(&grok_id)
        .expect("load connection")
        .expect("grok key must create a connection");
    assert_eq!(record.driver_kind, "grok");
    assert_eq!(record.auth_method, "api_key");
    assert_eq!(record.credential_ref, "vault");
    assert_eq!(
        registry.get_secret(&grok_id).as_deref(),
        Some("xai-test-key")
    );
    assert_ne!(
        grok_id,
        connection_id_for("opencode", "api_key", &identity),
        "connections are not keyed by auth method alone"
    );
}

#[test]
fn an_empty_api_key_creates_no_connection() {
    let temp = TempAppData::new();
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");

    persist_api_key_connection(&mut registry, "opencode", "   ").expect("empty key is a no-op");

    assert!(
        registry.list().unwrap().is_empty(),
        "an empty key must not create a connection"
    );
    let connection_id = connection_id_for("opencode", "api_key", &AccountIdentity::default());
    assert!(registry.get_secret(&connection_id).is_none());
}

#[test]
fn non_chat_provider_keys_stay_vault_only() {
    let temp = TempAppData::new();
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");

    for provider in [
        "grok_transcription",
        "vercel",
        "cloudflare",
        "cloudflare_account_id",
    ] {
        persist_api_key_connection(&mut registry, provider, "secret-value")
            .expect("a vault-only key is not a connection");
    }

    assert!(
        registry.list().unwrap().is_empty(),
        "only opencode and grok keys own a shared chat connection"
    );
}

#[test]
fn a_failed_registry_write_is_reported() {
    let temp = TempAppData::new();
    let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
    registry
        .conn
        .execute_batch(
            "CREATE TRIGGER deny_connection_insert BEFORE INSERT ON connections
             BEGIN SELECT RAISE(ABORT, 'denied by test'); END;",
        )
        .expect("install failing trigger");

    let error = persist_api_key_connection(&mut registry, "opencode", "oc_sk_saved")
        .expect_err("a failed registry write must not look like success");
    assert!(
        error.contains("connection registry") || error.contains("denied by test"),
        "unexpected registry error: {error}"
    );
}
