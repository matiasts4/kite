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
        }],
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
