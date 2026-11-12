//! OSC 7501 presence reports. Malformed input is dropped whole. No PTY.

use super::presence::{Authority, BlockKind, Presence, PresenceState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OscReport {
    State(Presence),
    /// Drop the reported record. The observer may publish again.
    Clear { seq: u64 },
}

pub fn parse_osc_7501(raw: &str) -> Option<OscReport> {
    let payload = extract_payload(raw)?;
    if payload == "?" {
        return None;
    }
    let mut state: Option<String> = None;
    let mut kind: Option<String> = None;
    let mut message: Option<String> = None;
    let mut app: Option<String> = None;
    let mut seq: u64 = 0;
    let mut saw_seq = false;

    for part in payload.split(':') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (key, value) = part.split_once('=')?;
        let key = key.trim();
        let value = value.trim();
        match key {
            "state" => state = Some(value.to_string()),
            "kind" => kind = Some(value.to_string()),
            "msg" | "message" => {
                if value.contains('\n') || value.contains('\r') {
                    return None;
                }
                message = Some(value.to_string());
            }
            "title" | "app" => app = Some(value.to_string()),
            "seq" => {
                seq = value.parse().ok()?;
                saw_seq = true;
            }
            _ => {}
        }
        let _ = saw_seq;
    }

    let state_raw = state?;
    if state_raw == "clear" {
        return Some(OscReport::Clear { seq });
    }
    let parsed = match state_raw.as_str() {
        "idle" => PresenceState::Idle,
        "working" => PresenceState::Working,
        "blocked" => PresenceState::Blocked,
        "done" => PresenceState::Done,
        "error" => PresenceState::Error,
        _ => return None,
    };
    let kind = match kind {
        None => None,
        Some(raw) => Some(BlockKind::parse(&raw)?),
    };
    Some(OscReport::State(Presence {
        state: parsed,
        kind,
        message,
        app,
        seq,
        authority: Authority::Reported,
        at_ms: 0,
    }))
}

fn extract_payload(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let rest = if let Some(pos) = trimmed.find("7501") {
        let after = &trimmed[pos + 4..];
        after.trim_start_matches([' ', ';', ':'])
    } else if trimmed.contains("state=") || trimmed == "?" {
        trimmed
    } else {
        return None;
    };
    let end = rest
        .find('\u{7}')
        .or_else(|| rest.find("\u{1b}\\"))
        .unwrap_or(rest.len());
    let mut payload = rest[..end].trim();
    if let Some(stripped) = payload.strip_suffix("ST") {
        payload = stripped.trim();
    }
    if payload.is_empty() {
        None
    } else {
        Some(payload.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legal_stale_clear_and_malformed() {
        let ok = parse_osc_7501("OSC 7501 ; state=working:seq=2:kind=question ST").unwrap();
        match ok {
            OscReport::State(p) => {
                assert_eq!(p.state, PresenceState::Working);
                assert_eq!(p.seq, 2);
                assert_eq!(p.kind, Some(BlockKind::Question));
            }
            OscReport::Clear { .. } => panic!("expected state"),
        }

        let with_unknown = parse_osc_7501("state=idle:seq=4:widget=1").unwrap();
        match with_unknown {
            OscReport::State(p) => assert_eq!(p.state, PresenceState::Idle),
            OscReport::Clear { .. } => panic!("expected state"),
        }

        assert!(matches!(
            parse_osc_7501("state=clear:seq=9"),
            Some(OscReport::Clear { seq: 9 })
        ));
        assert!(parse_osc_7501("state=working:broken").is_none());
        assert!(parse_osc_7501("state=asleep").is_none());
        assert!(parse_osc_7501("state=blocked:kind=dance").is_none());
        assert!(parse_osc_7501("OSC 7501 ; ? ST").is_none());
        assert!(parse_osc_7501("").is_none());

        let bel = format!("\u{1b}]7501;state=done:seq=3\u{7}");
        assert!(matches!(
            parse_osc_7501(&bel),
            Some(OscReport::State(_))
        ));
    }
}
