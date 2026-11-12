use crate::vt_engine::screen::TerminalVtEngine;
use crate::vt_engine::types::{MAX_UNHANDLED_CSI_SAMPLES, REP_MAX};

pub fn rfind_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

pub fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

pub fn sync_hold_closes_within(bytes: &[u8]) -> bool {
    const START: &[u8] = b"\x1b[?2026h";
    const END: &[u8] = b"\x1b[?2026l";
    let mut depth = 1i32;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(START) {
            depth += 1;
            i += START.len();
            continue;
        }
        if bytes[i..].starts_with(END) {
            depth -= 1;
            i += END.len();
            if depth == 0 {
                return true;
            }
            continue;
        }
        i += 1;
    }
    false
}

/// Strips leading Braille/star spinners from agent terminal titles so
/// 10Hz title animations do not cause unnecessary header churn.
pub fn shown_title(title: &str) -> &str {
    let is_spinner = |c: char| {
        matches!(
            c,
            '\u{2800}'..='\u{28ff}'
                | '\u{00b7}'
                | '\u{2722}'
                | '\u{2733}'
                | '\u{2736}'
                | '\u{273b}'
                | '\u{273d}'
                | '\u{25d0}'..='\u{25d3}'
        )
    };
    let rest = title.trim_start_matches(|c: char| is_spinner(c) || c.is_whitespace());
    let led = title.len() - rest.len();
    if rest.is_empty()
        || !title[..led].chars().any(is_spinner)
        || !title[..led].ends_with(char::is_whitespace)
    {
        title
    } else {
        rest
    }
}

pub fn decode_base64_utf8(input: &[u8]) -> Option<String> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u8;
    for &b in input {
        if b == b'=' || b.is_ascii_whitespace() {
            continue;
        }
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
            if out.len() > (1 << 20) {
                return None;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Normalizes CSI sequences not natively supported by `vt100` (`CSI E`, `CSI F`, `CSI f`, `CSI s`, `CSI u`).
pub fn utf8_seq_len(lead: u8) -> usize {
    match lead {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf7 => 4,
        _ => 1,
    }
}

pub fn push_graphic_bytes(out: &mut Vec<u8>, bytes: &[u8], i: &mut usize, last_graphic_char: &mut char) {
    let b = bytes[*i];
    if b < 0x20 || b == 0x7f {
        out.push(b);
        *i += 1;
        return;
    }
    let width = utf8_seq_len(b);
    if width == 1 || *i + width > bytes.len() {
        if b < 0x80 {
            *last_graphic_char = b as char;
        }
        out.push(b);
        *i += 1;
        return;
    }
    let slice = &bytes[*i..*i + width];
    if slice[1..].iter().all(|c| (*c & 0xc0) == 0x80) {
        if let Ok(text) = std::str::from_utf8(slice) {
            if let Some(ch) = text.chars().next() {
                if !ch.is_control() {
                    *last_graphic_char = ch;
                }
            }
            out.extend_from_slice(slice);
            *i += width;
            return;
        }
    }
    out.push(b);
    *i += 1;
}

pub fn repeat_last_graphic(out: &mut Vec<u8>, ch: char, count: usize) {
    let mut buf = [0u8; 4];
    let encoded = ch.encode_utf8(&mut buf);
    for _ in 0..count {
        out.extend_from_slice(encoded.as_bytes());
    }
}

pub fn rep_count(params: &[u8]) -> usize {
    let text = std::str::from_utf8(params).unwrap_or("");
    let first = text.split(';').next().unwrap_or("");
    let count = if first.is_empty() {
        1
    } else {
        first.parse::<usize>().unwrap_or(1)
    };
    count.clamp(1, REP_MAX)
}

pub fn normalize_csi_sequences(bytes: &[u8], last_graphic_char: &mut char) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b {
            push_graphic_bytes(&mut out, bytes, &mut i, last_graphic_char);
            continue;
        }
        if i + 1 >= bytes.len() {
            out.push(0x1b);
            break;
        }
        match bytes[i + 1] {
            b'[' => {
                let mut k = i + 2;
                while k < bytes.len() && bytes[k] < 0x40 {
                    k += 1;
                }
                if k >= bytes.len() {
                    out.extend_from_slice(&bytes[i..]);
                    break;
                }
                let final_byte = bytes[k];
                let body = &bytes[i + 2..k];
                let private = body
                    .first()
                    .is_some_and(|b| matches!(b, b'?' | b'>' | b'<' | b'='));
                if !private && final_byte == b'b' && body.iter().all(|b| b.is_ascii_digit() || *b == b';') {
                    repeat_last_graphic(&mut out, *last_graphic_char, rep_count(body));
                    i = k + 1;
                    continue;
                }
                if !private {
                    match final_byte {
                        b'E' => {
                            let n = std::str::from_utf8(body)
                                .ok()
                                .and_then(|s| s.parse::<u16>().ok())
                                .unwrap_or(1)
                                .max(1);
                            out.extend_from_slice(format!("\x1b[{n}B\r").as_bytes());
                            i = k + 1;
                            continue;
                        }
                        b'F' => {
                            let n = std::str::from_utf8(body)
                                .ok()
                                .and_then(|s| s.parse::<u16>().ok())
                                .unwrap_or(1)
                                .max(1);
                            out.extend_from_slice(format!("\x1b[{n}A\r").as_bytes());
                            i = k + 1;
                            continue;
                        }
                        b'f' => {
                            out.extend_from_slice(b"\x1b[");
                            out.extend_from_slice(body);
                            out.push(b'H');
                            i = k + 1;
                            continue;
                        }
                        b's' if body.is_empty() => {
                            out.extend_from_slice(b"\x1b7");
                            i = k + 1;
                            continue;
                        }
                        b'u' if body.is_empty() => {
                            out.extend_from_slice(b"\x1b8");
                            i = k + 1;
                            continue;
                        }
                        _ => {}
                    }
                }
                out.extend_from_slice(&bytes[i..=k]);
                i = k + 1;
            }
            b']' => {
                let mut k = i + 2;
                while k < bytes.len() {
                    if bytes[k] == 0x07 {
                        k += 1;
                        break;
                    }
                    if bytes[k] == 0x1b && k + 1 < bytes.len() && bytes[k + 1] == b'\\' {
                        k += 2;
                        break;
                    }
                    k += 1;
                }
                let end = k.min(bytes.len());
                out.extend_from_slice(&bytes[i..end]);
                i = end;
            }
            _ => {
                out.push(bytes[i]);
                out.push(bytes[i + 1]);
                i += 2;
            }
        }
    }
    out
}

