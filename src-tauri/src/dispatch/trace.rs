//! Residual record of one handoff. A failed write does not fail the caller.
//! Under `cfg(test)` nothing is written unless a directory override is set.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const TEXT_LIMIT: usize = 16_000;
const BRACKET_START: &str = "\u{1b}[200~";
const MANUAL_MARK: &str = "Kite Dispatch";

static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
std::thread_local! {
    static TRACE_OVERRIDE: std::cell::RefCell<Option<PathBuf>> =
        std::cell::RefCell::new(None);
}

#[cfg(not(windows))]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(test)]
pub fn set_dir_override(dir: Option<PathBuf>) {
    TRACE_OVERRIDE.with(|slot| *slot.borrow_mut() = dir);
}

#[derive(Clone, Copy)]
pub struct Fields<'a> {
    pub op: &'a str,
    pub session: &'a str,
    pub engine: &'a str,
    pub status: &'a str,
    pub pane: &'a str,
    pub writes: u64,
    pub launcher: &'a str,
    pub manual: &'a str,
}

pub fn manual_label(system_prompt: bool, text: &str) -> &'static str {
    if system_prompt {
        "system-prompt"
    } else if text.contains(MANUAL_MARK) {
        "inline"
    } else {
        "none"
    }
}

pub fn handoff_event(channel: &str, text: &str, fields: Fields<'_>) -> serde_json::Value {
    let lines = count_lines(text);
    let bracketed = text.contains(BRACKET_START);
    let ends_with_enter = text.ends_with('\n') || text.ends_with('\r');
    let (stored, truncated) = clip_text(text);
    let (at, _) = stamps();
    serde_json::json!({
        "at": at,
        "op": fields.op,
        "session": fields.session,
        "engine": fields.engine,
        "status": fields.status,
        "pane": fields.pane,
        "channel": channel,
        "writes": fields.writes,
        "lines": lines,
        "bracketed": bracketed,
        "endsWithEnter": ends_with_enter,
        "launcher": fields.launcher,
        "manual": fields.manual,
        "verdict": verdict_of(channel, text, lines, bracketed),
        "text": stored,
        "textTruncated": truncated,
    })
}

pub fn record(event: &serde_json::Value) {
    let Some(dir) = traces_dir() else {
        return;
    };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|err| err.into_inner());
    let _ = persist_event(&dir, event);
}

fn traces_dir() -> Option<PathBuf> {
    #[cfg(test)]
    {
        TRACE_OVERRIDE.with(|slot| slot.borrow().clone())
    }
    #[cfg(not(test))]
    {
        Some(crate::persist::roaming_app_dir().join("dispatch").join("traces"))
    }
}

fn count_lines(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let mut lines = 0usize;
    let mut rest = text;
    loop {
        lines += 1;
        let Some(at) = rest.find(['\n', '\r']) else {
            break;
        };
        let mut next = at + rest[at..].chars().next().map(|ch| ch.len_utf8()).unwrap_or(1);
        if rest[at..].starts_with('\r') && rest[next..].starts_with('\n') {
            next += 1;
        }
        if next >= rest.len() {
            break;
        }
        rest = &rest[next..];
    }
    lines
}

fn verdict_of(channel: &str, text: &str, lines: usize, bracketed: bool) -> &'static str {
    if text.is_empty() {
        return "empty";
    }
    match channel {
        "argv" | "launch" => {
            if lines > 1 {
                "argv-multiline"
            } else {
                "one-piece"
            }
        }
        "pty" => {
            if lines > 1 && !bracketed {
                "split-risk"
            } else {
                "one-piece"
            }
        }
        "thread" => "one-piece",
        _ => "one-piece",
    }
}

fn clip_text(text: &str) -> (String, bool) {
    let mut count = 0usize;
    for (idx, _) in text.char_indices() {
        if count == TEXT_LIMIT {
            return (text[..idx].to_string(), true);
        }
        count += 1;
    }
    (text.to_string(), false)
}

