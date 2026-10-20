use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[allow(unused_mut)]
pub fn silent_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn user_home_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home)
    } else {
        PathBuf::from(".")
    }
}

pub fn format_unix_to_rfc3339(ms: i64) -> String {
    let total_sec = ms / 1000;
    let days = total_sec / 86400;
    let rem_sec = total_sec % 86400;
    let hour = rem_sec / 3600;
    let min = (rem_sec % 3600) / 60;
    let sec = rem_sec % 60;

    let mut y = 1970;
    let mut d = days;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
        let days_in_y = if leap { 366 } else { 365 };
        if d < days_in_y {
            break;
        }
        d -= days_in_y;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
    let days_in_m = [
        31,
        if leap { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut m = 1;
    for &dim in &days_in_m {
        if d < dim {
            break;
        }
        d -= dim;
        m += 1;
    }
    let day = d + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, day, hour, min, sec)
}

pub fn b64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for c in input.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// Returns (subject, exp_seconds) from a JWT payload.
pub fn decode_jwt_claims(token: &str) -> Option<(String, Option<i64>)> {
    let payload = token.split('.').nth(1)?;
    let bytes = b64url_decode(payload)?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let sub = v.get("sub")?.as_str()?.trim().to_string();
    if sub.is_empty() {
        return None;
    }
    Some((sub, v.get("exp").and_then(|e| e.as_i64())))
}

pub fn url_encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

pub fn chrono_parse_rfc3339(s: &str) -> Result<i64, ()> {
    // Basic RFC3339 parser for timestamps like 2026-10-15T21:28:00Z
    let clean = s.trim();
    if clean.len() < 19 {
        return Err(());
    }
    let parts: Vec<&str> = clean.split('T').collect();
    if parts.len() != 2 {
        return Err(());
    }
    let ymd: Vec<&str> = parts[0].split('-').collect();
    if ymd.len() != 3 {
        return Err(());
    }
    let year: i32 = ymd[0].parse().map_err(|_| ())?;
    let month: u32 = ymd[1].parse().map_err(|_| ())?;
    let day: u32 = ymd[2].parse().map_err(|_| ())?;

    let time_part = parts[1].trim_end_matches('Z');
    let hms: Vec<&str> = time_part.split(':').collect();
    if hms.len() < 3 {
        return Err(());
    }
    let hour: u32 = hms[0].parse().map_err(|_| ())?;
    let min: u32 = hms[1].parse().map_err(|_| ())?;
    let sec_str = hms[2].split('.').next().unwrap_or("0");
    let sec: u32 = sec_str.parse().map_err(|_| ())?;

    // Approximate days since unix epoch (1970)
    let mut total_days = 0i64;
    for y in 1970..year {
        let is_leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
        total_days += if is_leap { 366 } else { 365 };
    }
    let days_in_month = [
        31,
        if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    for m in 1..month {
        total_days += days_in_month[(m - 1) as usize] as i64;
    }
    total_days += (day - 1) as i64;

    let total_secs = total_days * 86400 + (hour as i64) * 3600 + (min as i64) * 60 + (sec as i64);
    Ok(total_secs * 1000)
}

pub fn format_unix_to_iso(ms: i64) -> String {
    let total_sec = ms / 1000;
    let sec = total_sec % 60;
    let min = (total_sec / 60) % 60;
    let hour = (total_sec / 3600) % 24;
    format!("Reset at {:02}:{:02}:{:02} UTC", hour, min, sec)
}
