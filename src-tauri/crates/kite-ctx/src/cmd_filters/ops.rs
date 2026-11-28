//! Deterministic CLI output filters for `gh`, `docker`, and `curl`.

use crate::ccr_store::CcrStore;
use crate::crusher::SmartCrusher;
use crate::lossless::compact_lossless;
use crate::pipeline::{detect_content_kind, ContentKind};

pub fn filter_gh_with_ccr(
    args: &[String],
    output: &str,
    ccr: Option<&CcrStore>,
) -> Option<(&'static str, String)> {
    let kind = detect_content_kind(output);
    if kind == ContentKind::Json {
        if let Ok(crushed) = SmartCrusher::default().crush(output, ccr) {
            if crushed.output.len() < output.len() {
                return Some(("gh_json", crushed.output));
            }
        }
    }

    let sub = args.first().map(String::as_str).unwrap_or("");
    if matches!(sub, "pr" | "issue" | "run" | "checks") && output.lines().count() > 50 {
        let lines: Vec<&str> = output.lines().collect();
        let kept: Vec<&str> = lines
            .iter()
            .copied()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with("──")
            })
            .take(45)
            .collect();
        let mut rendered = kept.join("\n");
        let omitted = lines.len().saturating_sub(kept.len());
        if omitted > 0 {
            if let Some(hash) = ccr.and_then(|s| s.put(output, &rendered, "cmd_filter", "gh").ok())
            {
                rendered.push_str(&format!(
                    "\n... (+{omitted} lines in CCR — `kite ctx retrieve {hash} --search <term>`) <<ccr:{hash}>>"
                ));
            } else {
                rendered.push_str(&format!("\n... (+{omitted} lines omitted)"));
            }
        }
        if rendered.len() < output.len() {
            return Some(("gh", rendered));
        }
    }

    let folded = compact_lossless(output, kind);
    Some(("gh", folded))
}

pub fn filter_docker_with_ccr(
    args: &[String],
    output: &str,
    exit_code: i32,
    ccr: Option<&CcrStore>,
) -> Option<(&'static str, String)> {
    let sub = args.first().map(String::as_str).unwrap_or("");
    if matches!(sub, "build" | "compose") {
        let mut kept = Vec::new();
        let mut stripped = 0usize;
        for line in output.lines() {
            let t = line.trim();
            let lower = t.to_ascii_lowercase();
            let is_err = exit_code != 0
                && (lower.contains("error") || lower.contains("failed") || lower.contains("exit code"));
            if is_err || t.starts_with("Step ") || t.starts_with("=> ERROR") || t.starts_with("Successfully ") {
                kept.push(line);
                continue;
            }
            if t.starts_with('#') && (t.contains("CACHED") || t.contains("sha256:") || t.contains("[internal]")) {
                stripped += 1;
                continue;
            }
            kept.push(line);
        }
        if stripped > 0 && !kept.is_empty() {
            let mut body = kept.join("\n");
            if body.chars().count() > 8_000 {
                body = crate::cmd_filters::spill_tail_preserving_ccr_preview(
                    output,
                    &body,
                    8_000,
                    "docker",
                    "error",
                    ccr,
                );
            }
            return Some(("docker_build", body));
        }
    }

    let folded = compact_lossless(output, detect_content_kind(output));
    Some(("docker", folded))
}

pub fn filter_curl_with_ccr(output: &str, ccr: Option<&CcrStore>) -> Option<(&'static str, String)> {
    let trimmed = output.trim();
    if detect_content_kind(trimmed) == ContentKind::Json {
        if let Ok(crushed) = SmartCrusher::default().crush(trimmed, ccr) {
            if crushed.output.len() < output.len() {
                return Some(("curl_json", crushed.output));
            }
        }
    }
    if output.len() > 8_000 {
        let preview: String = output.chars().take(3_500).collect();
        if let Some(hash) = ccr.and_then(|s| s.put(output, &preview, "cmd_filter", "curl").ok()) {
            return Some((
                "curl",
                format!(
                    "{preview}\n... [full response ({} chars) in CCR — `kite ctx retrieve {hash} --search <term>`] <<ccr:{hash}>>",
                    output.chars().count()
                ),
            ));
        }
    }
    None
}
