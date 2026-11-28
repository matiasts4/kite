use serde::{Deserialize, Serialize};

use crate::tokens::SavingsReceipt;

/// Content classification used by the deterministic router before compression.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentKind {
    Auto,
    Json,
    Diff,
    Grep,
    Paths,
    Log,
    AxTree,
    Dom,
    NetworkWaterfall,
    Text,
}

/// Strategy contract implemented by pure-Rust compressors in `kite-ctx`.
pub trait CompressionStrategy {
    fn name(&self) -> &'static str;
    fn compress(&self, input: &str) -> String;
}

/// Output produced by running text through the optimization pipeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompressedPayload {
    pub text: String,
    pub kind: ContentKind,
    pub receipt: SavingsReceipt,
}

/// Classify raw text deterministically using lightweight structural inspection (zero ML).
pub fn detect_content_kind(text: &str) -> ContentKind {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return ContentKind::Text;
    }

    if (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('{') && trimmed.ends_with('}'))
    {
        if serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
            return ContentKind::Json;
        }
    }

    let mut diff_markers = 0usize;
    let mut grep_lines = 0usize;
    let mut path_lines = 0usize;
    let mut ax_lines = 0usize;
    let mut dom_signals = 0usize;
    let mut net_lines = 0usize;
    let mut non_empty = 0usize;

    for line in trimmed.lines().take(60) {
        let l = line.trim_end();
        if l.is_empty() {
            continue;
        }
        non_empty += 1;
        if l.starts_with("diff --git ")
            || l.starts_with("@@ ")
            || l.starts_with("index ")
            || l.starts_with("--- ")
            || l.starts_with("+++ ")
        {
            diff_markers += 1;
        }
        if is_grep_line(l) {
            grep_lines += 1;
        } else if is_path_like_line(l) {
            path_lines += 1;
        }
        if is_ax_tree_line(l) {
            ax_lines += 1;
        }
        if is_dom_line(l) {
            dom_signals += 1;
        }
        if is_network_waterfall_line(l) {
            net_lines += 1;
        }
    }

    if diff_markers >= 2 {
        return ContentKind::Diff;
    }
    if non_empty >= 2 && net_lines * 10 >= non_empty * 6 {
        return ContentKind::NetworkWaterfall;
    }
    if non_empty >= 2 && ax_lines * 10 >= non_empty * 5 {
        return ContentKind::AxTree;
    }
    if dom_signals >= 2
        || trimmed.starts_with("<!DOCTYPE html")
        || trimmed.starts_with("<html")
        || trimmed.starts_with("<svg")
    {
        return ContentKind::Dom;
    }
    if non_empty >= 3 && grep_lines * 10 >= non_empty * 6 {
        return ContentKind::Grep;
    }
    if non_empty >= 4 && path_lines * 10 >= non_empty * 8 {
        return ContentKind::Paths;
    }
    if non_empty >= 6 {
        return ContentKind::Log;
    }
    ContentKind::Text
}

fn is_ax_tree_line(line: &str) -> bool {
    let t = line.trim_start().trim_start_matches("- ").trim_start();
    if t.is_empty() {
        return false;
    }
    if t.contains("[@e") || t.contains("[ref=e") || t.starts_with("@e") {
        return true;
    }
    let role = t.split([' ', '"', '[']).next().unwrap_or("");
    matches!(
        role,
        "RootWebArea"
            | "WebArea"
            | "banner"
            | "navigation"
            | "main"
            | "contentinfo"
            | "complementary"
            | "button"
            | "link"
            | "textbox"
            | "searchbox"
            | "heading"
            | "checkbox"
            | "radio"
            | "combobox"
            | "menuitem"
            | "tab"
            | "switch"
    ) && (t.contains('"') || t.contains('[') || t == role)
}

fn is_dom_line(line: &str) -> bool {
    let t = line.trim();
    (t.starts_with('<') && t.contains('>'))
        && (t.contains("</")
            || t.starts_with("<div")
            || t.starts_with("<span")
            || t.starts_with("<svg")
            || t.starts_with("<style")
            || t.starts_with("<html")
            || t.starts_with("<body")
            || t.starts_with("<button")
            || t.starts_with("<input")
            || t.starts_with("<path"))
}

fn is_network_waterfall_line(line: &str) -> bool {
    let t = line.trim();
    let has_method = [
        "GET ", "POST ", "PUT ", "PATCH ", "DELETE ", "HEAD ", "OPTIONS ",
    ]
    .iter()
    .any(|m| t.contains(m));
    let has_url_or_path = t.contains("http://") || t.contains("https://") || t.contains(" /");
    let has_status = t
        .split_whitespace()
        .any(|tok| tok.len() == 3 && tok.bytes().all(|b| b.is_ascii_digit()));
    has_method && (has_url_or_path || has_status)
}

fn is_grep_line(line: &str) -> bool {
    let bytes = line.as_bytes();
    let Some(first_colon) = bytes.iter().position(|&b| b == b':') else {
        return false;
    };
    if first_colon == 0 {
        return false;
    }
    // Avoid mistaking Windows drive letter (`C:\...`) for `file:line:`.
    if first_colon == 1 && bytes.get(2) == Some(&b'\\') {
        let rest = &line[3..];
        let Some(next_colon) = rest.find(':') else {
            return false;
        };
        let after = &rest[next_colon + 1..];
        return has_numeric_line_prefix(after);
    }
    let after = &line[first_colon + 1..];
    has_numeric_line_prefix(after)
}

fn has_numeric_line_prefix(after_path: &str) -> bool {
    let Some(second_colon) = after_path.find(':') else {
        return false;
    };
    let num_part = &after_path[..second_colon];
    !num_part.is_empty() && num_part.bytes().all(|b| b.is_ascii_digit())
}

fn is_path_like_line(line: &str) -> bool {
    !line.contains(' ')
        && (line.contains('/') || line.contains('\\'))
        && !line.starts_with("http://")
        && !line.starts_with("https://")
}
