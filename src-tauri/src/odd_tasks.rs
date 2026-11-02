// Kite Code — ODD Task Store (Outcome-Driven Development)
// File-based task repository under <workspace>/.kite/tasks/<slug>.md
//
// Follows benchmarked non-blocking task runner principles:
// "Pass spec by reference, never paraphrase. Subagents read .kite/tasks/<slug>.md verbatim."

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Convert a title or phrase into a clean URL-friendly kebab-case slug
pub fn slugify(title: &str) -> String {
    let mut result = String::new();
    let mut last_was_dash = false;

    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            result.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if ch == ' ' || ch == '-' || ch == '_' || ch == '.' || ch == '/' || ch == '\\' {
            if !last_was_dash && !result.is_empty() {
                result.push('-');
                last_was_dash = true;
            }
        }
    }

    let trimmed = result.trim_matches('-');
    if trimmed.is_empty() {
        "task".to_string()
    } else {
        trimmed.to_string()
    }
}

fn resolve_tasks_dir(cwd_opt: Option<&str>) -> PathBuf {
    let base = cwd_opt
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    base.join(".kite").join("tasks")
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OddTaskSummary {
    pub slug: String,
    pub title: String,
    pub status: String,
    pub engine: String,
    pub relative_path: String,
    pub total_checks: usize,
    pub completed_checks: usize,
    pub modified_at_unix_ms: u128,
}

/// Creates a new ODD specification task file under .kite/tasks/<slug>.md
///
/// Returns:
/// {
///   "success": true,
///   "slug": "20261018-login-oauth",
///   "taskFilePath": "E:/kite/.kite/tasks/20261018-login-oauth.md",
///   "relativePath": ".kite/tasks/20261018-login-oauth.md",
///   "subagentPrompt": "Desarrolla la tarea ODD especificada en .kite/tasks/..."
/// }
#[tauri::command]
pub fn create_odd_task_file(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);

    let cwd = req.get("cwd").and_then(|v| v.as_str());
    let title = req
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Tarea sin título")
        .trim();

    let subagent_engine = req
        .get("subagentEngine")
        .or_else(|| req.get("engine"))
        .and_then(|v| v.as_str())
        .unwrap_or("grok")
        .trim();

    let objective = req
        .get("objective")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    let spec = req
        .get("spec")
        .or_else(|| req.get("implementationDetails"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    let constraints: Vec<String> = req
        .get("constraints")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let verification_steps: Vec<String> = req
        .get("verificationSteps")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let acceptance_criteria: Vec<String> = req
        .get("acceptanceCriteria")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let slug = req
        .get("slug")
        .and_then(|v| v.as_str())
        .map(slugify)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| slugify(title));

    let tasks_dir = resolve_tasks_dir(cwd);
    if let Err(err) = fs::create_dir_all(&tasks_dir) {
        return json!({
            "success": false,
            "error": format!("No se pudo crear el directorio .kite/tasks: {err}")
        });
    }

    let file_path = tasks_dir.join(format!("{slug}.md"));
    let relative_path = format!(".kite/tasks/{slug}.md");

    // Format Markdown content matching the canonical 5-section ODD specification
    let mut md = String::new();
    md.push_str(&format!("# Task: {title}\n"));
    md.push_str("**Status**: pending\n");
    md.push_str(&format!("**Assigned Engine**: {subagent_engine}\n"));
    md.push_str(&format!("**Created Unix Ms**: {}\n\n", now_unix_ms()));

    md.push_str("## 1. Objective\n");
    if objective.is_empty() {
        md.push_str("Implementar la funcionalidad descrita en la especificación técnica.\n\n");
    } else {
        md.push_str(objective);
        md.push_str("\n\n");
    }

    md.push_str("## 2. Specification & Implementation Details\n");
    if spec.is_empty() {
        md.push_str("Revisa los requisitos acordados con el orquestador.\n\n");
    } else {
        md.push_str(spec);
        md.push_str("\n\n");
    }

    md.push_str("## 3. Constraints & Invariants\n");
    if constraints.is_empty() {
        md.push_str("- No modifiques archivos fuera del alcance sin justificación.\n");
        md.push_str("- Mantén compatibilidad y preserva comentarios existentes.\n");
        md.push_str("- Trabaja directamente sobre el workspace actual (sin Git worktrees).\n\n");
    } else {
        for c in &constraints {
            md.push_str(&format!("- {c}\n"));
        }
        md.push('\n');
    }

    md.push_str("## 4. Verification & Testing Steps\n");
    if verification_steps.is_empty() {
        md.push_str("1. Ejecuta la suite de pruebas del proyecto (`cargo test`, `npm test` o similar).\n");
        md.push_str("2. Verifica que no haya errores de compilación ni de tipado.\n\n");
    } else {
        for (idx, step) in verification_steps.iter().enumerate() {
            md.push_str(&format!("{}. {step}\n", idx + 1));
        }
        md.push('\n');
    }

    md.push_str("## 5. Acceptance Checklist\n");
    if acceptance_criteria.is_empty() {
        md.push_str("- [ ] Código implementado siguiendo la especificación\n");
        md.push_str("- [ ] Pruebas ejecutadas y pasando satisfactoriamente\n");
        md.push_str("- [ ] Verificación final completada\n");
    } else {
        for item in &acceptance_criteria {
            md.push_str(&format!("- [ ] {item}\n"));
        }
    }

    if let Err(err) = fs::write(&file_path, &md) {
        return json!({
            "success": false,
            "error": format!("Error escribiendo archivo {}: {err}", file_path.display())
        });
    }

    let subagent_prompt = format!(
        "Desarrolla la tarea ODD especificada en {relative_path}. Sigue estrictamente la especificación, no asumas cambios fuera del alcance, ejecuta las pruebas descritas en la sección 4 y marca los checkboxes en la sección 5 al finalizar."
    );

    json!({
        "success": true,
        "slug": slug,
        "taskFilePath": file_path.to_string_lossy(),
        "relativePath": relative_path,
        "subagentPrompt": subagent_prompt
    })
}

/// Lists all ODD tasks in .kite/tasks/
#[tauri::command]
pub fn list_odd_task_files(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let cwd = req.get("cwd").and_then(|v| v.as_str());
    let tasks_dir = resolve_tasks_dir(cwd);

    if !tasks_dir.is_dir() {
        return json!({
            "tasks": []
        });
    }

    let mut tasks = Vec::new();

    if let Ok(entries) = fs::read_dir(&tasks_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                let slug = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();

                if let Ok(content) = fs::read_to_string(&path) {
                    let mut title = slug.clone();
                    let mut status = "pending".to_string();
                    let mut engine = "grok".to_string();
                    let mut total_checks = 0;
                    let mut completed_checks = 0;

                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed.starts_with("# Task:") {
                            title = trimmed.trim_start_matches("# Task:").trim().to_string();
                        } else if trimmed.starts_with("# ") && title == slug {
                            title = trimmed.trim_start_matches('#').trim().to_string();
                        } else if trimmed.to_ascii_lowercase().starts_with("**status**:") {
                            status = trimmed
                                .split(':')
                                .nth(1)
                                .unwrap_or("pending")
                                .trim()
                                .to_string();
                        } else if trimmed.to_ascii_lowercase().starts_with("**assigned engine**:") {
                            engine = trimmed
                                .split(':')
                                .nth(1)
                                .unwrap_or("grok")
                                .trim()
                                .to_string();
                        } else if trimmed.starts_with("- [ ]") {
                            total_checks += 1;
                        } else if trimmed.starts_with("- [x]") || trimmed.starts_with("- [X]") {
                            total_checks += 1;
                            completed_checks += 1;
                        }
                    }

                    let modified_at_unix_ms = entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis())
                        .unwrap_or(0);

                    let relative_path = format!(".kite/tasks/{slug}.md");

                    tasks.push(OddTaskSummary {
                        slug,
                        title,
                        status,
                        engine,
                        relative_path,
                        total_checks,
                        completed_checks,
                        modified_at_unix_ms,
                    });
                }
            }
        }
    }

    // Sort descending by modification time
    tasks.sort_by(|a, b| b.modified_at_unix_ms.cmp(&a.modified_at_unix_ms));

    json!({
        "tasks": tasks
    })
}