pub fn csi_params_end(body: &[u8], start: usize) -> usize {
    let mut idx = start;
    while idx < body.len() && (body[idx].is_ascii_digit() || body[idx] == b';') {
        idx += 1;
    }
    idx
}

pub fn csi_is_recognized(body: &[u8], final_byte: u8) -> bool {
    let private = matches!(body.first().copied(), Some(b'?' | b'>' | b'<' | b'='));
    let params_end = csi_params_end(body, if private { 1 } else { 0 });
    if params_end != body.len() {
        return false;
    }
    if private {
        return matches!(final_byte, b'h' | b'l' | b'J' | b'K' | b'n' | b'p' | b'u' | b'c');
    }
    matches!(
        final_byte,
        b'@' | b'A'
            | b'B'
            | b'C'
            | b'D'
            | b'E'
            | b'F'
            | b'G'
            | b'H'
            | b'J'
            | b'K'
            | b'L'
            | b'M'
            | b'P'
            | b'S'
            | b'T'
            | b'X'
            | b'b'
            | b'c'
            | b'd'
            | b'f'
            | b'h'
            | b'l'
            | b'm'
            | b'n'
            | b'q'
            | b'r'
            | b's'
            | b't'
            | b'u'
    )
}

pub(crate) fn watch_win32_input_mode(engine: &mut TerminalVtEngine, bytes: &[u8]) {
    const ON: &[u8] = b"\x1b[?9001h";
    const OFF: &[u8] = b"\x1b[?9001l";
    const KEEP: usize = ON.len() - 1;

    let mut edge = std::mem::take(&mut engine.win32_tail);
    edge.extend_from_slice(&bytes[..bytes.len().min(KEEP)]);
    let latest = |buf: &[u8]| -> Option<bool> {
        let on_pos = rfind_subsequence(buf, ON);
        let off_pos = rfind_subsequence(buf, OFF);
        match (on_pos, off_pos) {
            (Some(on), off) => Some(off.is_none_or(|o| on > o)),
            (None, Some(_)) => Some(false),
            (None, None) => None,
        }
    };
    if let Some(on) = latest(bytes).or_else(|| latest(&edge)) {
        engine.win32_input_mode = on;
    }
    let end = if bytes.len() >= KEEP { bytes } else { &edge };
    engine.win32_tail = end[end.len().saturating_sub(KEEP)..].to_vec();
}

