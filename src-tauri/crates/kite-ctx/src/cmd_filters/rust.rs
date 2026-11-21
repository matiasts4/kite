use std::collections::HashSet;

use crate::ccr_store::CcrStore;

use super::{resolve_subcommand_index, CARGO_VALUE_FLAGS};

const MAX_CARGO_WARNINGS: usize = 25;

pub fn filter_cargo(
    args: &[String],
    output: &str,
    exit_code: i32,
) -> Option<(&'static str, String)> {
    filter_cargo_with_ccr(args, output, exit_code, None)
}

pub fn filter_cargo_with_ccr(
    args: &[String],
    output: &str,
    exit_code: i32,
    ccr: Option<&CcrStore>,
) -> Option<(&'static str, String)> {
    let idx = resolve_subcommand_index(args, CARGO_VALUE_FLAGS, true)?;
    let sub = args[idx].as_str();
    match sub {
        "test" | "nextest" => Some(("cargo_test", compact_cargo_test(output, exit_code))),
        "check" | "build" | "clippy" => {
            Some(("cargo_build", compact_cargo_build(output, exit_code, ccr)))
        }
        _ => None,
    }
}

fn is_cargo_progress_noise(trimmed: &str) -> bool {
    trimmed.starts_with("Compiling ")
        || trimmed.starts_with("Downloading ")
        || trimmed.starts_with("Downloaded ")
        || trimmed.starts_with("Checking ")
        || trimmed.starts_with("Fresh ")
        || trimmed.starts_with("Locking ")
        || trimmed.starts_with("Updating ")
        || trimmed.starts_with("Blocking waiting for file lock")
}