/// Updates the status field of an ODD task file
#[tauri::command]
pub fn update_odd_task_status(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let cwd = req.get("cwd").and_then(|v| v.as_str());
    let slug = req
        .get("slug")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let new_status = req
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("in_progress")
        .trim();

    if slug.is_empty() {
        return json!({ "success": false, "error": "Falta el parámetro slug" });
    }

    let tasks_dir = resolve_tasks_dir(cwd);
    let file_path = tasks_dir.join(format!("{slug}.md"));

    if !file_path.is_file() {
        return json!({
            "success": false,
            "error": format!("No se encontró la tarea {}", file_path.display())
        });
    }

    match fs::read_to_string(&file_path) {
        Ok(content) => {
            let mut updated_lines = Vec::new();
            let mut found_status = false;

            for line in content.lines() {
                if line.trim().to_ascii_lowercase().starts_with("**status**:") {
                    updated_lines.push(format!("**Status**: {new_status}"));
                    found_status = true;
                } else {
                    updated_lines.push(line.to_string());
                }
            }

            if !found_status {
                // Insert after title
                if !updated_lines.is_empty() {
                    updated_lines.insert(1, format!("**Status**: {new_status}"));
                } else {
                    updated_lines.push(format!("**Status**: {new_status}"));
                }
            }

            let new_content = updated_lines.join("\n");
            if let Err(e) = fs::write(&file_path, new_content) {
                return json!({ "success": false, "error": format!("Error escribiendo: {e}") });
            }

            json!({
                "success": true,
                "slug": slug,
                "status": new_status
            })
        }
        Err(e) => json!({ "success": false, "error": format!("Error leyendo archivo: {e}") }),
    }
}

