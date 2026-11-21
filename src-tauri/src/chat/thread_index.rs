use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone)]
pub struct ThreadIndexEntry {
    pub id: String,
    pub title: String,
    pub title_lower: String,
    pub profile_id: Option<String>,
    pub workspace_id: Option<String>,
    pub provider: String,
    pub status: String,
    pub updated_at_unix_ms: i64,
    pub created_at_unix_ms: i64,
    pub archived: bool,
    pub searchable_text: String,
    pub items: Vec<Value>,
}

impl ThreadIndexEntry {
    fn from_thread(thread: &Value) -> Option<Self> {
        let id = thread.get("id").and_then(Value::as_str)?.trim();
        if id.is_empty() {
            return None;
        }
        let title = thread
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Chat")
            .to_string();
        let profile_id = thread
            .get("profileId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let workspace_id = thread
            .get("workspaceId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let provider = thread
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("antigravity")
            .to_string();
        let status = thread
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("idle")
            .to_string();
        let updated_at_unix_ms = thread
            .get("updatedAtUnixMs")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let created_at_unix_ms = thread
            .get("createdAtUnixMs")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let archived = thread
            .get("archivedAtUnixMs")
            .and_then(Value::as_i64)
            .is_some();
        let items = thread
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let title_lower = title.to_lowercase();
        let mut searchable = title_lower.clone();
        for item in &items {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    searchable.push('\n');
                    searchable.push_str(&trimmed.to_lowercase());
                }
            }
        }

        Some(Self {
            id: id.to_string(),
            title,
            title_lower,
            profile_id,
            workspace_id,
            provider,
            status,
            updated_at_unix_ms,
            created_at_unix_ms,
            archived,
            searchable_text: searchable,
            items,
        })
    }

    fn to_summary(&self) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "profileId": self.profile_id,
            "workspaceId": self.workspace_id,
            "provider": self.provider,
            "status": self.status,
            "itemCount": self.items.len(),
            "createdAtUnixMs": self.created_at_unix_ms,
            "updatedAtUnixMs": self.updated_at_unix_ms,
        })
    }
}

#[derive(Default)]
pub struct ThreadSearchIndex {
    entries: HashMap<String, ThreadIndexEntry>,
    seeded: bool,
}

static THREAD_INDEX: OnceLock<Mutex<ThreadSearchIndex>> = OnceLock::new();

fn index_lock() -> &'static Mutex<ThreadSearchIndex> {
    THREAD_INDEX.get_or_init(|| Mutex::new(ThreadSearchIndex::default()))
}

fn ensure_seeded() {
    let already_seeded = index_lock().lock().map(|idx| idx.seeded).unwrap_or(true);
    if already_seeded {
        return;
    }
    // Lock persist::threads() first and drop it before locking THREAD_INDEX
    // to preserve global lock ordering and avoid deadlocks.
    let snapshot: Vec<ThreadIndexEntry> = crate::persist::threads()
        .lock()
        .map(|list| list.iter().filter_map(ThreadIndexEntry::from_thread).collect())
        .unwrap_or_default();

    if let Ok(mut idx) = index_lock().lock() {
        if !idx.seeded {
            for entry in snapshot {
                idx.entries.entry(entry.id.clone()).or_insert(entry);
            }
            idx.seeded = true;
        }
    }
}

pub fn index_thread(thread: &Value) {
    let Some(entry) = ThreadIndexEntry::from_thread(thread) else {
        return;
    };
    if let Ok(mut idx) = index_lock().lock() {
        idx.entries.insert(entry.id.clone(), entry);
    }
}

pub fn remove_from_index(thread_id: &str) {
    let id = thread_id.trim();
    if id.is_empty() {
        return;
    }
    if let Ok(mut idx) = index_lock().lock() {
        idx.entries.remove(id);
    }
}

fn matches_scope(
    entry: &ThreadIndexEntry,
    workspace_id: Option<&str>,
    agent_id: Option<&str>,
) -> bool {
    if entry.archived {
        return false;
    }
    if let Some(ws) = workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
        if entry.workspace_id.as_deref() != Some(ws) {
            return false;
        }
    }
    if let Some(aid) = agent_id.map(str::trim).filter(|s| !s.is_empty()) {
        if entry.profile_id.as_deref() != Some(aid) {
            return false;
        }
    }
    true
}

