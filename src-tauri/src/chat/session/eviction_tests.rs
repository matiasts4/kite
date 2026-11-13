use super::*;

use super::*;

    fn make_spec(thread_id: &str, driver: &str, resume_handle: Option<&str>) -> SessionSpec {
        SessionSpec {
            thread_id: thread_id.to_string(),
            driver: driver.to_string(),
            connection_id: Some("conn-1".to_string()),
            working_directory: Some("E:/kite".to_string()),
            mode: SessionMode::Persistent,
            recipe: None,
            resume_handle: resume_handle.map(String::from),
            extra_env: Vec::new(),
        }
    }

    #[test]
    fn evict_provider_sessions_stops_idle_antigravity_and_clears_resume_handles() {
        let mut manager = SessionManager::new();

        let agy_idle_t = ScriptedTransport::new().with_resume_handle("handle-agy-1");
        manager
            .attach(
                make_spec("thread-agy-idle", "agy", Some("handle-agy-1")),
                Box::new(agy_idle_t.clone()),
            )
            .unwrap();
        manager
            .send_turn("thread-agy-idle", "cmd-1", "hola")
            .unwrap();
        agy_idle_t.script(TransportEvent::TurnEnded);
        manager.poll("thread-agy-idle").unwrap();
        assert_eq!(
            manager.status("thread-agy-idle").unwrap().state,
            SessionState::Idle
        );

        let antigravity_resumable_t = ScriptedTransport::new().with_resume_handle("handle-agy-2");
        manager
            .attach(
                make_spec("thread-agy-alias", "antigravity", Some("handle-agy-2")),
                Box::new(antigravity_resumable_t.clone()),
            )
            .unwrap();
        manager.start("thread-agy-alias").unwrap();
        manager
            .reap_session("thread-agy-alias")
            .expect("reap second session");
        assert_eq!(
            manager.status("thread-agy-alias").unwrap().resume_handle.as_deref(),
            Some("handle-agy-2")
        );

        let codex_t = ScriptedTransport::new().with_resume_handle("handle-codex");
        manager
            .attach(
                make_spec("thread-codex", "codex", Some("handle-codex")),
                Box::new(codex_t.clone()),
            )
            .unwrap();
        manager.send_turn("thread-codex", "cmd-2", "ping").unwrap();
        codex_t.script(TransportEvent::TurnEnded);
        manager.poll("thread-codex").unwrap();

        let evicted = manager.evict_provider_sessions("antigravity");
        assert!(evicted.contains(&"thread-agy-idle".to_string()));
        assert!(evicted.contains(&"thread-agy-alias".to_string()));
        assert!(!evicted.contains(&"thread-codex".to_string()));

        assert_eq!(
            manager.status("thread-agy-idle").unwrap().state,
            SessionState::Reaped
        );
        assert_eq!(manager.status("thread-agy-idle").unwrap().resume_handle, None);
        assert_eq!(manager.status("thread-agy-alias").unwrap().resume_handle, None);
        assert_eq!(agy_idle_t.stop_count(), 1);

        // Unrelated provider must remain warm and keep its handle.
        assert_eq!(manager.status("thread-codex").unwrap().state, SessionState::Idle);
        assert_eq!(
            manager.status("thread-codex").unwrap().resume_handle.as_deref(),
            Some("handle-codex")
        );
        assert_eq!(codex_t.stop_count(), 0);
    }

    #[test]
    fn evict_provider_sessions_clears_handle_without_killing_active_running_turn() {
        let mut manager = SessionManager::new();
        let active_t = ScriptedTransport::new().with_resume_handle("handle-active");
        manager
            .attach(
                make_spec("thread-active", "agy", Some("handle-active")),
                Box::new(active_t.clone()),
            )
            .unwrap();
        manager.send_turn("thread-active", "cmd-live", "stream").unwrap();
        assert_eq!(
            manager.status("thread-active").unwrap().state,
            SessionState::Running
        );

        let evicted = manager.evict_provider_sessions("agy");
        assert!(!evicted.contains(&"thread-active".to_string()));
        assert_eq!(
            manager.status("thread-active").unwrap().state,
            SessionState::Running
        );
        assert_eq!(manager.status("thread-active").unwrap().resume_handle, None);
        assert_eq!(active_t.stop_count(), 0);
    }
