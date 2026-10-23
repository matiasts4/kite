//! Driver declarations: what each connected driver actually accepts.
//!
//! Every field is copied from the observed matrix in
//! `odd/tasks/agent-sessions-t0.md`. A driver id alone proves nothing: when the
//! binary was absent or a flag was not exercised, the declaration says so
//! instead of inheriting a capability from a sibling driver.

use crate::chat::session::SessionMode;

/// What one driver was observed to accept. This is evidence about the driver,
/// not a permission: the runtime still requires a verified connection and the
/// explicit process opt-in before it keeps a process open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriverDeclaration {
    pub driver: String,
    /// `None` means the driver could not be observed on this machine. Unknown
    /// is deliberately not one of the known modes.
    pub session_mode: Option<SessionMode>,
    pub accepts_model: bool,
    pub accepts_effort: bool,
    pub accepts_permission: bool,
    /// The driver's own plan / build / ask values, when such a switch exists.
    pub work_modes: Vec<String>,
    pub accepts_resume: bool,
    /// Controls this declaration does not provide, each with the reason the
    /// evidence matrix recorded.
    pub unsupported: Vec<(String, String)>,
}

impl DriverDeclaration {
    /// The recorded reason a control is not accepted, when the declaration
    /// says so. A missing control without a reason is a table defect.
    pub fn unsupported_reason(&self, control: &str) -> Option<&str> {
        self.unsupported
            .iter()
            .find(|(name, _)| name == control)
            .map(|(_, reason)| reason.as_str())
    }

    pub fn has_work_mode(&self, mode: &str) -> bool {
        self.work_modes.iter().any(|value| value == mode)
    }
}

pub fn declaration(driver: &str) -> Option<DriverDeclaration> {
    let declared = match driver {
        // Launcher `agy` 1.4.5: `--input-format stream-json` documents a lasting
        // channel; the matrix therefore declares it persistent. The channel
        // itself was not exercised, so nothing here claims a probe result.
        "antigravity" | "agy" => DriverDeclaration {
            driver: "antigravity".to_string(),
            session_mode: Some(SessionMode::Persistent),
            accepts_model: true,
            accepts_effort: true,
            accepts_permission: true,
            work_modes: work_modes(&["plan", "accept-edits", "full-access"]),
            accepts_resume: true,
            unsupported: Vec::new(),
        },
        // The claude binary is absent on this machine. Its session mode is
        // unknown, not one shot: the argv in the tree is not proof.
        "claude" => DriverDeclaration {
            driver: driver.to_string(),
            session_mode: None,
            accepts_model: true,
            accepts_effort: false,
            accepts_permission: true,
            work_modes: work_modes(&["plan", "acceptEdits", "bypassPermissions"]),
            accepts_resume: true,
            unsupported: vec![
                unsupported(
                    "effort",
                    "claude",
                    "no effort flag was observed and the catalog advertises levels only",
                ),
                unsupported(
                    "sessionMode",
                    "claude",
                    "unknown: the binary is absent on this machine, so no lasting channel was observed",
                ),
            ],
        },
        // `codex` 0.163.0 exposes `app-server`, which the matrix classifies as
        // persistent even though its frames were not observed.
        "codex" => DriverDeclaration {
            driver: driver.to_string(),
            session_mode: Some(SessionMode::Persistent),
            accepts_model: true,
            accepts_effort: false,
            accepts_permission: true,
            work_modes: work_modes(&["read-only", "full-auto"]),
            accepts_resume: true,
            unsupported: vec![unsupported(
                "effort",
                "codex",
                "the exec spawn passes no effort flag; levels are advertised only",
            )],
        },
        // `cursor-agent` 2026.10.22 exposes `--resume` and `ls resume`, not a
        // server subcommand, so it is resumable rather than persistent.
        "cursor" => DriverDeclaration {
            driver: driver.to_string(),
            session_mode: Some(SessionMode::Resumable),
            accepts_model: false,
            accepts_effort: false,
            accepts_permission: false,
            work_modes: Vec::new(),
            accepts_resume: true,
            unsupported: vec![
                unsupported("model", "cursor", "no model flag was observed; the spawn passes only -p"),
                unsupported("effort", "cursor", "no effort flag was observed"),
                unsupported("permission", "cursor", "no permission flag was observed"),
                unsupported("workMode", "cursor", "no plan, build, or ask switch was observed"),
            ],
        },
        // `gemini` 0.64.0 exposes `--resume` and `--session-id`, so it is
        // resumable. No model, effort, permission, or work-mode flag was
        // observed for the current spawn.
        "gemini" => DriverDeclaration {
            driver: driver.to_string(),
            session_mode: Some(SessionMode::Resumable),
            accepts_model: false,
            accepts_effort: false,
            accepts_permission: false,
            work_modes: Vec::new(),
            accepts_resume: true,
            unsupported: vec![
                unsupported("model", "gemini", "no model flag was observed on this machine"),
                unsupported("effort", "gemini", "no effort flag was observed"),
                unsupported("permission", "gemini", "no permission flag was observed"),
                unsupported("workMode", "gemini", "no plan, build, or ask switch was observed"),
            ],
        },
        // `grok` 1.0.62 exposes `--resume`, `--session-id`, and
        // `--permission-mode` with six documented values.
        "grok" => DriverDeclaration {
            driver: driver.to_string(),
            session_mode: Some(SessionMode::Resumable),
            accepts_model: false,
            accepts_effort: false,
            accepts_permission: true,
            work_modes: work_modes(&[
                "default",
                "acceptEdits",
                "auto",
                "dontAsk",
                "bypassPermissions",
                "plan",
            ]),
            accepts_resume: true,
            unsupported: vec![
                unsupported("model", "grok", "no model flag was observed on this machine"),
                unsupported("effort", "grok", "no effort flag was observed"),
            ],
        },
        // `opencode` 2.1.4 exposes `serve`, `--server`, `--session`, and `acp`,
        // so the lasting channel exists; its run spawn passes no controls.
        "opencode" => DriverDeclaration {
            driver: driver.to_string(),
            session_mode: Some(SessionMode::Persistent),
            accepts_model: false,
            accepts_effort: false,
            accepts_permission: false,
            work_modes: Vec::new(),
            accepts_resume: true,
            unsupported: vec![
                unsupported("model", "opencode", "the run spawn passes no model; selection was not observed"),
                unsupported("effort", "opencode", "no effort flag was observed"),
                unsupported("permission", "opencode", "no permission flag was observed"),
                unsupported("workMode", "opencode", "no plan, build, or ask switch was observed"),
            ],
        },
        _ => return None,
    };
    Some(declared)
}

