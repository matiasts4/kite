//! Presence record. A current program report wins over a later screen observation.

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

/// A current program report is the presence. Screen observation applies only
/// after `clear` or when the program has never reported. Sequence numbers are
/// not compared across authorities: a screen clock must not outrank a report.
pub fn choose_effective(reported: Option<&Presence>, observed: Option<&Presence>) -> Presence {
    match (reported, observed) {
        (Some(reported), _) => reported.clone(),
        (None, Some(observed)) => observed.clone(),
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

    #[test]
    fn a_report_wins_over_a_later_screen_clock() {
        let reported = Presence {
            state: PresenceState::Blocked,
            kind: Some(BlockKind::Permission),
            message: None,
            app: None,
            seq: 2,
            authority: Authority::Reported,
            at_ms: 10,
        };
        let observed = Presence {
            state: PresenceState::Idle,
            kind: None,
            message: None,
            app: None,
            seq: 1_700_000_000_000,
            authority: Authority::Observed,
            at_ms: 11,
        };
        assert_eq!(
            choose_effective(Some(&reported), Some(&observed)).state,
            PresenceState::Blocked
        );
    }

    #[test]
    fn the_screen_applies_only_when_no_report_is_current() {
        let observed = Presence {
            state: PresenceState::Idle,
            kind: None,
            message: None,
            app: None,
            seq: 4,
            authority: Authority::Observed,
            at_ms: 10,
        };
        assert_eq!(
            choose_effective(None, Some(&observed)).state,
            PresenceState::Idle
        );
    }
}
