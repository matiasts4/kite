    use super::*;

    fn ids(raw: &str) -> Vec<String> {
        parse_opencode_models(raw)
            .iter()
            .filter_map(|model| model.get("id").and_then(|value| value.as_str()))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn catalog_availability_names_the_three_empty_signals() {
        assert_eq!(classify_catalog_availability(false, None), "missing-binary");
        assert_eq!(classify_catalog_availability(false, Some(true)), "missing-binary");
        assert_eq!(classify_catalog_availability(true, Some(false)), "signed-out");
        assert_eq!(classify_catalog_availability(true, Some(true)), "ready");
        assert_eq!(classify_catalog_availability(true, None), "ready");
    }

    #[test]
    fn providers_without_a_list_command_return_no_invented_models() {
        for provider in ["claude", "gemini", "codex"] {
            let value = provider_models(provider, true);
            let models = value
                .get("models")
                .and_then(|entry| entry.as_array())
                .cloned()
                .unwrap_or_default();
            assert!(
                models.is_empty(),
                "{provider} returned invented models: {models:?}"
            );
        }
    }

    #[test]
    fn parses_provider_model_lines_and_drops_duplicates() {
        let raw = "google/gemini-3.1-pro-preview\n\nnot-a-model\ngoogle/gemini-3.1-pro-preview\nopenai/gpt-5.6-sol\n";
        assert_eq!(
            ids(raw),
            vec![
                "google/gemini-3.1-pro-preview".to_string(),
                "openai/gpt-5.6-sol".to_string()
            ]
        );
    }

    #[test]
    fn rejects_ids_with_whitespace_or_an_invalid_start() {
        let raw = "google/gemini 3\n-/bad\n/model\nok/model-1\n";
        assert_eq!(ids(raw), vec!["ok/model-1".to_string()]);
    }

    #[test]
    fn a_list_without_a_provider_prefix_yields_no_models() {
        assert!(ids("auto\ncomposer\ndefault\n").is_empty());
    }

    #[test]
    fn parses_grok_models_output() {
        let raw = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n";
        let parsed: Vec<String> = parse_grok_models(raw)
            .iter()
            .filter_map(|model| model.get("id").and_then(|value| value.as_str()))
            .map(str::to_string)
            .collect();
        assert_eq!(
            parsed,
            vec![
                "grok-4.7".to_string(),
                "grok-4.7-build-fast".to_string(),
                "grok-4.6".to_string(),
                "grok-4.5".to_string()
            ]
        );
    }

    #[test]
    fn parses_grok_models_when_the_default_is_not_in_the_list() {
        let raw = "You logged in with grok.com.\nDefault model: grok-4.6 (not in list below)\nAvailable models:\n";
        let parsed: Vec<String> = parse_grok_models(raw)
            .iter()
            .filter_map(|model| model.get("id").and_then(|value| value.as_str()))
            .map(str::to_string)
            .collect();
        assert_eq!(parsed, vec!["grok-4.6".to_string()]);
    }

    #[test]
    fn parses_grok_catalog_names_effort_and_skips_hidden() {
        let raw = r#"{
            "models": {
                "grok-4.7": {
                    "info": {
                        "name": "Grok 4.7",
                        "description": "Frontier",
                        "hidden": false,
                        "supports_reasoning_effort": true,
                        "reasoning_effort": "high",
                        "reasoning_efforts": [
                            {"id": "xhigh"},
                            {"id": "high"},
                            {"id": "medium"},
                            {"id": "low"}
                        ]
                    }
                },
                "grok-4.5": {
                    "info": {
                        "name": "Grok 4.5",
                        "hidden": false,
                        "supports_reasoning_effort": true,
                        "reasoning_effort": "low",
                        "reasoning_efforts": [{"id": "high"}, {"id": "medium"}, {"id": "low"}]
                    }
                },
                "grok-hidden": {
                    "info": {
                        "name": "Hidden",
                        "hidden": true,
                        "supports_reasoning_effort": true,
                        "reasoning_efforts": [{"id": "low"}, {"id": "high"}]
                    }
                }
            }
        }"#;
        let parsed = parse_grok_catalog_models(raw);
        let ids: Vec<&str> = parsed
            .iter()
            .filter_map(|model| model.get("id").and_then(|value| value.as_str()))
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"grok-4.7"));
        assert!(ids.contains(&"grok-4.5"));
        assert!(!ids.contains(&"grok-hidden"));
        let seven = parsed
            .iter()
            .find(|model| model.get("id").and_then(|value| value.as_str()) == Some("grok-4.7"))
            .expect("grok-4.7");
        assert_eq!(seven.get("name").and_then(|value| value.as_str()), Some("Grok 4.7"));
        assert_eq!(seven.get("supportsEffort").and_then(|value| value.as_bool()), Some(true));
        let levels: Vec<&str> = seven
            .get("effortLevels")
            .and_then(|value| value.as_array())
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        assert_eq!(levels, vec!["low", "medium", "high", "xhigh"]);
        assert_eq!(seven.get("defaultEffort").and_then(|value| value.as_str()), Some("high"));
        let five = parsed
            .iter()
            .find(|model| model.get("id").and_then(|value| value.as_str()) == Some("grok-4.5"))
            .expect("grok-4.5");
        let five_levels: Vec<&str> = five
            .get("effortLevels")
            .and_then(|value| value.as_array())
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        assert_eq!(five_levels, vec!["low", "medium", "high"]);
    }

    #[test]
    fn parses_cursor_models_output() {
        let raw = "Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex-low - Codex 5.3 Low\ngpt-5.3-codex - Codex 5.3\n";
        let parsed = parse_cursor_models(raw);
        let ids: Vec<&str> = parsed
            .iter()
            .filter_map(|model| model.get("id").and_then(|value| value.as_str()))
            .collect();
        assert_eq!(ids, vec!["auto", "gpt-5.3-codex-low", "gpt-5.3-codex"]);
        let names: Vec<&str> = parsed
            .iter()
            .filter_map(|model| model.get("name").and_then(|value| value.as_str()))
            .collect();
        assert_eq!(names[1], "Codex 5.3 Low");
    }

    #[test]
    fn parses_opencode_agents_default_and_custom() {
        let agents = provider_agents("opencode");
        assert!(agents.iter().any(|a| a.get("id").and_then(|v| v.as_str()) == Some("build")));
        assert!(agents.iter().any(|a| a.get("id").and_then(|v| v.as_str()) == Some("plan")));
        // If local opencode.json exists, gentle-orchestrator should be present
        if std::path::Path::new(&format!("{}/.config/opencode/opencode.json", std::env::var("USERPROFILE").unwrap_or_default())).is_file() {
            assert!(agents.iter().any(|a| a.get("id").and_then(|v| v.as_str()) == Some("gentle-orchestrator")));
        }
    }

    #[test]
    fn sorts_effort_levels_in_canonical_progression() {
        let mut tiers = vec![
            "high".to_string(),
            "ultra".to_string(),
            "max".to_string(),
            "minimal".to_string(),
            "low".to_string(),
            "xhigh".to_string(),
            "medium".to_string(),
        ];
        sort_effort_levels(&mut tiers);
        assert_eq!(
            tiers,
            vec!["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        );
    }

    #[test]
    fn parses_agy_models_merging_effort_suffixes() {
        let raw = "gemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\ngemini-4-argon-low\tGemini 4 Argon (Low)\n";
        let parsed = parse_agy_models(raw);
        assert_eq!(parsed.len(), 1);
        let model = &parsed[0];
        assert_eq!(model.get("id").and_then(|v| v.as_str()), Some("gemini-4-argon"));
        assert_eq!(model.get("supportsEffort").and_then(|v| v.as_bool()), Some(true));
        let levels: Vec<&str> = model
            .get("effortLevels")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(levels, vec!["low", "medium", "high"]);
        assert_eq!(model.get("defaultEffort").and_then(|v| v.as_str()), Some("medium"));
    }

    #[test]
    fn parses_opencode_models_with_custom_variants_and_names() {
        let config = json!({
            "provider": {
                "google": {
                    "models": {
                        "gemini-3-flash": {
                            "name": "Gemini 3 Flash Custom",
                            "variants": {
                                "high": { "thinkingLevel": "high" },
                                "low": { "thinkingLevel": "low" },
                                "minimal": { "thinkingLevel": "minimal" },
                                "medium": { "thinkingLevel": "medium" }
                            }
                        },
                        "claude-opus-thinking": {
                            "name": "Claude Opus Thinking",
                            "variants": {
                                "low": {},
                                "max": {}
                            }
                        }
                    }
                }
            },
            "model": "google/gemini-3-flash",
            "variant": "high"
        });

        let raw = "google/gemini-3-flash\ngoogle/claude-opus-thinking\n";
        let models = parse_opencode_models_inner(raw, Some(&config));
        assert_eq!(models.len(), 2);

        let flash = &models[0];
        assert_eq!(flash.get("name").and_then(|v| v.as_str()), Some("Gemini 3 Flash Custom"));
        assert_eq!(flash.get("supportsEffort").and_then(|v| v.as_bool()), Some(true));
        let flash_levels: Vec<&str> = flash
            .get("effortLevels")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(flash_levels, vec!["minimal", "low", "medium", "high"]);
        assert_eq!(flash.get("defaultEffort").and_then(|v| v.as_str()), Some("high"));

        let opus = &models[1];
        assert_eq!(opus.get("name").and_then(|v| v.as_str()), Some("Claude Opus Thinking"));
        let opus_levels: Vec<&str> = opus
            .get("effortLevels")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(opus_levels, vec!["low", "max"]);
    }

    #[test]
    fn parses_agy_models_collapsing_an_ultra_suffix() {
        let raw = "gemini-4-argon-ultra\tGemini 4 Argon (Ultra)\ngemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-4-argon-max\tGemini 4 Argon (Max)\n";
        let parsed = parse_agy_models(raw);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].get("id").and_then(|v| v.as_str()), Some("gemini-4-argon"));
        assert_eq!(parsed[0].get("name").and_then(|v| v.as_str()), Some("Gemini 4 Argon"));
        let levels: Vec<&str> = parsed[0]
            .get("effortLevels")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(levels, vec!["low", "max", "ultra"]);
    }

    #[test]
    fn a_single_agy_tier_does_not_advertise_effort() {
        let parsed = parse_agy_models("plain-ultra\tPlain (Ultra)\n");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].get("supportsEffort").and_then(|v| v.as_bool()), Some(false));
        assert!(parsed[0].get("effortLevels").is_none());
    }

    #[test]
    fn grok_text_list_has_no_invented_effort_until_the_catalog_says_so() {
        let raw = "Available models:\n  * grok-4.7 (default)\n  - grok-4.5\n";
        let mut models = parse_grok_models(raw);
        assert_eq!(models[0].get("supportsEffort").and_then(|v| v.as_bool()), Some(false));

        let catalog = r#"{
            "models": {
                "grok-4.7": {
                    "info": {
                        "supports_reasoning_effort": true,
                        "reasoning_effort": "high",
                        "reasoning_efforts": [
                            {"id": "xhigh"},
                            {"id": "high"},
                            {"id": "medium"},
                            {"id": "low"}
                        ]
                    }
                },
                "grok-4.5": {
                    "info": {
                        "supports_reasoning_effort": true,
                        "reasoning_effort": "low",
                        "reasoning_efforts": [{"id": "minimal"}]
                    }
                }
            }
        }"#;
        let menus = parse_grok_effort_menus(catalog);
        apply_grok_effort_menus(&mut models, &menus);

        assert_eq!(models[0].get("supportsEffort").and_then(|v| v.as_bool()), Some(true));
        let levels: Vec<&str> = models[0]
            .get("effortLevels")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(levels, vec!["low", "medium", "high", "xhigh"]);
        assert_eq!(models[0].get("defaultEffort").and_then(|v| v.as_str()), Some("high"));
        assert_eq!(models[1].get("supportsEffort").and_then(|v| v.as_bool()), Some(false));
        assert!(models[1].get("effortLevels").is_none());
    }

    #[test]
    fn opencode_variants_include_ultra_and_a_single_variant_stays_off() {
        let config = json!({
            "provider": {
                "xai": {
                    "models": {
                        "grok-ceiling": {
                            "name": "Grok Ceiling",
                            "variants": { "low": {}, "ultra": {}, "high": {} }
                        },
                        "solo": {
                            "name": "Solo",
                            "variants": { "ultra": {} }
                        }
                    }
                }
            }
        });
        let models = parse_opencode_models_inner("xai/grok-ceiling\nxai/solo\n", Some(&config));
        let ceiling = &models[0];
        let levels: Vec<&str> = ceiling
            .get("effortLevels")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(levels, vec!["low", "high", "ultra"]);
        assert_eq!(models[1].get("supportsEffort").and_then(|v| v.as_bool()), Some(false));
    }
