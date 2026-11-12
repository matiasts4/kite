use serde_json::{json, Value};
use std::path::PathBuf;

pub fn provider_agents(provider: &str) -> Vec<Value> {
    let canon = match provider {
        "agy" => "antigravity",
        "claude-code" => "claude",
        "open-code" => "opencode",
        other => other,
    };

    let mut modes = vec![
        json!({
            "id": "build",
            "label": "Build",
            "detail": "Works with the permission mode below",
            "plan": false,
        }),
        json!({
            "id": "plan",
            "label": "Plan",
            "detail": "Reads and plans, changes nothing",
            "plan": true,
        }),
    ];

    if canon == "opencode" {
        if let Some(custom_agents) = read_opencode_config_agents() {
            for agent in custom_agents {
                let id = agent.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id != "build" && id != "plan" {
                    modes.push(agent);
                }
            }
        }
    }

    modes
}

fn read_opencode_config_agents() -> Option<Vec<Value>> {
    let mut candidates = Vec::new();
    if let Ok(user) = std::env::var("USERPROFILE") {
        candidates.push(PathBuf::from(&user).join(".config").join("opencode").join("opencode.json"));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(&home).join(".config").join("opencode").join("opencode.json"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(&local).join("opencode").join("opencode.json"));
    }
    candidates.push(PathBuf::from(".opencode").join("opencode.json"));

    for path in candidates {
        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    if let Some(agents_obj) = val.get("agent").and_then(|v| v.as_object()) {
                        let mut list = Vec::new();
                        for (key, agent_data) in agents_obj {
                            let hidden = agent_data
                                .get("hidden")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            if hidden {
                                continue;
                            }
                            let desc = agent_data
                                .get("description")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let mode = agent_data
                                .get("mode")
                                .and_then(|v| v.as_str())
                                .unwrap_or("subagent");
                            let model = agent_data
                                .get("model")
                                .and_then(|v| v.as_str());

                            // Generate human-friendly label
                            let label = key
                                .split(&['-', '_'][..])
                                .map(|w| {
                                    let mut chars = w.chars();
                                    match chars.next() {
                                        None => String::new(),
                                        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
                                    }
                                })
                                .collect::<Vec<_>>()
                                .join(" ");

                            let detail = if !desc.is_empty() {
                                desc.to_string()
                            } else {
                                format!("Mode: {mode}")
                            };

                            let mut entry = json!({
                                "id": key,
                                "label": label,
                                "detail": detail,
                                "plan": false,
                                "mode": mode,
                            });
                            if let Some(m) = model {
                                entry["model"] = json!(m);
                            }
                            list.push(entry);
                        }
                        return Some(list);
                    }
                }
            }
        }
    }
    None
}
