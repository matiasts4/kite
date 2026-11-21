use std::collections::BTreeMap;

use serde_json::Value;

use super::{normalize_npx_tool, resolve_subcommand_index, NPX_VALUE_FLAGS, PKG_VALUE_FLAGS};

pub fn filter_npx(args: &[String], output: &str, exit_code: i32) -> Option<(&'static str, String)> {
    let idx = resolve_subcommand_index(args, NPX_VALUE_FLAGS, false)?;
    let tool = normalize_npx_tool(&args[idx]);
    match tool.as_str() {
        "vitest" | "jest" => filter_js_test(output, exit_code),
        "tsc" => filter_tsc(output),
        _ => None,
    }
}

pub fn filter_pkg_runner(
    args: &[String],
    output: &str,
    exit_code: i32,
) -> Option<(&'static str, String)> {
    let idx = resolve_subcommand_index(args, PKG_VALUE_FLAGS, false)?;
    let first = args[idx].as_str();
    let tail = &args[idx + 1..];
    if first == "run" {
        if let Some(script) = tail.iter().find(|a| !a.starts_with('-')).map(String::as_str) {
            if script.contains("test") || script == "vitest" || script == "jest" {
                return filter_js_test(output, exit_code);
            }
            if script == "tsc" || script == "typecheck" {
                return filter_tsc(output);
            }
        }
    }
    if first == "test" || first == "vitest" || first == "jest" {
        return filter_js_test(output, exit_code);
    }
    if first == "tsc" || first == "typecheck" {
        return filter_tsc(output);
    }

    let kept: Vec<&str> = output
        .lines()
        .filter(|line| {
            let t = line.trim();
            !t.starts_with("npm notice")
                && !t.starts_with("Progress:")
                && !t.starts_with("Packages:")
                && !t.contains("packages are looking for funding")
        })
        .collect();
    Some(("js_pkg", kept.join("\n")))
}

pub fn filter_js_test(output: &str, exit_code: i32) -> Option<(&'static str, String)> {
    if let Ok(json) = serde_json::from_str::<Value>(output.trim()) {
        if let Some(formatted) = format_vitest_json(&json) {
            return Some(("vitest_json", formatted));
        }
    }

    let mut summaries = Vec::new();
    let mut failures = Vec::new();
    let mut in_fail_block = false;

    for line in output.lines() {
        let t = line.trim();
        if t.starts_with("✓") || t.starts_with("√") || t.starts_with("PASS ") {
            in_fail_block = false;
            continue;
        }
        if t.starts_with("Test Files")
            || t.starts_with("Tests ")
            || t.starts_with("Duration ")
            || t.starts_with("Tests:")
            || t.starts_with("Test Suites:")
        {
            in_fail_block = false;
            summaries.push(t.to_string());
            continue;
        }
        if t.starts_with("FAIL ")
            || t.starts_with("×")
            || t.starts_with("✗")
            || t.starts_with("AssertionError")
            || t.starts_with("Error:")
        {
            in_fail_block = true;
            failures.push(line.to_string());
            continue;
        }
        if in_fail_block && !t.is_empty() {
            failures.push(line.to_string());
        }
    }

    if exit_code == 0 && failures.is_empty() && !summaries.is_empty() {
        return Some(("vitest_text", summaries.join("\n")));
    }

    if !failures.is_empty() || !summaries.is_empty() {
        let mut out = failures;
        out.extend(summaries);
        return Some(("vitest_text", out.join("\n")));
    }
    None
}

fn format_vitest_json(json: &Value) -> Option<String> {
    let total = json.get("numTotalTests")?.as_u64()?;
    let passed = json.get("numPassedTests").and_then(Value::as_u64).unwrap_or(0);
    let failed = json.get("numFailedTests").and_then(Value::as_u64).unwrap_or(0);
    let mut out = vec![format!("tests: {total} total | {passed} passed | {failed} failed")];
    if let Some(files) = json.get("testResults").and_then(Value::as_array) {
        for file in files {
            let path = file.get("name").and_then(Value::as_str).unwrap_or("unknown");
            if let Some(assertions) = file.get("assertionResults").and_then(Value::as_array) {
                for a in assertions {
                    if a.get("status").and_then(Value::as_str) == Some("failed") {
                        let title = a.get("fullName").and_then(Value::as_str).unwrap_or("test");
                        let msg = a
                            .get("failureMessages")
                            .and_then(Value::as_array)
                            .and_then(|arr| arr.first())
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        out.push(format!("FAIL {path} :: {title}: {msg}"));
                    }
                }
            }
        }
    }
    Some(out.join("\n"))
}

pub fn filter_tsc(output: &str) -> Option<(&'static str, String)> {
    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut other = Vec::new();

    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        // Shape: `src/foo.ts(12,5): error TS2322: ...`
        if let Some(paren_idx) = t.find('(') {
            if let Some(close_idx) = t[paren_idx..].find("): error ") {
                let file = t[..paren_idx].to_string();
                let loc = &t[paren_idx + 1..paren_idx + close_idx];
                let msg = &t[paren_idx + close_idx + 3..];
                grouped
                    .entry(file)
                    .or_default()
                    .push(format!("  {loc} {msg}"));
                continue;
            }
        }
        other.push(line.to_string());
    }

    if grouped.is_empty() {
        return None;
    }

    let mut out = Vec::new();
    for (file, diags) in grouped {
        out.push(format!("{file} ({}):", diags.len()));
        out.extend(diags);
    }
    out.extend(other);
    Some(("tsc", out.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_tsc_errors_by_file_and_keeps_vitest_failures() {
        let tsc_raw = "\
src/app.ts(10,3): error TS2322: Type 'number' is not assignable to type 'string'.
src/app.ts(22,7): error TS2339: Property 'foo' does not exist.
src/lib.ts(4,1): error TS2304: Cannot find name 'Bar'.
";
        let (_, tsc_out) = filter_tsc(tsc_raw).unwrap();
        assert!(tsc_out.contains("src/app.ts (2):"));
        assert!(tsc_out.contains("  10,3 error TS2322:"));

        let vitest_raw = "\
 ✓ src/a.test.ts (4)
 ❯ src/b.test.ts (2)
   ✓ passes
   × fails cleanly
     AssertionError: expected 1 to be 2

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 5 passed (6)
";
        let (_, vitest_out) = filter_js_test(vitest_raw, 1).unwrap();
        assert!(!vitest_out.contains("src/a.test.ts"));
        assert!(vitest_out.contains("AssertionError: expected 1 to be 2"));
        assert!(vitest_out.contains("Tests  1 failed | 5 passed (6)"));
    }
}
