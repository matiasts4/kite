use super::*;
use serde_json::json;
use std::path::Path;

static TEST_LOCK: Mutex<()> = Mutex::new(());

fn with_temp_config(test: impl FnOnce(&Path)) {
    let _lock = TEST_LOCK.lock().unwrap();
    let dir = std::env::temp_dir().join(format!("kite-studio-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    *TEST_CONFIG_DIR.lock().unwrap() = Some(dir.clone());
    struct Clear(PathBuf);
    impl Drop for Clear {
        fn drop(&mut self) {
            *TEST_CONFIG_DIR.lock().unwrap() = None;
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _clear = Clear(dir.clone());
    test(&dir);
}

#[test]
fn older_layout_revision_does_not_replace_stored_layout() {
    let stored = json!({"revision": 4});
    assert!(incoming_layout_revision_accepted(None, &json!({"revision": 0})));
    assert!(!incoming_layout_revision_accepted(Some(&stored), &json!({"revision": 3})));
    assert!(incoming_layout_revision_accepted(Some(&stored), &json!({"revision": 4})));
    assert!(incoming_layout_revision_accepted(Some(&stored), &json!({"revision": 5})));
    assert!(!incoming_layout_revision_accepted(Some(&stored), &json!({})));

    with_temp_config(|_dir| {
        let workspace_id = "a1111111-1111-4111-8111-111111111199";
        let newer = json!({
            "schemaVersion": 2,
            "workspaceId": workspace_id,
            "revision": 2,
            "tabs": [{"id": "new"}],
            "activeTabId": null,
            "fullscreenLeafId": null
        });
        save_workspace_layout(json!({ "layout": newer }));
        let older = json!({
            "schemaVersion": 2,
            "workspaceId": workspace_id,
            "revision": 1,
            "tabs": [{"id": "old"}],
            "activeTabId": null,
            "fullscreenLeafId": null
        });
        save_workspace_layout(json!({ "layout": older }));
        let loaded = load_workspace_layout(json!({ "workspaceId": workspace_id }));
        assert_eq!(loaded["layout"]["revision"], 2);
        assert_eq!(loaded["layout"]["tabs"][0]["id"], "new");
    });
}

#[test]
fn kite_layout_round_trip_without_tauri() {
    with_temp_config(|dir| {
        let workspace_id = "a1111111-1111-4111-8111-111111111111";
        let layout = json!({
            "schemaVersion": 2,
            "workspaceId": workspace_id,
            "tabs": [{ "id": "tab-1", "title": "Terminal" }],
            "activeTabId": "tab-1",
            "fullscreenLeafId": null
        });
        let saved = save_workspace_layout(json!({ "request": { "layout": layout } }));
        assert!(saved.is_null());

        let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("layouts.json")).unwrap()).unwrap();
        assert_eq!(on_disk[workspace_id]["tabs"][0]["title"], "Terminal");

        let loaded = load_workspace_layout(json!({ "workspaceId": workspace_id }));
        assert_eq!(loaded["layout"]["schemaVersion"], 2);
        assert_eq!(loaded["layout"]["workspaceId"], workspace_id);
        assert_eq!(loaded["layout"]["tabs"], layout["tabs"]);
        assert_eq!(loaded["layout"]["activeTabId"], "tab-1");
        assert!(loaded["layout"]["fullscreenLeafId"].is_null());
        assert_eq!(loaded["recoveryNotices"], json!([]));
        assert_eq!(loaded["readOnly"], false);

        let again = load_workspace_layout(json!({ "request": { "workspaceId": workspace_id } }));
        assert_eq!(loaded, again);

        let missing_id = "b2222222-2222-4222-8222-222222222222";
        let missing = load_workspace_layout(json!({ "workspaceId": missing_id }));
        assert_eq!(missing["layout"], empty_layout(missing_id));
        assert_eq!(missing["recoveryNotices"], json!([]));
        assert_eq!(missing["readOnly"], false);
    });
}

#[test]
fn kite_ssh_enrollment_records_endpoint() {
    with_temp_config(|dir| {
        let rejected = [
            json!({ "host": "", "username": "alice", "folder": "/work", "port": 22 }),
            json!({ "host": "   ", "username": "alice", "folder": "/work", "port": 22 }),
            json!({ "host": "example.com", "username": "", "folder": "/work", "port": 22 }),
            json!({ "host": "example.com", "username": "alice", "folder": "", "port": 22 }),
            json!({ "host": "example.com", "username": "alice", "folder": "   ", "port": 22 }),
            json!({ "host": "example.com", "username": "alice", "folder": "/work", "port": 0 }),
            json!({ "host": "example.com", "username": "alice", "folder": "/work", "port": 65536 }),
            json!({ "host": "example.com", "username": "alice", "folder": "/work", "port": -1 }),
        ];
        for request in rejected {
            assert!(connect_ssh_workspace(Some(request)).is_null());
        }
        assert!(!dir.join("ssh-workspaces.json").exists());

        let created = connect_ssh_workspace(Some(json!({
            "request": {
                "host": "example.com",
                "username": "alice",
                "folder": "/work/app",
                "port": 22,
                "chooseKey": false
            }
        })));
        assert_eq!(created["displayName"], "alice@example.com");
        assert_eq!(created["pinned"], false);
        assert_eq!(created["available"], false);
        assert!(created.get("host").is_none());
        assert!(created.get("folder").is_none());
        let created_at = created["createdAtUnixMs"].as_i64().unwrap();
        let now = now_unix_ms();
        assert!((now - created_at).abs() < 10_000);
        assert_ne!(created["displayName"], "SSH Workspace");

        let id = created["id"].as_str().unwrap();
        let on_disk: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("ssh-workspaces.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(on_disk[id]["host"], "example.com");
        assert_eq!(on_disk[id]["username"], "alice");
        assert_eq!(on_disk[id]["port"], 22);
        assert_eq!(on_disk[id]["folder"], "/work/app");

        let reconnected = reconnect_ssh_workspace(Some(json!({ "workspaceId": id })));
        assert_eq!(reconnected, created);
        assert!(reconnect_ssh_workspace(Some(json!({
            "workspaceId": "c3333333-3333-4333-8333-333333333333"
        })))
        .is_null());
        assert!(reconnect_ssh_workspace(None).is_null());
    });
}

#[test]
fn kite_agent_resume_lifecycle() {
    with_temp_config(|_dir| {
        STARTUP_PROMPT_DISMISSED.store(false, std::sync::atomic::Ordering::SeqCst);
        let workspace_id = "d4444444-4444-4444-8444-444444444444";
        let pane_id = "e5555555-5555-4555-8555-555555555555";
        let initial_session_id = "f6666666-6666-4666-8666-666666666666";

        let layout = json!({
            "schemaVersion": 2,
            "workspaceId": workspace_id,
            "tabs": [{
                "id": "tab-1",
                "title": "Agent Tab",
                "root": {
                    "type": "leaf",
                    "id": pane_id,
                    "occupant": {
                        "kind": "terminal",
                        "sessionId": initial_session_id,
                        "title": "Claude Assistant",
                        "engine": "claude"
                    }
                }
            }],
            "activeTabId": "tab-1",
            "fullscreenLeafId": null
        });
        save_workspace_layout(json!({ "request": { "layout": layout } }));

        // By default alwaysResume is true so startup resumes automatically without modal
        let prefs_default = agent_resume_preferences_get(None);
        assert_eq!(prefs_default["alwaysResume"], true);
        let prompt_auto = resume_prompt_get(None);
        assert_eq!(prompt_auto["status"], "quiet");

        // When user opts out of alwaysResume, prompt becomes pending on startup
        agent_resume_preferences_set(Some(json!({ "alwaysResume": false })));
        let prefs_before = agent_resume_preferences_get(None);
        assert_eq!(prefs_before["alwaysResume"], false);

        let prompt = resume_prompt_get(None);
        assert_eq!(prompt["schemaVersion"], 1);
        assert_eq!(prompt["status"], "pending");
        assert_eq!(prompt["total"], 1);
        assert_eq!(prompt["agents"][0]["paneId"], pane_id);
        assert_eq!(prompt["agents"][0]["engine"], "claude");

        // Preferences get & set
        agent_resume_preferences_set(Some(json!({ "alwaysResume": true })));
        let prefs_after = agent_resume_preferences_get(None);
        assert_eq!(prefs_after["alwaysResume"], true);
        agent_resume_preferences_set(Some(json!({ "alwaysResume": false })));

        // History starts empty
        let history_before = agent_pane_history(Some(json!({
            "workspaceId": workspace_id,
            "paneId": pane_id,
            "engine": "claude"
        })));
        assert_eq!(history_before["schemaVersion"], 1);
        assert_eq!(history_before["conversations"].as_array().unwrap().len(), 0);

        // Answer with resumeAll dismisses prompt
        let answered = resume_prompt_answer(Some(json!({
            "choice": "resumeAll",
            "alwaysResume": false
        })));
        assert_eq!(answered["status"], "quiet");
        let prompt_after = resume_prompt_get(None);
        assert_eq!(prompt_after["status"], "quiet");

        // Choice "fresh" archives current key and creates a fresh conversation
        let choice_fresh = agent_pane_resume_choice(Some(json!({
            "workspaceId": workspace_id,
            "paneId": pane_id,
            "engine": "claude",
            "choice": { "kind": "fresh" }
        })));
        assert_eq!(choice_fresh["changed"], true);

        // History now has the initial conversation archived
        let history_after = agent_pane_history(Some(json!({
            "workspaceId": workspace_id,
            "paneId": pane_id,
            "engine": "claude"
        })));
        let convs = history_after["conversations"].as_array().unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0]["key"], initial_session_id);

        // Can resume the previous conversation
        let choice_previous = agent_pane_resume_choice(Some(json!({
            "workspaceId": workspace_id,
            "paneId": pane_id,
            "engine": "claude",
            "choice": { "kind": "previous", "key": initial_session_id }
        })));
        assert_eq!(choice_previous["changed"], true);
    });
}
