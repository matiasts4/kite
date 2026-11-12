use super::*;
use serde_json::json;
use std::fs;
use uuid::Uuid;

#[test]
fn test_saved_account_profile_serialization() {
    let profile = SavedAccountProfile {
        id: "test-id-123".to_string(),
        provider: "agy".to_string(),
        label: "Work Account".to_string(),
        email: Some("dev@company.com".to_string()),
        plan_name: Some("Google AI Pro".to_string()),
        is_active: true,
        last_used_unix_ms: 1729000000000,
        primary_remaining_percent: Some(85.5),
        primary_reset_at: Some("18:00".to_string()),
        time_until_reset_ms: Some(3600000),
        credential_status: None,
        has_refresh_token: false,
    };

    let json_val = serde_json::to_value(&profile).expect("serialize profile");
    assert_eq!(json_val["id"], "test-id-123");
    assert_eq!(json_val["provider"], "agy");
    assert_eq!(json_val["label"], "Work Account");
    assert_eq!(json_val["email"], "dev@company.com");
    assert_eq!(json_val["isActive"], true);
    assert_eq!(json_val["primaryRemainingPercent"], 85.5);

    let deserialized: SavedAccountProfile = serde_json::from_value(json_val).expect("deserialize profile");
    assert_eq!(deserialized.id, profile.id);
    assert_eq!(deserialized.primary_remaining_percent, Some(85.5));
}

#[test]
fn test_provider_canonicalisation() {
    assert_eq!(canon_provider("antigravity"), "agy");
    assert!(same_provider("antigravity", "agy"));
    assert!(!same_provider("agy", "gemini"));
}

#[test]
fn list_saved_accounts_direct_returns_schema_without_panicking() {
    let value = list_saved_accounts_direct(Some(json!({ "provider": "agy" })));
    assert_eq!(value.get("schemaVersion").and_then(|v| v.as_i64()), Some(1));
    assert!(value.get("profiles").and_then(|v| v.as_array()).is_some());
}

#[test]
fn test_blocking_process_detection() {
    assert!(is_blocking_process("agy", "antigravity.exe"));
    assert!(is_blocking_process("agy", "antigravity"));
    assert!(!is_blocking_process("agy", "geminiapplauncher.exe"));
    assert!(!is_blocking_process("agy", "agy.exe"));
    assert!(!is_blocking_process("claude", "agy.exe"));
    assert!(!is_blocking_process("claude", "claude.exe"));
}