pub(crate) fn scan_protocol_sequences(engine: &mut TerminalVtEngine, bytes: &[u8]) {
    watch_win32_input_mode(engine, bytes);

    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b || i + 1 >= bytes.len() {
            i += 1;
            continue;
        }
        match bytes[i + 1] {
            b'[' => {
                let start = i + 2;
                let mut j = start;
                while j < bytes.len()
                    && (bytes[j].is_ascii_digit()
                        || matches!(bytes[j], b';' | b'?' | b'>' | b'<' | b'=' | b' ' | b'$'))
                {
                    j += 1;
                }
                if j >= bytes.len() {
                    break;
                }
                let final_byte = bytes[j];
                let body = &bytes[start..j];
                handle_csi_sequence(engine, body, final_byte);
                i = j + 1;
            }
            b']' => {
                // OSC sequence: \x1b] ... (\x07 or \x1b\\)
                let start = i + 2;
                let mut j = start;
                let mut term_len = 0;
                while j < bytes.len() {
                    if bytes[j] == 0x07 {
                        term_len = 1;
                        break;
                    }
                    if bytes[j] == 0x1b && j + 1 < bytes.len() && bytes[j + 1] == b'\\' {
                        term_len = 2;
                        break;
                    }
                    j += 1;
                }
                if term_len == 0 {
                    break;
                }
                let osc_body = &bytes[start..j];
                handle_osc_sequence(engine, osc_body);
                i = j + term_len;
            }
            _ => {
                i += 1;
            }
        }
    }
}