fn persist_event(dir: &Path, event: &serde_json::Value) -> std::io::Result<()> {
    let Ok(line) = serde_json::to_string(event) else {
        return Ok(());
    };
    fs::create_dir_all(dir)?;
    let (_, date) = stamps();
    let path = dir.join(format!("dispatch-{date}.jsonl"));
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    file.flush()?;
    fs::write(dir.join("latest.txt"), render_latest(event))?;
    Ok(())
}

fn render_latest(event: &serde_json::Value) -> String {
    fn field(event: &serde_json::Value, key: &str) -> String {
        match event.get(key) {
            Some(serde_json::Value::String(value)) => value.clone(),
            Some(serde_json::Value::Bool(value)) => value.to_string(),
            Some(serde_json::Value::Number(value)) => value.to_string(),
            _ => String::new(),
        }
    }
    format!(
        "at: {at}\nop: {op}\nsession: {session}\nengine: {engine}\nchannel: {channel}\nwrites: {writes}\nlines: {lines}\nbracketed: {bracketed}\nendsWithEnter: {ends}\nlauncher: {launcher}\nverdict: {verdict}\n{text}\n",
        at = field(event, "at"),
        op = field(event, "op"),
        session = field(event, "session"),
        engine = field(event, "engine"),
        channel = field(event, "channel"),
        writes = field(event, "writes"),
        lines = field(event, "lines"),
        bracketed = field(event, "bracketed"),
        ends = field(event, "endsWithEnter"),
        launcher = field(event, "launcher"),
        verdict = field(event, "verdict"),
        text = field(event, "text"),
    )
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct WinSystemTime {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    milliseconds: u16,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetSystemTime(out: *mut WinSystemTime);
    fn GetLocalTime(out: *mut WinSystemTime);
}

fn stamps() -> (String, String) {
    #[cfg(windows)]
    {
        let mut utc = WinSystemTime {
            year: 0,
            month: 0,
            day_of_week: 0,
            day: 0,
            hour: 0,
            minute: 0,
            second: 0,
            milliseconds: 0,
        };
        let mut local = utc;
        unsafe {
            GetSystemTime(&mut utc);
            GetLocalTime(&mut local);
        }
        (
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                utc.year, utc.month, utc.day, utc.hour, utc.minute, utc.second
            ),
            format!("{:04}-{:02}-{:02}", local.year, local.month, local.day),
        )
    }
    #[cfg(not(windows))]
    {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|dur| dur.as_secs())
            .unwrap_or(0);
        let (year, month, day, hour, minute, second) = civil_utc(secs);
        (
            format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"),
            format!("{year:04}-{month:02}-{day:02}"),
        )
    }
}

