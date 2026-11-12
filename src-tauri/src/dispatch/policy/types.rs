use std::collections::VecDeque;

use crate::dispatch::envelope::last_lines;
use crate::dispatch::presence::{Authority, Presence, PresenceState};
use crate::dispatch::role::RoleFile;
use crate::dispatch::types::{Caller, DispatchError, Family, PaneVisibility, Receipt, ReceiptStatus};

#[derive(Clone)]
pub struct Queued {
    pub id: String,
    pub op: String,
    pub address_label: String,
    pub text: String,
    pub mounted: bool,
    pub source: Option<String>,
    pub label: Option<String>,
    pub presentation_emitted: bool,
}

pub struct InflightMeta {
    pub at_ms: u64,
    pub changed: bool,
    pub key: String,
}

pub struct Endpoint {
    pub family: Family,
    pub id: String,
    pub alias: Option<String>,
    pub engine: Option<String>,
    pub parent: Option<String>,
    pub outlive: bool,
    pub observed: Option<Presence>,
    pub reported: Option<Presence>,
    pub queue: VecDeque<Queued>,
    pub in_flight: Option<String>,
    pub generation: u64,
    pub queued_generation: u64,
    pub saw_working: bool,
    pub sent_report_since_working: bool,
    pub exit_fact: Option<String>,
    pub tail: String,
    /// Last state that already produced a parent notice. Cleared on entry to working.
    pub last_noticed: Option<PresenceState>,
    pub live: bool,
    pub any_signal: bool,
    pub report_arrived: bool,
}

impl Endpoint {
    pub fn new(
        family: Family,
        id: &str,
        alias: Option<String>,
        parent: Option<String>,
        outlive: bool,
    ) -> Self {
        Self {
            family,
            id: id.to_string(),
            alias,
            engine: None,
            parent,
            outlive,
            observed: None,
            reported: None,
            queue: VecDeque::new(),
            in_flight: None,
            generation: 0,
            queued_generation: 0,
            saw_working: false,
            sent_report_since_working: false,
            exit_fact: None,
            tail: String::new(),
            last_noticed: None,
            live: true,
            any_signal: false,
            report_arrived: false,
        }
    }
}

pub struct SendInput {
    pub id: String,
    pub address: String,
    pub body: String,
    pub caller: Caller,
    pub force: bool,
    pub allow_queue: bool,
    pub only_ready: bool,
    pub wrap: Option<bool>,
    pub from: String,
    pub mounted: bool,
    pub source: Option<String>,
    pub label: Option<String>,
    pub now_ms: u64,
    pub profile_id: Option<String>,
    pub system: bool,
    /// The desktop already showed the flight. A later flush must not show a second one.
    pub presentation_emitted: bool,
}

pub struct RunInput {
    pub id: String,
    pub via: Family,
    pub engine: Option<String>,
    pub command: Option<String>,
    pub name: Option<String>,
    pub parent: Option<String>,
    pub outlive: bool,
    pub role: Option<RoleFile>,
    pub role_missing: bool,
    pub task: Option<String>,
    pub caller: Caller,
    pub cwd: Option<String>,
    pub now_ms: u64,
    pub hidden: bool,
    /// Non-empty means the process argv. The task is not also a birth prompt.
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildrenMode {
    All,
    Any,
}

pub struct WaitInput {
    pub id: String,
    pub address: Option<String>,
    pub until: Vec<PresenceState>,
    pub children: Option<ChildrenMode>,
    pub timeout_ms: u64,
    pub started_ms: u64,
    pub now_ms: u64,
}

/// The process argument. A system-prompt engine keeps the manual out of this text.
/// Every other known agent receives the complete manual here.
pub fn receipt_status_label(status: ReceiptStatus) -> &'static str {
    match status {
        ReceiptStatus::Queued => "queued",
        ReceiptStatus::Submitted => "submitted",
        ReceiptStatus::Rejected => "rejected",
        ReceiptStatus::Settled => "settled",
        ReceiptStatus::Failed => "failed",
        ReceiptStatus::Stalled => "stalled",
    }
}

pub fn pane_label(pane: PaneVisibility) -> &'static str {
    match pane {
        PaneVisibility::Shown => "shown",
        PaneVisibility::Hidden => "hidden",
        PaneVisibility::Pending => "pending",
        PaneVisibility::NotShown => "not_shown",
    }
}

pub fn birth_prompt(body: &str, _manual_as_system: bool) -> Option<String> {
    let body = body.trim();
    if body.is_empty() {
        None
    } else {
        Some(body.to_string())
    }
}

pub fn format_terminal_paste(text: &str) -> String {
    let clean = text
        .replace("\u{1b}[200~", "")
        .replace("\u{1b}[201~", "")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let trimmed = clean.trim_end_matches('\n');
    format!("\u{1b}[200~{trimmed}\u{1b}[201~")
}

pub fn is_spinner_frame_line(line: &str) -> bool {
    let trimmed = line.trim();
    let Some(first) = trimmed.chars().next() else {
        return false;
    };
    ('\u{2800}'..='\u{28ff}').contains(&first)
}

pub fn clean_notice_tail(source: &str, max_lines: usize) -> String {
    let trimmed = source.trim_end();
    if trimmed.is_empty() || max_lines == 0 {
        return String::new();
    }
    let filtered: Vec<&str> = trimmed
        .lines()
        .filter(|line| !is_spinner_frame_line(line))
        .collect();
    if filtered.is_empty() {
        return last_lines(trimmed, max_lines);
    }
    let start = filtered.len().saturating_sub(max_lines);
    filtered[start..].join("\n")
}

pub fn rejected(id: &str, op: &str, address: &str, err: DispatchError) -> Receipt {
    Receipt::new(
        id,
        op,
        if err == DispatchError::Timeout {
            ReceiptStatus::Failed
        } else {
            ReceiptStatus::Rejected
        },
        address,
        false,
        None,
        Some(err.code().into()),
    )
}