fn query_threads_internal(
    query: Option<&str>,
    workspace_id: Option<&str>,
    agent_id: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Value {
    ensure_seeded();
    let needle = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
    let effective_limit = limit.clamp(1, 200);

    let mut matched: Vec<ThreadIndexEntry> = index_lock()
        .lock()
        .map(|idx| {
            idx.entries
                .values()
                .filter(|e| matches_scope(e, workspace_id, agent_id))
                .filter(|e| match needle.as_deref() {
                    Some(q) => e.searchable_text.contains(q),
                    None => true,
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    matched.sort_by(|a, b| {
        b.updated_at_unix_ms
            .cmp(&a.updated_at_unix_ms)
            .then_with(|| a.id.cmp(&b.id))
    });

    let total = matched.len();
    let start = cursor.min(total);
    let end = (start + effective_limit).min(total);
    let page: Vec<Value> = matched[start..end].iter().map(ThreadIndexEntry::to_summary).collect();
    let next_cursor = if end < total { Some(end) } else { None };

    let mut out = json!({
        "threads": page,
        "nextCursor": next_cursor,
        "total": total,
    });
    if let Some(q) = query {
        out["query"] = json!(q);
    }
    out
}

pub fn list_threads_paged(
    workspace_id: Option<&str>,
    agent_id: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Value {
    query_threads_internal(None, workspace_id, agent_id, cursor, limit)
}

pub fn search_threads(
    query: &str,
    workspace_id: Option<&str>,
    agent_id: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Value {
    query_threads_internal(Some(query), workspace_id, agent_id, cursor, limit)
}

pub fn read_thread_items_paged(
    thread_id: &str,
    cursor: Option<usize>,
    limit: usize,
) -> Value {
    ensure_seeded();
    let id = thread_id.trim();
    let effective_limit = limit.clamp(1, 200);
    let items_opt = index_lock()
        .lock()
        .ok()
        .and_then(|idx| idx.entries.get(id).map(|e| e.items.clone()));

    let Some(items) = items_opt else {
        return json!({
            "threadId": id,
            "found": false,
            "items": [],
            "nextCursor": Value::Null,
            "totalItems": 0,
        });
    };

    let total_items = items.len();
    let start = cursor.unwrap_or(0).min(total_items);
    let end = (start + effective_limit).min(total_items);
    let page = items[start..end].to_vec();
    let next_cursor = if end < total_items { Some(end) } else { None };

    json!({
        "threadId": id,
        "found": true,
        "items": page,
        "nextCursor": next_cursor,
        "totalItems": total_items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Cleanup(Vec<String>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for id in &self.0 {
                remove_from_index(id);
            }
        }
    }

    #[test]
    fn thread_index_lists_searches_and_pages_items_incrementally() {
        let ws = format!("idx-ws-{}", uuid::Uuid::new_v4().simple());
        let agent = format!("idx-agent-{}", uuid::Uuid::new_v4().simple());
        let t1 = format!("idx-t1-{}", uuid::Uuid::new_v4().simple());
        let t2 = format!("idx-t2-{}", uuid::Uuid::new_v4().simple());
        let t3 = format!("idx-t3-{}", uuid::Uuid::new_v4().simple());
        let _cleanup = Cleanup(vec![t1.clone(), t2.clone(), t3.clone()]);

        index_thread(&json!({
            "id": t1,
            "title": "Auth Migration Plan",
            "profileId": agent,
            "workspaceId": ws,
            "provider": "claude",
            "status": "idle",
            "createdAtUnixMs": 1000,
            "updatedAtUnixMs": 2000,
            "items": [
                { "id": "i1", "kind": "user", "text": "Check oauth tokens" },
                { "id": "i2", "kind": "assistant", "text": "Rotating refresh token" },
                { "id": "i3", "kind": "assistant", "text": "Verified PKCE flow" }
            ]
        }));
        index_thread(&json!({
            "id": t2,
            "title": "UI Polish",
            "profileId": agent,
            "workspaceId": ws,
            "provider": "codex",
            "status": "idle",
            "createdAtUnixMs": 1500,
            "updatedAtUnixMs": 3000,
            "items": [
                { "id": "j1", "kind": "user", "text": "Fix button radius" }
            ]
        }));
        index_thread(&json!({
            "id": t3,
            "title": "Archived Thread",
            "profileId": agent,
            "workspaceId": ws,
            "provider": "claude",
            "status": "idle",
            "archivedAtUnixMs": 2500,
            "createdAtUnixMs": 1000,
            "updatedAtUnixMs": 4000,
            "items": []
        }));

        // List page 1 (limit 1) -> t2 first (updatedAt 3000), archived t3 excluded
        let page1 = list_threads_paged(Some(&ws), Some(&agent), 0, 1);
        assert_eq!(page1["total"], 2);
        assert_eq!(page1["threads"][0]["id"], t2);
        assert_eq!(page1["nextCursor"], 1);

        let page2 = list_threads_paged(Some(&ws), Some(&agent), 1, 1);
        assert_eq!(page2["threads"][0]["id"], t1);
        assert_eq!(page2["nextCursor"], Value::Null);

        // Search matches item text ("PKCE")
        let search = search_threads("pkce", Some(&ws), Some(&agent), 0, 10);
        assert_eq!(search["total"], 1);
        assert_eq!(search["threads"][0]["id"], t1);

        // Paged items read
        let items_p1 = read_thread_items_paged(&t1, Some(0), 2);
        assert_eq!(items_p1["found"], true);
        assert_eq!(items_p1["totalItems"], 3);
        assert_eq!(items_p1["nextCursor"], 2);
        assert_eq!(items_p1["items"].as_array().map(|a| a.len()), Some(2));

        let items_p2 = read_thread_items_paged(&t1, Some(2), 2);
        assert_eq!(items_p2["nextCursor"], Value::Null);
        assert_eq!(items_p2["items"].as_array().map(|a| a.len()), Some(1));
        assert_eq!(items_p2["items"][0]["id"], "i3");
    }
}
