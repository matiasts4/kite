//! Presence record. Reported authority wins only when its sequence is newer.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceState {
    Idle,
    Working,
    Blocked,
    Done,
    Error,
    Unknown,
    Gone,
}

impl PresenceState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Error => "error",
            Self::Unknown => "unknown",
            Self::Gone => "gone",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "idle" => Some(Self::Idle),
            "working" => Some(Self::Working),
            "blocked" => Some(Self::Blocked),
            "done" => Some(Self::Done),
            "error" => Some(Self::Error),
            "unknown" => Some(Self::Unknown),
            "gone" => Some(Self::Gone),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Permission,
    Question,
    Auth,
}

impl BlockKind {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "permission" => Some(Self::Permission),
            "question" => Some(Self::Question),
            "auth" => Some(Self::Auth),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Question => "question",
            Self::Auth => "auth",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authority {
    Reported,
    Observed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Presence {
    pub state: PresenceState,
    pub kind: Option<BlockKind>,
    pub message: Option<String>,
    pub app: Option<String>,
    pub seq: u64,
    pub authority: Authority,
    pub at_ms: u64,
}

impl Presence {
    pub fn unknown(at_ms: u64) -> Self {
        Self {
            state: PresenceState::Unknown,
            kind: None,
            message: None,
            app: None,
            seq: 0,
            authority: Authority::Observed,
            at_ms,
        }
    }
}

pub fn is_ready(state: PresenceState) -> bool {
    matches!(state, PresenceState::Idle | PresenceState::Done)
}

/// Map the pane states this product already computes.
pub fn map_pane_state(raw: &str) -> PresenceState {
    match raw {
        "working" => PresenceState::Working,
        "waitingForYou" | "waiting_for_you" | "blocked" => PresenceState::Blocked,
        "idle" => PresenceState::Idle,
        "done" => PresenceState::Done,
        "exited" | "gone" => PresenceState::Gone,
        "error" => PresenceState::Error,
        _ => PresenceState::Unknown,
    }
}

pub fn choose_effective(reported: Option<&Presence>, observed: Option<&Presence>) -> Presence {
    match (reported, observed) {
        (Some(r), Some(o)) if r.seq > o.seq => r.clone(),
        (Some(r), None) => r.clone(),
        (_, Some(o)) => o.clone(),
        (None, None) => Presence::unknown(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_map_matches_the_existing_vocabulary() {
        assert_eq!(map_pane_state("waitingForYou"), PresenceState::Blocked);
        assert_eq!(map_pane_state("exited"), PresenceState::Gone);
        assert_eq!(map_pane_state("working"), PresenceState::Working);
        assert_eq!(map_pane_state("idle"), PresenceState::Idle);
        assert_eq!(map_pane_state("done"), PresenceState::Done);
    }
}
