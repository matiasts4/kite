use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use crate::ccr_store::CcrStore;

use super::{normalize_npx_tool, resolve_subcommand_index, NPX_VALUE_FLAGS, PKG_VALUE_FLAGS};

const MAX_JS_FAILURE_CHARS: usize = 6_000;
const MAX_DOM_DUMP_LINES: usize = 12;

pub fn filter_npx(args: &[String], output: &str, exit_code: i32) -> Option<(&'static str, String)> {
    filter_npx_with_ccr(args, output, exit_code, None)
}

pub fn filter_npx_with_ccr(
    args: &[String],
    output: &str,
    exit_code: i32,
    ccr: Option<&CcrStore>,
) -> Option<(&'static str, String)> {
    let idx = resolve_subcommand_index(args, NPX_VALUE_FLAGS, false)?;
    let tool = normalize_npx_tool(&args[idx]);
    match tool.as_str() {
        "vitest" | "jest" => filter_js_test_with_ccr(output, exit_code, ccr),
        "playwright" => filter_playwright_with_ccr(output, exit_code, ccr),
        "tsc" => filter_tsc(output),
        "eslint" | "prettier" => filter_eslint_prettier(output, exit_code),
        _ => None,
    }
}

pub fn filter_pkg_runner(
    args: &[String],
    output: &str,
    exit_code: i32,
) -> Option<(&'static str, String)> {
    filter_pkg_runner_with_ccr(args, output, exit_code, None)
}