fn compact_cargo_test(output: &str, exit_code: i32) -> String {
    let mut summaries = Vec::new();
    let mut failure_lines = Vec::new();
    let mut in_failures_block = false;
    let mut passed_count = 0usize;

    for line in output.lines() {
        let trimmed = line.trim();
        if is_cargo_progress_noise(trimmed) {
            continue;
        }
        if trimmed.starts_with("Running ") || trimmed.starts_with("Doc-tests ") {
            in_failures_block = false;
            continue;
        }
        if trimmed.starts_with("test ") && trimmed.ends_with("... ok") {
            passed_count += 1;
            continue;
        }
        if trimmed.starts_with("test result:") {
            in_failures_block = false;
            summaries.push(trimmed.to_string());
            continue;
        }
        if trimmed == "failures:" {
            in_failures_block = true;
            failure_lines.push(line.to_string());
            continue;
        }
        if in_failures_block
            || trimmed.ends_with("FAILED")
            || trimmed.starts_with("error")
            || trimmed.starts_with("thread '")
            || trimmed.starts_with("panicked at")
        {
            failure_lines.push(line.to_string());
        }
    }

    if exit_code == 0 && failure_lines.is_empty() && !summaries.is_empty() {
        return summaries.join("\n");
    }

    let mut out = Vec::new();
    if !failure_lines.is_empty() {
        out.extend(failure_lines);
    }
    if !summaries.is_empty() {
        out.extend(summaries);
    }
    if out.is_empty() {
        if passed_count > 0 && exit_code == 0 {
            return format!("{passed_count} passed");
        }
        return output.to_string();
    }
    out.join("\n")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DiagKind {
    Error,
    Warning,
}

#[derive(Default)]
struct CargoDiagCollector {
    error_blocks: Vec<String>,
    seen_errors: HashSet<String>,
    compact_warnings: Vec<String>,
    seen_warnings: HashSet<(String, String)>,
    tail_notes: Vec<String>,
    current_kind: Option<DiagKind>,
    current_lines: Vec<String>,
}

impl CargoDiagCollector {
    fn flush(&mut self) {
        let Some(kind) = self.current_kind.take() else {
            return;
        };
        if self.current_lines.is_empty() {
            return;
        }
        match kind {
            DiagKind::Error => {
                let block = self.current_lines.join("\n").trim_end().to_string();
                if self.seen_errors.insert(block.clone()) {
                    self.error_blocks.push(block);
                }
            }
            DiagKind::Warning => {
                let header = self.current_lines[0]
                    .trim_start()
                    .strip_prefix("warning:")
                    .unwrap_or(&self.current_lines[0])
                    .trim()
                    .to_string();
                let location = self
                    .current_lines
                    .iter()
                    .find_map(|l| l.trim_start().strip_prefix("--> ").map(str::trim))
                    .unwrap_or("")
                    .to_string();
                if self.seen_warnings.insert((location.clone(), header.clone())) {
                    let row = if location.is_empty() {
                        format!("WARN {header}")
                    } else {
                        format!("WARN {location} — {header}")
                    };
                    self.compact_warnings.push(row);
                }
            }
        }
        self.current_lines.clear();
    }
}

fn compact_cargo_build(output: &str, exit_code: i32, ccr: Option<&CcrStore>) -> String {
    let mut acc = CargoDiagCollector::default();

    for line in output.lines() {
        let trimmed = line.trim();
        if is_cargo_progress_noise(trimmed) {
            continue;
        }
        if is_cargo_warning_summary(trimmed) {
            acc.flush();
            continue;
        }

        if line.starts_with("error[") || line.starts_with("error:") {
            acc.flush();
            if line.starts_with("error: could not compile") || line.starts_with("error: aborting") {
                acc.tail_notes.push(trimmed.to_string());
            } else {
                acc.current_kind = Some(DiagKind::Error);
                acc.current_lines.push(line.to_string());
            }
            continue;
        }

        if line.starts_with("warning:") {
            acc.flush();
            acc.current_kind = Some(DiagKind::Warning);
            acc.current_lines.push(line.to_string());
            continue;
        }

        if acc.current_kind.is_some() {
            if trimmed.is_empty() {
                acc.flush();
            } else {
                acc.current_lines.push(line.to_string());
            }
            continue;
        }

        if trimmed.starts_with("Finished ") && exit_code == 0 {
            acc.tail_notes.push(trimmed.to_string());
        } else if !trimmed.is_empty() {
            acc.tail_notes.push(line.to_string());
        }
    }
    acc.flush();

    let mut out: Vec<String> = Vec::new();
    out.extend(acc.error_blocks.iter().cloned());

    let warn_limit = if !acc.error_blocks.is_empty() {
        10
    } else {
        MAX_CARGO_WARNINGS
    };
    if !acc.compact_warnings.is_empty() {
        let shown = acc.compact_warnings.len().min(warn_limit);
        out.extend(acc.compact_warnings.iter().take(shown).cloned());
        if acc.compact_warnings.len() > shown {
            let omitted = acc.compact_warnings.len() - shown;
            let preview_so_far = out.join("\n");
            if let Some(hash) =
                ccr.and_then(|s| s.put(output, &preview_so_far, "cmd_filter", "cargo check").ok())
            {
                out.push(format!(
                    "... (+{omitted} unique warnings omitted — run `kite ctx retrieve {hash}` for full diagnostics) <<ccr:{hash}>>"
                ));
            } else {
                out.push(format!("... (+{omitted} unique warnings omitted)"));
            }
        }
    }

    out.extend(acc.tail_notes);
    if out.is_empty() {
        output.trim().to_string()
    } else {
        out.join("\n")
    }
}

fn is_cargo_warning_summary(trimmed: &str) -> bool {
    (trimmed.starts_with("warning: ") && trimmed.contains("generated ") && trimmed.contains("warning"))
        || trimmed.starts_with("warning: `") && trimmed.contains("emitted")
        || trimmed.starts_with("For more information about this error")
        || trimmed.starts_with("Some errors have detailed explanations")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_passing_tests_and_compiling_noise_while_keeping_failures() {
        let raw_pass = "\
   Compiling serde v1.0.229
   Compiling kite-ctx v0.1.0
     Running unittests src/lib.rs
running 3 tests
test alpha ... ok
test beta ... ok
test gamma ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
";
        let res = compact_cargo_test(raw_pass, 0);
        assert_eq!(
            res,
            "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s"
        );

        let raw_fail = "\
   Compiling kite-ctx v0.1.0
running 2 tests
test alpha ... ok
test beta ... FAILED

failures:

---- beta stdout ----
thread 'beta' panicked at src/lib.rs:42: assertion failed

test result: FAILED. 1 passed; 1 failed; 0 ignored
";
        let fail_res = compact_cargo_test(raw_fail, 101);
        assert!(fail_res.contains("test beta ... FAILED"));
        assert!(fail_res.contains("panicked at src/lib.rs:42"));
        assert!(!fail_res.contains("test alpha ... ok"));
        assert!(!fail_res.contains("Compiling kite-ctx"));
    }

    #[test]
    fn deduplicates_and_condenses_cargo_check_warnings_while_preserving_errors() {
        let raw = "\
   Compiling kite-ctx v0.1.0
warning: unused variable: `tmp`
  --> src/lib.rs:12:9
   |
12 |     let tmp = 1;
   |         ^^^ help: if this is intentional, prefix it with an underscore: `_tmp`
   |
   = note: `#[warn(unused_variables)]` on by default

warning: unused variable: `tmp`
  --> src/lib.rs:12:9
   |
12 |     let tmp = 1;
   |         ^^^ help: if this is intentional, prefix it with an underscore: `_tmp`

error[E0308]: mismatched types
  --> src/main.rs:44:12
   |
44 |     return 42;
   |            ^^ expected `()`, found integer

warning: `kite-code` (bin \"kite-code\") generated 2 warnings
error: could not compile `kite-code` (bin \"kite-code\") due to 1 previous error
";
        let (_, filtered) = filter_cargo(&["check".to_string()], raw, 101).unwrap();
        assert!(filtered.contains("error[E0308]: mismatched types"));
        assert!(filtered.contains("expected `()`, found integer"));
        assert_eq!(filtered.matches("unused variable: `tmp`").count(), 1);
        assert!(!filtered.contains("generated 2 warnings"));
        assert!(filtered.len() < raw.len() * 3 / 4);
    }
}