fn unsupported(control: &str, driver: &str, detail: &str) -> (String, String) {
    (control.to_string(), format!("{driver}: {detail}"))
}

fn work_modes(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DRIVERS: [&str; 7] = [
        "antigravity",
        "claude",
        "codex",
        "cursor",
        "gemini",
        "grok",
        "opencode",
    ];

    #[test]
    fn the_declaration_table_matches_the_observed_matrix() {
        // driver, session mode, model, effort, permission, resume
        let expected: [(&str, Option<SessionMode>, bool, bool, bool, bool); 7] = [
            ("antigravity", Some(SessionMode::Persistent), true, true, true, true),
            ("codex", Some(SessionMode::Persistent), true, false, true, true),
            ("opencode", Some(SessionMode::Persistent), false, false, false, true),
            ("gemini", Some(SessionMode::Resumable), false, false, false, true),
            ("grok", Some(SessionMode::Resumable), false, false, true, true),
            ("cursor", Some(SessionMode::Resumable), false, false, false, true),
            ("claude", None, true, false, true, true),
        ];

        for (driver, mode, model, effort, permission, resume) in expected {
            let declared = declaration(driver)
                .unwrap_or_else(|| panic!("{driver} must have a declaration"));
            assert_eq!(declared.driver, driver);
            assert_eq!(declared.session_mode, mode, "{driver} session mode");
            assert_eq!(declared.accepts_model, model, "{driver} model");
            assert_eq!(declared.accepts_effort, effort, "{driver} effort");
            assert_eq!(declared.accepts_permission, permission, "{driver} permission");
            assert_eq!(declared.accepts_resume, resume, "{driver} resume");
        }

        assert!(declaration("not-a-driver").is_none());
    }

    #[test]
    fn work_modes_come_from_the_observed_flags() {
        let modes = |driver: &str| {
            declaration(driver)
                .unwrap_or_else(|| panic!("{driver} declaration"))
                .work_modes
        };

        assert_eq!(
            modes("antigravity"),
            vec![
                "plan".to_string(),
                "accept-edits".to_string(),
                "full-access".to_string()
            ]
        );
        assert_eq!(
            modes("claude"),
            vec![
                "plan".to_string(),
                "acceptEdits".to_string(),
                "bypassPermissions".to_string()
            ]
        );
        assert_eq!(
            modes("codex"),
            vec!["read-only".to_string(), "full-auto".to_string()]
        );
        assert_eq!(
            modes("grok"),
            vec![
                "default".to_string(),
                "acceptEdits".to_string(),
                "auto".to_string(),
                "dontAsk".to_string(),
                "bypassPermissions".to_string(),
                "plan".to_string()
            ]
        );
        for driver in ["cursor", "gemini", "opencode"] {
            assert!(modes(driver).is_empty(), "{driver} has no observed work mode");
        }
    }

    #[test]
    fn every_missing_control_carries_a_reason() {
        for driver in DRIVERS {
            let declared = declaration(driver)
                .unwrap_or_else(|| panic!("{driver} declaration"));

            for (control, reason) in &declared.unsupported {
                assert!(!control.trim().is_empty(), "{driver} has an unnamed control");
                assert!(
                    !reason.trim().is_empty(),
                    "{driver} has no reason for {control}"
                );
            }

            let controls = [
                ("model", declared.accepts_model),
                ("effort", declared.accepts_effort),
                ("permission", declared.accepts_permission),
                ("resume", declared.accepts_resume),
                ("workMode", !declared.work_modes.is_empty()),
            ];
            for (control, accepted) in controls {
                if !accepted {
                    assert!(
                        declared.unsupported_reason(control).is_some(),
                        "{driver} must explain the missing {control} control"
                    );
                }
            }
        }
    }

    #[test]
    fn an_unobserved_driver_is_never_classified() {
        let claude = declaration("claude").expect("claude declaration");
        assert_eq!(claude.session_mode, None);
        assert!(claude.unsupported_reason("sessionMode").is_some());
    }

    #[test]
    fn the_program_alias_resolves_to_the_canonical_driver() {
        let canonical = declaration("antigravity").expect("antigravity declaration");
        let alias = declaration("agy").expect("agy declaration");

        assert_eq!(alias.driver, "antigravity");
        assert_eq!(alias.session_mode, canonical.session_mode);
        assert_eq!(alias.unsupported, canonical.unsupported);
    }
}
