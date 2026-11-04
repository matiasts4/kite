//! Engines the terminal launcher already knows how to start.
//! `programs` and `run` share this table. It does not scan the disk and it does not probe installs.

/// Canonical names, in the order `kite dispatch programs` prints them.
pub fn names() -> &'static [&'static str] {
    &[
        "claude-code",
        "codex",
        "cursor",
        "gemini",
        "github-copilot",
        "droid",
        "open-code",
        "deep-seek",
        "grok",
        "kimi",
        "amp",
        "antigravity",
        "gentle-shell",
        "aider",
        "muse",
    ]
}

/// One name per line, no trailing newline.
pub fn lines() -> String {
    names().join("\n")
}

/// The canonical engine for a launcher alias, or `None` when the word is not a known program.
pub fn canonical(word: &str) -> Option<&'static str> {
    let key = word.trim().to_ascii_lowercase();
    let name = match key.as_str() {
        "claude" | "claude-code" => "claude-code",
        "codex" => "codex",
        "cursor" | "cursor-agent" | "agent" => "cursor",
        "gemini" => "gemini",
        "github-copilot" | "copilot" => "github-copilot",
        "droid" => "droid",
        "opencode" | "open-code" => "open-code",
        "deepseek" | "deep-seek" => "deep-seek",
        "grok" => "grok",
        "kimi" => "kimi",
        "amp" => "amp",
        "agy" | "antigravity" => "antigravity",
        "gentle-shell" | "gentleshell" | "gentle" | "gentle-pi" => "gentle-shell",
        "aider" => "aider",
        "muse" => "muse",
        _ => return None,
    };
    Some(name)
}

/// True only when that engine already accepts a system-prompt argument.
pub fn accepts_system_prompt(engine: &str) -> bool {
    matches!(canonical(engine), Some("grok" | "claude-code"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_is_only_grok_and_claude_code() {
        assert!(accepts_system_prompt("grok"));
        assert!(accepts_system_prompt("claude"));
        assert!(accepts_system_prompt("claude-code"));
        assert!(!accepts_system_prompt("codex"));
        assert!(!accepts_system_prompt("powershell"));
        assert!(!accepts_system_prompt("shell"));
        assert!(!accepts_system_prompt("qwen"));
        assert_eq!(canonical("copilot"), Some("github-copilot"));
        assert_eq!(canonical("agent"), Some("cursor"));
        assert_eq!(canonical("nosuch"), None);
        assert_eq!(canonical("deepseek"), Some("deep-seek"));
        assert_eq!(canonical("agy"), Some("antigravity"));
        assert_eq!(canonical("gentle"), Some("gentle-shell"));
        assert_eq!(canonical("opencode"), Some("open-code"));
        assert!(!names().contains(&"powershell"));
        assert!(!names().contains(&"qwen"));
        assert!(!names().contains(&"shell"));
    }
}
