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
        ..Default::default()
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
        ..Default::default()
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
        ..Default::default()
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

    fn delete(&self) -> bool {
        *self.read_value.borrow_mut() = None;
        true
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
        ..Default::default()
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
        ..Default::default()
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

#[test]
fn test_switch_preflight_order_validates_target_before_idle_and_busy_terminals() {
    use super::commands::switch_preflight_check_with;
    use crate::terminal::{ProviderSessionSummary, ProviderSessionsInspection};

    let tmp = std::env::temp_dir().join(format!("kite_preflight_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    let prof_dir = tmp.join("agy").join("acc-valid");
    let bad_dir = tmp.join("agy").join("acc-tokenless");
    fs::create_dir_all(&prof_dir).unwrap();
    fs::create_dir_all(&bad_dir).unwrap();

    // Valid token profile
    let valid_cred = json!({
        "id_token_email": "valid@example.com",
        "token": {
            "access_token": "ya29.valid-access",
            "refresh_token": "1//valid-refresh"
        }
    });
    fs::write(
        prof_dir.join("gemini_antigravity_cred.json"),
        serde_json::to_string(&valid_cred).unwrap(),
    )
    .unwrap();

    // Tokenless profile
    let tokenless_cred = json!({
        "id_token_email": "broken@example.com",
        "token": {
            "access_token": "",
            "refresh_token": ""
        }
    });
    fs::write(
        bad_dir.join("gemini_antigravity_cred.json"),
        serde_json::to_string(&tokenless_cred).unwrap(),
    )
    .unwrap();

    let busy_inspection = ProviderSessionsInspection {
        managed_idle: vec![],
        managed_busy: vec![ProviderSessionSummary {
            session_id: "sid-busy-1".to_string(),
            engine: "agy".to_string(),
            workspace_id: Some("ws-1".to_string()),
            pane_id: Some("pane-1".to_string()),
            cwd: "E:/kite".to_string(),
            busy: true,
            reasons: vec!["recent_output".to_string()],
            last_output_age_ms: Some(450),
            presentation_live: true,
        }],
        external_blocking: vec![],
        unaffected_terminals_count: 2,
    };

    // 1. Tokenless target MUST fail BEFORE PROVIDER_BUSY or CONFIRM_BUSY_TERMINALS.
    let res_invalid = switch_preflight_check_with(
        &tmp,
        "antigravity",
        "acc-tokenless",
        false,
        Err("Antigravity IDE running".to_string()),
        &busy_inspection,
    )
    .expect("tokenless profile must fail preflight");
    assert_eq!(res_invalid["success"], false);
    assert_ne!(res_invalid["code"], "PROVIDER_BUSY");
    assert_ne!(res_invalid["code"], "CONFIRM_BUSY_TERMINALS");

    // 2. Valid target + blocking external IDE MUST fail with PROVIDER_BUSY BEFORE busy terminal prompt.
    let res_ide_busy = switch_preflight_check_with(
        &tmp,
        "antigravity",
        "acc-valid",
        true,
        Err("antigravity.exe está abierto".to_string()),
        &busy_inspection,
    )
    .expect("external blocking IDE must return PROVIDER_BUSY even when force=true");
    assert_eq!(res_ide_busy["success"], false);
    assert_eq!(res_ide_busy["code"], "PROVIDER_BUSY");

    // 3. Valid target + idle IDE + managedBusy + force=false MUST return CONFIRM_BUSY_TERMINALS.
    let res_confirm = switch_preflight_check_with(
        &tmp,
        "antigravity",
        "acc-valid",
        false,
        Ok(()),
        &busy_inspection,
    )
    .expect("busy terminal without force must pause with CONFIRM_BUSY_TERMINALS");
    assert_eq!(res_confirm["success"], false);
    assert_eq!(res_confirm["code"], "CONFIRM_BUSY_TERMINALS");
    assert_eq!(res_confirm["busySessions"][0]["sessionId"], "sid-busy-1");
    assert_eq!(res_confirm["managedIdleCount"], 0);
    assert_eq!(res_confirm["unaffectedTerminalsCount"], 2);

    // 4. Valid target + idle IDE + managedBusy + force=true MUST pass preflight (None).
    let res_forced = switch_preflight_check_with(
        &tmp,
        "antigravity",
        "acc-valid",
        true,
        Ok(()),
        &busy_inspection,
    );
    assert!(res_forced.is_none());

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_canonical_handoff_provider_normalizes_agy_and_defaults_to_antigravity() {
    use crate::chat::runtime::settle::canonical_handoff_provider;

    assert_eq!(canonical_handoff_provider(None), "antigravity");
    assert_eq!(canonical_handoff_provider(Some("")), "antigravity");
    assert_eq!(canonical_handoff_provider(Some("  ")), "antigravity");
    assert_eq!(canonical_handoff_provider(Some("agy")), "antigravity");
    assert_eq!(canonical_handoff_provider(Some("antigravity")), "antigravity");
    assert_eq!(canonical_handoff_provider(Some("codex")), "codex");
}

#[test]
fn test_invalidate_provider_model_cache_clears_agy_and_antigravity_aliases() {
    use crate::chat::models::{
        invalidate_provider_model_cache_in, model_cache, CachedProviderModels,
    };
    use crate::chat::normalize::catalog_cache_key;
    use std::time::Instant;

    let tmp_dir = std::env::temp_dir().join(format!("kite_model_cache_evict_{}", Uuid::new_v4()));
    fs::create_dir_all(&tmp_dir).unwrap();
    let disk_cache_path = tmp_dir.join("provider_models_cache.json");

    let key_pipe_default = catalog_cache_key("antigravity", None); // "antigravity|"
    let key_pipe_conn = catalog_cache_key("agy", Some("conn-1")); // "antigravity|conn-1"
    let key_colon = "antigravity:default".to_string();
    let key_codex_pipe = catalog_cache_key("codex", None); // "codex|"

    fs::write(
        &disk_cache_path,
        serde_json::to_string_pretty(&json!({
            "agy": { "models": [{ "id": "m0" }], "cachedAtUnixMs": 9999999999999i64 },
            key_pipe_default.clone(): { "models": [{ "id": "m1" }], "cachedAtUnixMs": 9999999999999i64 },
            key_pipe_conn.clone(): { "models": [{ "id": "m2" }], "cachedAtUnixMs": 9999999999999i64 },
            key_colon.clone(): { "models": [{ "id": "m3" }], "cachedAtUnixMs": 9999999999999i64 },
            key_codex_pipe.clone(): { "models": [{ "id": "gpt-5" }], "cachedAtUnixMs": 9999999999999i64 },
        }))
        .unwrap(),
    )
    .unwrap();

    {
        let mut cache = model_cache().lock().unwrap();
        for k in ["agy", &key_pipe_default, &key_pipe_conn, &key_colon] {
            cache.insert(
                k.to_string(),
                CachedProviderModels {
                    cached_at: Instant::now(),
                    models: vec![json!({ "id": "model-agy" })],
                },
            );
        }
        cache.insert(
            key_codex_pipe.clone(),
            CachedProviderModels {
                cached_at: Instant::now(),
                models: vec![json!({ "id": "gpt-5" })],
            },
        );
    }

    invalidate_provider_model_cache_in(&disk_cache_path, "antigravity");

    {
        let mut cache = model_cache().lock().unwrap();
        assert!(!cache.contains_key("agy"));
        assert!(!cache.contains_key(&key_pipe_default));
        assert!(!cache.contains_key(&key_pipe_conn));
        assert!(!cache.contains_key(&key_colon));
        assert!(cache.contains_key(&key_codex_pipe));
        cache.remove(&key_codex_pipe);
    }

    let disk_after: Value = serde_json::from_slice(&fs::read(&disk_cache_path).unwrap()).unwrap();
    let obj = disk_after.as_object().unwrap();
    assert!(!obj.contains_key("agy"));
    assert!(!obj.contains_key(&key_pipe_default));
    assert!(!obj.contains_key(&key_pipe_conn));
    assert!(!obj.contains_key(&key_colon));
    assert!(obj.contains_key(&key_codex_pipe));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_clear_provider_thread_handles_clears_antigravity_aliases_and_preserves_codex() {
    use crate::chat::runtime::state::clear_provider_thread_handles;

    let mut threads = vec![
        json!({ "id": "t1", "provider": "antigravity", "providerSessionId": "conv-old-1" }),
        json!({ "id": "t2", "provider": "agy", "providerSessionId": "conv-old-2" }),
        json!({ "id": "t3", "provider": "codex", "providerSessionId": "conv-codex" }),
    ];

    let cleared = clear_provider_thread_handles(&mut threads, "antigravity");
    assert_eq!(cleared, 2);
    assert!(threads[0]["providerSessionId"].is_null());
    assert!(threads[1]["providerSessionId"].is_null());
    assert_eq!(threads[2]["providerSessionId"], "conv-codex");
}

#[derive(Default)]
struct MockLoginFlowOps {
    quiesced_to_return: std::cell::RefCell<Vec<crate::terminal::QuiescedTerminal>>,
    quiesce_calls: std::cell::Cell<usize>,
    evict_calls: std::cell::Cell<usize>,
    respawn_calls: std::cell::RefCell<Vec<(String, Option<String>, Vec<String>)>>,
}

impl super::commands::LoginFlowOps for MockLoginFlowOps {
    fn quiesce_and_evict(&self) -> Vec<crate::terminal::QuiescedTerminal> {
        self.quiesce_calls.set(self.quiesce_calls.get() + 1);
        self.evict_calls.set(self.evict_calls.get() + 1);
        self.quiesced_to_return.borrow().clone()
    }

    fn invalidate_and_evict(&self) {
        self.evict_calls.set(self.evict_calls.get() + 1);
    }

    fn respawn(
        &self,
        account_label: &str,
        email: Option<&str>,
        quiesced: &[crate::terminal::QuiescedTerminal],
    ) {
        self.respawn_calls.borrow_mut().push((
            account_label.to_string(),
            email.map(String::from),
            quiesced.iter().map(|q| q.session_id.clone()).collect(),
        ));
    }
}

#[test]
fn test_clear_ide_auth_state_from_db_removes_only_auth_keys_in_tx() {
    let dir = std::env::temp_dir().join(format!("kite-clear-ide-db-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("state.vscdb");

    assert_eq!(crate::quota::clear_ide_auth_state_from_db(&dir.join("missing.vscdb")).unwrap(), false);

    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
            [],
        )
        .unwrap();
        for (k, v) in [
            ("antigravityAuthStatus", r#"{"email":"old@example.com","name":"Old"}"#),
            ("antigravityUnifiedStateSync.oauthToken", "tok-123"),
            ("antigravityUnifiedStateSync.userStatus", "status-123"),
            ("antigravity.profileUrl", "https://example.com/p.png"),
            ("unrelated.theme", "kite-dark"),
        ] {
            conn.execute(
                "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
                rusqlite::params![k, v],
            )
            .unwrap();
        }
    }

    assert_eq!(crate::quota::clear_ide_auth_state_from_db(&db_path).unwrap(), true);
    assert_eq!(crate::quota::clear_ide_auth_state_from_db(&db_path).unwrap(), false);

    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let remaining_auth = crate::quota::extract_ide_auth_rows_from_db(&db_path).unwrap();
    assert!(remaining_auth.is_empty());
    let unrelated: String = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'unrelated.theme'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unrelated, "kite-dark");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_inspect_raw_antigravity_credential_health_classifies_all_states() {
    assert_eq!(
        crate::quota::inspect_raw_antigravity_credential_health(None),
        ("missing_file", false, None)
    );
    assert_eq!(
        crate::quota::inspect_raw_antigravity_credential_health(Some("not-json")),
        ("corrupt", false, None)
    );
    assert_eq!(
        crate::quota::inspect_raw_antigravity_credential_health(Some(
            r#"{"id_token_email":"empty@example.com","token":{"access_token":"","refresh_token":""}}"#
        )),
        ("missing_tokens", false, None)
    );
    assert_eq!(
        crate::quota::inspect_raw_antigravity_credential_health(Some(
            r#"{"id_token_email":"access@example.com","token":{"access_token":"ya29.only"}}"#
        )),
        ("valid", false, Some("access@example.com".to_string()))
    );
    assert_eq!(
        crate::quota::inspect_raw_antigravity_credential_health(Some(
            r#"{"id_token_email":"full@example.com","token":{"access_token":"ya29.ok","refresh_token":"1//ok"}}"#
        )),
        ("valid", true, Some("full@example.com".to_string()))
    );
}

#[test]
fn test_build_antigravity_login_argv_from_help_supports_exe_cmd_and_fallback() {
    use std::path::Path;

    let (argv, cmd) = super::commands::build_antigravity_login_argv_from_help(
        Some(Path::new(r"C:\Tools\agy.exe")),
        Some("Flags:\n  --login   Log in with Google interactively, then exit"),
    );
    assert_eq!(argv, vec![r"C:\Tools\agy.exe", "acp", "--login"]);
    assert_eq!(cmd, "agy acp --login");

    let (argv_cmd, cmd_cmd) = super::commands::build_antigravity_login_argv_from_help(
        Some(Path::new(r"C:\Tools\agy.cmd")),
        Some("  --login   Log in with Google interactively"),
    );
    assert_eq!(argv_cmd, vec!["cmd.exe", "/C", r"C:\Tools\agy.cmd", "acp", "--login"]);
    assert_eq!(cmd_cmd, "agy acp --login");

    let (argv_fallback, cmd_fallback) = super::commands::build_antigravity_login_argv_from_help(
        Some(Path::new(r"C:\Tools\agy.exe")),
        Some("Usage: agy acp\n  --stdio"),
    );
    assert_eq!(argv_fallback, vec![r"C:\Tools\agy.exe"]);
    assert_eq!(cmd_fallback, "agy");

    let (argv_unresolved_login, cmd_unresolved_login) =
        super::commands::build_antigravity_login_argv_from_help(None, Some("  --login"));
    assert_eq!(argv_unresolved_login, vec!["agy", "acp", "--login"]);
    assert_eq!(cmd_unresolved_login, "agy acp --login");

    let (argv_unresolved, cmd_unresolved) =
        super::commands::build_antigravity_login_argv_from_help(None, None);
    assert_eq!(argv_unresolved, vec!["agy"]);
    assert_eq!(cmd_unresolved, "agy");
}

#[test]
fn test_start_and_cancel_account_login_flow_snapshots_clears_and_restores_all_auth_state() {
    use super::commands::{cancel_account_login_flow_with, probe_live_account_login_status_with, start_account_login_flow_with};
    use crate::terminal::{ProviderSessionSummary, ProviderSessionsInspection, QuiescedTerminal};

    let dir = std::env::temp_dir().join(format!("kite-login-flow-test-{}", Uuid::new_v4()));
    let root = dir.join("vault");
    let live_dir = dir.join("live");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&live_dir).unwrap();

    let prev_cred = r#"{"token":{"access_token":"ya29.prev","refresh_token":"1//prev"},"id_token_email":"prev@example.com"}"#;
    let pbtxt1 = live_dir.join("antigravity_state.pbtxt");
    let pbtxt2 = live_dir.join("jetski_state.pbtxt");
    fs::write(&pbtxt1, "prev-agy-pbtxt").unwrap();
    fs::write(&pbtxt2, "prev-jetski-pbtxt").unwrap();

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
            rusqlite::params!["antigravityAuthStatus", r#"{"email":"prev@example.com","name":"Prev"}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params!["unrelated.key", "keep-me"],
        )
        .unwrap();
    }

    let mappings = vec![
        FileMapping { source: pbtxt1.clone(), rel_dest: "antigravity_state.pbtxt" },
        FileMapping { source: pbtxt2.clone(), rel_dest: "jetski_state.pbtxt" },
    ];
    let store = MockAgyCredStore {
        read_value: std::cell::RefCell::new(Some(prev_cred.to_string())),
        forced_readback: std::cell::RefCell::new(None),
        write_error: None,
    };

    // Pre-seed custom label in registry to verify auto-save preserves custom label
    let mut initial_reg = AccountProfilesRegistry::default();
    initial_reg.profiles.push(SavedAccountProfile {
        id: "prof-prev".to_string(),
        provider: "agy".to_string(),
        label: "Personal Pro".to_string(),
        email: Some("prev@example.com".to_string()),
        plan_name: None,
        is_active: true,
        last_used_unix_ms: 100,
        primary_remaining_percent: None,
        primary_reset_at: None,
        time_until_reset_ms: None,
        credential_status: None,
        has_refresh_token: false,
        ..Default::default()
    });
    save_registry_to(&root, &initial_reg).unwrap();

    let ops = MockLoginFlowOps {
        quiesced_to_return: std::cell::RefCell::new(vec![crate::terminal::QuiescedTerminal {
            session_id: "sid-agy-1".to_string(),
            cwd: dir.to_string_lossy().to_string(),
            base_engine: "agy".to_string(),
            effective_engine: "agy".to_string(),
            provider_session_id: None,
            workspace_id: Some("ws-1".to_string()),
            pane_id: Some("pane-1".to_string()),
            cols: 80,
            rows: 24,
            presentation_live: true,
            auto_approve: true,
        }]),
        ..Default::default()
    };

    let empty_inspection = ProviderSessionsInspection::default();
    let busy_inspection = ProviderSessionsInspection {
        managed_busy: vec![ProviderSessionSummary {
            session_id: "sid-agy-1".to_string(),
            engine: "agy".to_string(),
            workspace_id: Some("ws-1".to_string()),
            pane_id: Some("pane-1".to_string()),
            cwd: dir.to_string_lossy().to_string(),
            busy: true,
            reasons: vec!["recent_output".to_string()],
            last_output_age_ms: Some(200),
            presentation_live: true,
        }],
        ..Default::default()
    };

    // 1. Unsupported provider rejected cleanly
    let bad_prov = start_account_login_flow_with(
        &root,
        "codex",
        false,
        &mappings,
        Some(&db_path),
        &store,
        Ok(()),
        &empty_inspection,
        vec!["agy".to_string()],
        "agy".to_string(),
        &ops,
    );
    assert_eq!(bad_prov["success"], false);
    assert_eq!(ops.quiesce_calls.get(), 0);

    // 2. External IDE busy blocks before touching credentials or terminals
    let ide_busy = start_account_login_flow_with(
        &root,
        "antigravity",
        true,
        &mappings,
        Some(&db_path),
        &store,
        Err("antigravity.exe active".to_string()),
        &busy_inspection,
        vec!["agy".to_string(), "acp".to_string(), "--login".to_string()],
        "agy acp --login".to_string(),
        &ops,
    );
    assert_eq!(ide_busy["success"], false);
    assert_eq!(ide_busy["code"], "PROVIDER_BUSY");
    assert_eq!(ops.quiesce_calls.get(), 0);
    assert!(store.read_raw().is_some());

    // 3. Busy Kite terminal without force returns CONFIRM_BUSY_TERMINALS before touching credentials
    let term_busy = start_account_login_flow_with(
        &root,
        "antigravity",
        false,
        &mappings,
        Some(&db_path),
        &store,
        Ok(()),
        &busy_inspection,
        vec!["agy".to_string(), "acp".to_string(), "--login".to_string()],
        "agy acp --login".to_string(),
        &ops,
    );
    assert_eq!(term_busy["success"], false);
    assert_eq!(term_busy["code"], "CONFIRM_BUSY_TERMINALS");
    assert_eq!(ops.quiesce_calls.get(), 0);
    assert!(store.read_raw().is_some());

    // 4. Start flow cleanly (force = true with busy terminal)
    let started = start_account_login_flow_with(
        &root,
        "antigravity",
        true,
        &mappings,
        Some(&db_path),
        &store,
        Ok(()),
        &busy_inspection,
        vec!["C:\\agy.exe".to_string(), "acp".to_string(), "--login".to_string()],
        "agy acp --login".to_string(),
        &ops,
    );
    assert_eq!(started["success"], true);
    let flow_id = started["flowId"].as_str().unwrap().to_string();
    assert_eq!(started["previousEmail"], "prev@example.com");
    assert_eq!(started["previousEmailSaved"], "prev@example.com");
    assert_eq!(started["engine"], "agy");
    assert_eq!(started["loginCommand"], "agy acp --login");
    assert_eq!(started["keyringDeleted"], true);
    assert_eq!(started["ideCleared"], true);
    assert_eq!(ops.quiesce_calls.get(), 1);
    assert_eq!(ops.evict_calls.get(), 1);

    // Cred store, pbtxt files, and IDE auth keys are cleared; unrelated DB key stays intact; active flags cleared
    assert!(store.read_raw().is_none());
    assert!(!pbtxt1.exists());
    assert!(!pbtxt2.exists());
    assert!(crate::quota::extract_ide_auth_rows_from_db(&db_path).unwrap().is_empty());
    let reg_mid = load_registry_from(&root);
    assert_eq!(reg_mid.profiles[0].label, "Personal Pro");
    assert!(!reg_mid.profiles[0].is_active);

    // Probe must strictly return unauthenticated (never fall back to anything else)
    let probe_empty = probe_live_account_login_status_with("antigravity", Some("prev@example.com"), &store);
    assert_eq!(probe_empty["authenticated"], false);
    assert_eq!(probe_empty["credentialStatus"], "missing_file");

    // Tokenless credential must also report unauthenticated
    store.write_checked(r#"{"id_token_email":"partial@example.com","token":{"access_token":"","refresh_token":""}}"#).unwrap();
    let probe_tokenless = probe_live_account_login_status_with("antigravity", Some("prev@example.com"), &store);
    assert_eq!(probe_tokenless["authenticated"], false);
    assert_eq!(probe_tokenless["credentialStatus"], "missing_tokens");

    // 5. Cancel flow restores cred, pbtxt, IDE rows, active flag, respawns quiesced terminals, removes rollback dir
    fs::write(&pbtxt1, "partial-new-pbtxt").unwrap();
    let cancelled = cancel_account_login_flow_with(
        &root,
        "antigravity",
        Some(&flow_id),
        &mappings,
        Some(&db_path),
        &store,
        &ops,
    );
    assert_eq!(cancelled["success"], true);
    assert_eq!(cancelled["restored"], true);
    assert_eq!(cancelled["restoredEmail"], "prev@example.com");

    assert_eq!(store.read_raw().as_deref(), Some(prev_cred));
    assert_eq!(fs::read_to_string(&pbtxt1).unwrap(), "prev-agy-pbtxt");
    assert_eq!(fs::read_to_string(&pbtxt2).unwrap(), "prev-jetski-pbtxt");
    let restored_rows = crate::quota::extract_ide_auth_rows_from_db(&db_path).unwrap();
    assert!(restored_rows.get("antigravityAuthStatus").unwrap().contains("prev@example.com"));
    let reg_after = load_registry_from(&root);
    assert!(reg_after.profiles[0].is_active);
    assert_eq!(ops.respawn_calls.borrow().len(), 1);
    assert_eq!(ops.respawn_calls.borrow()[0].2, vec!["sid-agy-1".to_string()]);
    assert!(!root.join("_login_rollback").join("agy").join(&flow_id).exists());

    // 6. Probe with valid new credential differentiates sameAsPrevious
    let new_cred = r#"{"token":{"access_token":"ya29.new","refresh_token":"1//new"},"id_token_email":"new@example.com"}"#;
    store.write_checked(new_cred).unwrap();
    let probe_new = probe_live_account_login_status_with("antigravity", Some("prev@example.com"), &store);
    assert_eq!(probe_new["authenticated"], true);
    assert_eq!(probe_new["credentialStatus"], "valid");
    assert_eq!(probe_new["email"], "new@example.com");
    assert_eq!(probe_new["hasRefreshToken"], true);
    assert_eq!(probe_new["sameAsPrevious"], false);

    let probe_same = probe_live_account_login_status_with("antigravity", Some("NEW@example.com"), &store);
    assert_eq!(probe_same["sameAsPrevious"], true);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_cancel_login_without_prior_session_clears_partial_artifacts_and_save_cleans_rollback() {
    use super::commands::{cancel_account_login_flow_with, save_account_profile_with, start_account_login_flow_with};
    use crate::terminal::ProviderSessionsInspection;

    let dir = std::env::temp_dir().join(format!("kite-login-noprev-test-{}", Uuid::new_v4()));
    let root = dir.join("vault");
    let live_dir = dir.join("live");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&live_dir).unwrap();

    let pbtxt1 = live_dir.join("antigravity_state.pbtxt");
    let db_path = dir.join("state.vscdb");
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
            [],
        )
        .unwrap();
    }

    let mappings = vec![FileMapping { source: pbtxt1.clone(), rel_dest: "antigravity_state.pbtxt" }];
    let store = MockAgyCredStore {
        read_value: std::cell::RefCell::new(None),
        forced_readback: std::cell::RefCell::new(None),
        write_error: None,
    };
    let ops = MockLoginFlowOps::default();

    let started = start_account_login_flow_with(
        &root,
        "agy",
        false,
        &mappings,
        Some(&db_path),
        &store,
        Ok(()),
        &ProviderSessionsInspection::default(),
        vec!["agy".to_string()],
        "agy".to_string(),
        &ops,
    );
    assert_eq!(started["success"], true);
    assert!(started["previousEmail"].is_null());
    let flow_id = started["flowId"].as_str().unwrap().to_string();

    // Simulate partial artifacts written during aborted login
    store.write_checked(r#"{"id_token_email":"partial@example.com"}"#).unwrap();
    fs::write(&pbtxt1, "partial-pbtxt").unwrap();
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params!["antigravityAuthStatus", r#"{"email":"partial@example.com"}"#],
        )
        .unwrap();
    }

    let cancelled = cancel_account_login_flow_with(
        &root,
        "agy",
        Some(&flow_id),
        &mappings,
        Some(&db_path),
        &store,
        &ops,
    );
    assert_eq!(cancelled["success"], true);
    assert_eq!(cancelled["restored"], true);
    assert!(cancelled["restoredEmail"].is_null());
    assert!(store.read_raw().is_none());
    assert!(!pbtxt1.exists());
    assert!(crate::quota::extract_ide_auth_rows_from_db(&db_path).unwrap().is_empty());

    // Now simulate starting a new login and completing it via save_account_profile_with -> stale rollback cleaned
    let started2 = start_account_login_flow_with(
        &root,
        "agy",
        false,
        &mappings,
        Some(&db_path),
        &store,
        Ok(()),
        &ProviderSessionsInspection::default(),
        vec!["agy".to_string()],
        "agy".to_string(),
        &ops,
    );
    let flow_id2 = started2["flowId"].as_str().unwrap().to_string();
    assert!(root.join("_login_rollback").join("agy").join(&flow_id2).exists());

    let valid_new = r#"{"token":{"access_token":"ya29.ok","refresh_token":"1//ok"},"id_token_email":"saved@example.com"}"#;
    store.write_checked(valid_new).unwrap();
    let saved = save_account_profile_with(
        &root,
        "agy",
        "Saved Account".to_string(),
        &mappings,
        Some(&db_path),
        &store,
        Some(LiveIdentityProbe {
            provider: "agy".to_string(),
            email: "saved@example.com".to_string(),
            name: None,
            source: "gemini:antigravity".to_string(),
        }),
        None,
    );
    assert_eq!(saved["success"], true);
    assert!(!root.join("_login_rollback").join("agy").exists());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_consecutive_start_account_login_flow_preserves_original_rollback_and_cleans_orphan() {
    let dir = std::env::temp_dir().join(format!("kite-login-consecutive-{}", Uuid::new_v4()));
    let root = dir.join("vault");
    let pbtxt = dir.join("antigravity_state.pbtxt");
    let db_path = dir.join("state.vscdb");
    fs::create_dir_all(&root).unwrap();
    fs::write(&pbtxt, "orig-pbtxt").unwrap();

    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params!["antigravityAuthStatus", r#"{"email":"orig@example.com"}"#],
        )
        .unwrap();
    }

    let valid_orig = r#"{"token":{"access_token":"ya29.orig","refresh_token":"1//orig"},"id_token_email":"orig@example.com"}"#;
    let store = MockAgyCredStore {
        read_value: std::cell::RefCell::new(Some(valid_orig.to_string())),
        forced_readback: std::cell::RefCell::new(None),
        write_error: None,
    };
    let mappings = vec![FileMapping {
        source: pbtxt.clone(),
        rel_dest: "antigravity_state.pbtxt",
    }];

    let ops = MockLoginFlowOps {
        quiesced_to_return: std::cell::RefCell::new(vec![crate::terminal::QuiescedTerminal {
            session_id: "agy-orig".into(),
            cwd: dir.to_string_lossy().to_string(),
            base_engine: "agy".into(),
            effective_engine: "agy".into(),
            provider_session_id: None,
            workspace_id: Some("ws-1".into()),
            pane_id: None,
            cols: 100,
            rows: 30,
            presentation_live: true,
            auto_approve: false,
        }]),
        ..Default::default()
    };

    let first = start_account_login_flow_with(
        &root,
        "agy",
        false,
        &mappings,
        Some(&db_path),
        &store,
        Ok(()),
        &crate::terminal::ProviderSessionsInspection::default(),
        vec!["agy".to_string()],
        "agy".to_string(),
        &ops,
    );
    assert_eq!(first["success"], true);
    let flow_1 = first["flowId"].as_str().unwrap().to_string();

    // Calling start_account_login_flow again while credentials are empty must carry forward
    // orig@example.com, original IDE rows/.pbtxt, and prior quiesced terminals without leaving flow_1.
    ops.quiesced_to_return.borrow_mut().clear();
    let second = start_account_login_flow_with(
        &root,
        "agy",
        false,
        &mappings,
        Some(&db_path),
        &store,
        Ok(()),
        &crate::terminal::ProviderSessionsInspection::default(),
        vec!["agy".to_string()],
        "agy".to_string(),
        &ops,
    );
    assert_eq!(second["success"], true);
    let flow_2 = second["flowId"].as_str().unwrap().to_string();
    assert_ne!(flow_2, flow_1);
    assert_eq!(second["previousEmail"], "orig@example.com");
    assert!(!root.join("_login_rollback").join("agy").join(&flow_1).exists());

    let cancelled = cancel_account_login_flow_with(
        &root,
        "agy",
        Some(&flow_2),
        &mappings,
        Some(&db_path),
        &store,
        &ops,
    );
    assert_eq!(cancelled["success"], true);
    assert_eq!(cancelled["restoredEmail"], "orig@example.com");
    assert_eq!(cancelled["terminalsRestarted"], 1);
    assert_eq!(store.read_raw().as_deref(), Some(valid_orig));
    assert_eq!(fs::read_to_string(&pbtxt).unwrap(), "orig-pbtxt");
    assert!(crate::quota::extract_ide_auth_rows_from_db(&db_path)
        .unwrap()
        .contains_key("antigravityAuthStatus"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_rename_account_profile_validates_label_hydrates_health_and_persists() {
    use super::commands::rename_account_profile_with;
    use super::registry::save_registry_to;

    let dir = std::env::temp_dir().join(format!("kite-rename-test-{}", Uuid::new_v4()));
    let root = dir.join("vault");
    let prof_dir = root.join("agy").join("acc-rename-1");
    fs::create_dir_all(&prof_dir).unwrap();
    fs::write(
        prof_dir.join("gemini_antigravity_cred.json"),
        r#"{"token":{"access_token":"ya29.valid","refresh_token":"1//valid"},"id_token_email":"user@example.com"}"#,
    )
    .unwrap();

    let reg = AccountProfilesRegistry {
        profiles: vec![SavedAccountProfile {
            id: "acc-rename-1".to_string(),
            provider: "agy".to_string(),
            label: "Old Name".to_string(),
            email: Some("user@example.com".to_string()),
            plan_name: Some("Google AI Pro".to_string()),
            is_active: true,
            last_used_unix_ms: 1234,
            primary_remaining_percent: Some(85.0),
            primary_reset_at: None,
            time_until_reset_ms: None,
            credential_status: None,
            has_refresh_token: false,
            ..Default::default()
        }],
        ..Default::default()
    };
    save_registry_to(&root, &reg).unwrap();

    // 1. Rejects empty / whitespace-only labels without modifying persisted label
    let empty_res = rename_account_profile_with(&root, "antigravity", "acc-rename-1", "   ".to_string());
    assert_eq!(empty_res["success"], false);
    assert!(empty_res["error"].as_str().unwrap_or("").contains("vacío"));
    assert_eq!(load_registry_from(&root).profiles[0].label, "Old Name");

    // 2. Rejects unknown profile ID cleanly
    let missing_res = rename_account_profile_with(&root, "antigravity", "missing-id", "New Label".to_string());
    assert_eq!(missing_res["success"], false);

    // 3. Renames cleanly via "antigravity" alias, trims whitespace, hydrates health, and persists to disk
    let ok_res = rename_account_profile_with(&root, "antigravity", "acc-rename-1", "  Trabajo Pro  ".to_string());
    assert_eq!(ok_res["success"], true);
    assert_eq!(ok_res["profile"]["label"], "Trabajo Pro");
    assert_eq!(ok_res["profile"]["credentialStatus"], "valid");
    assert_eq!(ok_res["profile"]["hasRefreshToken"], true);

    let reloaded = load_registry_from(&root);
    assert_eq!(reloaded.profiles.len(), 1);
    assert_eq!(reloaded.profiles[0].label, "Trabajo Pro");
    assert_eq!(reloaded.profiles[0].credential_status.as_deref(), Some("valid"));
    assert!(reloaded.profiles[0].has_refresh_token);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_build_antigravity_auth_telemetry_exposes_cli_ide_split_brain_and_expiry() {
    use super::commands::build_antigravity_auth_telemetry_from_parts;

    let raw_cred = r#"{
        "token": {
            "access_token": "ya29.abc",
            "refresh_token": "1//xyz",
            "expiry": "2026-10-30T19:13:14.500Z"
        },
        "id_token_email": "cli@example.com"
    }"#;
    let parsed_ident = crate::quota::parse_antigravity_credential_blob(raw_cred);
    let telemetry = build_antigravity_auth_telemetry_from_parts(
        parsed_ident.as_ref(),
        Some("ide@example.com"),
        false,
        false,
    );

    assert_eq!(telemetry["authMode"], "oauth");
    assert_eq!(telemetry["cliEmail"], "cli@example.com");
    assert_eq!(telemetry["credEmail"], "cli@example.com");
    assert_eq!(telemetry["ideEmail"], "ide@example.com");
    assert_eq!(telemetry["splitBrainWarning"], true);
    assert!(telemetry["splitBrainMessage"].as_str().unwrap_or("").contains("cli@example.com"));
    assert_eq!(telemetry["hasRefreshToken"], true);
    assert!(telemetry["expiresAtMs"].as_i64().is_some());

    let aligned = build_antigravity_auth_telemetry_from_parts(
        parsed_ident.as_ref(),
        Some("CLI@example.com"),
        false,
        false,
    );
    assert_eq!(aligned["splitBrainWarning"], false);
    assert!(aligned["splitBrainMessage"].is_null());
}

#[test]
fn test_save_account_profile_with_creates_updates_dedups_and_preserves_custom_label() {
    use super::commands::save_account_profile_with;
    use super::quota::LiveQuota;
    use super::storage::LiveIdentityProbe;

    let dir = std::env::temp_dir().join(format!("kite-save-prof-e2e-{}", Uuid::new_v4()));
    let root = dir.join("vault");
    let live_dir = dir.join("live");
    fs::create_dir_all(&live_dir).unwrap();
    let live_pbtxt = live_dir.join("antigravity_state.pbtxt");
    fs::write(&live_pbtxt, "pbtxt-alpha").unwrap();

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
                r#"{"email":"alpha@example.com","name":"Alpha User"}"#
            ],
        )
        .unwrap();
    }

    let mappings = vec![FileMapping {
        source: live_pbtxt.clone(),
        rel_dest: "antigravity_state.pbtxt",
    }];
    let cred_alpha = r#"{"token":{"access_token":"ya29.alpha","refresh_token":"1//alpha"},"id_token_email":"alpha@example.com"}"#;
    let store = MockAgyCredStore {
        read_value: std::cell::RefCell::new(Some(cred_alpha.to_string())),
        forced_readback: std::cell::RefCell::new(None),
        write_error: None,
    };

    let ident = LiveIdentityProbe {
        provider: "agy".to_string(),
        email: "alpha@example.com".to_string(),
        name: Some("Alpha User".to_string()),
        source: "oauth".to_string(),
    };
    let quota_first = LiveQuota {
        percent: 88.0,
        reset_at: Some("19:00".to_string()),
        until_ms: Some(1_800_000),
        email: Some("alpha@example.com".to_string()),
        plan: Some("Google AI Pro".to_string()),
        windows: Vec::new(),
    };

    let first = save_account_profile_with(
        &root,
        "antigravity",
        "Personal Pro".to_string(),
        &mappings,
        Some(&db_path),
        &store,
        Some(ident.clone()),
        Some(quota_first),
    );
    assert_eq!(first["success"], json!(true));
    let prof_id = first["profile"]["id"].as_str().unwrap().to_string();
    assert_eq!(first["profile"]["label"], json!("Personal Pro"));
    assert_eq!(first["profile"]["email"], json!("alpha@example.com"));
    assert_eq!(first["profile"]["credentialStatus"], json!("valid"));
    assert_eq!(first["profile"]["hasRefreshToken"], json!(true));
    assert_eq!(first["profile"]["isActive"], json!(true));
    assert!(root.join("agy").join(&prof_id).join("gemini_antigravity_cred.json").is_file());
    assert!(root.join("agy").join(&prof_id).join("ide_auth_state.json").is_file());
    assert_eq!(
        fs::read_to_string(root.join("agy").join(&prof_id).join("antigravity_state.pbtxt")).unwrap(),
        "pbtxt-alpha"
    );

    // Re-saving same email with raw email label (auto-save) must deduplicate and keep custom label
    let quota_updated = LiveQuota {
        percent: 72.5,
        reset_at: Some("20:00".to_string()),
        until_ms: Some(900_000),
        email: Some("ALPHA@example.com".to_string()),
        plan: Some("Google AI Pro".to_string()),
        windows: Vec::new(),
    };
    let second = save_account_profile_with(
        &root,
        "agy",
        "alpha@example.com".to_string(),
        &mappings,
        Some(&db_path),
        &store,
        Some(ident),
        Some(quota_updated),
    );
    assert_eq!(second["success"], json!(true));
    assert_eq!(second["profile"]["id"], json!(prof_id));
    assert_eq!(second["profile"]["label"], json!("Personal Pro"));
    assert_eq!(second["profile"]["primaryRemainingPercent"], json!(72.5));

    let reg = load_registry_from(&root);
    assert_eq!(reg.profiles.len(), 1);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_end_to_end_switch_preflight_apply_and_tokenless_rejection_preserves_active_state() {
    use super::commands::{save_account_profile_with, switch_preflight_check_with};
    use super::storage::LiveIdentityProbe;
    use crate::terminal::{ProviderSessionSummary, ProviderSessionsInspection};

    let dir = std::env::temp_dir().join(format!("kite-switch-e2e-{}", Uuid::new_v4()));
    let root = dir.join("vault");
    let live_dir = dir.join("live");
    fs::create_dir_all(&live_dir).unwrap();
    let live_pbtxt = live_dir.join("antigravity_state.pbtxt");

    let db_path = dir.join("state.vscdb");
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
            [],
        )
        .unwrap();
    }

    let mappings = vec![FileMapping {
        source: live_pbtxt.clone(),
        rel_dest: "antigravity_state.pbtxt",
    }];
    let cred_a = r#"{"token":{"access_token":"ya29.acctA","refresh_token":"1//acctA"},"id_token_email":"a@example.com"}"#;
    let cred_b = r#"{"token":{"access_token":"ya29.acctB","refresh_token":"1//acctB"},"id_token_email":"b@example.com"}"#;
    let store = MockAgyCredStore {
        read_value: std::cell::RefCell::new(Some(cred_a.to_string())),
        forced_readback: std::cell::RefCell::new(None),
        write_error: None,
    };

    let set_ide_email = |email: &str| {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params![
                "antigravityAuthStatus",
                format!(r#"{{"email":"{email}","name":"User"}}"#)
            ],
        )
        .unwrap();
    };

    // Save Account A
    fs::write(&live_pbtxt, "pbtxt-a").unwrap();
    set_ide_email("a@example.com");
    let res_a = save_account_profile_with(
        &root,
        "agy",
        "Account A".to_string(),
        &mappings,
        Some(&db_path),
        &store,
        Some(LiveIdentityProbe {
            provider: "agy".to_string(),
            email: "a@example.com".to_string(),
            name: None,
            source: "oauth".to_string(),
        }),
        None,
    );
    assert_eq!(res_a["success"], json!(true));
    let id_a = res_a["profile"]["id"].as_str().unwrap().to_string();

    // Save Account B (becomes currently active live account)
    *store.read_value.borrow_mut() = Some(cred_b.to_string());
    fs::write(&live_pbtxt, "pbtxt-b").unwrap();
    set_ide_email("b@example.com");
    let res_b = save_account_profile_with(
        &root,
        "agy",
        "Account B".to_string(),
        &mappings,
        Some(&db_path),
        &store,
        Some(LiveIdentityProbe {
            provider: "agy".to_string(),
            email: "b@example.com".to_string(),
            name: None,
            source: "oauth".to_string(),
        }),
        None,
    );
    assert_eq!(res_b["success"], json!(true));
    let id_b = res_b["profile"]["id"].as_str().unwrap().to_string();

    // Create a tokenless Account C directory (not switchable)
    let broken_dir = root.join("agy").join("prof-tokenless");
    fs::create_dir_all(&broken_dir).unwrap();
    fs::write(broken_dir.join("antigravity_state.pbtxt"), "pbtxt-c").unwrap();
    fs::write(
        broken_dir.join("gemini_antigravity_cred.json"),
        r#"{"id_token_email":"broken@example.com"}"#,
    )
    .unwrap();

    let busy_inspection = ProviderSessionsInspection {
        managed_idle: Vec::new(),
        managed_busy: vec![ProviderSessionSummary {
            session_id: "term-1".to_string(),
            engine: "antigravity".to_string(),
            workspace_id: None,
            pane_id: None,
            cwd: "/repo".to_string(),
            busy: true,
            reasons: vec!["recent_output".to_string()],
            last_output_age_ms: Some(120),
            presentation_live: true,
        }],
        external_blocking: Vec::new(),
        unaffected_terminals_count: 2,
    };
    let idle_inspection = ProviderSessionsInspection::default();

    // Preflight 1: tokenless profile rejected BEFORE busy / process checks
    let pre_broken = switch_preflight_check_with(
        &root,
        "agy",
        "prof-tokenless",
        true,
        Ok(()),
        &idle_inspection,
    )
    .expect("tokenless profile must fail preflight");
    assert_eq!(pre_broken["code"], json!("INVALID_TARGET_PROFILE"));

    // Preflight 2: external IDE lock rejected
    let pre_locked = switch_preflight_check_with(
        &root,
        "agy",
        &id_a,
        true,
        Err("IDE process running".to_string()),
        &idle_inspection,
    )
    .expect("locked provider must fail preflight");
    assert_eq!(pre_locked["code"], json!("PROVIDER_BUSY"));

    // Preflight 3: busy Kite terminal requires force=true
    let pre_busy = switch_preflight_check_with(
        &root,
        "agy",
        &id_a,
        false,
        Ok(()),
        &busy_inspection,
    )
    .expect("busy terminal without force must return CONFIRM_BUSY_TERMINALS");
    assert_eq!(pre_busy["code"], json!("CONFIRM_BUSY_TERMINALS"));
    assert_eq!(pre_busy["unaffectedTerminalsCount"], json!(2));

    // Preflight 4: force=true passes
    assert!(
        switch_preflight_check_with(&root, "agy", &id_a, true, Ok(()), &busy_inspection)
            .is_none()
    );

    // Apply Account A (B -> A swap) and verify all persisted surfaces + IDE state.vscdb
    apply_profile_to_active_with(&root, "agy", &id_a, &mappings, Some(&db_path), &store)
        .expect("switch B -> A must succeed");
    assert_eq!(fs::read_to_string(&live_pbtxt).unwrap(), "pbtxt-a");
    let active_cred_after = store.read_value.borrow().clone().unwrap();
    assert!(active_cred_after.contains("ya29.acctA"));
    assert!(active_cred_after.contains("a@example.com"));
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let auth_after_a: String = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(auth_after_a.contains("a@example.com"));

    // Corrupt B's saved credential to missing tokens and ensure attempting apply leaves A completely intact
    fs::write(
        root.join("agy").join(&id_b).join("gemini_antigravity_cred.json"),
        r#"{"id_token_email":"b@example.com"}"#,
    )
    .unwrap();
    let err_apply_tokenless =
        apply_profile_to_active_with(&root, "agy", &id_b, &mappings, Some(&db_path), &store)
            .expect_err("tokenless target must fail apply");
    assert!(!err_apply_tokenless.is_empty());
    assert_eq!(fs::read_to_string(&live_pbtxt).unwrap(), "pbtxt-a");
    assert!(store.read_value.borrow().as_deref().unwrap().contains("ya29.acctA"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_detected_cli_accounts_cache_hits_and_invalidates_on_write() {
    use super::commands::DetectedCliAccountsCache;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    let cache = DetectedCliAccountsCache::new(Duration::from_secs(60));
    let probes = AtomicUsize::new(0);

    let first = cache.get_or_compute(false, false, || {
        let count = probes.fetch_add(1, Ordering::SeqCst) + 1;
        json!({ "schemaVersion": 1, "probeCount": count })
    });
    let second = cache.get_or_compute(false, false, || {
        let count = probes.fetch_add(1, Ordering::SeqCst) + 1;
        json!({ "schemaVersion": 1, "probeCount": count })
    });

    assert_eq!(probes.load(Ordering::SeqCst), 1);
    assert_eq!(first["probeCount"], json!(1));
    assert_eq!(second["probeCount"], json!(1));

    // Write invalidation forces the next read to recompute.
    cache.invalidate();
    let third = cache.get_or_compute(false, false, || {
        let count = probes.fetch_add(1, Ordering::SeqCst) + 1;
        json!({ "schemaVersion": 1, "probeCount": count })
    });
    assert_eq!(probes.load(Ordering::SeqCst), 2);
    assert_eq!(third["probeCount"], json!(2));

    // When cfg!(test) bypass is requested (bypass_time_ttl = true), cache does not serve stale results.
    let bypassed = cache.get_or_compute(false, true, || {
        let count = probes.fetch_add(1, Ordering::SeqCst) + 1;
        json!({ "schemaVersion": 1, "probeCount": count })
    });
    assert_eq!(probes.load(Ordering::SeqCst), 3);
    assert_eq!(bypassed["probeCount"], json!(3));
}

#[test]
fn test_inspect_external_provider_processes_distinguishes_base_app_vs_residual() {
    use super::storage::{
        close_residual_provider_processes_with, inspect_external_provider_processes_with,
        ExternalProcessRecord,
    };
    use std::cell::RefCell;
    use std::collections::HashSet;

    // 1. Enum unavailable -> unknown, cannot close
    let unknown = inspect_external_provider_processes_with("agy", None, &HashSet::new());
    assert_eq!(unknown.state, "unknown");
    assert!(!unknown.can_close_processes);

    // 2. Visible base Antigravity window + Chromium child -> base_app_open, NEVER allow close button
    let open_procs = vec![
        ExternalProcessRecord {
            pid: 100,
            parent_pid: Some(10),
            name: "antigravity.exe".to_string(),
            command_line: Some("\"C:\\Antigravity\\Antigravity.exe\"".to_string()),
            has_visible_window: true,
            window_title: Some("Mi Proyecto - Antigravity".to_string()),
        },
        ExternalProcessRecord {
            pid: 101,
            parent_pid: Some(100),
            name: "antigravity.exe".to_string(),
            command_line: Some("\"C:\\Antigravity\\Antigravity.exe\" --type=utility".to_string()),
            has_visible_window: false,
            window_title: None,
        },
    ];
    let base_open = inspect_external_provider_processes_with("antigravity", Some(open_procs), &HashSet::new());
    assert_eq!(base_open.state, "base_app_open");
    assert!(!base_open.can_close_processes);
    assert_eq!(base_open.base_app_pids, vec![100]);
    assert!(base_open.residual_processes.is_empty());

    // Attempting close_residual when base_app_open MUST refuse without terminating PIDs
    let killed = RefCell::new(Vec::<u32>::new());
    let refuse = close_residual_provider_processes_with(
        "agy",
        || base_open.clone(),
        |pids| {
            killed.borrow_mut().extend_from_slice(pids);
            Ok(())
        },
    );
    assert_eq!(refuse["success"], false);
    assert_eq!(refuse["code"], "BASE_APP_OPEN");
    assert!(killed.borrow().is_empty());

    // 3. Only residual helpers + excluded ancestor -> residual_only, excludes ancestor/PTY PIDs
    let mut excluded = HashSet::new();
    excluded.insert(500u32);
    let residual_procs = vec![
        ExternalProcessRecord {
            pid: 500,
            parent_pid: Some(1),
            name: "antigravity.exe".to_string(),
            command_line: Some("Antigravity.exe --import=sidecar".to_string()),
            has_visible_window: false,
            window_title: None,
        },
        ExternalProcessRecord {
            pid: 201,
            parent_pid: Some(200),
            name: "antigravity.exe".to_string(),
            command_line: Some("\"C:\\Antigravity\\Antigravity.exe\" --type=utility".to_string()),
            has_visible_window: false,
            window_title: None,
        },
        ExternalProcessRecord {
            pid: 202,
            parent_pid: Some(1),
            name: "antigravity.exe".to_string(),
            command_line: Some("\"C:\\Antigravity\\Antigravity.exe\" --type=renderer".to_string()),
            has_visible_window: false,
            window_title: None,
        },
    ];
    let residual_only =
        inspect_external_provider_processes_with("agy", Some(residual_procs), &excluded);
    assert_eq!(residual_only.state, "residual_only");
    assert!(residual_only.can_close_processes);
    assert_eq!(
        residual_only.residual_processes.iter().map(|p| p.pid).collect::<Vec<_>>(),
        vec![201, 202]
    );

    let idle_inspect = inspect_external_provider_processes_with("agy", Some(vec![]), &excluded);
    let mut call_n = 0usize;
    let closed_ok = close_residual_provider_processes_with(
        "agy",
        || {
            call_n += 1;
            if call_n == 1 {
                residual_only.clone()
            } else {
                idle_inspect.clone()
            }
        },
        |pids| {
            killed.borrow_mut().extend_from_slice(pids);
            Ok(())
        },
    );
    assert_eq!(closed_ok["success"], true);
    assert_eq!(closed_ok["closedCount"], 2);
    assert_eq!(*killed.borrow(), vec![201, 202]);

    // 4. Unknown command_line OR unflagged main exe on windowless process fails safe as base_app_open (can_close_processes=false)
    let opaque_proc = vec![ExternalProcessRecord {
        pid: 300,
        parent_pid: Some(1),
        name: "antigravity.exe".to_string(),
        command_line: None,
        has_visible_window: false,
        window_title: None,
    }];
    let opaque = inspect_external_provider_processes_with("agy", Some(opaque_proc), &HashSet::new());
    assert_eq!(opaque.state, "base_app_open");
    assert!(!opaque.can_close_processes);

    let unflagged_main = vec![ExternalProcessRecord {
        pid: 301,
        parent_pid: Some(1),
        name: "antigravity.exe".to_string(),
        command_line: Some("\"C:\\Antigravity\\Antigravity.exe\" --no-sandbox".to_string()),
        has_visible_window: false,
        window_title: None,
    }];
    let unflagged =
        inspect_external_provider_processes_with("agy", Some(unflagged_main), &HashSet::new());
    assert_eq!(unflagged.state, "base_app_open");
    assert!(!unflagged.can_close_processes);
    assert!(unflagged.residual_processes.is_empty());

    // 5. electron_run_as_node helper classifies as residual sidecar & surviving PID fails safely
    let sidecar_proc = vec![ExternalProcessRecord {
        pid: 302,
        parent_pid: Some(1),
        name: "antigravity.exe".to_string(),
        command_line: Some("Antigravity.exe --ms-enable-electron_run_as_node worker.js".to_string()),
        has_visible_window: false,
        window_title: None,
    }];
    let sidecar_res =
        inspect_external_provider_processes_with("agy", Some(sidecar_proc), &HashSet::new());
    assert_eq!(sidecar_res.state, "residual_only");
    assert!(sidecar_res.can_close_processes);
    assert_eq!(sidecar_res.residual_processes[0].kind, "sidecar");

    let survivor = close_residual_provider_processes_with(
        "agy",
        || sidecar_res.clone(),
        |_| Ok(()),
    );
    assert_eq!(survivor["success"], false);
    assert_eq!(survivor["canCloseProcesses"], true);
    assert_eq!(survivor["residualProcessCount"], 1);
}

#[test]
fn test_switch_preflight_check_with_external_enriches_provider_busy() {
    use super::commands::switch_preflight_check_with_external;
    use super::storage::{ExternalProcessInspection, ResidualProcessSummary};
    use crate::terminal::ProviderSessionsInspection;

    let tmp = std::env::temp_dir().join(format!("kite_preflight_ext_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    let prof_dir = tmp.join("agy").join("acc-valid");
    fs::create_dir_all(&prof_dir).unwrap();
    fs::write(
        prof_dir.join("gemini_antigravity_cred.json"),
        serde_json::to_string(&json!({
            "id_token_email": "valid@example.com",
            "token": { "access_token": "ya29.ok", "refresh_token": "1//ok" }
        }))
        .unwrap(),
    )
    .unwrap();

    let ext = ExternalProcessInspection {
        state: "residual_only".to_string(),
        can_close_processes: true,
        base_app_pids: vec![],
        base_app_titles: vec![],
        residual_processes: vec![
            ResidualProcessSummary {
                pid: 401,
                name: "antigravity.exe".to_string(),
                kind: "utility".to_string(),
            },
            ResidualProcessSummary {
                pid: 402,
                name: "antigravity.exe".to_string(),
                kind: "renderer".to_string(),
            },
        ],
        message: "Quedaron 2 procesos secundarios de Antigravity abiertos.".to_string(),
    };
    let res = switch_preflight_check_with_external(
        &tmp,
        "antigravity",
        "acc-valid",
        false,
        &ext,
        &ProviderSessionsInspection::default(),
    )
    .expect("residual process must return PROVIDER_BUSY");

    assert_eq!(res["code"], "PROVIDER_BUSY");
    assert_eq!(res["providerBusyKind"], "residual_only");
    assert_eq!(res["canCloseProcesses"], true);
    assert_eq!(res["residualProcessCount"], 2);
    assert_eq!(res["residualProcesses"][0]["pid"], 401);

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_auto_switch_policy_serialization_backwards_compat_and_validation() {
    use super::commands::{get_auto_switch_policy_with, save_auto_switch_policy_with};
    use super::registry::AutoSwitchPolicy;

    let tmp = std::env::temp_dir().join(format!("kite_auto_policy_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();

    // 1. Legacy profiles.json without auto_switch_policies or model/window fields loads cleanly with opt-in disabled.
    let legacy_json = json!({
        "profiles": [{
            "id": "acc-1",
            "provider": "agy",
            "label": "Personal",
            "email": "p@kite.local",
            "planName": "Google AI Pro",
            "isActive": true,
            "lastUsedUnixMs": 1000,
            "primaryRemainingPercent": 80.0
        }]
    });
    fs::write(tmp.join("profiles.json"), serde_json::to_vec_pretty(&legacy_json).unwrap()).unwrap();

    let fetched = get_auto_switch_policy_with(&tmp, "antigravity");
    assert_eq!(fetched["provider"], "agy");
    assert_eq!(fetched["policy"]["enabled"], false);
    assert_eq!(fetched["policy"]["triggerThresholdPercent"], 0.0);
    assert_eq!(fetched["policy"]["selectionStrategy"], "highest_quota");
    assert_eq!(fetched["policy"]["modelMismatchPolicy"], "confirm_notification");
    assert_eq!(fetched["policy"]["busyTerminalsPolicy"], "wait_idle");
    assert_eq!(fetched["policy"]["autoContinueChatTurn"], true);
    assert_eq!(fetched["policy"]["cooldownSeconds"], 120);
    assert_eq!(fetched["policy"]["maxConsecutiveSwitches"], 3);

    // 2. Rejects invalid bounds / empty / unknown policies cleanly without overwriting.
    let bad_threshold = save_auto_switch_policy_with(
        &tmp,
        "antigravity",
        json!({ "enabled": true, "triggerThresholdPercent": -1.0 }),
    );
    assert_eq!(bad_threshold["success"], false);

    let bad_strategy = save_auto_switch_policy_with(
        &tmp,
        "antigravity",
        json!({ "enabled": true, "selectionStrategy": "random_magic" }),
    );
    assert_eq!(bad_strategy["success"], false);

    let bad_breaker = save_auto_switch_policy_with(
        &tmp,
        "antigravity",
        json!({ "enabled": true, "maxConsecutiveSwitches": 0 }),
    );
    assert_eq!(bad_breaker["success"], false);

    let empty_provider = save_auto_switch_policy_with(&tmp, "   ", json!({ "enabled": true }));
    assert_eq!(empty_provider["success"], false);

    // 3. Valid save persists normalized alias ("antigravity" -> "agy").
    let mut valid_policy = AutoSwitchPolicy::default();
    valid_policy.enabled = true;
    valid_policy.selection_strategy = "priority_order".to_string();
    valid_policy.priority_order = vec!["acc-2".to_string(), "acc-1".to_string()];
    valid_policy.excluded_account_ids = vec!["acc-bad".to_string()];
    let saved = save_auto_switch_policy_with(
        &tmp,
        "antigravity",
        serde_json::to_value(&valid_policy).unwrap(),
    );
    assert_eq!(saved["success"], true);
    assert_eq!(saved["provider"], "agy");
    assert_eq!(saved["policy"]["enabled"], true);
    assert_eq!(saved["policy"]["selectionStrategy"], "priority_order");

    let reloaded = get_auto_switch_policy_with(&tmp, "agy");
    assert_eq!(reloaded["policy"]["enabled"], true);
    assert_eq!(reloaded["policy"]["excludedAccountIds"][0], "acc-bad");

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_sync_active_profile_capabilities_never_cross_contaminates_inactive_profiles() {
    use super::commands::sync_active_profile_capabilities_in;
    use super::quota::LiveQuota;
    use super::registry::CachedQuotaWindow;

    let tmp = std::env::temp_dir().join(format!("kite_cap_sync_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();

    let reg = AccountProfilesRegistry {
        profiles: vec![
            SavedAccountProfile {
                id: "acc-pro".to_string(),
                provider: "agy".to_string(),
                label: "Pro".to_string(),
                email: Some("pro@kite.local".to_string()),
                plan_name: Some("Google AI Pro".to_string()),
                is_active: true,
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-free".to_string(),
                provider: "agy".to_string(),
                label: "Free".to_string(),
                email: Some("free@kite.local".to_string()),
                plan_name: Some("Free Tier".to_string()),
                is_active: false,
                available_model_ids: vec!["gemini-2.5-flash".to_string()],
                models_updated_at_unix_ms: Some(1111),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    save_registry_to(&tmp, &reg).unwrap();

    let live_q = LiveQuota {
        percent: 42.0,
        reset_at: Some("2026-11-15T12:00:00Z".to_string()),
        until_ms: Some(1800_000),
        email: Some("pro@kite.local".to_string()),
        plan: Some("Google AI Ultra".to_string()),
        windows: vec![CachedQuotaWindow {
            name: "Claude".to_string(),
            remaining_percent: 42.0,
            is_exhausted: false,
            resets_at: Some("2026-11-15T12:00:00Z".to_string()),
            time_until_reset_ms: Some(1800_000),
            updated_at_unix_ms: 5000,
        }],
    };
    let models = vec![
        "claude-opus-4-6".to_string(),
        "gemini-3-pro".to_string(),
        "gemini-2.5-flash".to_string(),
    ];

    let changed = sync_active_profile_capabilities_in(
        &tmp,
        "agy",
        Some("pro@kite.local"),
        Some(&live_q),
        Some(&models),
        Some(5000),
    );
    assert!(changed);

    let updated = load_registry_from(&tmp);
    let pro = updated.profiles.iter().find(|p| p.id == "acc-pro").unwrap();
    let free = updated.profiles.iter().find(|p| p.id == "acc-free").unwrap();
    assert_eq!(pro.plan_name.as_deref(), Some("Google AI Ultra"));
    assert_eq!(pro.quota_windows.len(), 1);
    assert_eq!(pro.quota_windows[0].name, "Claude");
    assert_eq!(pro.available_model_ids, models);
    assert_eq!(pro.models_updated_at_unix_ms, Some(5000));

    // Inactive Free account must retain its own plan & model list untouched
    assert_eq!(free.plan_name.as_deref(), Some("Free Tier"));
    assert_eq!(free.available_model_ids, vec!["gemini-2.5-flash".to_string()]);
    assert!(free.quota_windows.is_empty());

    // Email mismatch from stale quota probe must not write onto acc-pro either
    let stale_q = LiveQuota {
        email: Some("someone-else@kite.local".to_string()),
        ..live_q
    };
    let rejected = sync_active_profile_capabilities_in(
        &tmp,
        "agy",
        Some("someone-else@kite.local"),
        Some(&stale_q),
        Some(&["bad-model".to_string()]),
        Some(6000),
    );
    assert!(!rejected);

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_rank_auto_switch_candidates_handles_models_windows_exclusions_and_resets() {
    use super::commands::rank_auto_switch_candidates_in;
    use super::registry::{AutoSwitchPolicy, CachedQuotaWindow};
    use std::collections::HashMap;

    let tmp = std::env::temp_dir().join(format!("kite_rank_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);

    let seed_valid_cred = |id: &str, email: &str| {
        let dir = tmp.join("agy").join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("gemini_antigravity_cred.json"),
            serde_json::to_string(&json!({
                "id_token_email": email,
                "token": { "access_token": "ya29.ok", "refresh_token": "1//ok" }
            }))
            .unwrap(),
        )
        .unwrap();
    };
    seed_valid_cred("acc-active", "active@kite.local");
    seed_valid_cred("acc-exact-known", "exact@kite.local");
    seed_valid_cred("acc-exact-unknown", "unknownq@kite.local");
    seed_valid_cred("acc-mismatch", "free@kite.local");
    seed_valid_cred("acc-excluded", "excl@kite.local");
    seed_valid_cred("acc-reset-elapsed", "reset@kite.local");
    // acc-invalid has missing_tokens
    let bad_dir = tmp.join("agy").join("acc-invalid");
    fs::create_dir_all(&bad_dir).unwrap();
    fs::write(
        bad_dir.join("gemini_antigravity_cred.json"),
        r#"{"id_token_email":"bad@kite.local","token":{}}"#,
    )
    .unwrap();

    let now = 10_000_000_i64;
    let reg = AccountProfilesRegistry {
        profiles: vec![
            SavedAccountProfile {
                id: "acc-active".to_string(),
                provider: "agy".to_string(),
                label: "Active".to_string(),
                email: Some("active@kite.local".to_string()),
                plan_name: Some("Google AI Pro".to_string()),
                is_active: true,
                primary_remaining_percent: Some(0.0),
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-invalid".to_string(),
                provider: "agy".to_string(),
                label: "NoTokens".to_string(),
                email: Some("bad@kite.local".to_string()),
                primary_remaining_percent: Some(100.0),
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-excluded".to_string(),
                provider: "agy".to_string(),
                label: "Excluded".to_string(),
                email: Some("excl@kite.local".to_string()),
                primary_remaining_percent: Some(100.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-mismatch".to_string(),
                provider: "agy".to_string(),
                label: "FreeTier".to_string(),
                email: Some("free@kite.local".to_string()),
                plan_name: Some("Free".to_string()),
                primary_remaining_percent: Some(100.0),
                available_model_ids: vec!["gemini-2.5-flash".to_string(), "gemini-2.5-pro".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-exact-unknown".to_string(),
                provider: "agy".to_string(),
                label: "UnknownQuotaExact".to_string(),
                email: Some("unknownq@kite.local".to_string()),
                primary_remaining_percent: None,
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-exact-known".to_string(),
                provider: "agy".to_string(),
                label: "KnownHealthy".to_string(),
                email: Some("exact@kite.local".to_string()),
                plan_name: Some("Google AI Pro".to_string()),
                primary_remaining_percent: Some(75.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-reset-elapsed".to_string(),
                provider: "agy".to_string(),
                label: "ResetReady".to_string(),
                email: Some("reset@kite.local".to_string()),
                last_used_unix_ms: now - 5000,
                time_until_reset_ms: Some(1000),
                primary_remaining_percent: Some(0.0),
                quota_windows: vec![CachedQuotaWindow {
                    name: "Claude".to_string(),
                    remaining_percent: 0.0,
                    is_exhausted: true,
                    resets_at: None,
                    time_until_reset_ms: Some(1000),
                    updated_at_unix_ms: now - 5000,
                }],
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    save_registry_to(&tmp, &reg).unwrap();

    let mut policy = AutoSwitchPolicy::default();
    policy.enabled = true;
    policy.excluded_account_ids = vec!["acc-excluded".to_string()];

    let ranked = rank_auto_switch_candidates_in(
        &tmp,
        "antigravity",
        Some("claude-opus-4-6"),
        &policy,
        &HashMap::new(),
        now,
    );
    let ids: Vec<&str> = ranked.iter().map(|c| c.profile.id.as_str()).collect();
    assert!(!ids.contains(&"acc-active"));
    assert!(!ids.contains(&"acc-invalid"));
    assert!(!ids.contains(&"acc-excluded"));
    // Reset-elapsed recovered account must be eligible, known healthy beats unknown None, exact beats mismatch.
    assert!(ids.contains(&"acc-reset-elapsed"));
    assert_eq!(ids[0], "acc-exact-known");
    assert_eq!(ranked[0].compatibility, "exact");

    // Exact unknown ranks ahead of model_mismatch (or exact known ahead of unknown)
    let pos_known = ids.iter().position(|id| *id == "acc-exact-known").unwrap();
    let pos_unknown = ids.iter().position(|id| *id == "acc-exact-unknown").unwrap();
    let pos_mismatch = ids.iter().position(|id| *id == "acc-mismatch").unwrap();
    assert!(pos_known < pos_unknown);
    assert!(pos_unknown < pos_mismatch);

    let mismatch = &ranked[pos_mismatch];
    assert_eq!(mismatch.compatibility, "model_mismatch");
    assert_eq!(mismatch.suggested_fallback_model.as_deref(), Some("gemini-2.5-pro"));
    assert_eq!(mismatch.source_plan.as_deref(), Some("Google AI Pro"));
    assert_eq!(mismatch.target_plan.as_deref(), Some("Free"));

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_rank_priority_order_bucket_mismatch_and_resume_runtime_state() {
    use super::commands::{
        get_auto_switch_policy_with, rank_auto_switch_candidates_in, resume_auto_switch_with,
        set_auto_switch_runtime_status,
    };
    use super::registry::{AutoSwitchPolicy, AutoSwitchRuntimeStatus, CachedQuotaWindow};
    use std::collections::HashMap;

    let tmp = std::env::temp_dir().join(format!("kite_rank_prio_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);

    for (id, email) in [
        ("acc-active", "active@kite.local"),
        ("acc-prio-1", "p1@kite.local"),
        ("acc-prio-2", "p2@kite.local"),
        ("acc-bucket-partial", "partial@kite.local"),
    ] {
        let dir = tmp.join("agy").join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("gemini_antigravity_cred.json"),
            serde_json::to_string(&json!({
                "id_token_email": email,
                "token": { "access_token": "ya29.ok", "refresh_token": "1//ok" }
            }))
            .unwrap(),
        )
        .unwrap();
    }

    let now = 20_000_000_i64;
    let reg = AccountProfilesRegistry {
        profiles: vec![
            SavedAccountProfile {
                id: "acc-active".to_string(),
                provider: "agy".to_string(),
                label: "Active".to_string(),
                email: Some("active@kite.local".to_string()),
                plan_name: Some("Google AI Pro".to_string()),
                is_active: true,
                primary_remaining_percent: Some(0.0),
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-prio-1".to_string(),
                provider: "agy".to_string(),
                label: "PreferredLowerPct".to_string(),
                email: Some("p1@kite.local".to_string()),
                primary_remaining_percent: Some(40.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-prio-2".to_string(),
                provider: "agy".to_string(),
                label: "SecondHigherPct".to_string(),
                email: Some("p2@kite.local".to_string()),
                primary_remaining_percent: Some(95.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-bucket-partial".to_string(),
                provider: "agy".to_string(),
                label: "BucketPartial".to_string(),
                email: Some("partial@kite.local".to_string()),
                plan_name: Some("Google AI Pro".to_string()),
                primary_remaining_percent: Some(90.0),
                quota_windows: vec![
                    CachedQuotaWindow {
                        name: "Claude".to_string(),
                        remaining_percent: 0.0,
                        is_exhausted: true,
                        resets_at: None,
                        time_until_reset_ms: Some(300_000),
                        updated_at_unix_ms: now,
                    },
                    CachedQuotaWindow {
                        name: "Gemini Flash".to_string(),
                        remaining_percent: 90.0,
                        is_exhausted: false,
                        resets_at: None,
                        time_until_reset_ms: None,
                        updated_at_unix_ms: now,
                    },
                ],
                available_model_ids: vec![
                    "claude-opus-4-6".to_string(),
                    "gemini-2.5-flash".to_string(),
                ],
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    save_registry_to(&tmp, &reg).unwrap();

    let mut policy = AutoSwitchPolicy::default();
    policy.enabled = true;
    policy.selection_strategy = "priority_order".to_string();
    policy.priority_order = vec!["acc-prio-1".to_string(), "acc-prio-2".to_string()];

    let ranked = rank_auto_switch_candidates_in(
        &tmp,
        "antigravity",
        Some("claude-opus-4-6"),
        &policy,
        &HashMap::new(),
        now,
    );
    assert_eq!(ranked.len(), 3);
    assert_eq!(ranked[0].profile.id, "acc-prio-1");
    assert_eq!(ranked[0].compatibility, "exact");
    assert_eq!(ranked[1].profile.id, "acc-prio-2");
    assert_eq!(ranked[1].compatibility, "exact");

    // Bucket-level mismatch: Claude bucket is 0%, Gemini Flash bucket is 90%.
    assert_eq!(ranked[2].profile.id, "acc-bucket-partial");
    assert_eq!(ranked[2].compatibility, "model_mismatch");
    assert_eq!(ranked[2].relevant_window_name.as_deref(), Some("Claude"));
    assert_eq!(ranked[2].suggested_fallback_model.as_deref(), Some("gemini-2.5-flash"));

    // Runtime pause & resume_auto_switch_with
    set_auto_switch_runtime_status(
        "agy",
        AutoSwitchRuntimeStatus {
            paused: true,
            pause_reason: Some("circuit_breaker".to_string()),
            cooldown_until_ms: Some(now + 60_000),
            recent_switch_count: 3,
            next_reset_at: Some("18:00".to_string()),
            next_reset_ms: Some(120_000),
            last_error_code: Some("PROVIDER_BUSY".to_string()),
            residual_process_count: Some(2),
            base_app_titles: vec!["Antigravity".to_string()],
        },
    );
    let paused_view = get_auto_switch_policy_with(&tmp, "antigravity");
    assert_eq!(paused_view["status"]["paused"], true);
    assert_eq!(paused_view["status"]["pauseReason"], "circuit_breaker");
    assert_eq!(paused_view["status"]["baseAppTitles"], json!(["Antigravity"]));

    let resumed = resume_auto_switch_with(&tmp, "antigravity");
    assert_eq!(resumed["success"], true);
    assert_eq!(resumed["status"]["paused"], false);
    assert!(resumed["status"]["pauseReason"].is_null());
    assert_eq!(resumed["status"]["recentSwitchCount"], 0);
    assert!(resumed["status"]["lastErrorCode"].is_null());
    assert!(resumed["status"]["residualProcessCount"].is_null());
    assert!(resumed["status"].get("baseAppTitles").is_none());

    let _ = fs::remove_dir_all(&tmp);
}

struct MockAutoSwitchEnv {
    root: std::path::PathBuf,
    external: std::sync::Mutex<super::storage::ExternalProcessInspection>,
    sessions: std::sync::Mutex<crate::terminal::ProviderSessionsInspection>,
    runtime_statuses: std::sync::Mutex<std::collections::HashMap<String, super::registry::AutoSwitchRuntimeStatus>>,
    switch_handler: std::sync::Mutex<Box<dyn FnMut(&str, &str, bool) -> Value + Send>>,
    switch_calls: std::sync::Mutex<Vec<(String, String, bool)>>,
    emitted_events: std::sync::Mutex<Vec<(String, Value)>>,
}

impl MockAutoSwitchEnv {
    fn new(root: std::path::PathBuf) -> Self {
        Self {
            root,
            external: std::sync::Mutex::new(super::storage::ExternalProcessInspection::idle()),
            sessions: std::sync::Mutex::new(crate::terminal::ProviderSessionsInspection::default()),
            runtime_statuses: std::sync::Mutex::new(std::collections::HashMap::new()),
            switch_handler: std::sync::Mutex::new(Box::new(|_, _, _| json!({ "success": true }))),
            switch_calls: std::sync::Mutex::new(Vec::new()),
            emitted_events: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn set_switch_handler<F>(&self, f: F)
    where
        F: FnMut(&str, &str, bool) -> Value + Send + 'static,
    {
        *self.switch_handler.lock().unwrap() = Box::new(f);
    }

    fn take_events(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut *self.emitted_events.lock().unwrap())
    }
}

impl super::auto_switch::AutoSwitchEnv for MockAutoSwitchEnv {
    fn profiles_root(&self) -> std::path::PathBuf {
        self.root.clone()
    }

    fn inspect_external(&self, _provider: &str) -> super::storage::ExternalProcessInspection {
        self.external.lock().unwrap().clone()
    }

    fn inspect_sessions(&self, _provider: &str) -> crate::terminal::ProviderSessionsInspection {
        self.sessions.lock().unwrap().clone()
    }

    fn execute_switch(&self, provider: &str, account_id: &str, force_busy: bool) -> Value {
        self.switch_calls.lock().unwrap().push((
            provider.to_string(),
            account_id.to_string(),
            force_busy,
        ));
        (self.switch_handler.lock().unwrap())(provider, account_id, force_busy)
    }

    fn get_runtime_status(&self, provider: &str) -> super::registry::AutoSwitchRuntimeStatus {
        let canon = canon_provider(provider);
        self.runtime_statuses
            .lock()
            .unwrap()
            .get(&canon)
            .cloned()
            .unwrap_or_default()
    }

    fn set_runtime_status(&self, provider: &str, status: super::registry::AutoSwitchRuntimeStatus) {
        let canon = canon_provider(provider);
        self.runtime_statuses.lock().unwrap().insert(canon, status);
    }

    fn emit_event(&self, event: &str, payload: Value) {
        self.emitted_events
            .lock()
            .unwrap()
            .push((event.to_string(), payload));
    }
}

fn seed_agy_cred_file(root: &std::path::Path, id: &str, email: &str) {
    let dir = root.join("agy").join(id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("gemini_antigravity_cred.json"),
        serde_json::to_string(&json!({
            "id_token_email": email,
            "token": { "access_token": "ya29.ok", "refresh_token": "1//ok" }
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn test_auto_switch_coordinator_disabled_and_healthy_recovery_clears_all_exhausted() {
    use super::auto_switch::{
        evaluate_auto_switch_with, AutoSwitchCoordinatorState, AutoSwitchOutcome,
        AutoSwitchTriggerRequest,
    };
    use super::registry::{save_auto_switch_policy_in, AutoSwitchPolicy, AutoSwitchRuntimeStatus};

    let tmp = std::env::temp_dir().join(format!("kite_as_disabled_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();

    let env = MockAutoSwitchEnv::new(tmp.clone());
    let mut state = AutoSwitchCoordinatorState::default();

    let req = AutoSwitchTriggerRequest {
        provider: "antigravity".to_string(),
        trigger_source: "quota_poll".to_string(),
        requested_model: None,
        thread_id: None,
        current_remaining_percent: Some(0.0),
        has_exhausted_window: true,
        now_unix_ms: 1_000_000,
    };
    assert!(matches!(
        evaluate_auto_switch_with(&req, &mut state, &env),
        AutoSwitchOutcome::Disabled
    ));
    assert!(env.switch_calls.lock().unwrap().is_empty());

    let mut policy = AutoSwitchPolicy::default();
    policy.enabled = true;
    save_auto_switch_policy_in(&tmp, "agy", policy).unwrap();

    state
        .target_cooldown_until_ms
        .insert(("agy".to_string(), "acc-2".to_string()), 5_000_000);
    env.set_runtime_status(
        "agy",
        AutoSwitchRuntimeStatus {
            paused: true,
            pause_reason: Some("ALL_ACCOUNTS_EXHAUSTED".to_string()),
            next_reset_at: Some("18:00".to_string()),
            next_reset_ms: Some(60_000),
            ..Default::default()
        },
    );

    let healthy_req = AutoSwitchTriggerRequest {
        provider: "antigravity".to_string(),
        trigger_source: "quota_poll".to_string(),
        requested_model: None,
        thread_id: None,
        current_remaining_percent: Some(45.0),
        has_exhausted_window: false,
        now_unix_ms: 1_100_000,
    };
    assert!(matches!(
        evaluate_auto_switch_with(&healthy_req, &mut state, &env),
        AutoSwitchOutcome::NotExhausted
    ));
    let cleared = env.get_runtime_status("agy");
    assert!(!cleared.paused);
    assert!(cleared.pause_reason.is_none());
    assert!(cleared.next_reset_at.is_none());
    assert!(state.target_cooldown_until_ms.is_empty());
    let events = env.take_events();
    assert!(events.iter().any(|(name, _)| name == "kite://auto-switch-status"));

    // Healthy poll must NOT auto-clear CIRCUIT_BREAKER_PAUSED
    env.set_runtime_status(
        "agy",
        AutoSwitchRuntimeStatus {
            paused: true,
            pause_reason: Some("CIRCUIT_BREAKER_PAUSED".to_string()),
            recent_switch_count: 3,
            ..Default::default()
        },
    );
    assert!(matches!(
        evaluate_auto_switch_with(&healthy_req, &mut state, &env),
        AutoSwitchOutcome::NotExhausted
    ));
    let still_paused = env.get_runtime_status("agy");
    assert!(still_paused.paused);
    assert_eq!(
        still_paused.pause_reason.as_deref(),
        Some("CIRCUIT_BREAKER_PAUSED")
    );

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_auto_switch_coordinator_exact_match_switches_records_cooldown_and_emits_events() {
    use super::auto_switch::{
        evaluate_auto_switch_with, AutoSwitchCoordinatorState, AutoSwitchOutcome,
        AutoSwitchTriggerRequest,
    };
    use super::registry::{save_auto_switch_policy_in, AutoSwitchPolicy};

    let tmp = std::env::temp_dir().join(format!("kite_as_exact_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    seed_agy_cred_file(&tmp, "acc-a", "a@kite.local");
    seed_agy_cred_file(&tmp, "acc-b", "b@kite.local");

    let reg = AccountProfilesRegistry {
        profiles: vec![
            SavedAccountProfile {
                id: "acc-a".to_string(),
                provider: "agy".to_string(),
                label: "Personal".to_string(),
                email: Some("a@kite.local".to_string()),
                plan_name: Some("Google AI Pro".to_string()),
                is_active: true,
                primary_remaining_percent: Some(0.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-b".to_string(),
                provider: "agy".to_string(),
                label: "Work".to_string(),
                email: Some("b@kite.local".to_string()),
                plan_name: Some("Google AI Pro".to_string()),
                is_active: false,
                primary_remaining_percent: Some(85.0),
                available_model_ids: vec![
                    "claude-opus-4-6".to_string(),
                    "gemini-2.5-flash".to_string(),
                ],
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    save_registry_to(&tmp, &reg).unwrap();

    let mut policy = AutoSwitchPolicy::default();
    policy.enabled = true;
    policy.cooldown_seconds = 120;
    save_auto_switch_policy_in(&tmp, "agy", policy).unwrap();

    let env = MockAutoSwitchEnv::new(tmp.clone());
    let mut state = AutoSwitchCoordinatorState::default();
    let now = 2_000_000_i64;

    let req = AutoSwitchTriggerRequest {
        provider: "antigravity".to_string(),
        trigger_source: "chat_turn".to_string(),
        requested_model: Some("claude-opus-4-6".to_string()),
        thread_id: Some("thread-42".to_string()),
        current_remaining_percent: Some(0.0),
        has_exhausted_window: false,
        now_unix_ms: now,
    };

    let outcome = evaluate_auto_switch_with(&req, &mut state, &env);
    match outcome {
        AutoSwitchOutcome::Switched {
            provider,
            from_account_id,
            from_account_label,
            to_account_id,
            to_account_label,
            applied_model,
            model_adjusted,
            auto_continue_chat_turn,
            compatibility,
            status,
            ..
        } => {
            assert_eq!(provider, "agy");
            assert_eq!(from_account_id.as_deref(), Some("acc-a"));
            assert_eq!(from_account_label, "Personal");
            assert_eq!(to_account_id, "acc-b");
            assert_eq!(to_account_label, "Work");
            assert_eq!(applied_model.as_deref(), Some("claude-opus-4-6"));
            assert!(!model_adjusted);
            assert!(auto_continue_chat_turn);
            assert_eq!(compatibility, "exact");
            assert!(!status.paused);
            assert_eq!(status.recent_switch_count, 1);
            assert_eq!(status.cooldown_until_ms, Some(now + 120_000));
        }
        other => panic!("Expected Switched, got {:?}", other),
    }

    assert_eq!(
        *env.switch_calls.lock().unwrap(),
        vec![("agy".to_string(), "acc-b".to_string(), false)]
    );
    assert_eq!(state.last_switch_unix_ms.get("agy"), Some(&now));
    assert_eq!(
        state
            .target_cooldown_until_ms
            .get(&("agy".to_string(), "acc-a".to_string())),
        Some(&(now + 120_000))
    );

    let events = env.take_events();
    assert!(events.iter().any(|(e, _)| e == "kite://auto-switch-status"));
    let exec_ev = events
        .iter()
        .find(|(e, _)| e == "kite://auto-switch-executed")
        .expect("must emit auto-switch-executed");
    assert_eq!(exec_ev.1["provider"], "agy");
    assert_eq!(exec_ev.1["fromAccountId"], "acc-a");
    assert_eq!(exec_ev.1["toAccountId"], "acc-b");
    assert_eq!(exec_ev.1["appliedModel"], "claude-opus-4-6");
    assert_eq!(exec_ev.1["triggerSource"], "chat_turn");

    // Trigger inside cooldown must return SkippedCooldown without switching again
    let cooldown_req = AutoSwitchTriggerRequest {
        now_unix_ms: now + 30_000,
        ..req
    };
    match evaluate_auto_switch_with(&cooldown_req, &mut state, &env) {
        AutoSwitchOutcome::SkippedCooldown { status } => {
            assert_eq!(status.cooldown_until_ms, Some(now + 120_000));
        }
        other => panic!("Expected SkippedCooldown, got {:?}", other),
    }
    assert_eq!(env.switch_calls.lock().unwrap().len(), 1);

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_auto_switch_coordinator_rolling_circuit_breaker_pauses_and_manual_resume_unlocks() {
    use super::auto_switch::{
        evaluate_auto_switch_with, on_manual_switch_with, AutoSwitchCoordinatorState,
        AutoSwitchOutcome, AutoSwitchTriggerRequest,
    };
    use super::registry::{save_auto_switch_policy_in, AutoSwitchPolicy};

    let tmp = std::env::temp_dir().join(format!("kite_as_breaker_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    for (id, em) in [
        ("acc-1", "u1@kite.local"),
        ("acc-2", "u2@kite.local"),
        ("acc-3", "u3@kite.local"),
        ("acc-4", "u4@kite.local"),
    ] {
        seed_agy_cred_file(&tmp, id, em);
    }

    let now = 5_000_000_i64;
    let reg = AccountProfilesRegistry {
        profiles: vec![
            SavedAccountProfile {
                id: "acc-1".to_string(),
                provider: "agy".to_string(),
                label: "U1".to_string(),
                email: Some("u1@kite.local".to_string()),
                is_active: true,
                primary_remaining_percent: Some(0.0),
                time_until_reset_ms: Some(120_000),
                primary_reset_at: Some("18:05".to_string()),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-2".to_string(),
                provider: "agy".to_string(),
                label: "U2".to_string(),
                email: Some("u2@kite.local".to_string()),
                is_active: false,
                primary_remaining_percent: Some(90.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-3".to_string(),
                provider: "agy".to_string(),
                label: "U3".to_string(),
                email: Some("u3@kite.local".to_string()),
                is_active: false,
                primary_remaining_percent: Some(80.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-4".to_string(),
                provider: "agy".to_string(),
                label: "U4".to_string(),
                email: Some("u4@kite.local".to_string()),
                is_active: false,
                primary_remaining_percent: Some(70.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    save_registry_to(&tmp, &reg).unwrap();

    let mut policy = AutoSwitchPolicy::default();
    policy.enabled = true;
    policy.cooldown_seconds = 60;
    policy.max_consecutive_switches = 3;
    save_auto_switch_policy_in(&tmp, "agy", policy).unwrap();

    let env = MockAutoSwitchEnv::new(tmp.clone());
    let tmp_for_handler = tmp.clone();
    env.set_switch_handler(move |_prov, target_id, _force| {
        let mut r = load_registry_from(&tmp_for_handler);
        for p in &mut r.profiles {
            p.is_active = p.id == target_id;
            if p.id == target_id {
                p.primary_remaining_percent = Some(0.0);
            }
        }
        save_registry_to(&tmp_for_handler, &r).unwrap();
        json!({ "success": true })
    });

    let mut state = AutoSwitchCoordinatorState::default();
    let base_req = |t: i64| AutoSwitchTriggerRequest {
        provider: "agy".to_string(),
        trigger_source: "pty_error".to_string(),
        requested_model: Some("claude-opus-4-6".to_string()),
        thread_id: None,
        current_remaining_percent: Some(0.0),
        has_exhausted_window: true,
        now_unix_ms: t,
    };

    assert!(matches!(
        evaluate_auto_switch_with(&base_req(now), &mut state, &env),
        AutoSwitchOutcome::Switched { .. }
    ));
    assert!(matches!(
        evaluate_auto_switch_with(&base_req(now + 70_000), &mut state, &env),
        AutoSwitchOutcome::Switched { .. }
    ));
    assert!(matches!(
        evaluate_auto_switch_with(&base_req(now + 140_000), &mut state, &env),
        AutoSwitchOutcome::Switched { .. }
    ));

    // 4th switch within 10 minutes must trip circuit breaker
    match evaluate_auto_switch_with(&base_req(now + 210_000), &mut state, &env) {
        AutoSwitchOutcome::Paused { status } => {
            assert!(status.paused);
            assert_eq!(status.pause_reason.as_deref(), Some("CIRCUIT_BREAKER_PAUSED"));
            assert_eq!(status.recent_switch_count, 3);
            assert_eq!(status.next_reset_at.as_deref(), Some("18:05"));
            assert_eq!(status.next_reset_ms, Some(120_000));
        }
        other => panic!("Expected Paused circuit breaker, got {:?}", other),
    }
    assert_eq!(env.switch_calls.lock().unwrap().len(), 3);

    // Even after 10 minutes pass, CIRCUIT_BREAKER_PAUSED stays locked until user resumes
    match evaluate_auto_switch_with(&base_req(now + 900_000), &mut state, &env) {
        AutoSwitchOutcome::Paused { status } => {
            assert!(status.paused);
            assert_eq!(status.pause_reason.as_deref(), Some("CIRCUIT_BREAKER_PAUSED"));
        }
        other => panic!("Expected Paused to persist until manual resume, got {:?}", other),
    }

    // Manual switch / resume unlocks breaker cleanly
    on_manual_switch_with("agy", &mut state, &env);
    assert!(!env.get_runtime_status("agy").paused);
    assert!(state.recent_switches_ms.get("agy").map_or(true, |v| v.is_empty()));
    assert!(state.target_cooldown_until_ms.is_empty());

    let mut r = load_registry_from(&tmp);
    for p in &mut r.profiles {
        if p.id == "acc-1" {
            p.primary_remaining_percent = Some(95.0);
        }
    }
    save_registry_to(&tmp, &r).unwrap();

    assert!(matches!(
        evaluate_auto_switch_with(&base_req(now + 905_000), &mut state, &env),
        AutoSwitchOutcome::Switched { .. }
    ));

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_auto_switch_coordinator_all_accounts_exhausted_earliest_reset_eta() {
    use super::auto_switch::{
        evaluate_auto_switch_with, AutoSwitchCoordinatorState, AutoSwitchOutcome,
        AutoSwitchTriggerRequest,
    };
    use super::registry::{save_auto_switch_policy_in, AutoSwitchPolicy, CachedQuotaWindow};

    let tmp = std::env::temp_dir().join(format!("kite_as_all_ex_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    seed_agy_cred_file(&tmp, "acc-1", "a1@kite.local");
    seed_agy_cred_file(&tmp, "acc-2", "a2@kite.local");
    seed_agy_cred_file(&tmp, "acc-excluded", "ex@kite.local");

    let now = 8_000_000_i64;
    let reg = AccountProfilesRegistry {
        profiles: vec![
            SavedAccountProfile {
                id: "acc-1".to_string(),
                provider: "agy".to_string(),
                label: "A1".to_string(),
                email: Some("a1@kite.local".to_string()),
                is_active: true,
                last_used_unix_ms: now,
                primary_remaining_percent: Some(0.0),
                primary_reset_at: Some("2026-11-15T19:00:00Z".to_string()),
                time_until_reset_ms: Some(900_000),
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-2".to_string(),
                provider: "agy".to_string(),
                label: "A2".to_string(),
                email: Some("a2@kite.local".to_string()),
                is_active: false,
                last_used_unix_ms: now,
                primary_remaining_percent: Some(0.0),
                quota_windows: vec![CachedQuotaWindow {
                    name: "Claude".to_string(),
                    remaining_percent: 0.0,
                    is_exhausted: true,
                    resets_at: Some("2026-11-15T18:05:00Z".to_string()),
                    time_until_reset_ms: Some(300_000),
                    updated_at_unix_ms: now,
                }],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-excluded".to_string(),
                provider: "agy".to_string(),
                label: "Excluded".to_string(),
                email: Some("ex@kite.local".to_string()),
                is_active: false,
                primary_remaining_percent: Some(100.0),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    save_registry_to(&tmp, &reg).unwrap();

    let mut policy = AutoSwitchPolicy::default();
    policy.enabled = true;
    policy.excluded_account_ids = vec!["acc-excluded".to_string()];
    save_auto_switch_policy_in(&tmp, "agy", policy).unwrap();

    let env = MockAutoSwitchEnv::new(tmp.clone());
    let mut state = AutoSwitchCoordinatorState::default();
    let req = AutoSwitchTriggerRequest {
        provider: "agy".to_string(),
        trigger_source: "quota_poll".to_string(),
        requested_model: None,
        thread_id: None,
        current_remaining_percent: Some(0.0),
        has_exhausted_window: true,
        now_unix_ms: now,
    };

    match evaluate_auto_switch_with(&req, &mut state, &env) {
        AutoSwitchOutcome::Paused { status } => {
            assert!(status.paused);
            assert_eq!(status.pause_reason.as_deref(), Some("ALL_ACCOUNTS_EXHAUSTED"));
            assert_eq!(status.next_reset_ms, Some(300_000));
            assert_eq!(
                status.next_reset_at.as_deref(),
                Some("2026-11-15T18:05:00Z")
            );
        }
        other => panic!("Expected Paused ALL_ACCOUNTS_EXHAUSTED, got {:?}", other),
    }

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_auto_switch_coordinator_external_process_and_busy_terminal_policies() {
    use super::auto_switch::{
        evaluate_auto_switch_with, AutoSwitchCoordinatorState, AutoSwitchOutcome,
        AutoSwitchTriggerRequest,
    };
    use super::registry::{save_auto_switch_policy_in, AutoSwitchPolicy};
    use super::storage::{ExternalProcessInspection, ResidualProcessSummary};
    use crate::terminal::{ProviderSessionSummary, ProviderSessionsInspection};

    let tmp = std::env::temp_dir().join(format!("kite_as_busy_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    seed_agy_cred_file(&tmp, "acc-1", "a1@kite.local");
    seed_agy_cred_file(&tmp, "acc-2", "a2@kite.local");

    let reg = AccountProfilesRegistry {
        profiles: vec![
            SavedAccountProfile {
                id: "acc-1".to_string(),
                provider: "agy".to_string(),
                label: "A1".to_string(),
                email: Some("a1@kite.local".to_string()),
                is_active: true,
                primary_remaining_percent: Some(0.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-2".to_string(),
                provider: "agy".to_string(),
                label: "A2".to_string(),
                email: Some("a2@kite.local".to_string()),
                is_active: false,
                primary_remaining_percent: Some(95.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    save_registry_to(&tmp, &reg).unwrap();

    let mut policy = AutoSwitchPolicy::default();
    policy.enabled = true;
    policy.busy_terminals_policy = "wait_idle".to_string();
    save_auto_switch_policy_in(&tmp, "agy", policy.clone()).unwrap();

    let env = MockAutoSwitchEnv::new(tmp.clone());
    let mut state = AutoSwitchCoordinatorState::default();
    let req = AutoSwitchTriggerRequest {
        provider: "agy".to_string(),
        trigger_source: "quota_poll".to_string(),
        requested_model: Some("claude-opus-4-6".to_string()),
        thread_id: None,
        current_remaining_percent: Some(0.0),
        has_exhausted_window: false,
        now_unix_ms: 9_000_000,
    };

    // 1. base_app_open pauses cleanly without killing IDE window
    *env.external.lock().unwrap() = ExternalProcessInspection {
        state: "base_app_open".to_string(),
        can_close_processes: false,
        base_app_pids: vec![123],
        base_app_titles: vec!["Antigravity — kite".to_string()],
        residual_processes: vec![],
        message: "Antigravity IDE open".to_string(),
    };
    match evaluate_auto_switch_with(&req, &mut state, &env) {
        AutoSwitchOutcome::Paused { status } => {
            assert!(status.paused);
            assert_eq!(status.pause_reason.as_deref(), Some("IDE_PROCESS_BUSY"));
            assert_eq!(status.last_error_code.as_deref(), Some("PROVIDER_BUSY"));
            assert_eq!(status.base_app_titles, vec!["Antigravity — kite".to_string()]);
        }
        other => panic!("Expected IDE_PROCESS_BUSY, got {:?}", other),
    }

    // 2. residual_only pauses with RESIDUAL_PROCESSES_BLOCKING & residual count
    *env.external.lock().unwrap() = ExternalProcessInspection {
        state: "residual_only".to_string(),
        can_close_processes: true,
        base_app_pids: vec![],
        base_app_titles: vec![],
        residual_processes: vec![
            ResidualProcessSummary {
                pid: 201,
                name: "antigravity.exe".to_string(),
                kind: "utility".to_string(),
            },
            ResidualProcessSummary {
                pid: 202,
                name: "antigravity.exe".to_string(),
                kind: "renderer".to_string(),
            },
        ],
        message: "2 residuals".to_string(),
    };
    match evaluate_auto_switch_with(&req, &mut state, &env) {
        AutoSwitchOutcome::Paused { status } => {
            assert!(status.paused);
            assert_eq!(
                status.pause_reason.as_deref(),
                Some("RESIDUAL_PROCESSES_BLOCKING")
            );
            assert_eq!(status.last_error_code.as_deref(), Some("PROVIDER_BUSY"));
            assert_eq!(status.residual_process_count, Some(2));
        }
        other => panic!("Expected RESIDUAL_PROCESSES_BLOCKING, got {:?}", other),
    }

    // 3. External idle, but managed busy PTY with "wait_idle" defers cleanly
    *env.external.lock().unwrap() = ExternalProcessInspection::idle();
    let busy_summary = ProviderSessionSummary {
        session_id: "term-1".to_string(),
        engine: "antigravity".to_string(),
        workspace_id: None,
        pane_id: None,
        cwd: "C:/repo".to_string(),
        busy: true,
        reasons: vec!["recent_output".to_string()],
        last_output_age_ms: Some(120),
        presentation_live: true,
    };
    *env.sessions.lock().unwrap() = ProviderSessionsInspection {
        managed_busy: vec![busy_summary.clone()],
        ..Default::default()
    };
    match evaluate_auto_switch_with(&req, &mut state, &env) {
        AutoSwitchOutcome::Paused { status } => {
            assert!(status.paused);
            assert_eq!(
                status.pause_reason.as_deref(),
                Some("BUSY_TERMINALS_DEFERRED")
            );
        }
        other => panic!("Expected BUSY_TERMINALS_DEFERRED, got {:?}", other),
    }
    assert!(env.switch_calls.lock().unwrap().is_empty());

    // 4. "ask" returns NeedsConfirmation with busy_sessions
    policy.busy_terminals_policy = "ask".to_string();
    save_auto_switch_policy_in(&tmp, "agy", policy.clone()).unwrap();
    match evaluate_auto_switch_with(&req, &mut state, &env) {
        AutoSwitchOutcome::NeedsConfirmation {
            reason,
            busy_sessions,
            ..
        } => {
            assert_eq!(reason, "busy_terminals_ask");
            assert_eq!(busy_sessions.len(), 1);
            assert_eq!(busy_sessions[0].session_id, "term-1");
        }
        other => panic!("Expected NeedsConfirmation busy_terminals_ask, got {:?}", other),
    }
    assert!(env.switch_calls.lock().unwrap().is_empty());

    // 5. "interrupt" passes force_busy = true and executes switch
    policy.busy_terminals_policy = "interrupt".to_string();
    save_auto_switch_policy_in(&tmp, "agy", policy).unwrap();
    assert!(matches!(
        evaluate_auto_switch_with(&req, &mut state, &env),
        AutoSwitchOutcome::Switched { .. }
    ));
    assert_eq!(
        *env.switch_calls.lock().unwrap(),
        vec![("agy".to_string(), "acc-2".to_string(), true)]
    );

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_auto_switch_coordinator_model_mismatch_confirm_vs_auto_fallback_and_unverified() {
    use super::auto_switch::{
        evaluate_auto_switch_with, AutoSwitchCoordinatorState, AutoSwitchOutcome,
        AutoSwitchTriggerRequest,
    };
    use super::registry::{save_auto_switch_policy_in, AutoSwitchPolicy};

    let tmp = std::env::temp_dir().join(format!("kite_as_mismatch_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    seed_agy_cred_file(&tmp, "acc-pro", "pro@kite.local");
    seed_agy_cred_file(&tmp, "acc-free", "free@kite.local");

    let reg = AccountProfilesRegistry {
        profiles: vec![
            SavedAccountProfile {
                id: "acc-pro".to_string(),
                provider: "agy".to_string(),
                label: "Pro".to_string(),
                email: Some("pro@kite.local".to_string()),
                plan_name: Some("Google AI Pro".to_string()),
                is_active: true,
                primary_remaining_percent: Some(0.0),
                available_model_ids: vec!["claude-opus-4-6".to_string()],
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-free".to_string(),
                provider: "agy".to_string(),
                label: "Free".to_string(),
                email: Some("free@kite.local".to_string()),
                plan_name: Some("Free".to_string()),
                is_active: false,
                primary_remaining_percent: Some(100.0),
                available_model_ids: vec![
                    "gemini-2.5-pro".to_string(),
                    "gemini-2.5-flash".to_string(),
                ],
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    save_registry_to(&tmp, &reg).unwrap();

    let mut policy = AutoSwitchPolicy::default();
    policy.enabled = true;
    policy.model_mismatch_policy = "confirm_notification".to_string();
    save_auto_switch_policy_in(&tmp, "agy", policy.clone()).unwrap();

    let env = MockAutoSwitchEnv::new(tmp.clone());
    let mut state = AutoSwitchCoordinatorState::default();
    let req = AutoSwitchTriggerRequest {
        provider: "agy".to_string(),
        trigger_source: "chat_turn".to_string(),
        requested_model: Some("claude-opus-4-6".to_string()),
        thread_id: Some("th-1".to_string()),
        current_remaining_percent: Some(0.0),
        has_exhausted_window: false,
        now_unix_ms: 10_000_000,
    };

    // 1. model_mismatch + confirm_notification asks without touching credentials
    match evaluate_auto_switch_with(&req, &mut state, &env) {
        AutoSwitchOutcome::NeedsConfirmation {
            candidate,
            reason,
            requested_model,
            thread_id,
            ..
        } => {
            assert_eq!(reason, "model_mismatch");
            assert_eq!(candidate.profile.id, "acc-free");
            assert_eq!(
                candidate.suggested_fallback_model.as_deref(),
                Some("gemini-2.5-pro")
            );
            assert_eq!(requested_model.as_deref(), Some("claude-opus-4-6"));
            assert_eq!(thread_id.as_deref(), Some("th-1"));
        }
        other => panic!("Expected NeedsConfirmation model_mismatch, got {:?}", other),
    }
    assert!(env.switch_calls.lock().unwrap().is_empty());

    // 2. model_mismatch + auto_fallback switches and applies fallback model
    policy.model_mismatch_policy = "auto_fallback".to_string();
    save_auto_switch_policy_in(&tmp, "agy", policy.clone()).unwrap();
    match evaluate_auto_switch_with(&req, &mut state, &env) {
        AutoSwitchOutcome::Switched {
            applied_model,
            model_adjusted,
            compatibility,
            ..
        } => {
            assert_eq!(compatibility, "model_mismatch");
            assert!(model_adjusted);
            assert_eq!(applied_model.as_deref(), Some("gemini-2.5-pro"));
        }
        other => panic!("Expected Switched with fallback model, got {:?}", other),
    }

    // 3. unverified_catalog + confirm_notification also asks
    let mut r2 = load_registry_from(&tmp);
    r2.profiles[1].available_model_ids.clear();
    save_registry_to(&tmp, &r2).unwrap();
    policy.model_mismatch_policy = "confirm_notification".to_string();
    save_auto_switch_policy_in(&tmp, "agy", policy).unwrap();
    let mut state2 = AutoSwitchCoordinatorState::default();
    match evaluate_auto_switch_with(&req, &mut state2, &env) {
        AutoSwitchOutcome::NeedsConfirmation { reason, .. } => {
            assert_eq!(reason, "unverified_catalog");
        }
        other => panic!("Expected NeedsConfirmation unverified_catalog, got {:?}", other),
    }

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_auto_switch_coordinator_failure_cooldown_provider_busy_race_and_quota_poll_helper() {
    use super::auto_switch::{
        build_quota_poll_trigger_request, evaluate_auto_switch_with, AutoSwitchCoordinatorState,
        AutoSwitchOutcome, AutoSwitchTriggerRequest,
    };
    use super::registry::{save_auto_switch_policy_in, AutoSwitchPolicy};
    use crate::quota::{ProviderQuotaStatus, QuotaWindow};
    use std::collections::HashMap;

    // 1. Quota poll trigger helper verifies available/auth & exhausted window detection
    let unavail = ProviderQuotaStatus {
        provider_id: "antigravity".to_string(),
        display_name: "Antigravity".to_string(),
        is_available: false,
        is_auth: false,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 0.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: 0,
        error: None,
    };
    assert!(build_quota_poll_trigger_request("antigravity", &unavail, 1000).is_none());

    let partial_exhaust = ProviderQuotaStatus {
        is_available: true,
        is_auth: true,
        primary_remaining_percent: 50.0,
        windows: vec![QuotaWindow {
            name: "Claude".to_string(),
            usage_percent: 100.0,
            remaining_fraction: 0.0,
            resets_at: None,
            time_until_reset_ms: Some(1000),
            is_exhausted: true,
        }],
        ..unavail
    };
    let built = build_quota_poll_trigger_request("antigravity", &partial_exhaust, 12_345).unwrap();
    assert_eq!(built.provider, "agy");
    assert_eq!(built.trigger_source, "quota_poll");
    assert_eq!(built.current_remaining_percent, Some(50.0));
    assert!(built.has_exhausted_window);
    assert_eq!(built.now_unix_ms, 12_345);

    // 2. Failure puts broken target on cooldown so next trigger picks backup candidate
    let tmp = std::env::temp_dir().join(format!("kite_as_fail_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    seed_agy_cred_file(&tmp, "acc-1", "a1@kite.local");
    seed_agy_cred_file(&tmp, "acc-broken", "broken@kite.local");
    seed_agy_cred_file(&tmp, "acc-good", "good@kite.local");

    let reg = AccountProfilesRegistry {
        profiles: vec![
            SavedAccountProfile {
                id: "acc-1".to_string(),
                provider: "agy".to_string(),
                label: "A1".to_string(),
                email: Some("a1@kite.local".to_string()),
                is_active: true,
                primary_remaining_percent: Some(0.0),
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-broken".to_string(),
                provider: "agy".to_string(),
                label: "Broken".to_string(),
                email: Some("broken@kite.local".to_string()),
                is_active: false,
                primary_remaining_percent: Some(90.0),
                ..Default::default()
            },
            SavedAccountProfile {
                id: "acc-good".to_string(),
                provider: "agy".to_string(),
                label: "Good".to_string(),
                email: Some("good@kite.local".to_string()),
                is_active: false,
                primary_remaining_percent: Some(60.0),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    save_registry_to(&tmp, &reg).unwrap();

    let mut policy = AutoSwitchPolicy::default();
    policy.enabled = true;
    save_auto_switch_policy_in(&tmp, "agy", policy).unwrap();

    let env = MockAutoSwitchEnv::new(tmp.clone());
    env.set_switch_handler(|_prov, target_id, _force| {
        if target_id == "acc-broken" {
            json!({
                "success": false,
                "code": "KEYRING_FAILED",
                "error": "keyring locked"
            })
        } else {
            json!({ "success": true })
        }
    });

    let mut state = AutoSwitchCoordinatorState::default();
    let req = AutoSwitchTriggerRequest {
        provider: "agy".to_string(),
        trigger_source: "quota_poll".to_string(),
        requested_model: None,
        thread_id: None,
        current_remaining_percent: Some(0.0),
        has_exhausted_window: false,
        now_unix_ms: 20_000_000,
    };

    match evaluate_auto_switch_with(&req, &mut state, &env) {
        AutoSwitchOutcome::Failed { code, error, status } => {
            assert_eq!(code, "KEYRING_FAILED");
            assert_eq!(error, "keyring locked");
            assert_eq!(status.last_error_code.as_deref(), Some("KEYRING_FAILED"));
        }
        other => panic!("Expected Failed, got {:?}", other),
    }
    assert!(state
        .target_cooldown_until_ms
        .contains_key(&("agy".to_string(), "acc-broken".to_string())));

    // Immediately retrying bypasses cooled-down broken profile and switches to acc-good
    match evaluate_auto_switch_with(&req, &mut state, &env) {
        AutoSwitchOutcome::Switched { to_account_id, .. } => {
            assert_eq!(to_account_id, "acc-good");
        }
        other => panic!("Expected fallback switch to acc-good, got {:?}", other),
    }

    // 3. Race returning PROVIDER_BUSY maps into Paused status cleanly
    let env_race = MockAutoSwitchEnv::new(tmp.clone());
    env_race.set_switch_handler(|_, _, _| {
        json!({
            "success": false,
            "code": "PROVIDER_BUSY",
            "providerBusyKind": "base_app_open",
            "baseAppTitles": ["Antigravity — app"]
        })
    });
    let mut state_race = AutoSwitchCoordinatorState::default();
    match evaluate_auto_switch_with(&req, &mut state_race, &env_race) {
        AutoSwitchOutcome::Paused { status } => {
            assert!(status.paused);
            assert_eq!(status.pause_reason.as_deref(), Some("IDE_PROCESS_BUSY"));
            assert_eq!(status.base_app_titles, vec!["Antigravity — app".to_string()]);
        }
        other => panic!("Expected Paused IDE_PROCESS_BUSY on race, got {:?}", other),
    }

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn test_resume_auto_switch_with_clears_global_coordinator_circuit_breaker() {
    use super::auto_switch::{auto_switch_coordinator_lock, auto_switch_coordinator_state};
    use super::commands::{resume_auto_switch_with, set_auto_switch_runtime_status};
    use super::registry::AutoSwitchRuntimeStatus;

    let tmp = std::env::temp_dir().join(format!("kite_as_global_res_{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();

    // Use "codex" to avoid colliding with parallel "agy" runtime status tests
    {
        let _lock = auto_switch_coordinator_lock().lock().unwrap();
        let mut st = auto_switch_coordinator_state().lock().unwrap();
        st.last_switch_unix_ms.insert("codex".to_string(), 999);
        st.recent_switches_ms
            .insert("codex".to_string(), vec![997, 998, 999]);
        st.target_cooldown_until_ms
            .insert(("codex".to_string(), "c1".to_string()), 5000);
    }
    set_auto_switch_runtime_status(
        "codex",
        AutoSwitchRuntimeStatus {
            paused: true,
            pause_reason: Some("CIRCUIT_BREAKER_PAUSED".to_string()),
            recent_switch_count: 3,
            ..Default::default()
        },
    );

    let resumed = resume_auto_switch_with(&tmp, "codex");
    assert_eq!(resumed["success"], true);
    assert_eq!(resumed["status"]["paused"], false);

    {
        let _lock = auto_switch_coordinator_lock().lock().unwrap();
        let st = auto_switch_coordinator_state().lock().unwrap();
        assert!(!st.last_switch_unix_ms.contains_key("codex"));
        assert!(!st.recent_switches_ms.contains_key("codex"));
        assert!(!st
            .target_cooldown_until_ms
            .keys()
            .any(|(p, _)| p == "codex"));
    }

    let _ = fs::remove_dir_all(&tmp);
}
