//! Generic native `invoke_subagent` placeholder cards.
//!
//! Antigravity records an `invoke_subagent` tool call as a generic "Subagent" card the
//! moment the call is streamed. The real, transcript-backed subagent is only discovered
//! later, so the same delegation can otherwise show up twice. These helpers pair the
//! placeholder with its discovered subagent so the timeline keeps a single card.

use serde_json::Value;

use crate::acp::strip_mcp_prefix;

const GENERIC_ROLE: &str = "Subagent";
/// Discovered subagents are timestamped from the child transcript, which can trail the
/// streamed tool call by a moment.
const PAIRING_SLACK_MS: i64 = 15_000;

fn item_id(it: &Value) -> &str {
    it.get("id").and_then(Value::as_str).unwrap_or("")
}

fn meta_str<'a>(it: &'a Value, key: &str) -> &'a str {
    it.get("subagentMeta")
        .and_then(|m| m.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn created_at(it: &Value) -> i64 {
    it.get("createdAtUnixMs")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

/// An `invoke_subagent` card that no discovered subagent has claimed yet.
pub(super) fn is_unbound_invoke_placeholder(it: &Value) -> bool {
    let id = item_id(it);
    let is_invoke = it
        .get("toolName")
        .and_then(Value::as_str)
        .is_some_and(|n| strip_mcp_prefix(n, &Value::Null).1 == "invoke_subagent");
    it.get("toolKind").and_then(Value::as_str) == Some("subagent")
        && is_invoke
        && !id.is_empty()
        && meta_str(it, "subagentId") == id
        && meta_str(it, "role") == GENERIC_ROLE
}

/// Index of the unclaimed placeholder a discovered subagent should adopt, preferring one
/// whose prompt matches and otherwise the earliest (placeholders are chronological).
pub(super) fn find_unbound_placeholder_index(items: &[Value], prompt: Option<&str>) -> Option<usize> {
    let wanted = prompt.map(str::trim).filter(|p| !p.is_empty());
    let by_prompt = wanted.and_then(|p| {
        items
            .iter()
            .position(|it| is_unbound_invoke_placeholder(it) && meta_str(it, "prompt").trim() == p)
    });
    by_prompt.or_else(|| items.iter().position(is_unbound_invoke_placeholder))
}

fn is_downgraded_blocked_native_invoke(it: &Value) -> bool {
    let clean_name = super::record::resolve_item_clean_tool_name(it).1;
    let status = it.get("status").and_then(Value::as_str).unwrap_or("");
    let text = it.get("text").and_then(Value::as_str).unwrap_or("").trim();
    clean_name.eq_ignore_ascii_case("invoke_subagent")
        && it.get("toolKind").and_then(Value::as_str) == Some("dynamicToolCall")
        && (status.eq_ignore_ascii_case("failed") || status.eq_ignore_ascii_case("error"))
        && it.get("subagentMeta").is_none()
        && (text.is_empty()
            || text.to_ascii_lowercase().contains("pre-tool hook")
            || text.to_ascii_lowercase().contains("invoke_subagent` is blocked")
            || text.to_ascii_lowercase().contains("invoke_subagent is blocked"))
}

/// A settled, empty placeholder (`toolKind: "subagent"`) that never produced steps, a
/// transcript, or a child thread.
fn is_empty_settled_placeholder(it: &Value) -> bool {
    if super::record::is_unspawned_failed_native_invoke(it) {
        return true;
    }
    let steps = it
        .pointer("/subagentMeta/stepCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    is_unbound_invoke_placeholder(it)
        && matches!(
            meta_str(it, "status"),
            "completed" | "failed" | "killed" | "stopped"
        )
        && steps == 0
        && meta_str(it, "transcriptUri").trim().is_empty()
        && meta_str(it, "childThreadId").trim().is_empty()
}

/// A card backed by a real delegated subagent (`sub_<cid>`, `childThreadId`, or `transcriptUri`).
fn is_discovered_card(it: &Value) -> bool {
    if it.get("toolKind").and_then(Value::as_str) != Some("subagent") {
        return false;
    }
    let id = item_id(it);
    let sid = meta_str(it, "subagentId");
    let ctid = meta_str(it, "childThreadId");
    let uri = meta_str(it, "transcriptUri");
    (id.starts_with("sub_") && !sid.is_empty() && sid != id)
        || !ctid.trim().is_empty()
        || !uri.trim().is_empty()
}

/// Ids of empty placeholders (and downgraded blocked native `invoke_subagent` attempts)
/// superseded by a real delegation card. Pairing is chronological: each real delegation
/// retires at most one matching placeholder, and downgraded attempts only pair with a
/// contemporary or later delegation so prior turns never hide a standalone blocked call.
pub(super) fn superseded_placeholder_ids(items: &[Value]) -> Vec<String> {
    let mut candidates: Vec<(i64, String, bool)> = items
        .iter()
        .filter_map(|it| {
            if is_empty_settled_placeholder(it) {
                Some((created_at(it), item_id(it).to_string(), true))
            } else if is_downgraded_blocked_native_invoke(it) {
                Some((created_at(it), item_id(it).to_string(), false))
            } else {
                None
            }
        })
        .collect();
    if candidates.is_empty() {
        return Vec::new();
    }
    candidates.sort_by_key(|(at, _, _)| *at);
    let mut discovered: Vec<i64> = items
        .iter()
        .filter(|it| is_discovered_card(it))
        .map(created_at)
        .collect();
    discovered.sort_unstable();

    let mut superseded = Vec::new();
    for at in discovered {
        if let Some(pos) = candidates
            .iter()
            .position(|(placeholder_at, _, _)| *placeholder_at <= at + PAIRING_SLACK_MS)
            .or_else(|| candidates.iter().position(|(_, _, allow_any)| *allow_any))
        {
            superseded.push(candidates.remove(pos).1);
        }
    }
    superseded
}

/// Remove placeholders (and their runs) superseded by a real delegation card, returning the
/// retired timeline item IDs and removed `(subagentId, parentToolCallId)` run pairs.
pub(super) fn drop_superseded_placeholders_with_details(
    thread: &mut Value,
) -> (Vec<String>, Vec<(String, String)>) {
    let ids = thread
        .get("items")
        .and_then(Value::as_array)
        .map(|items| superseded_placeholder_ids(items))
        .unwrap_or_default();
    if ids.is_empty() {
        return (Vec::new(), Vec::new());
    }
    if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
        items.retain(|it| !ids.iter().any(|id| id == item_id(it)));
    }
    let mut removed_runs = Vec::new();
    if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
        runs.retain(|r| {
            let sid = r.get("subagentId").and_then(Value::as_str).unwrap_or("");
            let ptc = r
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if ids.iter().any(|id| id == sid || id == ptc) {
                removed_runs.push((sid.to_string(), ptc.to_string()));
                return false;
            }
            true
        });
    }
    (ids, removed_runs)
}

/// Remove placeholders (and their runs) superseded by a discovered subagent. Returns
/// whether the thread changed.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn drop_superseded_placeholders(thread: &mut Value) -> bool {
    let (ids, _) = drop_superseded_placeholders_with_details(thread);
    !ids.is_empty()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::chat::subagents::hydrate_antigravity_subagents_with_logs_dir;
    use crate::chat::threads::blank_thread;

    fn placeholder(id: &str, at: i64) -> Value {
        json!({
            "id": id, "kind": "tool", "toolKind": "subagent", "toolName": "invoke_subagent",
            "title": "Subagent · Subagent", "status": "completed", "createdAtUnixMs": at,
            "subagentMeta": {
                "subagentId": id, "role": "Subagent", "status": "completed",
                "model": "gemini-4-hydrogen", "stepCount": 0
            }
        })
    }

    fn discovered(cid: &str, at: i64) -> Value {
        json!({
            "id": format!("sub_{cid}"), "kind": "tool", "toolKind": "subagent",
            "toolName": "invoke_subagent", "title": "Subagent · Verifier", "status": "failed",
            "createdAtUnixMs": at,
            "subagentMeta": {
                "subagentId": cid, "role": "Verifier", "status": "failed",
                "transcriptUri": "file:///tmp/t.jsonl", "stepCount": 35
            }
        })
    }

    #[test]
    fn discovered_card_retires_the_placeholder_it_duplicates() {
        let mut thread = json!({
            "items": [placeholder("t_call", 1_000), discovered("cid-1", 1_500)],
            "subagentRuns": [
                { "subagentId": "t_call", "parentToolCallId": "t_call", "role": "Subagent" },
                { "subagentId": "cid-1", "parentToolCallId": "sub_cid-1", "role": "Verifier" }
            ]
        });
        assert!(drop_superseded_placeholders(&mut thread));
        let items = thread["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "sub_cid-1");
        let runs = thread["subagentRuns"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["subagentId"], "cid-1");
        assert!(!drop_superseded_placeholders(&mut thread), "second pass is a no-op");
    }

    #[test]
    fn each_discovered_card_retires_at_most_one_placeholder() {
        let items = vec![
            placeholder("t_a", 1_000),
            placeholder("t_b", 2_000),
            discovered("cid-1", 1_200),
        ];
        assert_eq!(superseded_placeholder_ids(&items), vec!["t_a".to_string()]);
    }

    #[test]
    fn placeholder_without_a_discovered_card_is_kept() {
        let items = vec![placeholder("t_alone", 1_000)];
        assert!(superseded_placeholder_ids(&items).is_empty());
    }

    #[test]
    fn placeholder_that_already_ran_is_never_retired() {
        let mut ran = placeholder("t_ran", 1_000);
        ran["subagentMeta"]["stepCount"] = json!(4);
        let items = vec![ran, discovered("cid-1", 1_200)];
        assert!(superseded_placeholder_ids(&items).is_empty());
    }

    #[test]
    fn generic_placeholder_is_adopted_by_prompt_then_by_order() {
        let mut second = placeholder("t_b", 2_000);
        second["subagentMeta"]["prompt"] = json!("Check B");
        let items = vec![placeholder("t_a", 1_000), second];
        assert_eq!(find_unbound_placeholder_index(&items, Some("Check B")), Some(1));
        assert_eq!(find_unbound_placeholder_index(&items, Some("other")), Some(0));
        assert_eq!(find_unbound_placeholder_index(&items, None), Some(0));
        let claimed = vec![discovered("cid-1", 1_000)];
        assert_eq!(find_unbound_placeholder_index(&claimed, None), None);
    }

    #[test]
    fn hydrating_a_roleless_invoke_keeps_a_single_card() {
        let root = std::env::temp_dir().join(format!("kite-agy-ph-{}", uuid::Uuid::new_v4().simple()));
        let logs = root.join("parent").join(".system_generated").join("logs");
        let cid = format!("cid-ph-{}", uuid::Uuid::new_v4().simple());
        let child_logs = root.join(&cid).join(".system_generated").join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::create_dir_all(&child_logs).unwrap();
        let child = child_logs.join("transcript.jsonl");
        std::fs::write(
            &child,
            json!({ "type": "PLANNER_RESPONSE", "created_at": "2026-11-15T12:00:05Z", "content": "Done." })
                .to_string(),
        )
        .unwrap();
        let lines = [
            json!({
                "type": "PLANNER_RESPONSE", "created_at": "2026-11-15T12:00:01Z",
                "tool_calls": [{ "id": "call_1", "name": "invoke_subagent",
                    "args": { "Role": "Verifier", "Prompt": "Check", "Model": "inherit" } }]
            })
            .to_string(),
            json!({
                "type": "TOOL_RESPONSE", "created_at": "2026-11-15T12:00:02Z",
                "content": json!({ "conversationId": cid, "logAbsoluteUri": child.to_string_lossy() }).to_string()
            })
            .to_string(),
        ]
        .join("\n");
        std::fs::write(logs.join("transcript_full.jsonl"), lines).unwrap();

        let mut thread = blank_thread("agy-ph-1", None, "Parent", "antigravity", None);
        thread["model"] = json!("gemini-4-hydrogen");
        thread["providerSessionId"] = json!("parent-session-ph");
        thread["status"] = json!("idle");
        thread["items"] = json!([placeholder("t_call_1", 1_000)]);
        thread["subagentRuns"] = json!([
            { "subagentId": "t_call_1", "parentToolCallId": "t_call_1", "role": "Subagent",
              "status": "completed", "stepCount": 0 }
        ]);

        hydrate_antigravity_subagents_with_logs_dir(&mut thread, Some(&logs));

        let cards: Vec<&Value> = thread["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|it| it["toolKind"] == "subagent")
            .collect();
        assert_eq!(cards.len(), 1, "one delegation must render one card");
        assert_eq!(cards[0]["subagentMeta"]["subagentId"], cid.as_str());
        assert_eq!(cards[0]["subagentMeta"]["role"], "Verifier");
        assert_eq!(thread["subagentRuns"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
