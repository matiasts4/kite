use serde_json::{json, Value};

use super::*;

fn step(id: &str, text: &str) -> Value {
    json!({ "id": id, "kind": "tool", "title": "read_file", "text": text, "status": "completed" })
}

fn run_with_items(subagent_id: &str, child: Option<&str>, uri: Option<&str>, status: &str, n: usize) -> Value {
    let items: Vec<Value> = (0..n).map(|i| step(&format!("{subagent_id}-s{i}"), "payload")).collect();
    json!({
        "subagentId": subagent_id,
        "parentToolCallId": subagent_id,
        "childThreadId": child,
        "transcriptUri": uri,
        "role": "explorer",
        "status": status,
        "stepCount": 0,
        "items": items,
        "updatedAtUnixMs": 10,
    })
}

#[test]
fn project_thread_for_ipc_strips_items_only_from_externally_backed_runs() {
    let thread = json!({
        "id": "t-parent",
        "items": [{ "id": "keep", "kind": "user", "text": "hi" }],
        "subagentRuns": [
            run_with_items("by-child", Some("child-1"), None, "completed", 4),
            run_with_items("by-uri", None, Some("file:///tmp/x.jsonl"), "running", 3),
            run_with_items("inline", None, None, "running", 2),
        ],
    });

    let projected = project_thread_for_ipc(thread);
    let runs = projected["subagentRuns"].as_array().unwrap();

    assert_eq!(runs[0]["items"].as_array().unwrap().len(), 0);
    assert_eq!(runs[0]["stepCount"], 4, "stepCount must survive so cards still report progress");
    assert_eq!(runs[0]["itemsOmitted"], true);
    assert_eq!(runs[1]["items"].as_array().unwrap().len(), 0);
    assert_eq!(runs[2]["items"].as_array().unwrap().len(), 2, "inline runs keep their only copy");
    assert!(runs[2].get("itemsOmitted").is_none());
    assert_eq!(projected["items"].as_array().unwrap().len(), 1, "parent transcript untouched");
}

#[test]
fn run_update_payloads_are_slimmed_without_touching_the_source_run() {
    let run = run_with_items("sub-a", Some("child-a"), None, "running", 5);
    let mut payload = json!({ "kind": "subagentRunUpdated", "threadId": "t", "run": run.clone() });
    super::events::emit_slim_for_test(&mut payload);

    assert_eq!(payload["run"]["items"].as_array().unwrap().len(), 0);
    assert_eq!(payload["run"]["stepCount"], 5);
    assert_eq!(run["items"].as_array().unwrap().len(), 5);

    let mut steps = json!({ "kind": "subagentStepsUpdated", "threadId": "t", "items": [step("x", "y")] });
    super::events::emit_slim_for_test(&mut steps);
    assert_eq!(steps["items"].as_array().unwrap().len(), 1, "only run updates are slimmed");
}

#[test]
fn delta_step_items_emit_only_new_or_changed_steps_and_reset_on_settle() {
    let tid = "delta-thread";
    let sid = "delta-sub";
    let first = vec![step("a", "1"), step("b", "1")];
    assert_eq!(delta_step_items(tid, sid, &first, false).len(), 2);

    let same = vec![step("a", "1"), step("b", "1")];
    assert_eq!(delta_step_items(tid, sid, &same, false).len(), 0, "unchanged steps are not re-sent");

    let grown = vec![step("a", "1"), step("b", "2"), step("c", "1")];
    let delta = delta_step_items(tid, sid, &grown, true);
    let ids: Vec<&str> = delta.iter().filter_map(|i| i["id"].as_str()).collect();
    assert_eq!(ids, vec!["b", "c"]);

    let after_settle = delta_step_items(tid, sid, &grown, false);
    assert_eq!(after_settle.len(), 3, "settled runs drop fingerprints so a later run starts clean");
    let _ = delta_step_items(tid, sid, &grown, true);
}

#[test]
fn compaction_drops_duplicated_items_only_when_child_thread_persists_them() {
    let mut all = vec![
        json!({
            "id": "parent",
            "subagentRuns": [
                run_with_items("done-backed", Some("child-ok"), None, "completed", 3),
                run_with_items("done-orphan", Some("child-missing"), None, "completed", 3),
                run_with_items("still-running", Some("child-ok"), None, "running", 3),
                run_with_items("done-uri", Some("child-ok"), Some("file:///tmp/t.jsonl"), "completed", 3),
            ],
        }),
        json!({ "id": "child-ok", "items": [step("c1", "child step")] }),
    ];

    assert!(compact_settled_child_backed_run_items(&mut all, "parent"));
    let runs = all[0]["subagentRuns"].as_array().unwrap();
    assert_eq!(runs[0]["items"].as_array().unwrap().len(), 0);
    assert_eq!(runs[0]["stepCount"], 3);
    assert!(runs[0].get("itemsOmitted").is_none(), "compaction must not persist the IPC marker");
    assert_eq!(runs[1]["items"].as_array().unwrap().len(), 3, "child thread missing: keep the only copy");
    assert_eq!(runs[2]["items"].as_array().unwrap().len(), 3, "running runs keep accumulating items");
    assert_eq!(runs[3]["items"].as_array().unwrap().len(), 3, "transcript-backed runs are left to transcript sync");

    assert!(!compact_settled_child_backed_run_items(&mut all, "parent"), "second pass is a no-op");
}

#[test]
fn merge_same_subagent_id_runs_keeps_the_most_advanced_record_and_fills_gaps() {
    let mut placeholder = run_with_items("dup", Some("child-d"), None, "running", 0);
    placeholder["model"] = json!("gemini");
    placeholder["updatedAtUnixMs"] = json!(99);
    placeholder["latestActivity"] = json!("later activity");
    let mut full = run_with_items("dup", Some("child-d"), None, "completed", 4);
    full["stepCount"] = json!(4);
    let other = run_with_items("solo", Some("child-s"), None, "completed", 1);

    let mut runs = vec![placeholder, other, full];
    merge_same_subagent_id_runs(&mut runs);

    assert_eq!(runs.len(), 2);
    let dup = runs.iter().find(|r| r["subagentId"] == "dup").unwrap();
    assert_eq!(dup["items"].as_array().unwrap().len(), 4);
    assert_eq!(dup["model"], "gemini", "missing fields are filled from the other record");
    assert_eq!(dup["latestActivity"], "later activity", "newer lifecycle fields win");
    assert_eq!(dup["status"], "completed", "a newer placeholder never resurrects a settled run");
    assert_eq!(runs[0]["subagentId"], "dup", "first-seen order is preserved");
}
