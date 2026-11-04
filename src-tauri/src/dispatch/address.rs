//! Address grammar. Policy resolves these; it does not open sessions.

use super::types::DispatchError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddrRef {
    Session(String),
    Thread(String),
    Agent(String),
    Alias(String),
}

pub fn is_alias_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub fn parse_address(raw: &str) -> Result<AddrRef, DispatchError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(DispatchError::BadArgs);
    }
    if let Some(rest) = raw.strip_prefix("session:") {
        return non_empty(rest).map(AddrRef::Session);
    }
    if let Some(rest) = raw.strip_prefix("thread:") {
        return non_empty(rest).map(AddrRef::Thread);
    }
    if let Some(rest) = raw.strip_prefix("agent:") {
        return non_empty(rest).map(AddrRef::Agent);
    }
    if let Some(rest) = raw.strip_prefix("alias:") {
        if !is_alias_name(rest) {
            return Err(DispatchError::BadArgs);
        }
        return Ok(AddrRef::Alias(rest.to_string()));
    }
    if is_alias_name(raw) {
        return Ok(AddrRef::Alias(raw.to_string()));
    }
    Err(DispatchError::UnknownAddress)
}

fn non_empty(rest: &str) -> Result<String, DispatchError> {
    if rest.is_empty() || rest.contains(char::is_whitespace) {
        Err(DispatchError::BadArgs)
    } else {
        Ok(rest.to_string())
    }
}

/// A caller address that can own children. The words `human` and `agent` are not addresses.
pub fn is_caller_endpoint(raw: &str) -> bool {
    let prefixed =
        raw.starts_with("session:") || raw.starts_with("thread:") || raw.starts_with("alias:");
    prefixed && parse_address(raw).is_ok()
}

pub fn canonical(family_terminal: bool, id: &str) -> String {
    if family_terminal {
        format!("session:{id}")
    } else {
        format!("thread:{id}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bare_alias_and_rejects_bad_names() {
        assert_eq!(
            parse_address("review").unwrap(),
            AddrRef::Alias("review".into())
        );
        assert!(parse_address("Review").is_err());
        assert!(parse_address("-nope").is_err());
        assert!(is_alias_name("a"));
        assert!(!is_alias_name(&"a".repeat(33)));
    }
}