pub fn filter_pkg_runner_with_ccr(
    args: &[String],
    output: &str,
    exit_code: i32,
    ccr: Option<&CcrStore>,
) -> Option<(&'static str, String)> {
    let idx = resolve_subcommand_index(args, PKG_VALUE_FLAGS, false)?;
    let first = args[idx].as_str();
    let tail = &args[idx + 1..];
    if first == "run" {
        if let Some(script) = tail.iter().find(|a| !a.starts_with('-')).map(String::as_str) {
            if script.contains("playwright") {
                return filter_playwright_with_ccr(output, exit_code, ccr);
            }
            if script.contains("test") || script == "vitest" || script == "jest" {
                return filter_js_test_with_ccr(output, exit_code, ccr);
            }
            if script == "tsc" || script == "typecheck" {
                return filter_tsc(output);
            }
            if script.contains("eslint") || script.contains("prettier") || script == "lint" {
                return filter_eslint_prettier(output, exit_code);
            }
            if script.contains("build") || script.starts_with("verify") || script.contains("check") {
                return filter_build_or_verify_with_ccr(output, exit_code, ccr);
            }
        }
    }
    if first == "test" || first == "vitest" || first == "jest" {
        return filter_js_test_with_ccr(output, exit_code, ccr);
    }
    if first == "playwright" {
        return filter_playwright_with_ccr(output, exit_code, ccr);
    }
    if first == "tsc" || first == "typecheck" {
        return filter_tsc(output);
    }
    if first == "eslint" || first == "prettier" || first == "lint" {
        return filter_eslint_prettier(output, exit_code);
    }
    if first == "build" || first.starts_with("verify") {
        return filter_build_or_verify_with_ccr(output, exit_code, ccr);
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
    filter_js_test_with_ccr(output, exit_code, None)
}

pub fn filter_js_test_with_ccr(
    output: &str,
    exit_code: i32,
    ccr: Option<&CcrStore>,
) -> Option<(&'static str, String)> {
    if let Ok(json) = serde_json::from_str::<Value>(output.trim()) {
        if let Some(formatted) = format_vitest_json(&json) {
            return Some(("vitest_json", formatted));
        }
    }

    let mut summaries = Vec::new();
    let mut raw_failures = Vec::new();
    let mut in_fail_block = false;
    let mut in_stderr_noise = false;

    for line in output.lines() {
        let t = line.trim();
        if t.starts_with("✓") || t.starts_with("√") || t.starts_with("PASS ") {
            in_fail_block = false;
            in_stderr_noise = false;
            continue;
        }
        if t.starts_with("Test Files")
            || t.starts_with("Tests ")
            || t.starts_with("Duration ")
            || t.starts_with("Start at ")
            || t.starts_with("Tests:")
            || t.starts_with("Test Suites:")
        {
            in_fail_block = false;
            in_stderr_noise = false;
            summaries.push(t.to_string());
            continue;
        }

        // Passing runs frequently log expected `Error:` or `stderr |` messages inside tests;
        // never promote those to failure blocks when `exit_code == 0`.
        if exit_code == 0 {
            if t.starts_with("stderr |") || t.starts_with("stdout |") {
                in_stderr_noise = true;
            }
            if in_stderr_noise {
                continue;
            }
            if t.starts_with("FAIL ") || t.starts_with("AssertionError") {
                in_fail_block = true;
                raw_failures.push(line.to_string());
            }
            continue;
        }

        if t.starts_with("FAIL ")
            || t.starts_with("×")
            || t.starts_with("✗")
            || t.starts_with("AssertionError")
            || t.starts_with("Error:")
        {
            in_fail_block = true;
            raw_failures.push(line.to_string());
            continue;
        }
        if in_fail_block && !t.is_empty() {
            raw_failures.push(line.to_string());
        }
    }

    if exit_code == 0 && !summaries.is_empty() {
        return Some(("vitest_text", summaries.join("\n")));
    }

    if !raw_failures.is_empty() || !summaries.is_empty() {
        let compacted_failures = compact_js_failure_lines(&raw_failures);
        let mut out = compacted_failures;
        out.extend(summaries);
        let joined = out.join("\n");
        if joined.chars().count() > MAX_JS_FAILURE_CHARS {
            let head: String = joined.chars().take(4_200).collect();
            let tail_start = out.len().saturating_sub(8);
            let tail = out[tail_start..].join("\n");
            let preview = format!("{head}\n...\n{tail}");
            if let Some(hash) =
                ccr.and_then(|s| s.put(output, &preview, "cmd_filter", "vitest").ok())
            {
                return Some((
                    "vitest_text",
                    format!(
                        "{head}\n... [verbose failures spilled to CCR — `kite ctx retrieve {hash} --search FAIL`] <<ccr:{hash}>>\n{tail}"
                    ),
                ));
            }
        }
        return Some(("vitest_text", joined));
    }
    None
}

fn compact_js_failure_lines(lines: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(lines.len());
    let mut node_mod_run = 0usize;
    let mut dom_lines_seen = 0usize;
    let mut in_dom_dump = false;
    let mut dom_omitted = 0usize;
    let mut seen_headers: HashSet<String> = HashSet::new();
    let mut skip_dup_block = false;

    let flush_node_mods = |run: &mut usize, dst: &mut Vec<String>| {
        if *run > 0 {
            dst.push(format!("    ... ({} node_modules frames omitted)", *run));
            *run = 0;
        }
    };
    let flush_dom = |omitted: &mut usize, in_dom: &mut bool, seen: &mut usize, dst: &mut Vec<String>| {
        if *omitted > 0 {
            dst.push(format!("    ... ({} DOM lines omitted)", *omitted));
        }
        *omitted = 0;
        *in_dom = false;
        *seen = 0;
    };

    for line in lines {
        let t = line.trim();
        if t.starts_with("FAIL ") || t.starts_with("× ") || t.starts_with("✗ ") {
            flush_node_mods(&mut node_mod_run, &mut out);
            flush_dom(&mut dom_omitted, &mut in_dom_dump, &mut dom_lines_seen, &mut out);
            if !seen_headers.insert(t.to_string()) {
                skip_dup_block = true;
                continue;
            }
            skip_dup_block = false;
        }
        if skip_dup_block {
            continue;
        }

        let is_node_mod_frame =
            t.contains("node_modules") && (t.starts_with("at ") || t.contains("node_modules/") || t.contains("node_modules\\"));
        if is_node_mod_frame {
            node_mod_run += 1;
            continue;
        }
        flush_node_mods(&mut node_mod_run, &mut out);

        if t.starts_with("Ignored nodes:") || (t.starts_with("<body") && !in_dom_dump) {
            in_dom_dump = true;
            dom_lines_seen = 0;
        }
        if in_dom_dump {
            if t.starts_with("at ") || t.starts_with("❯ ") || t.starts_with("Expected:") || t.starts_with("Received:") {
                flush_dom(&mut dom_omitted, &mut in_dom_dump, &mut dom_lines_seen, &mut out);
            } else {
                dom_lines_seen += 1;
                if dom_lines_seen <= MAX_DOM_DUMP_LINES {
                    out.push(line.clone());
                } else {
                    dom_omitted += 1;
                }
                continue;
            }
        }

        out.push(line.clone());
    }

    flush_node_mods(&mut node_mod_run, &mut out);
    flush_dom(&mut dom_omitted, &mut in_dom_dump, &mut dom_lines_seen, &mut out);
    out
}

pub fn filter_playwright_with_ccr(
    output: &str,
    exit_code: i32,
    ccr: Option<&CcrStore>,
) -> Option<(&'static str, String)> {
    let mut kept = Vec::new();
    let mut summaries = Vec::new();
    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if (t.starts_with("✓") || t.starts_with("ok ")) && exit_code == 0 {
            continue;
        }
        if t.contains(" passed ") || t.contains(" failed ") || t.starts_with("Running ") {
            if t.contains(" passed") || t.contains(" failed") {
                summaries.push(t.to_string());
            }
            continue;
        }
        if exit_code != 0 {
            kept.push(line.to_string());
        }
    }
    if exit_code == 0 && !summaries.is_empty() {
        return Some(("playwright", summaries.join("\n")));
    }
    if !kept.is_empty() || !summaries.is_empty() {
        kept.extend(summaries);
        let joined = kept.join("\n");
        if joined.chars().count() > MAX_JS_FAILURE_CHARS {
            let spilled = crate::cmd_filters::spill_tail_preserving_ccr_preview(
                output,
                &joined,
                6_000,
                "playwright",
                "Error",
                ccr,
            );
            return Some(("playwright", spilled));
        }
        return Some(("playwright", joined));
    }
    None
}