#[cfg(not(windows))]
fn civil_utc(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let second = (secs % 60) as u32;
    let minute = ((secs / 60) % 60) as u32;
    let hour = ((secs / 3600) % 24) as u32;
    let z = (secs / 86400) as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = (if m <= 2 { y + 1 } else { y }) as i32;
    (year, m, d, hour, minute, second)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fields(op: &str) -> Fields<'_> {
        Fields {
            op,
            session: "s1",
            engine: "grok",
            status: "",
            pane: "",
            writes: 1,
            launcher: "",
            manual: "none",
        }
    }

    #[test]
    fn pty_five_lines_without_bracket_is_split_risk() {
        let event = handoff_event("pty", "a\nb\nc\nd\ne", fields("pty-write"));
        assert_eq!(event["lines"].as_u64(), Some(5));
        assert_eq!(event["verdict"].as_str(), Some("split-risk"));
        assert_eq!(event["writes"].as_u64(), Some(1));
        assert_eq!(event["bracketed"].as_bool(), Some(false));
    }

    #[test]
    fn pty_five_lines_bracketed_is_one_piece() {
        let text = "\u{1b}[200~a\nb\nc\nd\ne\u{1b}[201~";
        let event = handoff_event("pty", text, fields("pty-write"));
        assert_eq!(event["lines"].as_u64(), Some(5));
        assert_eq!(event["verdict"].as_str(), Some("one-piece"));
        assert_eq!(event["bracketed"].as_bool(), Some(true));
    }

    #[test]
    fn argv_five_lines_is_argv_multiline() {
        let text = "a\nb\nc\nd\ne";
        let argv = handoff_event("argv", text, fields("run"));
        assert_eq!(argv["lines"].as_u64(), Some(5));
        assert_eq!(argv["verdict"].as_str(), Some("argv-multiline"));
        let launch = handoff_event("launch", text, fields("launch"));
        assert_eq!(launch["verdict"].as_str(), Some("argv-multiline"));
    }

    #[test]
    fn pty_one_line_without_enter_is_one_piece() {
        let event = handoff_event("pty", "hello", fields("pty-write"));
        assert_eq!(event["lines"].as_u64(), Some(1));
        assert_eq!(event["verdict"].as_str(), Some("one-piece"));
        assert_eq!(event["endsWithEnter"].as_bool(), Some(false));
    }

    #[test]
    fn trailing_break_does_not_inflate_line_count() {
        let event = handoff_event("pty", "a\nb\n", fields("pty-write"));
        assert_eq!(event["lines"].as_u64(), Some(2));
        assert_eq!(event["endsWithEnter"].as_bool(), Some(true));
        assert_eq!(
            handoff_event("pty", "a\r\nb\r\n", fields("pty-write"))["lines"].as_u64(),
            Some(2)
        );
        assert_eq!(
            handoff_event("argv", "", fields("run"))["verdict"].as_str(),
            Some("empty")
        );
        assert_eq!(handoff_event("argv", "", fields("run"))["lines"].as_u64(), Some(0));
    }

    #[test]
    fn thread_multiline_is_one_piece() {
        let event = handoff_event("thread", "a\nb\nc\nd\ne", fields("submit"));
        assert_eq!(event["lines"].as_u64(), Some(5));
        assert_eq!(event["verdict"].as_str(), Some("one-piece"));
    }

    struct ClearOverride;

    impl Drop for ClearOverride {
        fn drop(&mut self) {
            set_dir_override(None);
        }
    }

    fn roaming_contains(needle: &str) -> bool {
        let dir = crate::persist::roaming_app_dir().join("dispatch").join("traces");
        let Ok(entries) = fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(text) = fs::read_to_string(&path) {
                    if text.contains(needle) {
                        return true;
                    }
                }
            }
        }
        false
    }

    #[test]
    fn record_appends_under_override_and_skips_roaming() {
        let sentinel = format!(
            "kite-trace-sentinel-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        set_dir_override(None);
        record(&handoff_event(
            "pty",
            &sentinel,
            fields("pty-write"),
        ));
        assert!(!roaming_contains(&sentinel));

        let dir = std::env::temp_dir().join(format!("kite-dispatch-trace-{sentinel}"));
        let _ = fs::remove_dir_all(&dir);
        set_dir_override(Some(dir.clone()));
        let _clear = ClearOverride;

        record(&handoff_event("pty", "solo", fields("pty-write")));
        record(&handoff_event("pty", "a\nb\nc\nd\ne", fields("pty-write")));

        let mut jsonl_path = None;
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("dispatch-") && name.ends_with(".jsonl") {
                jsonl_path = Some(entry.path());
            }
        }
        let jsonl_path = jsonl_path.expect("daily jsonl");
        let jsonl = fs::read_to_string(&jsonl_path).unwrap();
        let lines: Vec<&str> = jsonl.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(first["verdict"].as_str(), Some("one-piece"));
        assert_eq!(second["verdict"].as_str(), Some("split-risk"));
        assert_eq!(second["lines"].as_u64(), Some(5));
        assert_eq!(second["text"].as_str(), Some("a\nb\nc\nd\ne"));
        assert!(second["at"].as_str().unwrap_or("").contains('T'));
        assert!(second["at"].as_str().unwrap_or("").ends_with('Z'));

        let latest = fs::read_to_string(dir.join("latest.txt")).unwrap();
        assert_eq!(latest.matches("verdict:").count(), 1);
        assert!(latest.contains("verdict: split-risk"));
        assert!(latest.contains("op: pty-write"));
        assert!(latest.contains("a\nb\nc\nd\ne"));
        assert!(!latest.contains("verdict: one-piece"));
        assert!(!roaming_contains(&sentinel));

        let _ = fs::remove_dir_all(&dir);
    }
}