#[test]
fn test_copy_atomic_and_staged_path() {
    let dir = std::env::temp_dir().join(format!("bm-switcher-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let src = dir.join("a.json");
    let dst = dir.join("sub").join("b.json");
    fs::write(&src, b"hello").unwrap();

    assert!(copy_atomic(&src, &dst));
    assert_eq!(fs::read(&dst).unwrap(), b"hello");
    assert!(!staged_path(&dst).exists(), "temp file must not linger");
    assert!(!copy_atomic(&dir.join("missing"), &dst));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_save_current_account_profile_antigravity() {
    let mut reg = AccountProfilesRegistry::default();
    let p1 = SavedAccountProfile {
        id: "id-1".to_string(),
        provider: "agy".to_string(),
        label: "aloha".to_string(),
        email: Some("test@example.com".to_string()),
        plan_name: Some("Pro".to_string()),
        is_active: true,
        last_used_unix_ms: 100,
        primary_remaining_percent: Some(90.0),
        primary_reset_at: None,
        time_until_reset_ms: None,
        credential_status: None,
        has_refresh_token: false,
    };
    reg.profiles.push(p1);

    // A duplicate with same email should match existing and update instead of push
    let email = Some("test@example.com".to_string());
    let existing = reg.profiles.iter().position(|p| {
        p.provider == "agy" && p.email.as_ref().map_or(false, |e| e.eq_ignore_ascii_case(email.as_ref().unwrap()))
    });
    assert_eq!(existing, Some(0));
}

#[test]
fn test_get_provider_file_mappings_agy_is_clean() {
    let mappings = get_provider_file_mappings("agy");
    assert_eq!(mappings.len(), 2);
    let dests: Vec<&str> = mappings.iter().map(|m| m.rel_dest).collect();
    assert!(dests.contains(&"antigravity_state.pbtxt"));
    assert!(dests.contains(&"jetski_state.pbtxt"));
    assert!(!dests.contains(&"cli_settings.json"));
    assert!(!dests.contains(&"state.vscdb"));
    assert!(!dests.contains(&"storage.json"));
    assert!(!dests.contains(&"google_accounts.json"));
    assert!(!dests.contains(&"oauth_creds.json"));
}

#[test]
fn test_reconcile_agy_profile_integrity_repairs_drift() {
    let dir = std::env::temp_dir().join(format!("kite-reconcile-test-{}", Uuid::new_v4()));
    let agy_prof_dir = dir.join("agy").join("prof-1");
    fs::create_dir_all(&agy_prof_dir).unwrap();

    let cred_json = r#"{
        "token": {
            "access_token": "ya29.test",
            "refresh_token": "1//test"
        },
        "id_token_email": "reconciled@example.com"
    }"#;
    fs::write(agy_prof_dir.join("gemini_antigravity_cred.json"), cred_json).unwrap();
    fs::write(agy_prof_dir.join("oauth_creds.json"), "contaminated").unwrap();

    let mut reg = AccountProfilesRegistry::default();
    reg.profiles.push(SavedAccountProfile {
        id: "prof-1".to_string(),
        provider: "agy".to_string(),
        label: "Old Label".to_string(),
        email: Some("stale@example.com".to_string()),
        plan_name: None,
        is_active: true,
        last_used_unix_ms: 100,
        primary_remaining_percent: None,
        primary_reset_at: None,
        time_until_reset_ms: None,
        credential_status: None,
        has_refresh_token: false,
    });

    save_registry_to(&dir, &reg).unwrap();

    let loaded = load_registry_from(&dir);
    assert_eq!(loaded.profiles.len(), 1);
    assert_eq!(loaded.profiles[0].email.as_deref(), Some("reconciled@example.com"));
    // Legacy contaminated file should be removed
    assert!(!agy_prof_dir.join("oauth_creds.json").exists());

    let _ = fs::remove_dir_all(&dir);
}

struct MockAgyCredStore {
    read_value: std::cell::RefCell<Option<String>>,
    forced_readback: std::cell::RefCell<Option<String>>,
    write_error: Option<String>,
}

impl AntigravityCredStore for MockAgyCredStore {
    fn read_raw(&self) -> Option<String> {
        self.forced_readback
            .borrow()
            .clone()
            .or_else(|| self.read_value.borrow().clone())
    }

    fn write_checked(&self, blob_json: &str) -> Result<(), String> {
        if let Some(ref err) = self.write_error {
            return Err(err.clone());
        }
        *self.read_value.borrow_mut() = Some(blob_json.to_string());
        Ok(())
    }
}

#[test]
fn test_load_registry_persists_email_deduplication_and_health_status() {
    let dir = std::env::temp_dir().join(format!("kite-dedup-test-{}", Uuid::new_v4()));
    let valid_dir = dir.join("agy").join("valid-prof");
    let tokenless_dir = dir.join("agy").join("tokenless-prof");
    fs::create_dir_all(&valid_dir).unwrap();
    fs::create_dir_all(&tokenless_dir).unwrap();

    fs::write(
        valid_dir.join("gemini_antigravity_cred.json"),
        r#"{"token":{"access_token":"ya29.ok","refresh_token":"1//ok"},"id_token_email":"dup@example.com"}"#,
    )
    .unwrap();
    fs::write(
        tokenless_dir.join("gemini_antigravity_cred.json"),
        r#"{"token":{"access_token":"","refresh_token":""},"id_token_email":"tokenless@example.com"}"#,
    )
    .unwrap();

    let profiles_json = json!({
        "profiles": [
            {
                "id": "dup-old",
                "provider": "agy",
                "label": "Old",
                "email": "dup@example.com",
                "planName": null,
                "isActive": false,
                "lastUsedUnixMs": 100
            },
            {
                "id": "valid-prof",
                "provider": "agy",
                "label": "New Valid",
                "email": "DUP@example.com",
                "planName": null,
                "isActive": true,
                "lastUsedUnixMs": 200
            },
            {
                "id": "tokenless-prof",
                "provider": "agy",
                "label": "Broken",
                "email": "tokenless@example.com",
                "planName": null,
                "isActive": false,
                "lastUsedUnixMs": 150
            },
            {
                "id": "missing-prof",
                "provider": "agy",
                "label": "Missing",
                "email": "missing@example.com",
                "planName": null,
                "isActive": false,
                "lastUsedUnixMs": 50
            }
        ]
    });
    fs::write(
        dir.join("profiles.json"),
        serde_json::to_vec_pretty(&profiles_json).unwrap(),
    )
    .unwrap();

    let loaded = load_registry_from(&dir);
    assert_eq!(loaded.profiles.len(), 3, "duplicate email should be pruned");

    let persisted_raw = fs::read_to_string(dir.join("profiles.json")).unwrap();
    let persisted_val: Value = serde_json::from_str(&persisted_raw).unwrap();
    assert_eq!(
        persisted_val["profiles"].as_array().unwrap().len(),
        3,
        "deduplicated list must be persisted to profiles.json immediately"
    );

    let valid = loaded.profiles.iter().find(|p| p.id == "valid-prof").unwrap();
    assert_eq!(valid.credential_status.as_deref(), Some("valid"));
    assert!(valid.has_refresh_token);

    let tokenless = loaded.profiles.iter().find(|p| p.id == "tokenless-prof").unwrap();
    assert_eq!(tokenless.credential_status.as_deref(), Some("missing_tokens"));
    assert!(!tokenless.has_refresh_token);

    let missing = loaded.profiles.iter().find(|p| p.id == "missing-prof").unwrap();
    assert_eq!(missing.credential_status.as_deref(), Some("missing_file"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_snapshot_active_to_profile_fails_closed_when_agy_cred_missing_or_tokenless() {
    let dir = std::env::temp_dir().join(format!("kite-snap-failclosed-{}", Uuid::new_v4()));
    let live_dir = dir.join("live");
    let root = dir.join("vault");
    fs::create_dir_all(&live_dir).unwrap();
    fs::write(live_dir.join("antigravity_state.pbtxt"), "pbtxt-data").unwrap();

    let mappings = vec![FileMapping {
        source: live_dir.join("antigravity_state.pbtxt"),
        rel_dest: "antigravity_state.pbtxt",
    }];

    let empty_store = MockAgyCredStore {
        read_value: std::cell::RefCell::new(None),
        forced_readback: std::cell::RefCell::new(None),
        write_error: None,
    };
    let err_missing =
        snapshot_active_to_profile_with(&root, "agy", "p-missing", &mappings, None, &empty_store)
            .expect_err("missing credential must fail closed even if pbtxt exists");
    assert!(!err_missing.is_empty());

    let tokenless_store = MockAgyCredStore {
        read_value: std::cell::RefCell::new(Some(r#"{"id_token_email":"u@example.com"}"#.to_string())),
        forced_readback: std::cell::RefCell::new(None),
        write_error: None,
    };
    let err_tokenless =
        snapshot_active_to_profile_with(&root, "agy", "p-tokenless", &mappings, None, &tokenless_store)
            .expect_err("tokenless credential must fail closed");
    assert!(!err_tokenless.is_empty());
    assert!(
        !root.join("agy").join("p-tokenless").join("gemini_antigravity_cred.json").exists(),
        "failed snapshot must not leave broken credential artifact"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_apply_profile_rolls_back_on_post_write_verification_failure() {
    let dir = std::env::temp_dir().join(format!("kite-rollback-test-{}", Uuid::new_v4()));
    let root = dir.join("vault");
    let live_dir = dir.join("live");
    let target_dir = root.join("agy").join("target-prof");
    fs::create_dir_all(&live_dir).unwrap();
    fs::create_dir_all(&target_dir).unwrap();

    let prev_cred = r#"{"token":{"access_token":"ya29.prev","refresh_token":"1//prev"},"id_token_email":"prev@example.com"}"#;
    let next_cred = r#"{"token":{"access_token":"ya29.next","refresh_token":"1//next"},"id_token_email":"next@example.com"}"#;

    let live_pbtxt = live_dir.join("antigravity_state.pbtxt");
    fs::write(&live_pbtxt, "prev-pbtxt").unwrap();
    fs::write(target_dir.join("antigravity_state.pbtxt"), "next-pbtxt").unwrap();
    fs::write(target_dir.join("gemini_antigravity_cred.json"), next_cred).unwrap();

    let db_path = dir.join("state.vscdb");
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params![
                "antigravityAuthStatus",
                r#"{"email":"prev@example.com","name":"Prev"}"#
            ],
        )
        .unwrap();
    }

    let mappings = vec![FileMapping {
        source: live_pbtxt.clone(),
        rel_dest: "antigravity_state.pbtxt",
    }];

    // Simulate OS credential store returning stale previous value on verification readback
    let store = MockAgyCredStore {
        read_value: std::cell::RefCell::new(Some(prev_cred.to_string())),
        forced_readback: std::cell::RefCell::new(Some(prev_cred.to_string())),
        write_error: None,
    };

    let err = apply_profile_to_active_with(&root, "agy", "target-prof", &mappings, Some(&db_path), &store)
        .expect_err("verification mismatch must fail switch");
    assert!(!err.is_empty());

    // Live pbtxt, credential, and state.vscdb must all be rolled back cleanly
    assert_eq!(fs::read_to_string(&live_pbtxt).unwrap(), "prev-pbtxt");
    assert_eq!(store.read_value.borrow().as_deref(), Some(prev_cred));
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let auth_raw: String = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(auth_raw.contains("prev@example.com"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_reconcile_live_identity_clears_active_on_signout_and_keeps_list_fast() {
    let mut reg = AccountProfilesRegistry::default();
    reg.profiles.push(SavedAccountProfile {
        id: "prof-a".to_string(),
        provider: "agy".to_string(),
        label: "Account A".to_string(),
        email: Some("a@example.com".to_string()),
        plan_name: Some("Pro".to_string()),
        is_active: true,
        last_used_unix_ms: 100,
        primary_remaining_percent: Some(90.0),
        primary_reset_at: None,
        time_until_reset_ms: None,
        credential_status: Some("valid".to_string()),
        has_refresh_token: true,
    });
    reg.profiles.push(SavedAccountProfile {
        id: "prof-b".to_string(),
        provider: "agy".to_string(),
        label: "Account B".to_string(),
        email: Some("b@example.com".to_string()),
        plan_name: None,
        is_active: false,
        last_used_unix_ms: 90,
        primary_remaining_percent: None,
        primary_reset_at: None,
        time_until_reset_ms: None,
        credential_status: Some("valid".to_string()),
        has_refresh_token: true,
    });

    // When signed out (live_ident == None), stale is_active must be cleared cleanly
    let (changed_signout, unreg) = reconcile_live_identity_with_registry(&mut reg, "agy", None, None);
    assert!(changed_signout);
    assert!(unreg.is_none());
    assert!(reg.profiles.iter().all(|p| !p.is_active));

    // When live probe reports Account B, prof-b becomes active and prof-a stays inactive
    let live_b = LiveIdentityProbe {
        provider: "agy".to_string(),
        email: "b@example.com".to_string(),
        name: Some("User B".to_string()),
        source: "gemini:antigravity".to_string(),
    };
    let (changed_b, _) = reconcile_live_identity_with_registry(&mut reg, "agy", Some(&live_b), None);
    assert!(changed_b);
    assert!(!reg.profiles[0].is_active);
    assert!(reg.profiles[1].is_active);
}

#[test]
fn test_gemini_cli_mappings_stay_distinct_from_agy() {
    let gemini_maps = get_provider_file_mappings("gemini");
    let gemini_dests: Vec<&str> = gemini_maps.iter().map(|m| m.rel_dest).collect();
    assert!(gemini_dests.contains(&"oauth_creds.json"));
    assert!(gemini_dests.contains(&"google_accounts.json"));
}

#[test]
fn test_ensure_provider_idle_fails_closed_when_process_enum_unavailable() {
    use super::storage::ensure_provider_idle_with;

    let err = ensure_provider_idle_with("agy", None)
        .expect_err("process enumeration failure must fail closed instead of Ok(())");
    assert!(!err.is_empty());

    let blocking = ensure_provider_idle_with(
        "agy",
        Some(vec!["powershell.exe".to_string(), "antigravity.exe".to_string()]),
    )
    .expect_err("external Antigravity IDE process must block switch");
    assert!(blocking.contains("antigravity.exe"));

    ensure_provider_idle_with(
        "agy",
        Some(vec!["powershell.exe".to_string(), "codex.exe".to_string()]),
    )
    .expect("unrelated CLI or shell processes must not block Antigravity switch");
}
