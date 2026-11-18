use std::collections::BTreeMap;

pub fn filter_pytest(output: &str, exit_code: i32) -> Option<(&'static str, String)> {
    let mut kept = Vec::new();
    let mut in_failures = false;

    for line in output.lines() {
        let t = line.trim();
        if t.contains(" PASSED") && !in_failures {
            continue;
        }
        if t.starts_with("=== FAILURES ===") || t.starts_with("___ ") {
            in_failures = true;
            kept.push(line.to_string());
            continue;
        }
        if t.starts_with("=== ") && t.ends_with(" ===") {
            in_failures = false;
            kept.push(t.to_string());
            continue;
        }
        if in_failures || t.starts_with("E   ") || t.contains(" FAILED") || t.starts_with("FAILED ") {
            kept.push(line.to_string());
        }
    }

    if kept.is_empty() && exit_code == 0 {
        return None;
    }
    if kept.is_empty() {
        return None;
    }
    Some(("pytest", kept.join("\n")))
}

pub fn filter_python_lint(output: &str) -> Option<(&'static str, String)> {
    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut tail = Vec::new();

    for line in output.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let mut parts = t.splitn(3, ':');
        if let (Some(file), Some(line_no), Some(rest)) = (parts.next(), parts.next(), parts.next()) {
            if line_no.bytes().all(|b| b.is_ascii_digit()) && !line_no.is_empty() {
                grouped
                    .entry(file.to_string())
                    .or_default()
                    .push(format!("  {line_no}:{}", rest.trim_start()));
                continue;
            }
        }
        tail.push(line.to_string());
    }

    if grouped.is_empty() {
        return None;
    }

    let mut out = Vec::new();
    for (file, rows) in grouped {
        out.push(format!("{file} ({}):", rows.len()));
        out.extend(rows);
    }
    out.extend(tail);
    Some(("python_lint", out.join("\n")))
}