pub fn filter_eslint_prettier(output: &str, exit_code: i32) -> Option<(&'static str, String)> {
    let mut kept = Vec::new();
    let mut warn_files = 0usize;
    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("Checking formatting") {
            continue;
        }
        if t.starts_with("[warn]") {
            warn_files += 1;
            if warn_files <= 25 {
                kept.push(line.to_string());
            }
            continue;
        }
        kept.push(line.to_string());
    }
    if warn_files > 25 {
        kept.push(format!("... (+{} more formatting warnings)", warn_files - 25));
    }
    if kept.is_empty() && exit_code == 0 {
        return Some(("js_lint", "clean".to_string()));
    }
    Some(("js_lint", kept.join("\n")))
}

pub fn filter_build_or_verify_with_ccr(
    output: &str,
    exit_code: i32,
    ccr: Option<&CcrStore>,
) -> Option<(&'static str, String)> {
    let mut kept = Vec::new();
    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("transforming")
            || t.starts_with("rendering chunks")
            || t.starts_with("computing gzip size")
            || (t.starts_with("dist/") && t.contains("kB") && exit_code == 0)
            || t.starts_with("Compiling ")
            || t.starts_with("Checking ")
            || t.starts_with("Fresh ")
        {
            continue;
        }
        if exit_code == 0 && (t.starts_with("✓ ") || t.starts_with("√ ")) && t.contains(".test.") {
            continue;
        }
        kept.push(line.to_string());
    }
    if kept.is_empty() {
        return None;
    }
    let joined = kept.join("\n");
    if joined.chars().count() > 8_000 {
        let spilled = crate::cmd_filters::spill_tail_preserving_ccr_preview(
            output,
            &joined,
            8_000,
            "npm run",
            "error",
            ccr,
        );
        return Some(("js_build", spilled));
    }
    Some(("js_build", joined))
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

    #[test]
    fn suppresses_logged_error_noise_when_vitest_passes_and_collapses_node_modules_on_failure() {
        let passing_with_stderr = "\
stdout | src/foo.test.ts > handles error
stderr | src/foo.test.ts > handles error
Error: simulated upstream rejection
    at handler (src/foo.ts:12:9)
 ✓ src/foo.test.ts (8)
 Test Files  1 passed (1)
      Tests  8 passed (8)
";
        let (_, pass_out) = filter_js_test(passing_with_stderr, 0).unwrap();
        assert!(!pass_out.contains("simulated upstream rejection"));
        assert!(pass_out.contains("Tests  8 passed (8)"));

        let failing_with_noise = "\
 FAIL  src/bar.test.ts > renders dialog
AssertionError: expected 1 to equal 2
    at src/bar.test.ts:45:12
    at runTest (node_modules/@vitest/runner/dist/index.js:120:5)
    at processTicks (node_modules/vitest/dist/chunks/runtime.js:44:2)
Ignored nodes: comments, script, style
<body>
  <div>
    <span>line 1</span>
    <span>line 2</span>
    <span>line 3</span>
    <span>line 4</span>
    <span>line 5</span>
    <span>line 6</span>
    <span>line 7</span>
    <span>line 8</span>
    <span>line 9</span>
    <span>line 10</span>
    <span>line 11</span>
    <span>line 12</span>
    <span>line 13</span>
    <span>line 14</span>
  </div>
</body>
 Test Files  1 failed (1)
";
        let (_, fail_out) = filter_js_test(failing_with_noise, 1).unwrap();
        assert!(fail_out.contains("AssertionError: expected 1 to equal 2"));
        assert!(fail_out.contains("2 node_modules frames omitted"));
        assert!(fail_out.contains("DOM lines omitted"));

        // Oversized build/verify logs preserve trailing failure diagnostics when spilled to CCR.
        let mut long_build = (0..180)
            .map(|i| format!("build warning #{i}: bundle chunk padding module diagnostic item index"))
            .collect::<Vec<_>>()
            .join("\n");
        long_build.push_str("\nFATAL_TRAILING_BUILD_ERROR: missing export in bundle");
        let ccr = CcrStore::new(crate::store::ContextStore::open_in_memory().unwrap());
        let (_, build_out) = filter_build_or_verify_with_ccr(&long_build, 1, Some(&ccr)).unwrap();
        assert!(build_out.contains("FATAL_TRAILING_BUILD_ERROR: missing export in bundle"));
        assert!(build_out.contains("<<ccr:"));
    }
}
