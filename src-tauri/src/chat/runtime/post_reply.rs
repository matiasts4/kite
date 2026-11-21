//! A dropped connection that arrives after the agent already delivered its reply.
//!
//! Providers retry a failed follow-up request (for example the call that would report a
//! finished subagent back to the agent) several times and then fail the whole turn. When
//! the transcript already ends with the agent's reply, flagging the thread as errored
//! would misreport finished work as failed, so the failure is downgraded to a note.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::chat::threads::chat_item;
use crate::persist::{persist, threads};

use super::state::emit_note_item;

pub const CONNECTION_LOST_AFTER_REPLY_NOTE: &str =
    "Connection to the provider dropped after the reply was delivered. If the reply above looks incomplete, send a message to continue.";

const CONNECTION_MARKERS: &[&str] = &[
    "dial tcp",
    "no such host",
    "connection reset",
    "connection refused",
    "connection aborted",
    "connection lost",
    "network is unreachable",
    "tls handshake timeout",
    "i/o timeout",
    "client.timeout",
    "context deadline exceeded",
    "unexpected eof",
    "broken pipe",
    "temporary failure in name resolution",
    "econnreset",
    "enotfound",
    "etimedout",
    "the stream was interrupted",
    "stream was interrupted",
];

/// True when the failure text describes a transport problem, not a provider verdict.
pub fn is_connection_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    CONNECTION_MARKERS.iter().any(|marker| lower.contains(marker))
}

/// True when the newest meaningful item of the thread is the agent's own reply, with no
/// tool call, command, or non-empty reasoning after it.
pub fn reply_already_delivered(thread: &Value) -> bool {
    let Some(items) = thread.get("items").and_then(Value::as_array) else {
        return false;
    };
    let newest = items.iter().rev().find(|it| {
        let kind = it.get("kind").and_then(Value::as_str);
        if matches!(kind, Some("note" | "notice" | "error")) {
            return false;
        }
        if kind == Some("reasoning")
            && it
                .get("text")
                .and_then(Value::as_str)
                .is_none_or(|text| text.trim().is_empty())
        {
            return false;
        }
        true
    });
    newest.is_some_and(|it| {
        it.get("kind").and_then(Value::as_str) == Some("assistant")
            && it
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
    })
}

fn connection_loss_failure_text(thread: &Value, fallback_error: &str) -> Option<String> {
    let failure_text = match thread.pointer("/turnFailure/kind").and_then(Value::as_str) {
        Some("processError") => thread
            .pointer("/turnFailure/message")
            .and_then(Value::as_str)
            .unwrap_or(fallback_error)
            .to_string(),
        // Usage limits, sign-in problems and CLI usage errors must stay visible.
        Some(_) => return None,
        None => {
            if fallback_error.trim().is_empty() {
                return None;
            }
            fallback_error.to_string()
        }
    };
    if !is_connection_failure(&failure_text) || !reply_already_delivered(thread) {
        return None;
    }
    Some(failure_text)
}

/// Downgrades a connection failure that followed a delivered reply. Returns true when the
/// failure was absorbed, so the caller settles the run as successful.
pub fn absorb_connection_loss_after_reply(thread_id: &str, run_id: &str, error_text: &str) -> bool {
    if thread_id.is_empty() {
        return false;
    }
    {
        let mut items = threads().lock().unwrap();
        let Some(thread) = items
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        else {
            return false;
        };
        if connection_loss_failure_text(thread, error_text).is_none() {
            return false;
        }
        if let Some(obj) = thread.as_object_mut() {
            obj.remove("turnFailure");
        }
    }
    emit_note_item(thread_id, run_id, CONNECTION_LOST_AFTER_REPLY_NOTE);
    persist();
    true
}