/// Reads the raw Markdown content of an ODD task file
#[tauri::command]
pub fn get_odd_task_content(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let cwd = req.get("cwd").and_then(|v| v.as_str());
    let slug = req
        .get("slug")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if slug.is_empty() {
        return json!({ "success": false, "error": "Falta el parámetro slug" });
    }

    let tasks_dir = resolve_tasks_dir(cwd);
    let file_path = tasks_dir.join(format!("{slug}.md"));

    match fs::read_to_string(&file_path) {
        Ok(content) => json!({
            "success": true,
            "slug": slug,
            "content": content,
            "relativePath": format!(".kite/tasks/{slug}.md")
        }),
        Err(e) => json!({
            "success": false,
            "error": format!("No se pudo leer la tarea {}: {e}", file_path.display())
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("Implement Login Modal"), "implement-login-modal");
        assert_eq!(
            slugify("Refactor auth & tokens / v2"),
            "refactor-auth-tokens-v2"
        );
        assert_eq!(slugify("   ---hello---world---   "), "hello-world");
        assert_eq!(slugify(""), "task");
    }

    #[test]
    fn test_create_and_manage_odd_task() {
        let temp_dir = std::env::temp_dir().join(format!("kite_odd_test_{}", now_unix_ms()));
        let temp_dir_str = temp_dir.to_str().unwrap();

        // 1. Create ODD Task
        let create_res = create_odd_task_file(json!({
            "cwd": temp_dir_str,
            "title": "Migrate Token Auth",
            "subagentEngine": "grok",
            "objective": "Migrate from local storage to secure cookie tokens",
            "spec": "Replace localStorage.getItem with httpOnly cookie calls",
            "constraints": ["No breaking API changes", "Maintain backward compatibility"],
            "verificationSteps": ["cargo test", "npm run test:auth"],
            "acceptanceCriteria": ["Cookies sent on requests", "Token refreshed on 401"]
        }));

        assert_eq!(create_res["success"], true);
        let slug = create_res["slug"].as_str().unwrap();
        assert_eq!(slug, "migrate-token-auth");
        let task_file_path = create_res["taskFilePath"].as_str().unwrap();
        assert!(Path::new(task_file_path).is_file());

        // 2. Read content
        let content_res = get_odd_task_content(json!({
            "cwd": temp_dir_str,
            "slug": slug
        }));
        assert_eq!(content_res["success"], true);
        let content = content_res["content"].as_str().unwrap();
        assert!(content.contains("# Task: Migrate Token Auth"));
        assert!(content.contains("**Assigned Engine**: grok"));
        assert!(content.contains("## 1. Objective"));
        assert!(content.contains("## 5. Acceptance Checklist"));
        assert!(content.contains("- [ ] Cookies sent on requests"));

        // 3. List tasks
        let list_res = list_odd_task_files(json!({
            "cwd": temp_dir_str
        }));
        let tasks = list_res["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["slug"], "migrate-token-auth");
        assert_eq!(tasks[0]["status"], "pending");
        assert_eq!(tasks[0]["total_checks"], 2);
        assert_eq!(tasks[0]["completed_checks"], 0);

        // 4. Update status
        let update_res = update_odd_task_status(json!({
            "cwd": temp_dir_str,
            "slug": slug,
            "status": "completed"
        }));
        assert_eq!(update_res["success"], true);
        assert_eq!(update_res["status"], "completed");

        let updated_content = fs::read_to_string(task_file_path).unwrap();
        assert!(updated_content.contains("**Status**: completed"));

        // Clean up
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
