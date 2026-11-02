use crate::quota::*;

#[test]
fn test_fetch_grok_quota() {
    let q = fetch_grok_quota();
    println!("GROK RESULT: is_available={}, is_auth={}, error={:?}, meta={:?}", q.is_available, q.is_auth, q.error, q.metadata);
    assert!(q.is_available);
    assert!(q.is_auth);
}

#[test]
fn test_fetch_antigravity_quota() {
    let q = fetch_antigravity_quota();
    println!("ANTIGRAVITY RESULT: is_available={}, is_auth={}, remaining={}%", q.is_available, q.is_auth, q.primary_remaining_percent);
    println!("ANTIGRAVITY EMAIL: {:?}", q.metadata.get("email"));
    assert!(q.is_available);
    assert!(q.is_auth);
    assert!(q.metadata.get("email").is_some(), "Expected authenticated user email to be present");
}

#[test]
fn test_fetch_qoder_quota() {
    let q = fetch_qoder_quota();
    println!("QODER RESULT: is_available={}, is_auth={}, remaining={}%", q.is_available, q.is_auth, q.primary_remaining_percent);
    if q.is_available {
        assert!(q.is_auth);
    }
}

#[test]
fn test_fetch_cursor_quota() {
    let q = fetch_cursor_quota();
    println!("CURSOR RESULT: is_available={}, is_auth={}, error={:?}, meta={:?}, windows={:?}", q.is_available, q.is_auth, q.error, q.metadata, q.windows);
    assert!(q.is_available);
}

#[test]
fn test_all_quotas() {
    let val = get_subscription_quotas_direct(None, Some(true));
    println!("ALL QUOTAS:\n{}", serde_json::to_string_pretty(&val).unwrap());
}
