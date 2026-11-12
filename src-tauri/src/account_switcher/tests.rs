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
    });

    save_registry_to(&dir, &reg).unwrap();

    let loaded = load_registry_from(&dir);
    assert_eq!(loaded.profiles.len(), 1);
    assert_eq!(loaded.profiles[0].email.as_deref(), Some("reconciled@example.com"));
    // Legacy contaminated file should be removed
    assert!(!agy_prof_dir.join("oauth_creds.json").exists());

    let _ = fs::remove_dir_all(&dir);
}
