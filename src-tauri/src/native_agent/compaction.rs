//! Two-stage token-budget compaction for Native Fast Lane message histories (`S4`).
//!
//! - **Stage 1**: Above 75% of `token_budget`, keeps the most recent turns
//!   untouched and replaces older oversized `NativeRole::Tool` outputs
//!   (> 1,200 chars) with deterministic excerpt/hash stubs while preserving
//!   `tool_call_id`.
//! - **Stage 2**: If still above 75% of `token_budget`, collapses the oldest
//!   non-system exchanges into a single `[Compacted Conversation Summary]`
//!   recap message while keeping system messages, the latest 2 turns, and
//!   `Assistant(tool_calls) -> Tool` pairing intact.

use super::types::{NativeMessage, NativeRole};

/// Trigger compaction once estimated conversation tokens exceed 75% of budget.
pub const COMPACTION_THRESHOLD_RATIO: f64 = 0.75;

const STAGE1_TOOL_OUTPUT_CHAR_THRESHOLD: usize = 1_200;
const STAGE1_HEAD_CHARS: usize = 200;
const STAGE1_TAIL_CHARS: usize = 120;
const COMPACTED_TOOL_PREFIX: &str = "[compacted tool output ";
const COMPACTED_SUMMARY_PREFIX: &str = "[Compacted Conversation Summary]";
const STAGE2_MAX_BULLETS: usize = 12;
const STAGE2_BULLET_EXCERPT_CHARS: usize = 140;

/// Deterministic fast token estimate across all messages in `messages`.
pub fn estimate_tokens(messages: &[NativeMessage]) -> usize {
    messages.iter().map(estimate_message_tokens).sum()
}

fn estimate_message_tokens(msg: &NativeMessage) -> usize {
    let mut tokens = 4usize;
    tokens += kite_ctx::tokens::estimate_tokens(&msg.content);
    if let Some(id) = msg.tool_call_id.as_deref() {
        tokens += kite_ctx::tokens::estimate_tokens(id) + 2;
    }
    for call in &msg.tool_calls {
        tokens += 4
            + kite_ctx::tokens::estimate_tokens(&call.id)
            + kite_ctx::tokens::estimate_tokens(&call.name)
            + kite_ctx::tokens::estimate_tokens(&call.arguments);
    }
    tokens
}

fn threshold_for_budget(token_budget: usize) -> usize {
    ((token_budget as f64) * COMPACTION_THRESHOLD_RATIO) as usize
}

fn is_summary_recap(msg: &NativeMessage) -> bool {
    msg.content.trim_start().starts_with(COMPACTED_SUMMARY_PREFIX)
}

fn compact_tool_stub(tool_call_id: Option<&str>, raw: &str) -> String {
    let total_chars = raw.chars().count();
    let total_lines = raw.lines().count().max(1);
    let digest = kite_ctx::tokens::short_hash(raw);
    let head: String = raw.chars().take(STAGE1_HEAD_CHARS).collect();
    let tail: String = raw
        .chars()
        .skip(total_chars.saturating_sub(STAGE1_TAIL_CHARS))
        .collect();
    format!(
        "{COMPACTED_TOOL_PREFIX}id={} sha={} lines={} chars={}]\n{}\n...\n{}",
        tool_call_id.unwrap_or("unknown"),
        digest,
        total_lines,
        total_chars,
        head.trim_end(),
        tail.trim_start()
    )
}

fn stage1_protected_start(messages: &[NativeMessage]) -> usize {
    let user_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == NativeRole::User && !is_summary_recap(m))
        .map(|(idx, _)| idx)
        .collect();

    if user_indices.len() >= 3 {
        return user_indices[user_indices.len() - 2];
    }
    if user_indices.len() == 2 {
        return user_indices[1];
    }

    let assistant_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == NativeRole::Assistant)
        .map(|(idx, _)| idx)
        .collect();

    if assistant_indices.len() >= 2 {
        return assistant_indices[assistant_indices.len() - 1];
    }

    messages.len()
}