pub(crate) fn handle_csi_sequence(engine: &mut TerminalVtEngine, body: &[u8], final_byte: u8) {
    let Ok(s) = std::str::from_utf8(body) else {
        return;
    };

    // Cursor shape: DECSCUSR (\x1b[Ps q or \x1b[Ps SP q)
    if final_byte == b'q' {
        let trimmed = s.trim_end_matches(' ');
        match trimmed {
            "" | "0" | "1" | "2" => engine.cursor_shape = "block".to_string(),
            "3" | "4" => engine.cursor_shape = "underline".to_string(),
            "5" | "6" => engine.cursor_shape = "bar".to_string(),
            _ => {}
        }
        return;
    }

    // DEC Private Mode Set / Reset (\x1b[?Pm h / l)
    if let Some(rest) = s.strip_prefix('?') {
        if final_byte == b'h' || final_byte == b'l' {
            let enable = final_byte == b'h';
            for part in rest.split(';') {
                if let Ok(mode) = part.parse::<u16>() {
                    match mode {
                        1000 => {
                            engine.explicit_mouse_mode =
                                Some(if enable { "click" } else { "none" }.to_string());
                        }
                        1002 => {
                            engine.explicit_mouse_mode =
                                Some(if enable { "drag" } else { "none" }.to_string());
                        }
                        1003 => {
                            engine.explicit_mouse_mode =
                                Some(if enable { "any" } else { "none" }.to_string());
                        }
                        1004 => engine.focus_reporting = enable,
                        1006 => engine.explicit_sgr_mouse = Some(enable),
                        1016 => {
                            engine.sgr_pixels_mouse = enable;
                            if enable {
                                engine.explicit_sgr_mouse = Some(true);
                            }
                        }
                        2048 => engine.in_band_resize = enable,
                        9001 => engine.win32_input_mode = enable,
                        _ => {}
                    }
                }
            }
            return;
        }

        // DECRQM: Request DEC Private Mode (\x1b[?Ps$p -> \x1b[?Ps;Pm$y)
        if final_byte == b'p' && rest.ends_with('$') {
            let mode_str = rest.trim_end_matches('$');
            if let Ok(mode) = mode_str.parse::<u16>() {
                let screen = engine.parser.screen();
                // Pm: 1 = set, 2 = reset, 0 = not recognized
                let status = match mode {
                    25 => if screen.hide_cursor() { 2 } else { 1 },
                    1000 => if effective_mouse_mode(engine) == "click" { 1 } else { 2 },
                    1002 => if effective_mouse_mode(engine) == "drag" { 1 } else { 2 },
                    1003 => if effective_mouse_mode(engine) == "any" { 1 } else { 2 },
                    1004 => if engine.focus_reporting { 1 } else { 2 },
                    1006 => if effective_sgr_mouse(engine) { 1 } else { 2 },
                    1016 => if engine.sgr_pixels_mouse { 1 } else { 2 },
                    1049 => if screen.alternate_screen() { 1 } else { 2 },
                    2004 => if screen.bracketed_paste() { 1 } else { 2 },
                    2026 => if engine.render_held { 1 } else { 2 },
                    2027 => 1,
                    2048 => if engine.in_band_resize { 1 } else { 2 },
                    9001 => if engine.win32_input_mode { 1 } else { 2 },
                    _ => 0,
                };
                engine.replies
                    .extend_from_slice(format!("\x1b[?{mode};{status}$y").as_bytes());
            }
            return;
        }

        // Extended CPR (\x1b[?6n)
        if final_byte == b'n' && rest == "6" {
            let (r, c) = engine.parser.screen().cursor_position();
            engine.replies
                .extend_from_slice(format!("\x1b[?{};{};1R", r + 1, c + 1).as_bytes());
            return;
        }

        // Kitty keyboard query (\x1b[?u)
        if final_byte == b'u' && rest.is_empty() {
            let flags = engine.kitty_keyboard_flags();
            engine.replies
                .extend_from_slice(format!("\x1b[?{flags}u").as_bytes());
            return;
        }
    }

    // Kitty keyboard protocol push/pop/set (\x1b[>flags u, \x1b[<count u, \x1b[=flags;mode u)
    if final_byte == b'u' {
        if let Some(rest) = s.strip_prefix('>') {
            let flags = rest
                .split(';')
                .next()
                .and_then(|v| v.parse::<u8>().ok())
                .unwrap_or(0);
            if engine.kitty_keyboard_stack.len() >= 16 {
                engine.kitty_keyboard_stack.remove(0);
            }
            engine.kitty_keyboard_stack.push(flags);
            return;
        }
        if let Some(rest) = s.strip_prefix('<') {
            let count = rest.parse::<usize>().unwrap_or(1).max(1);
            for _ in 0..count {
                engine.kitty_keyboard_stack.pop();
            }
            return;
        }
        if let Some(rest) = s.strip_prefix('=') {
            let flags = rest
                .split(';')
                .next()
                .and_then(|v| v.parse::<u8>().ok())
                .unwrap_or(0);
            if let Some(last) = engine.kitty_keyboard_stack.last_mut() {
                *last = flags;
            } else {
                engine.kitty_keyboard_stack.push(flags);
            }
            return;
        }
    }

    // Device Status Report (DSR / CPR: \x1b[5n, \x1b[6n)
    if final_byte == b'n' {
        match s {
            "5" => engine.replies.extend_from_slice(b"\x1b[0n"),
            "6" => {
                let (r, c) = engine.parser.screen().cursor_position();
                engine.replies
                    .extend_from_slice(format!("\x1b[{};{}R", r + 1, c + 1).as_bytes());
            }
            _ => {}
        }
        return;
    }

    // Device Attributes (DA1 / DA2: \x1b[c, \x1b[>c)
    if final_byte == b'c' {
        if s.is_empty() || s == "0" {
            engine.replies.extend_from_slice(b"\x1b[?62;22c");
        } else if s == ">" || s == ">0" {
            engine.replies.extend_from_slice(b"\x1b[>1;10;0c");
        }
        return;
    }

    // Window manipulation queries (\x1b[14t, \x1b[16t, \x1b[18t)
    if final_byte == b't' {
        match s {
            "14" => {
                let h = (engine.rows as u32) * 18;
                let w = (engine.cols as u32) * 9;
                engine.replies
                    .extend_from_slice(format!("\x1b[4;{h};{w}t").as_bytes());
            }
            "16" => {
                engine.replies.extend_from_slice(b"\x1b[6;18;9t");
            }
            "18" => {
                engine.replies
                    .extend_from_slice(format!("\x1b[8;{};{}t", engine.rows, engine.cols).as_bytes());
            }
            _ => {}
        }
    }

    if !csi_is_recognized(body, final_byte) {
        let mut raw = Vec::with_capacity(body.len() + 3);
        raw.extend_from_slice(b"\x1b[");
        raw.extend_from_slice(body);
        raw.push(final_byte);
        note_unhandled_csi(engine, &raw);
    }
}

