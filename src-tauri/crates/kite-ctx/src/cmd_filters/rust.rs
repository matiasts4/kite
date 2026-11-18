pub fn filter_cargo(
    args: &[String],
    output: &str,
    exit_code: i32,
) -> Option<(&'static str, String)> {
    let sub = args
        .iter()
        .find(|a| !a.starts_with('-') && !a.starts_with('+'))
        .map(String::as_str)?;
    match sub {
        "test" | "nextest" => Some(("cargo_test", compact_cargo_test(output, exit_code))),
        "check" | "build" | "clippy" => Some(("cargo_build", compact_cargo_build(output, exit_code))),
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

fn compact_cargo_build(output: &str, exit_code: i32) -> String {
    let mut kept = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if is_cargo_progress_noise(trimmed) {
            continue;
        }
        if trimmed.starts_with("Finished ") && exit_code == 0 {
            kept.push(trimmed.to_string());
            continue;
        }
        if !trimmed.is_empty() || !kept.is_empty() {
            kept.push(line.to_string());
        }
    }
    if kept.is_empty() {
        output.trim().to_string()
    } else {
        kept.join("\n")
    }
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
}