fn stage2_protected_start(dialogue: &[NativeMessage]) -> usize {
    let user_indices: Vec<usize> = dialogue
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == NativeRole::User && !is_summary_recap(m))
        .map(|(idx, _)| idx)
        .collect();

    if user_indices.len() >= 3 {
        return user_indices[user_indices.len() - 2];
    }

    let assistant_indices: Vec<usize> = dialogue
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == NativeRole::Assistant)
        .map(|(idx, _)| idx)
        .collect();

    if assistant_indices.len() >= 3 {
        return assistant_indices[assistant_indices.len() - 2];
    }

    0
}

fn single_line_excerpt(raw: &str, max_chars: usize) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = collapsed.chars().count();
    if count <= max_chars {
        return collapsed;
    }
    let keep = max_chars.saturating_sub(3);
    let mut clipped: String = collapsed.chars().take(keep).collect();
    clipped.push_str("...");
    clipped
}

fn build_compacted_summary(collapsed: &[NativeMessage]) -> NativeMessage {
    let mut lines = vec![format!(
        "{COMPACTED_SUMMARY_PREFIX} ({} earlier messages collapsed)",
        collapsed.len()
    )];

    let mut bullet_count = 0usize;
    for msg in collapsed {
        if bullet_count >= STAGE2_MAX_BULLETS {
            let remaining = collapsed.len().saturating_sub(bullet_count);
            if remaining > 0 {
                lines.push(format!("- ... ({remaining} additional messages omitted)"));
            }
            break;
        }
        let role_label = match msg.role {
            NativeRole::System => "System",
            NativeRole::User => "User",
            NativeRole::Assistant => "Assistant",
            NativeRole::Tool => "Tool",
        };
        let body = if !msg.content.trim().is_empty() {
            single_line_excerpt(&msg.content, STAGE2_BULLET_EXCERPT_CHARS)
        } else if !msg.tool_calls.is_empty() {
            let names: Vec<&str> = msg.tool_calls.iter().map(|tc| tc.name.as_str()).collect();
            format!("called tools: {}", names.join(", "))
        } else {
            "(empty)".to_string()
        };
        if let Some(id) = msg.tool_call_id.as_deref() {
            lines.push(format!("- {role_label} [{id}]: {body}"));
        } else {
            lines.push(format!("- {role_label}: {body}"));
        }
        bullet_count += 1;
    }

    NativeMessage {
        role: NativeRole::User,
        content: lines.join("\n"),
        tool_call_id: None,
        tool_calls: Vec::new(),
    }
}

