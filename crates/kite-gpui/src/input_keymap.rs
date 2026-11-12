//! VT, SGR mouse, bracketed paste, Win32 input mode, and Kitty keyboard encoding.
//!
//! Byte sequences match the canvas surface so a native pane and a WebView pane
//! attached to the same session send the same input.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NamedKey {
    Enter,
    Escape,
    Tab,
    Backspace,
    ArrowUp,
    ArrowDown,
    ArrowRight,
    ArrowLeft,
    Home,
    End,
    Insert,
    Delete,
    PageUp,
    PageDown,
    F(u8),
    Char(char),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyEvent {
    pub key: NamedKey,
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    pub meta: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyContext {
    pub kitty_flags: u8,
    pub win32_mode: bool,
    pub application_cursor: bool,
    pub alternate_screen: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScrollDir {
    Up,
    Down,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedKey {
    pub bytes: Vec<u8>,
    pub scroll_page: Option<ScrollDir>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mods {
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    pub meta: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MousePoint {
    pub col: u16,
    pub row: u16,
    pub px_x: u16,
    pub px_y: u16,
}

pub fn normalize_paste(text: &str, bracketed_paste: bool) -> Vec<u8> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut normalized = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            normalized.push('\r');
        } else if ch == '\n' {
            normalized.push('\r');
        } else {
            normalized.push(ch);
        }
    }
    if bracketed_paste {
        let mut out = b"\x1b[200~".to_vec();
        out.extend(normalized.as_bytes());
        out.extend(b"\x1b[201~");
        out
    } else {
        normalized.into_bytes()
    }
}

pub fn encode_win32_special(key: NamedKey, shift: bool, alt: bool, ctrl: bool) -> Vec<u8> {
    let held = (if shift { 0x10 } else { 0 }) | (if alt { 0x02 } else { 0 }) | (if ctrl { 0x08 } else { 0 });
    let (vk, typed) = if key == NamedKey::Enter {
        let typed = if ctrl && !alt { 10 } else { 13 };
        (13, typed)
    } else {
        (27, 27)
    };
    format!("\x1b[{vk};28;{typed};1;{held};1_\x1b[{vk};28;{typed};0;{held};1_").into_bytes()
}

pub fn encode_vt_key(event: KeyEvent, ctx: KeyContext) -> Option<EncodedKey> {
    let has_mod = event.shift || event.alt || event.ctrl || event.meta;
    let mod_param = 1
        + usize::from(event.shift)
        + if event.alt { 2 } else { 0 }
        + if event.ctrl || event.meta { 4 } else { 0 };

    if event.key == NamedKey::Enter && has_mod {
        let bytes = if ctx.kitty_flags > 0 {
            format!("\x1b[13;{mod_param}u").into_bytes()
        } else if ctx.win32_mode {
            encode_win32_special(NamedKey::Enter, event.shift, event.alt, event.ctrl)
        } else if event.alt && !event.ctrl && !event.meta {
            b"\x1b\r".to_vec()
        } else {
            b"\n".to_vec()
        };
        return Some(EncodedKey { bytes, scroll_page: None });
    }
    if event.key == NamedKey::Escape && has_mod {
        let bytes = if ctx.kitty_flags > 0 {
            format!("\x1b[27;{mod_param}u").into_bytes()
        } else if ctx.win32_mode {
            encode_win32_special(NamedKey::Escape, event.shift, event.alt, event.ctrl)
        } else {
            b"\x1b".to_vec()
        };
        return Some(EncodedKey { bytes, scroll_page: None });
    }
    if event.key == NamedKey::Tab && event.shift {
        return Some(bytes_only(b"\x1b[Z"));
    }
    if event.key == NamedKey::Backspace && (event.ctrl || event.alt) {
        let bytes = if ctx.kitty_flags > 0 {
            format!("\x1b[127;{mod_param}u").into_bytes()
        } else if event.alt && !event.ctrl {
            b"\x1b\x7f".to_vec()
        } else {
            vec![0x17]
        };
        return Some(EncodedKey { bytes, scroll_page: None });
    }
    if event.ctrl && !event.meta && !event.alt {
        if let NamedKey::Char(ch) = event.key {
            let lower = ch.to_ascii_lowercase();
            if ('a'..='z').contains(&lower) {
                let bytes = if ctx.kitty_flags > 0 && event.shift {
                    format!("\x1b[{};{mod_param}u", lower as u32).into_bytes()
                } else {
                    vec![lower as u8 - 96]
                };
                return Some(EncodedKey { bytes, scroll_page: None });
            }
        }
    }

    if let Some(dir) = arrow_letter(event.key) {
        let bytes = if mod_param > 1 {
            format!("\x1b[1;{mod_param}{dir}").into_bytes()
        } else if ctx.application_cursor {
            format!("\x1bO{dir}").into_bytes()
        } else {
            format!("\x1b[{dir}").into_bytes()
        };
        return Some(EncodedKey { bytes, scroll_page: None });
    }

    let mut scroll_page = None;
    let bytes = match event.key {
        NamedKey::Enter => b"\r".to_vec(),
        NamedKey::Backspace => vec![0x7f],
        NamedKey::Tab => b"\t".to_vec(),
        NamedKey::Escape => {
            if ctx.kitty_flags > 0 {
                b"\x1b[27u".to_vec()
            } else {
                b"\x1b".to_vec()
            }
        }
        NamedKey::Home => special_nav(mod_param, ctx.application_cursor, "H", "OH", "[H"),
        NamedKey::End => special_nav(mod_param, ctx.application_cursor, "F", "OF", "[F"),
        NamedKey::Insert => tilde(2, mod_param),
        NamedKey::Delete => tilde(3, mod_param),
        NamedKey::PageUp => {
            if event.shift && !ctx.alternate_screen {
                scroll_page = Some(ScrollDir::Up);
            }
            tilde(5, mod_param)
        }
        NamedKey::PageDown => {
            if event.shift && !ctx.alternate_screen {
                scroll_page = Some(ScrollDir::Down);
            }
            tilde(6, mod_param)
        }
        NamedKey::F(n) => function_key(n, mod_param)?,
        NamedKey::Char(ch) if event.alt && !event.ctrl && !event.meta => {
            let mut bytes = vec![0x1b];
            let mut buf = [0u8; 4];
            bytes.extend(ch.encode_utf8(&mut buf).as_bytes());
            bytes
        }
        NamedKey::Char(ch) if !event.ctrl && !event.alt && !event.meta => {
            let mut buf = [0u8; 4];
            ch.encode_utf8(&mut buf).as_bytes().to_vec()
        }
        _ => return None,
    };
    Some(EncodedKey { bytes, scroll_page })
}

fn bytes_only(bytes: &[u8]) -> EncodedKey {
    EncodedKey {
        bytes: bytes.to_vec(),
        scroll_page: None,
    }
}

fn arrow_letter(key: NamedKey) -> Option<char> {
    match key {
        NamedKey::ArrowUp => Some('A'),
        NamedKey::ArrowDown => Some('B'),
        NamedKey::ArrowRight => Some('C'),
        NamedKey::ArrowLeft => Some('D'),
        _ => None,
    }
}

fn special_nav(mod_param: usize, application: bool, letter: &str, app: &str, normal: &str) -> Vec<u8> {
    if mod_param > 1 {
        format!("\x1b[1;{mod_param}{letter}").into_bytes()
    } else if application {
        format!("\x1b{app}").into_bytes()
    } else {
        format!("\x1b{normal}").into_bytes()
    }
}

fn tilde(code: u16, mod_param: usize) -> Vec<u8> {
    if mod_param > 1 {
        format!("\x1b[{code};{mod_param}~").into_bytes()
    } else {
        format!("\x1b[{code}~").into_bytes()
    }
}

fn function_key(n: u8, mod_param: usize) -> Option<Vec<u8>> {
    let bytes = match n {
        1 => ss3_or_mod(mod_param, 'P'),
        2 => ss3_or_mod(mod_param, 'Q'),
        3 => ss3_or_mod(mod_param, 'R'),
        4 => ss3_or_mod(mod_param, 'S'),
        5 => tilde(15, mod_param),
        6 => tilde(17, mod_param),
        7 => tilde(18, mod_param),
        8 => tilde(19, mod_param),
        9 => tilde(20, mod_param),
        10 => tilde(21, mod_param),
        11 => tilde(23, mod_param),
        12 => tilde(24, mod_param),
        _ => return None,
    };
    Some(bytes)
}

fn ss3_or_mod(mod_param: usize, letter: char) -> Vec<u8> {
    if mod_param > 1 {
        format!("\x1b[1;{mod_param}{letter}").into_bytes()
    } else {
        format!("\x1bO{letter}").into_bytes()
    }
}

pub fn encode_mouse_report(
    base_button: u16,
    release: bool,
    point: MousePoint,
    mods: Mods,
    sgr_mouse: bool,
    sgr_pixels: bool,
) -> Vec<u8> {
    let mod_bits: u16 = (if mods.shift { 4 } else { 0 })
        | (if mods.alt { 8 } else { 0 })
        | (if mods.ctrl || mods.meta { 16 } else { 0 });
    let cb = base_button | mod_bits;
    if sgr_pixels {
        let suffix = if release { 'm' } else { 'M' };
        let px = point.px_x.max(1);
        let py = point.px_y.max(1);
        return format!("\x1b[<{cb};{px};{py}{suffix}").into_bytes();
    }
    let cx = point.col as u32 + 1;
    let cy = point.row as u32 + 1;
    if sgr_mouse || cx > 223 || cy > 223 {
        let suffix = if release { 'm' } else { 'M' };
        return format!("\x1b[<{cb};{cx};{cy}{suffix}").into_bytes();
    }
    let x10 = if release { 3u16 | mod_bits } else { cb };
    let mut out = b"\x1b[M".to_vec();
    out.push(32 + x10 as u8);
    out.push(32 + cx.min(255) as u8);
    out.push(32 + cy.min(255) as u8);
    out
}

pub fn motion_button(buttons_down: u8) -> u16 {
    if buttons_down & 1 != 0 {
        32
    } else if buttons_down & 2 != 0 {
        33
    } else if buttons_down & 4 != 0 {
        34
    } else {
        35
    }
}

pub fn should_report_motion(mouse_mode: &str, buttons_down: u8, shift: bool) -> bool {
    if shift || mouse_mode == "none" || mouse_mode == "click" {
        return false;
    }
    if mouse_mode == "drag" && buttons_down == 0 {
        return false;
    }
    mouse_mode == "drag" || mouse_mode == "any"
}

pub fn encode_focus(focused: bool) -> &'static [u8] {
    if focused {
        b"\x1b[I"
    } else {
        b"\x1b[O"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(application: bool, kitty: u8, win32: bool) -> KeyContext {
        KeyContext {
            kitty_flags: kitty,
            win32_mode: win32,
            application_cursor: application,
            alternate_screen: false,
        }
    }

    fn key(named: NamedKey, shift: bool, alt: bool, ctrl: bool) -> KeyEvent {
        KeyEvent {
            key: named,
            shift,
            alt,
            ctrl,
            meta: false,
        }
    }

    #[test]
    fn arrows_application_cursor_and_modifiers() {
        let up = encode_vt_key(key(NamedKey::ArrowUp, false, false, false), ctx(false, 0, false)).unwrap();
        assert_eq!(up.bytes, b"\x1b[A");
        let app = encode_vt_key(key(NamedKey::ArrowUp, false, false, false), ctx(true, 0, false)).unwrap();
        assert_eq!(app.bytes, b"\x1bOA");
        let shifted = encode_vt_key(key(NamedKey::ArrowUp, true, false, false), ctx(true, 0, false)).unwrap();
        assert_eq!(shifted.bytes, b"\x1b[1;2A");
    }

    #[test]
    fn enter_escape_kitty_and_win32() {
        let plain = encode_vt_key(key(NamedKey::Enter, false, false, false), ctx(false, 0, false)).unwrap();
        assert_eq!(plain.bytes, b"\r");
        let alt = encode_vt_key(key(NamedKey::Enter, false, true, false), ctx(false, 0, false)).unwrap();
        assert_eq!(alt.bytes, b"\x1b\r");
        let kitty = encode_vt_key(key(NamedKey::Enter, true, false, false), ctx(false, 1, false)).unwrap();
        assert_eq!(kitty.bytes, b"\x1b[13;2u");
        let win32 = encode_vt_key(key(NamedKey::Enter, true, false, false), ctx(false, 0, true)).unwrap();
        assert_eq!(win32.bytes, b"\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_");
        let kitty_esc = encode_vt_key(key(NamedKey::Escape, false, false, false), ctx(false, 1, false)).unwrap();
        assert_eq!(kitty_esc.bytes, b"\x1b[27u");
    }

    #[test]
    fn ctrl_c_backtab_and_bracketed_paste() {
        let ctrl_c = encode_vt_key(key(NamedKey::Char('c'), false, false, true), ctx(false, 0, false)).unwrap();
        assert_eq!(ctrl_c.bytes, vec![0x03]);
        let backtab = encode_vt_key(key(NamedKey::Tab, true, false, false), ctx(false, 0, false)).unwrap();
        assert_eq!(backtab.bytes, b"\x1b[Z");
        assert_eq!(normalize_paste("a\nb", true), b"\x1b[200~a\rb\x1b[201~");
        assert_eq!(normalize_paste("a\r\nb", false), b"a\rb");
    }

    #[test]
    fn page_shift_scrolls_on_the_primary_screen() {
        let encoded = encode_vt_key(key(NamedKey::PageUp, true, false, false), ctx(false, 0, false)).unwrap();
        assert_eq!(encoded.scroll_page, Some(ScrollDir::Up));
        assert_eq!(encoded.bytes, b"\x1b[5;2~");
    }

    #[test]
    fn sgr_x10_pixels_and_wheel() {
        let point = MousePoint { col: 0, row: 0, px_x: 4, px_y: 9 };
        let mods = Mods { shift: false, alt: false, ctrl: false, meta: false };
        assert_eq!(
            encode_mouse_report(0, false, point, mods, true, false),
            b"\x1b[<0;1;1M"
        );
        assert_eq!(
            encode_mouse_report(0, true, point, mods, true, false),
            b"\x1b[<0;1;1m"
        );
        assert_eq!(
            encode_mouse_report(0, false, point, mods, false, false),
            b"\x1b[M !!"
        );
        assert_eq!(
            encode_mouse_report(64, false, point, mods, true, false),
            b"\x1b[<64;1;1M"
        );
        assert_eq!(
            encode_mouse_report(0, false, point, mods, false, true),
            b"\x1b[<0;4;9M"
        );
        assert_eq!(encode_focus(true), b"\x1b[I");
        assert_eq!(encode_focus(false), b"\x1b[O");
        assert!(!should_report_motion("click", 1, false));
        assert!(should_report_motion("drag", 1, false));
        assert!(!should_report_motion("drag", 0, false));
        assert!(should_report_motion("any", 0, false));
        assert_eq!(motion_button(1), 32);
        assert_eq!(motion_button(0), 35);
    }
}
