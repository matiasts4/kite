//! Agent-to-agent envelope. The body is the caller's text and nothing else.

pub fn wrap_envelope(from: &str, body: &str) -> String {
    format!(
        "[kite from=\"{from}\"]\n\
This is another agent, not the person.\n\
To reply: kite dispatch send {from} \"<reply>\"\n\
Irreversible and privileged actions still wait for the person.\n\
BODY:\n\
{body}"
    )
}

pub fn last_lines(text: &str, max_lines: usize) -> String {
    if max_lines == 0 {
        return String::new();
    }
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_matches_the_contract() {
        let text = wrap_envelope("alias:review", "Findings");
        assert_eq!(
            text,
            "[kite from=\"alias:review\"]\n\
This is another agent, not the person.\n\
To reply: kite dispatch send alias:review \"<reply>\"\n\
Irreversible and privileged actions still wait for the person.\n\
BODY:\n\
Findings"
        );
        assert!(!text.contains("transcript"));
    }
}