/// Applies 2-stage token-budget compaction in-place when `estimate_tokens(messages)`
/// exceeds 75% of `token_budget`. Returns `true` if `messages` was modified.
pub fn compact_messages(messages: &mut Vec<NativeMessage>, token_budget: usize) -> bool {
    if token_budget == 0 || messages.is_empty() {
        return false;
    }
    let threshold = threshold_for_budget(token_budget);
    if estimate_tokens(messages) <= threshold {
        return false;
    }

    let mut changed = false;

    // Stage 1: Compact older large tool outputs (> 1,200 chars) while preserving recent turns.
    let stage1_keep_from = stage1_protected_start(messages);
    for msg in messages.iter_mut().take(stage1_keep_from) {
        if msg.role == NativeRole::Tool
            && !msg.content.starts_with(COMPACTED_TOOL_PREFIX)
            && msg.content.chars().count() > STAGE1_TOOL_OUTPUT_CHAR_THRESHOLD
        {
            msg.content = compact_tool_stub(msg.tool_call_id.as_deref(), &msg.content);
            changed = true;
        }
    }

    if estimate_tokens(messages) <= threshold {
        return changed;
    }

    // Stage 2: Collapse oldest non-system dialogue/tool exchanges into a single recap message,
    // preserving explicit system prompts and the latest 2 turns (never splitting tool pairs).
    let mut system_msgs: Vec<NativeMessage> = Vec::new();
    let mut dialogue: Vec<NativeMessage> = Vec::new();
    for msg in messages.drain(..) {
        if msg.role == NativeRole::System && !is_summary_recap(&msg) {
            system_msgs.push(msg);
        } else {
            dialogue.push(msg);
        }
    }

    let keep_from = stage2_protected_start(&dialogue);
    if keep_from > 0 && keep_from < dialogue.len() {
        let summary_msg = build_compacted_summary(&dialogue[..keep_from]);
        let kept_tail = dialogue.split_off(keep_from);
        messages.extend(system_msgs);
        messages.push(summary_msg);
        messages.extend(kept_tail);
        changed = true;
    } else {
        messages.extend(system_msgs);
        messages.extend(dialogue);
    }

    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_agent::types::NativeToolCall;

    fn msg(role: NativeRole, content: &str) -> NativeMessage {
        NativeMessage {
            role,
            content: content.to_string(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    fn tool_call_msg(calls: Vec<(&str, &str, &str)>) -> NativeMessage {
        NativeMessage {
            role: NativeRole::Assistant,
            content: String::new(),
            tool_call_id: None,
            tool_calls: calls
                .into_iter()
                .map(|(id, name, args)| NativeToolCall {
                    id: id.to_string(),
                    name: name.to_string(),
                    arguments: args.to_string(),
                })
                .collect(),
        }
    }

    fn tool_result_msg(id: &str, content: &str) -> NativeMessage {
        NativeMessage {
            role: NativeRole::Tool,
            content: content.to_string(),
            tool_call_id: Some(id.to_string()),
            tool_calls: Vec::new(),
        }
    }

    #[test]
    fn noop_when_within_75_percent_budget() {
        let mut messages = vec![
            msg(NativeRole::System, "You are concise."),
            msg(NativeRole::User, "Hello"),
            msg(NativeRole::Assistant, "Hi there!"),
        ];
        let before = messages.clone();
        let tokens = estimate_tokens(&messages);
        let budget = (tokens * 2).max(100);
        assert!(!compact_messages(&mut messages, budget));
        assert_eq!(messages, before);
    }

    #[test]
    fn stage1_compacts_older_large_tool_outputs_and_preserves_recent_turns_and_ids() {
        let large_old = "line_data_alpha ".repeat(160); // ~2560 chars (> 1200)
        let large_recent = "line_data_recent ".repeat(140); // ~2380 chars (> 1200)
        assert!(large_old.chars().count() > 1_200);
        assert!(large_recent.chars().count() > 1_200);

        let mut messages = vec![
            msg(NativeRole::System, "System rules"),
            msg(NativeRole::User, "Turn 1"),
            tool_call_msg(vec![("call_old_1", "read_file", r#"{"path":"a.rs"}"#)]),
            tool_result_msg("call_old_1", &large_old),
            msg(NativeRole::Assistant, "Done turn 1."),
            msg(NativeRole::User, "Turn 2"),
            tool_call_msg(vec![("call_recent_2", "read_file", r#"{"path":"b.rs"}"#)]),
            tool_result_msg("call_recent_2", &large_recent),
            msg(NativeRole::User, "Turn 3"),
            msg(NativeRole::Assistant, "Working on turn 3."),
        ];

        let initial_tokens = estimate_tokens(&messages);
        // Set budget so initial > 75% (triggers Stage 1), while after compacting `call_old_1`
        // tokens drop safely below 75% (so Stage 2 is NOT needed and Turn 2 stays intact).
        let budget = initial_tokens + 100;
        assert!(initial_tokens > threshold_for_budget(budget));

        assert!(compact_messages(&mut messages, budget));
        assert!(estimate_tokens(&messages) <= threshold_for_budget(budget));

        // Older tool output was compacted while preserving its tool_call_id
        let old_tool = &messages[3];
        assert_eq!(old_tool.role, NativeRole::Tool);
        assert_eq!(old_tool.tool_call_id.as_deref(), Some("call_old_1"));
        assert!(old_tool.content.starts_with("[compacted tool output id=call_old_1"));
        assert!(old_tool.content.chars().count() < 600);

        // Recent turn 2 tool output was untouched
        let recent_tool = &messages[7];
        assert_eq!(recent_tool.tool_call_id.as_deref(), Some("call_recent_2"));
        assert_eq!(recent_tool.content, large_recent);

        // Stage 2 did not run
        assert!(!messages.iter().any(is_summary_recap));
    }

    #[test]
    fn stage2_collapses_oldest_turns_preserving_system_and_latest_two_turns() {
        let block = "detailed conversation context ".repeat(20); // ~600 chars, under 1200
        let mut messages = vec![
            msg(NativeRole::System, "Critical system directive."),
            msg(NativeRole::User, &format!("U1 {block}")),
            msg(NativeRole::Assistant, &format!("A1 {block}")),
            msg(NativeRole::User, &format!("U2 {block}")),
            msg(NativeRole::Assistant, &format!("A2 {block}")),
            msg(NativeRole::User, "U3 latest-2"),
            msg(NativeRole::Assistant, "A3 latest-2"),
            msg(NativeRole::User, "U4 latest-1"),
            msg(NativeRole::Assistant, "A4 latest-1"),
        ];

        let before_tokens = estimate_tokens(&messages);
        let budget = before_tokens / 2; // Tight budget forcing Stage 2
        assert!(compact_messages(&mut messages, budget));

        // System message preserved first
        assert_eq!(messages[0].role, NativeRole::System);
        assert_eq!(messages[0].content, "Critical system directive.");

        // Summary message inserted
        assert!(messages[1].content.starts_with(COMPACTED_SUMMARY_PREFIX));
        assert!(messages[1].content.contains("U1"));
        assert!(messages[1].content.contains("A2"));

        // Latest 2 turns preserved verbatim at the tail
        assert_eq!(messages.len(), 6);
        assert_eq!(messages[2].content, "U3 latest-2");
        assert_eq!(messages[3].content, "A3 latest-2");
        assert_eq!(messages[4].content, "U4 latest-1");
        assert_eq!(messages[5].content, "A4 latest-1");
        assert!(estimate_tokens(&messages) < before_tokens);
    }

    #[test]
    fn stage2_single_user_react_loop_preserves_tool_pairing() {
        let filler = "step trace output ".repeat(30);
        let mut messages = vec![
            msg(NativeRole::System, "Sys"),
            msg(NativeRole::User, "Solve task"),
            tool_call_msg(vec![("c1", "grep_search", "{}")]),
            tool_result_msg("c1", &filler),
            tool_call_msg(vec![("c2", "read_file", "{}")]),
            tool_result_msg("c2", &filler),
            tool_call_msg(vec![("c3", "read_file", "{}")]),
            tool_result_msg("c3", "kept-3"),
            tool_call_msg(vec![("c4", "edit_file", "{}")]),
            tool_result_msg("c4", "kept-4"),
        ];

        let before_tokens = estimate_tokens(&messages);
        assert!(compact_messages(&mut messages, before_tokens / 2));

        assert_eq!(messages[0].role, NativeRole::System);
        assert_eq!(messages[1].role, NativeRole::User);
        assert!(messages[1].content.starts_with(COMPACTED_SUMMARY_PREFIX));

        // Kept tail must start on an Assistant message (never an orphaned Tool message)
        assert_eq!(messages[2].role, NativeRole::Assistant);
        assert_eq!(messages[2].tool_calls[0].id, "c3");
        assert_eq!(messages[3].role, NativeRole::Tool);
        assert_eq!(messages[3].tool_call_id.as_deref(), Some("c3"));
        assert_eq!(messages[4].role, NativeRole::Assistant);
        assert_eq!(messages[4].tool_calls[0].id, "c4");
        assert_eq!(messages[5].role, NativeRole::Tool);
        assert_eq!(messages[5].tool_call_id.as_deref(), Some("c4"));
    }
}
