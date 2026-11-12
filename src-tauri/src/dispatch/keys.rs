//! Named keys for `kite dispatch keys`. One name becomes the bytes that are written.
//! `enter` is the only name that submits a line.

pub fn encode_key(name: &str) -> Option<String> {
    let key = name.trim().to_ascii_lowercase();
    match key.as_str() {
        "enter" | "return" => Some("\r".to_string()),
        "esc" | "escape" => Some("\u{1b}".to_string()),
        "tab" => Some("\t".to_string()),
        "up" => Some("\u{1b}[A".to_string()),
        "down" => Some("\u{1b}[B".to_string()),
        "right" => Some("\u{1b}[C".to_string()),
        "left" => Some("\u{1b}[D".to_string()),
        "backspace" => Some("\u{7f}".to_string()),
        "space" => Some(" ".to_string()),
        "ctrl+c" | "interrupt" => Some("\u{3}".to_string()),
        other if other.starts_with("ctrl+") && other.len() == 6 => {
            let ch = other.as_bytes()[5];
            if ch.is_ascii_alphabetic() {
                Some((((ch.to_ascii_lowercase() - b'a') + 1) as char).to_string())
            } else {
                None
            }
        }
        other if other.chars().count() == 1 && !other.starts_with('-') => Some(other.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enter_is_a_carriage_return_and_interrupt_is_etx() {
        assert_eq!(encode_key("enter").as_deref(), Some("\r"));
        assert_eq!(encode_key("ctrl+c").as_deref(), Some("\u{3}"));
        assert_eq!(encode_key("up").as_deref(), Some("\u{1b}[A"));
        assert_eq!(encode_key("a").as_deref(), Some("a"));
        assert!(encode_key("not-a-key").is_none());
    }
}
