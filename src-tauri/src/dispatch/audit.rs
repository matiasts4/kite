//! Audit rows. Historical imports are records, not live sends.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditRow {
    pub id: String,
    pub op: String,
    pub address: String,
    pub body: String,
    pub status: String,
    pub submitted: bool,
    pub historical: bool,
    pub sender_name: String,
    pub profile_id: String,
    pub created_ms: u64,
}

/// One-shot import of the old mailbox file. Rows are historical and are not resubmitted.
pub fn import_agent_messages(value: &Value) -> Vec<AuditRow> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .map(|row| AuditRow {
            id: row
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("historical")
                .to_string(),
            op: "import".into(),
            address: format!(
                "agent:{}",
                row.get("profileId").and_then(Value::as_str).unwrap_or("")
            ),
            body: row.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
            status: "historical".into(),
            submitted: false,
            historical: true,
            sender_name: row
                .get("senderName")
                .and_then(Value::as_str)
                .unwrap_or("Teammate")
                .to_string(),
            profile_id: row
                .get("profileId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            created_ms: row
                .get("createdAtUnixMs")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn import_does_not_mark_rows_for_resubmit() {
        let rows = import_agent_messages(&json!([
            {
                "id": "m1",
                "profileId": "agent-1",
                "senderName": "Builder",
                "body": "hello",
                "delivered": true,
                "createdAtUnixMs": 10
            }
        ]));
        assert_eq!(rows.len(), 1);
        assert!(rows[0].historical);
        assert!(!rows[0].submitted);
        assert_eq!(rows[0].op, "import");
        assert_eq!(rows[0].body, "hello");
    }
}