/// Idempotently heals an already-persisted thread whose `turnFailure` was a post-reply
/// connection loss, without calling `touch()` so startup migration stays lock-safe.
pub fn heal_persisted_connection_loss_after_reply(thread: &mut Value) -> bool {
    if thread.get("turnFailure").is_none() || connection_loss_failure_text(thread, "").is_none() {
        return false;
    }
    if let Some(obj) = thread.as_object_mut() {
        obj.remove("turnFailure");
    }
    if thread.get("status").and_then(Value::as_str) == Some("error") {
        thread["status"] = json!("idle");
    }
    let already_noted = thread
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .rev()
                .find(|it| it.get("kind").and_then(Value::as_str) == Some("note"))
        })
        .and_then(|it| it.get("text").and_then(Value::as_str))
        == Some(CONNECTION_LOST_AFTER_REPLY_NOTE);
    if !already_noted {
        let note = chat_item(
            &format!("n{}", Uuid::new_v4().simple()),
            "note",
            CONNECTION_LOST_AFTER_REPLY_NOTE,
            false,
        );
        if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
            items.push(note);
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn thread_with(items: Value) -> Value {
        json!({ "id": "t", "items": items })
    }

    #[test]
    fn recognizes_transport_errors_only() {
        let incident = "API error (attempt 5): request failed: Post \"https://x/v1internal:streamGenerateContent?alt=sse\": dial tcp: lookup x: no such host";
        assert!(is_connection_failure(incident));
        assert!(is_connection_failure("read tcp: connection reset by peer"));
        assert!(!is_connection_failure("invalid model selection"));
        assert!(!is_connection_failure("the provider process exited"));
    }

    #[test]
    fn reply_counts_as_delivered_only_when_it_is_the_newest_work() {
        let delivered = thread_with(json!([
            { "kind": "user", "text": "go" },
            { "kind": "tool", "text": "" },
            { "kind": "assistant", "text": "All done." },
            { "kind": "note", "text": "hidden" }
        ]));
        assert!(reply_already_delivered(&delivered));

        let mid_work = thread_with(json!([
            { "kind": "user", "text": "go" },
            { "kind": "assistant", "text": "Running it." },
            { "kind": "tool", "text": "" }
        ]));
        assert!(!reply_already_delivered(&mid_work));

        let no_reply = thread_with(json!([{ "kind": "user", "text": "go" }]));
        assert!(!reply_already_delivered(&no_reply));

        let empty_reply = thread_with(json!([
            { "kind": "user", "text": "go" },
            { "kind": "assistant", "text": "  " }
        ]));
        assert!(!reply_already_delivered(&empty_reply));
    }

    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            crate::chat::threads::remove_thread(&self.0);
        }
    }

    fn seeded_thread(failure: Value) -> (String, Cleanup) {
        let id = format!("post-reply-{}", uuid::Uuid::new_v4().simple());
        let mut thread = crate::chat::threads::blank_thread(&id, None, "T", "antigravity", None);
        thread["status"] = json!("error");
        thread["turnFailure"] = failure;
        thread["items"] = json!([
            { "id": "u1", "kind": "user", "text": "go" },
            { "id": "a1", "kind": "assistant", "text": "All done." }
        ]);
        threads().lock().unwrap().push(thread);
        (id.clone(), Cleanup(id))
    }

    fn thread_snapshot(id: &str) -> Value {
        threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .cloned()
            .unwrap()
    }

    #[test]
    fn connection_loss_after_the_reply_is_absorbed_into_a_note() {
        let (id, _cleanup) = seeded_thread(json!({
            "kind": "processError",
            "message": "API error (attempt 5): dial tcp: lookup x: no such host"
        }));
        assert!(absorb_connection_loss_after_reply(&id, "missing-run", ""));
        let thread = thread_snapshot(&id);
        assert!(thread.get("turnFailure").is_none(), "failure banner must be gone");
        let note = thread["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|it| it["kind"] == "note")
            .expect("a note replaces the failure");
        assert_eq!(note["text"], CONNECTION_LOST_AFTER_REPLY_NOTE);
    }

    #[test]
    fn quota_and_auth_failures_are_never_absorbed() {
        let (id, _cleanup) = seeded_thread(json!({
            "kind": "usageLimit",
            "message": "quota reached, dial tcp mentioned in passing"
        }));
        assert!(!absorb_connection_loss_after_reply(&id, "missing-run", ""));
        assert_eq!(thread_snapshot(&id)["turnFailure"]["kind"], "usageLimit");
    }

    #[test]
    fn whitespace_reasoning_after_reply_does_not_block_absorption() {
        let with_blank_thought = thread_with(json!([
            { "kind": "user", "text": "go" },
            { "kind": "assistant", "text": "All done." },
            { "kind": "reasoning", "text": "   " },
            { "kind": "notice", "text": "antigravity ended the turn with status ERROR" }
        ]));
        assert!(reply_already_delivered(&with_blank_thought));

        let with_real_thought = thread_with(json!([
            { "kind": "user", "text": "go" },
            { "kind": "assistant", "text": "Working on it." },
            { "kind": "reasoning", "text": "Checking remaining files" }
        ]));
        assert!(!reply_already_delivered(&with_real_thought));
    }

    #[test]
    fn heal_persisted_connection_loss_is_idempotent_and_preserves_non_connection_errors() {
        let mut persisted = json!({
            "id": "persisted-post-reply",
            "status": "error",
            "turnFailure": {
                "kind": "processError",
                "exit_code": 1,
                "message": "API error (attempt 5): request failed: Post \"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse\": dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host"
            },
            "items": [
                { "id": "u1", "kind": "user", "text": "go" },
                { "id": "a1", "kind": "assistant", "text": "Final answer." },
                { "id": "n1", "kind": "notice", "text": "antigravity ended the turn with status ERROR" }
            ]
        });

        assert!(heal_persisted_connection_loss_after_reply(&mut persisted));
        assert_eq!(persisted["status"], json!("idle"));
        assert!(persisted.get("turnFailure").is_none());
        let notes: Vec<&Value> = persisted["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|it| it["kind"] == "note")
            .collect();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["text"], CONNECTION_LOST_AFTER_REPLY_NOTE);

        // Second pass must be a no-op.
        assert!(!heal_persisted_connection_loss_after_reply(&mut persisted));

        // Mid-turn connection loss without a delivered reply stays untouched.
        let mut mid_turn = json!({
            "id": "persisted-mid-turn",
            "status": "error",
            "turnFailure": {
                "kind": "processError",
                "message": "dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host"
            },
            "items": [
                { "id": "u1", "kind": "user", "text": "go" },
                { "id": "t1", "kind": "tool", "status": "completed", "text": "read" }
            ]
        });
        assert!(!heal_persisted_connection_loss_after_reply(&mut mid_turn));
        assert_eq!(mid_turn["status"], json!("error"));
        assert!(mid_turn.get("turnFailure").is_some());
    }

    #[test]
    fn treats_stream_interrupted_errors_as_post_reply_connection_loss() {
        let interrupted = "The stream was interrupted. Please continue the task you were working on.";
        assert!(
            is_connection_failure(interrupted),
            "stream-interrupted error must classify as connection failure"
        );

        let mut persisted = json!({
            "id": "persisted-stream-interrupted",
            "status": "error",
            "turnFailure": {
                "kind": "processError",
                "exit_code": 1,
                "message": interrupted
            },
            "items": [
                { "id": "u1", "kind": "user", "text": "go" },
                { "id": "a1", "kind": "assistant", "text": "Completed voice analysis." }
            ]
        });
        assert!(heal_persisted_connection_loss_after_reply(&mut persisted));
        assert_eq!(persisted["status"], json!("idle"));
        assert!(persisted.get("turnFailure").is_none());

        let mut mid_turn = json!({
            "id": "mid-turn-stream-interrupted",
            "status": "error",
            "turnFailure": {
                "kind": "processError",
                "exit_code": 1,
                "message": interrupted
            },
            "items": [
                { "id": "u1", "kind": "user", "text": "go" },
                { "id": "t1", "kind": "tool", "status": "completed", "text": "read" }
            ]
        });
        assert!(!heal_persisted_connection_loss_after_reply(&mut mid_turn));
        assert_eq!(mid_turn["status"], json!("error"));
    }
}