pub(crate) fn note_unhandled_csi(engine: &mut TerminalVtEngine, raw: &[u8]) {
    let sample = String::from_utf8_lossy(raw).replace('\u{1b}', "ESC");
    if engine.diagnostics.unhandled_csi_samples.len() >= MAX_UNHANDLED_CSI_SAMPLES {
        engine.diagnostics.unhandled_csi_samples.pop_front();
    }
    engine.diagnostics.unhandled_csi_samples.push_back(sample);
}

pub(crate) fn handle_osc_sequence(engine: &mut TerminalVtEngine, body: &[u8]) {
    let Ok(s) = std::str::from_utf8(body) else {
        return;
    };
    let Some((code, rest)) = s.split_once(';') else {
        return;
    };
    match code {
        "0" | "2" => {
            let cleaned = shown_title(rest).to_string();
            engine.current_title = Some(cleaned);
        }
        "10" if rest == "?" => {
            // Foreground color query (#fafafa)
            engine.replies
                .extend_from_slice(b"\x1b]10;rgb:fafa/fafa/fafa\x1b\\");
        }
        "11" if rest == "?" => {
            // Background color query (#0a0a0a) — critical for dark-mode detection
            engine.replies
                .extend_from_slice(b"\x1b]11;rgb:0a0a/0a0a/0a0a\x1b\\");
        }
        "12" if rest == "?" => {
            // Cursor color query (#5c8fff)
            engine.replies
                .extend_from_slice(b"\x1b]12;rgb:5c5c/8f8f/ffff\x1b\\");
        }
        "52" => {
            // OSC 52 clipboard write: 52;c;<base64>
            if let Some((_target, b64)) = rest.split_once(';') {
                if b64 != "?" {
                    if let Some(decoded) = decode_base64_utf8(b64.as_bytes()) {
                        engine.pending_clipboard = Some(decoded);
                    }
                }
            }
        }
        _ => {}
    }
}

pub fn effective_mouse_mode(engine: &TerminalVtEngine) -> String {
    if let Some(ref explicit) = engine.explicit_mouse_mode {
        if explicit != "none" {
            return explicit.clone();
        }
    }
    match engine.parser.screen().mouse_protocol_mode() {
        vt100::MouseProtocolMode::None => "none".to_string(),
        vt100::MouseProtocolMode::Press | vt100::MouseProtocolMode::PressRelease => {
            "click".to_string()
        }
        vt100::MouseProtocolMode::ButtonMotion => "drag".to_string(),
        vt100::MouseProtocolMode::AnyMotion => "any".to_string(),
    }
}

pub fn effective_sgr_mouse(engine: &TerminalVtEngine) -> bool {
    if let Some(explicit) = engine.explicit_sgr_mouse {
        if explicit {
            return true;
        }
    }
    matches!(
        engine.parser.screen().mouse_protocol_encoding(),
        vt100::MouseProtocolEncoding::Sgr
    )
}

pub(crate) fn process_parser(engine: &mut TerminalVtEngine, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        engine.parser.process(bytes);
    }));
}
