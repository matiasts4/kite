    use super::*;
    use crate::chat::threads::{chat_item, upsert_item, THREAD_FIELD_NAMES};

    /// A thread shaped like the one the existing code writes. The projection
    /// test pins it to the canonical field list.
    fn thread_fixture() -> Value {
        json!({
            "schemaVersion": 1,
            "revision": "rev-1",
            "id": "thread-1",
            "profileId": Value::Null,
            "provider": "codex",
            "providerSessionId": Value::Null,
            "title": "First",
            "items": [],
            "plans": [],
            "mode": "acceptEdits",
            "plan": false,
            "model": Value::Null,
            "providerOptions": [],
            "status": "idle",
            "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0 },
            "workspaceId": Value::Null,
            "pinned": false,
            "pendingApproval": Value::Null,
            "createdAtUnixMs": 1_700_000_000_000i64,
            "updatedAtUnixMs": 1_700_000_000_000i64
        })
    }

    fn approval() -> Value {
        json!({
            "id": "approval-1",
            "toolName": "shell",
            "title": "Run a command",
            "detail": Value::Null,
            "risk": "low",
            "impact": "writes a file",
            "status": "pending"
        })
    }

    fn populated_log() -> ThreadEventLog {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).expect("thread log");
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "title", "value": "Renamed" }),
        )
        .unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "status", "value": "running" }),
        )
        .unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("user-1", "user", "do the thing", false) }),
        )
        .unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("assistant-1", "assistant", "working on it", false) }),
        )
        .unwrap();
        log.append(ThreadEventKind::ApprovalOpened, json!({ "approval": approval() }))
            .unwrap();
        log.append(
            ThreadEventKind::ApprovalResolved,
            json!({ "requestId": "approval-1", "decision": "allowOnce" }),
        )
        .unwrap();
        log.append(ThreadEventKind::Lifecycle, json!({ "state": "running" }))
            .unwrap();
        log
    }

    /// A scratch directory under the system temp directory, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "kite-event-log-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_projection_keeps_the_thread_shape_existing_readers_expect() {
        let item = chat_item("assistant-1", "assistant", "hello", false);
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "title", "value": "Renamed" }),
        )
        .unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "status", "value": "running" }),
        )
        .unwrap();
        log.append(ThreadEventKind::ItemUpsert, json!({ "item": item.clone() }))
            .unwrap();

        let mut expected = thread_fixture();
        expected["title"] = json!("Renamed");
        expected["status"] = json!("running");
        upsert_item(&mut expected, &item);

        let projection = log.compatibility_projection();
        assert_eq!(projection, expected);

        let mut projected: Vec<&str> = projection
            .as_object()
            .expect("projection is an object")
            .keys()
            .map(String::as_str)
            .collect();
        projected.sort_unstable();
        let mut canonical: Vec<&str> = THREAD_FIELD_NAMES.to_vec();
        canonical.sort_unstable();
        assert_eq!(projected, canonical);
    }

    #[test]
    fn folding_the_same_log_twice_produces_the_same_thread() {
        let log = populated_log();
        let first = log.fold(&thread_fixture());
        let second = log.fold(&thread_fixture());
        assert_eq!(first, second);
        assert_eq!(log.compatibility_projection(), log.compatibility_projection());

        let dir = TempDir::new("determinism");
        let path = dir.join("thread.json");
        log.save_to(&path).unwrap();
        let loaded = ThreadEventLog::load("thread-1", &path).unwrap();
        assert_eq!(loaded.entries(), log.entries());
        assert_eq!(loaded.compatibility_projection(), log.compatibility_projection());
    }

    #[test]
    fn the_sequence_is_monotonic_and_refuses_a_duplicate_or_a_gap() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        assert_eq!(log.last_sequence(), 1);
        assert_eq!(
            log.append(ThreadEventKind::Field, json!({ "name": "title", "value": "Two" }))
                .unwrap()
                .sequence,
            2
        );

        let before = log.entries().len();
        assert_eq!(
            log.append_at(
                2,
                ThreadEventKind::Field,
                json!({ "name": "title", "value": "Again" })
            )
            .unwrap_err(),
            EventLogError::DuplicateSequence(2)
        );
        assert_eq!(
            log.append_at(
                4,
                ThreadEventKind::Field,
                json!({ "name": "title", "value": "Gap" })
            )
            .unwrap_err(),
            EventLogError::Gap {
                expected: 3,
                found: 4
            }
        );
        assert_eq!(
            log.append_at(0, ThreadEventKind::Field, json!({ "name": "title", "value": "Zero" }))
                .unwrap_err(),
            EventLogError::InvalidPayload("event sequences start at 1".to_string())
        );
        assert_eq!(log.entries().len(), before);
        assert_eq!(log.last_sequence(), 2);
        assert_eq!(log.compatibility_projection()["title"], "Two");

        assert_eq!(
            log.append_at(
                3,
                ThreadEventKind::Field,
                json!({ "name": "title", "value": "Three" })
            )
            .unwrap()
            .sequence,
            3
        );
        assert!(
            log.entries().iter().all(|entry| entry.at_ms > 0),
            "every durable entry carries a timestamp"
        );
    }

    #[test]
    fn replaying_a_command_returns_the_same_receipt_without_appending() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        let item = chat_item("assistant-1", "assistant", "hello", false);
        let payload = json!({ "item": item });

        let first = log
            .append_command(ThreadEventKind::ItemUpsert, "command-1", payload.clone())
            .unwrap();
        let entries = log.entries().len();
        let replay = log
            .append_command(ThreadEventKind::ItemUpsert, "command-1", payload)
            .unwrap();

        assert!(!first.duplicate);
        assert!(replay.duplicate);
        assert_eq!(first.sequence, replay.sequence);
        assert_eq!(log.entries().len(), entries);
        assert_eq!(log.receipt("command-1").unwrap().sequence, first.sequence);
    }

    #[test]
    fn reusing_a_command_id_with_another_payload_is_rejected() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append_command(
            ThreadEventKind::ItemUpsert,
            "command-1",
            json!({ "item": chat_item("assistant-1", "assistant", "hello", false) }),
        )
        .unwrap();
        let entries = log.entries().len();

        let error = log
            .append_command(
                ThreadEventKind::ItemUpsert,
                "command-1",
                json!({ "item": chat_item("assistant-1", "assistant", "different", false) }),
            )
            .unwrap_err();

        assert_eq!(error, EventLogError::CommandConflict("command-1".to_string()));
        assert_eq!(log.entries().len(), entries);
    }

    #[test]
    fn receipts_are_stable_after_reopening_the_store() {
        let dir = TempDir::new("receipts");
        let path = dir.join("thread.json");
        let payload = json!({ "item": chat_item("assistant-1", "assistant", "hello", false) });
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        let first = log
            .append_command(ThreadEventKind::ItemUpsert, "command-1", payload.clone())
            .unwrap();
        log.save_to(&path).unwrap();

        let mut loaded = ThreadEventLog::load("thread-1", &path).unwrap();
        let stored = loaded.receipt("command-1").expect("the receipt survives");
        assert_eq!(stored.sequence, first.sequence);
        assert_eq!(stored.kind, "item.upsert");

        let replay = loaded
            .append_command(ThreadEventKind::ItemUpsert, "command-1", payload)
            .unwrap();
        assert!(replay.duplicate);
        assert_eq!(loaded.entries(), log.entries());
    }

    #[test]
    fn compaction_preserves_the_folded_result_and_the_next_sequence() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        for index in 0..8 {
            log.append(
                ThreadEventKind::Field,
                json!({ "name": "title", "value": format!("title-{index}") }),
            )
            .unwrap();
            log.append(
                ThreadEventKind::ItemUpsert,
                json!({ "item": chat_item(
                    &format!("item-{index}"),
                    "assistant",
                    &format!("text {index}"),
                    false
                ) }),
            )
            .unwrap();
        }
        let before = log.compatibility_projection();
        let frontier = log.last_sequence();
        assert_eq!(log.entries().len(), 17);

        log.compact(3).unwrap();

        assert_eq!(log.compatibility_projection(), before);
        assert_eq!(log.last_sequence(), frontier);
        assert_eq!(log.entries().len(), 4);
        assert_eq!(log.entries()[0].kind, "snapshot");
        assert_eq!(log.entries()[0].sequence, frontier - 3);
        assert_eq!(
            log.entries().last().unwrap().sequence,
            frontier,
            "the tail keeps every retained entry in order"
        );
        assert_eq!(
            log.append(ThreadEventKind::Field, json!({ "name": "title", "value": "after" }))
                .unwrap()
                .sequence,
            frontier + 1
        );
        assert_eq!(log.compatibility_projection()["title"], "after");
    }

    #[test]
    fn compaction_without_a_base_changes_nothing() {
        let mut log = ThreadEventLog::new("thread-1");
        for index in 0..5 {
            log.append(
                ThreadEventKind::Field,
                json!({ "name": "title", "value": format!("title-{index}") }),
            )
            .unwrap();
        }

        assert_eq!(log.compact(1).unwrap_err(), EventLogError::MissingBase);
        assert_eq!(log.entries().len(), 5);
        assert_eq!(log.last_sequence(), 5);
        assert_eq!(log.compact(0).unwrap_err(), EventLogError::InvalidCompactionLimit);
    }

    #[test]
    fn a_bounded_log_compacts_itself_and_keeps_the_same_fold() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture())
            .unwrap()
            .with_compaction_limit(4);
        let mut longest = 0;
        for index in 0..12 {
            log.append(
                ThreadEventKind::Field,
                json!({ "name": "title", "value": format!("title-{index}") }),
            )
            .unwrap();
            longest = longest.max(log.entries().len());
        }

        assert!(longest <= 5, "the log stays bounded to its limit plus one entry");
        assert_eq!(log.entries()[0].kind, "snapshot");
        assert_eq!(log.last_sequence(), 13);
        assert_eq!(log.compatibility_projection()["title"], "title-11");
    }

    #[test]
    fn a_corrupt_store_fails_to_load_without_being_rewritten() {
        let dir = TempDir::new("corrupt");
        let path = dir.join("thread.json");
        let garbage = b"{ not json".to_vec();
        fs::write(&path, &garbage).unwrap();

        let error = ThreadEventLog::load("thread-1", &path).unwrap_err();

        assert!(matches!(error, EventLogError::Corrupt(_)));
        assert_eq!(fs::read(&path).unwrap(), garbage);
    }

    #[test]
    fn a_stored_log_with_a_gap_is_rejected_and_left_alone() {
        let dir = TempDir::new("stored-gap");
        let path = dir.join("thread.json");
        let body = serde_json::to_vec(&json!({
            "schemaVersion": EVENT_LOG_SCHEMA_VERSION,
            "threadId": "thread-1",
            "lastSequence": 3,
            "entries": [
                { "sequence": 1, "kind": "snapshot", "payload": { "thread": thread_fixture() }, "atMs": 10 },
                { "sequence": 3, "kind": "field", "payload": { "name": "title", "value": "three" }, "atMs": 11 }
            ],
            "receipts": []
        }))
        .unwrap();
        fs::write(&path, &body).unwrap();

        let error = ThreadEventLog::load("thread-1", &path).unwrap_err();

        assert!(matches!(error, EventLogError::Corrupt(_)));
        assert_eq!(fs::read(&path).unwrap(), body);
    }

    #[test]
    fn a_failed_write_leaves_the_previous_store_readable() {
        let dir = TempDir::new("failed-write");
        let path = dir.join("thread.json");
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "title", "value": "Saved" }),
        )
        .unwrap();
        log.save_to(&path).unwrap();
        let saved = fs::read(&path).unwrap();

        // The temporary sibling is a directory, so the replace cannot happen.
        fs::create_dir(temp_path(&path)).unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "title", "value": "Not saved" }),
        )
        .unwrap();
        assert!(log.save_to(&path).is_err());

        assert_eq!(fs::read(&path).unwrap(), saved);
        let loaded = ThreadEventLog::load("thread-1", &path).unwrap();
        assert_eq!(loaded.compatibility_projection()["title"], "Saved");
    }

    #[test]
    fn a_legacy_entry_array_migrates_in_memory_and_the_file_is_not_rewritten() {
        let dir = TempDir::new("legacy");
        let path = dir.join("thread.json");
        let legacy = serde_json::to_vec(&json!([
            { "sequence": 1, "kind": "snapshot", "payload": { "thread": thread_fixture() }, "atMs": 10 },
            { "sequence": 2, "kind": "field", "payload": { "name": "title", "value": "Legacy" }, "atMs": 11 }
        ]))
        .unwrap();
        fs::write(&path, &legacy).unwrap();

        let loaded = ThreadEventLog::load("thread-1", &path).unwrap();

        assert_eq!(loaded.entries().len(), 2);
        assert_eq!(loaded.compatibility_projection()["title"], "Legacy");
        assert_eq!(fs::read(&path).unwrap(), legacy);
    }

    #[test]
    fn a_failed_migration_leaves_the_previous_store_untouched() {
        let dir = TempDir::new("migration");
        let path = dir.join("thread.json");
        let broken = serde_json::to_vec(&json!([
            { "sequence": 1, "kind": "field", "payload": { "name": "title", "value": "no time" } }
        ]))
        .unwrap();
        fs::write(&path, &broken).unwrap();

        let error = ThreadEventLog::load("thread-1", &path).unwrap_err();

        assert!(matches!(error, EventLogError::Migration(_)));
        assert_eq!(fs::read(&path).unwrap(), broken);
    }

    #[test]
    fn a_newer_store_is_rejected_without_being_rewritten() {
        let dir = TempDir::new("newer");
        let path = dir.join("thread.json");
        let newer = serde_json::to_vec(&json!({
            "schemaVersion": 99,
            "threadId": "thread-1",
            "lastSequence": 0,
            "entries": [],
            "receipts": []
        }))
        .unwrap();
        fs::write(&path, &newer).unwrap();

        let error = ThreadEventLog::load("thread-1", &path).unwrap_err();

        assert_eq!(error, EventLogError::UnsupportedVersion(99));
        assert_eq!(fs::read(&path).unwrap(), newer);
    }

    #[test]
    fn a_store_belongs_to_one_thread() {
        let dir = TempDir::new("thread-id");
        let path = dir.join("thread.json");
        ThreadEventLog::from_thread(&thread_fixture())
            .unwrap()
            .save_to(&path)
            .unwrap();

        assert_eq!(
            ThreadEventLog::load("thread-2", &path).unwrap_err(),
            EventLogError::ThreadMismatch {
                expected: "thread-2".to_string(),
                found: "thread-1".to_string()
            }
        );

        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        assert!(matches!(
            log.append(
                ThreadEventKind::Snapshot,
                json!({ "thread": { "id": "thread-9" } })
            ),
            Err(EventLogError::ThreadMismatch { .. })
        ));
        assert_eq!(log.last_sequence(), 1);
    }

    #[test]
    fn a_settled_or_unknown_approval_does_not_change_the_projection() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(ThreadEventKind::ApprovalOpened, json!({ "approval": approval() }))
            .unwrap();
        let opened = log.compatibility_projection();
        assert_eq!(opened["status"], "waiting");
        assert_eq!(opened["pendingApproval"]["id"], "approval-1");

        log.append(
            ThreadEventKind::ApprovalResolved,
            json!({ "requestId": "approval-unknown", "decision": "deny" }),
        )
        .unwrap();
        assert_eq!(log.compatibility_projection(), opened);

        log.append(
            ThreadEventKind::ApprovalResolved,
            json!({ "requestId": "approval-1", "decision": "allowOnce" }),
        )
        .unwrap();
        let resolved = log.compatibility_projection();
        assert!(resolved["pendingApproval"].is_null());
        assert_eq!(resolved["status"], "running");

        log.append(
            ThreadEventKind::ApprovalResolved,
            json!({ "requestId": "approval-1", "decision": "deny" }),
        )
        .unwrap();
        assert_eq!(log.compatibility_projection(), resolved);

        assert!(matches!(
            log.append(
                ThreadEventKind::ApprovalResolved,
                json!({ "requestId": "approval-1", "decision": "maybe" })
            ),
            Err(EventLogError::InvalidPayload(_))
        ));
    }

    #[test]
    fn a_provider_exit_settles_approvals_and_keeps_the_prompt() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("user-1", "user", "do the thing", false) }),
        )
        .unwrap();
        log.append(ThreadEventKind::ApprovalOpened, json!({ "approval": approval() }))
            .unwrap();

        log.append(
            ThreadEventKind::Lifecycle,
            json!({ "state": "failed", "code": 1, "reason": "provider exited" }),
        )
        .unwrap();
        let failed = log.compatibility_projection();
        assert!(failed["pendingApproval"].is_null());
        assert_eq!(failed["status"], "error");
        assert_eq!(
            failed["items"][0]["text"], "do the thing",
            "a failed turn keeps the user's prompt readable"
        );
        assert!(log
            .entries()
            .iter()
            .any(|entry| entry.kind == "lifecycle" && entry.payload["state"] == "failed"));

        log.append(ThreadEventKind::Lifecycle, json!({ "state": "interrupted" }))
            .unwrap();
        assert_eq!(log.compatibility_projection()["status"], "idle");
        assert_eq!(log.compatibility_projection(), log.fold(&thread_fixture()));
    }

    #[test]
    fn item_removal_removes_an_item_by_id() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("assistant-1", "assistant", "hello", false) }),
        )
        .unwrap();
        log.append(ThreadEventKind::ItemRemove, json!({ "id": "assistant-1" }))
            .unwrap();

        assert!(log.compatibility_projection()["items"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn recovery_is_idempotent_across_two_loads() {
        let dir = TempDir::new("recovery-idempotent");
        let path = dir.join("thread.json");
        populated_log().save_to(&path).unwrap();
        let snapshot = thread_fixture();

        let first = recover_thread_with_snapshot("thread-1", &path, Some(&snapshot));
        let second = recover_thread_with_snapshot("thread-1", &path, Some(&snapshot));

        assert_eq!(first, second);
        assert_eq!(first.source, RecoverySource::Log);
        assert_eq!(first.events.len(), 8);
        assert_eq!(first.thread["title"], "Renamed");
        assert_eq!(first.thread["status"], "running");
        assert_eq!(first.thread["items"][0]["text"], "do the thing");
        assert!(first.diagnostic.is_none());
    }

    #[test]
    fn a_corrupted_log_falls_back_to_the_snapshot_and_is_left_alone() {
        let dir = TempDir::new("recovery-corrupt");
        let path = dir.join("thread.json");
        let garbage = b"{ not json".to_vec();
        fs::write(&path, &garbage).unwrap();
        let snapshot = thread_fixture();

        let recovered = recover_thread_with_snapshot("thread-1", &path, Some(&snapshot));

        assert_eq!(recovered.source, RecoverySource::Snapshot);
        assert_eq!(recovered.thread, snapshot);
        assert!(recovered.events.is_empty());
        assert!(recovered.diagnostic.is_some());
        assert_eq!(fs::read(&path).unwrap(), garbage);
    }

    #[test]
    fn a_missing_log_falls_back_to_the_snapshot_without_creating_a_file() {
        let dir = TempDir::new("recovery-missing");
        let path = dir.join("thread.json");
        let snapshot = thread_fixture();

        let recovered = recover_thread_with_snapshot("thread-1", &path, Some(&snapshot));

        assert_eq!(recovered.thread, snapshot);
        assert_eq!(recovered.source, RecoverySource::Snapshot);
        assert!(recovered.events.is_empty());
        assert!(recovered.diagnostic.is_none());
        assert!(!path.exists(), "recovery is read-only");
    }

    #[test]
    fn the_fold_and_the_compatibility_snapshot_agree() {
        let snapshot = thread_fixture();
        let log = populated_log();
        let projection = log.compatibility_projection();

        assert_eq!(log.fold(&snapshot), projection);

        let dir = TempDir::new("recovery-agree");
        let path = dir.join("thread.json");
        log.save_to(&path).unwrap();

        let recovered = recover_thread_with_snapshot("thread-1", &path, Some(&snapshot));

        assert_eq!(recovered.thread, log.fold(&snapshot));
        assert_eq!(recovered.thread, projection);
        assert_eq!(recovered.thread["title"], "Renamed");
        assert_eq!(recovered.thread["items"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn the_public_recovery_reads_a_self_contained_log_without_writing() {
        let dir = TempDir::new("recovery-public");
        let path = dir.join("thread.json");
        let log = populated_log();
        log.save_to(&path).unwrap();
        let before = fs::read(&path).unwrap();

        let recovered = recover_thread("thread-1", &path);

        assert_eq!(recovered.source, RecoverySource::Log);
        assert_eq!(recovered.thread, log.compatibility_projection());
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn recovery_reports_only_a_stored_provider_handle() {
        let dir = TempDir::new("recovery-handle");
        let path = dir.join("thread.json");
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "providerSessionId", "value": "provider-session-9" }),
        )
        .unwrap();
        log.save_to(&path).unwrap();

        let recovered = recover_thread_with_snapshot("thread-1", &path, Some(&thread_fixture()));
        assert!(recovered.resume_available());
        assert_eq!(recovered.resume_handle.as_deref(), Some("provider-session-9"));

        let blank = recover_thread_with_snapshot("thread-1", &path, None);
        assert!(blank.resume_available());

        let mut blank_log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        blank_log
            .append(
                ThreadEventKind::Field,
                json!({ "name": "providerSessionId", "value": "   " }),
            )
            .unwrap();
        let blank_path = dir.join("blank.json");
        blank_log.save_to(&blank_path).unwrap();

        let empty = recover_thread_with_snapshot("thread-1", &blank_path, Some(&thread_fixture()));
        assert!(!empty.resume_available());
        assert_eq!(empty.resume_handle, None);
    }
