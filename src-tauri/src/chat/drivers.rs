//! Driver declarations: what each connected driver actually accepts.
//!
//! Every field is copied from the observed matrix in
//! `odd/tasks/agent-sessions-t0.md`. A driver id alone proves nothing: when the
//! binary was absent or a flag was not exercised, the declaration says so
//! instead of inheriting a capability from a sibling driver.
//!
//! A declaration also carries the version evidence a lasting transport needs:
//! the probe arguments, the newest observed version and the minimum this build
//! accepts, plus the fixture that records the observed probe output. The wire
//! field says whether this build actually speaks the lasting channel; a driver
//! whose wire is documented only in part is refused instead of approximated.

use std::fmt;
use std::path::Path;
use std::time::Duration;

use crate::chat::session::SessionMode;
use crate::chat::utils::chat_log;
use crate::hidden_exec::run;

/// Why this build cannot keep a Codex turn on one process. `codex app-server
/// --help` documents the stdio transport and the schema tooling, but not a
/// request frame that accepts a user turn, so no frame is invented here.
pub const CODEX_APP_SERVER_GAP: &str =
    "codex: `codex app-server --help` documents the stdio transport and the schema tooling, but no request frame that accepts a user turn, so this build does not invent one and keeps codex on one command per turn";

/// Why Claude has no lasting wire in this build. The binary is absent, so no
/// channel and no version were observed; unknown stays unknown.
pub const CLAUDE_UNOBSERVED: &str =
    "claude: the binary is absent on this machine, so no lasting channel and no version were observed";

/// A parsed `major.minor.patch` version. Build and prerelease suffixes are
/// ignored: the minimum check only compares released numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Version {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }
}

impl fmt::Display for Version {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Reads the first version-shaped token in a probe's output. Real CLIs prefix
/// the number with their own name or a `v`, so the parser scans tokens instead
/// of demanding one exact shape. A token that is not exactly three numeric
/// components is ignored, which keeps a word or a build id from passing as a
/// version.
pub fn parse_version(raw: &str) -> Option<Version> {
    raw.split_whitespace().find_map(parse_version_token)
}

fn parse_version_token(token: &str) -> Option<Version> {
    let token = token.trim_start_matches(['v', 'V']);
    let token = token.split(['-', '+']).next()?;
    let mut parts = token.split('.');
    let major = parse_component(parts.next()?)?;
    let minor = parse_component(parts.next()?)?;
    let patch = parse_component(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    Some(Version::new(major, minor, patch))
}

fn parse_component(part: &str) -> Option<u32> {
    if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    part.parse().ok()
}

/// Version evidence for one lasting transport. `fixture` is crate-relative so
/// tests can open it from `CARGO_MANIFEST_DIR` and compare it with `observed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriverVersion {
    /// Arguments appended to the driver program to print its version.
    pub probe_args: Vec<&'static str>,
    /// The newest version this build was written against.
    pub observed: Version,
    /// The oldest version this build accepts. Anything older fails closed.
    pub minimum: Version,
    /// Recorded probe output, relative to `src-tauri`.
    pub fixture: &'static str,
}

/// What a probe printed, or the reason it could not be read.
pub trait DriverProbe: fmt::Debug + Send {
    fn probe(
        &self,
        driver: &str,
        program: &Path,
        evidence: &DriverVersion,
    ) -> Result<String, String>;
}

/// The real probe: it runs the driver's own documented version flag. It is a
/// separate type so a test can supply a version without starting a process.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemDriverProbe;

impl DriverProbe for SystemDriverProbe {
    fn probe(
        &self,
        driver: &str,
        program: &Path,
        evidence: &DriverVersion,
    ) -> Result<String, String> {
        let output = run(program, &evidence.probe_args, Duration::from_secs(10)).map_err(|error| {
            format!(
                "could not run the {driver} version probe ({}): {error}",
                program.display()
            )
        })?;
        if output.timed_out {
            return Err(format!(
                "the {driver} version probe did not finish within ten seconds"
            ));
        }
        if output.code != Some(0) {
            return Err(format!(
                "the {driver} version probe exited with status {:?}: {}",
                output.code,
                probe_excerpt(&String::from_utf8_lossy(&output.stderr))
            ));
        }
        let stdout = output.stdout_lossy();
        let raw = if stdout.trim().is_empty() {
            String::from_utf8_lossy(&output.stderr).into_owned()
        } else {
            stdout
        };
        // The raw output is the preserved log for an accepted or rejected
        // version. A diagnostic in the thread is bounded; this line is not.
        chat_log(&format!(
            "driver version probe: driver={driver}, program={}, raw={}",
            program.display(),
            raw.trim()
        ));
        Ok(raw)
    }
}

/// Compares a probe's output with the declared minimum. A lower version and an
/// unreadable output are both failures, so a mismatch never starts a process.
pub fn evaluate_version(raw: &str, evidence: &DriverVersion) -> Result<Version, String> {
    let observed = parse_version(raw).ok_or_else(|| {
        format!(
            "the version probe printed no version number (raw: {})",
            probe_excerpt(raw)
        )
    })?;
    if observed < evidence.minimum {
        return Err(format!(
            "the installed version {observed} is older than the minimum {}",
            evidence.minimum
        ));
    }
    Ok(observed)
}

fn probe_excerpt(raw: &str) -> String {
    let clipped: String = raw.trim().chars().take(160).collect();
    if clipped.is_empty() {
        "<no output>".to_string()
    } else {
        clipped
    }
}

/// Whether this build speaks the driver's documented lasting wire. `Supported`
/// means an adapter exists; `Unsupported` means the documented surface is not
/// enough to keep a turn on one process, and the reason names the gap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireSupport {
    Supported,
    Unsupported { reason: String },
}

impl WireSupport {
    pub fn is_supported(&self) -> bool {
        matches!(self, WireSupport::Supported)
    }

    pub fn unsupported_reason(&self) -> Option<&str> {
        match self {
            WireSupport::Supported => None,
            WireSupport::Unsupported { reason } => Some(reason.as_str()),
        }
    }

    fn unsupported(reason: &str) -> Self {
        WireSupport::Unsupported {
            reason: reason.to_string(),
        }
    }
}

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
    /// Version evidence for the lasting transport. Present only when this
    /// build has an adapter for the driver's wire.
    pub version: Option<DriverVersion>,
    /// Whether this build speaks the lasting wire the driver documents.
    pub wire: WireSupport,
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
            version: Some(DriverVersion {
                probe_args: vec!["--version"],
                observed: Version::new(1, 4, 5),
                minimum: Version::new(1, 4, 5),
                fixture: "tests/fixtures/driver-agy.version.txt",
            }),
            wire: WireSupport::Supported,
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
            version: None,
            wire: WireSupport::unsupported(CLAUDE_UNOBSERVED),
        },
        // `codex` 0.163.0 exposes `app-server`, which the matrix classifies as
        // persistent even though its frames were not observed. The help output
        // documents the transport but no turn frame, so the wire is refused.
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
            version: Some(DriverVersion {
                probe_args: vec!["--version"],
                observed: Version::new(0, 163, 0),
                minimum: Version::new(0, 163, 0),
                fixture: "tests/fixtures/driver-codex.version.txt",
            }),
            wire: WireSupport::unsupported(CODEX_APP_SERVER_GAP),
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
            version: None,
            wire: WireSupport::unsupported(
                "cursor: `cursor-agent` documents --resume and `ls resume` only, so no lasting channel was observed",
            ),
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
            version: None,
            wire: WireSupport::unsupported(
                "gemini: 0.64.0 documents --resume and --session-id only, so no lasting channel was observed",
            ),
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
            version: None,
            wire: WireSupport::unsupported(
                "grok: 1.0.62 documents --resume and --session-id only, so no lasting channel was observed",
            ),
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
            version: Some(DriverVersion {
                probe_args: vec!["--version"],
                observed: Version::new(2, 1, 4),
                minimum: Version::new(2, 1, 4),
                fixture: "tests/fixtures/driver-opencode.version.txt",
            }),
            wire: WireSupport::Supported,
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

    #[test]
    fn version_probes_parse_the_observed_outputs() {
        assert_eq!(parse_version("codex-cli 0.163.0"), Some(Version::new(0, 163, 0)));
        assert_eq!(parse_version("opencode v2.1.4"), Some(Version::new(2, 1, 4)));
        assert_eq!(parse_version("1.4.5\n"), Some(Version::new(1, 4, 5)));
        assert_eq!(parse_version("V2.1.4"), Some(Version::new(2, 1, 4)));
        assert_eq!(
            parse_version("opencode v2.1.4-dev+build.7"),
            Some(Version::new(2, 1, 4))
        );
    }

    #[test]
    fn an_output_without_a_version_is_rejected() {
        for raw in ["", "   ", "opencode unknown", "version", "v2", "1.2", "1.2.3.4", "1.x.3"] {
            assert_eq!(parse_version(raw), None, "{raw:?} must not parse");
        }
    }

    #[test]
    fn a_version_below_the_minimum_fails_closed() {
        let evidence = declaration("codex")
            .expect("codex declaration")
            .version
            .expect("codex version evidence");

        assert_eq!(
            evaluate_version("codex-cli 0.163.0", &evidence),
            Ok(Version::new(0, 163, 0))
        );
        assert_eq!(
            evaluate_version("codex-cli 0.170.0", &evidence),
            Ok(Version::new(0, 170, 0))
        );

        let stale = evaluate_version("codex-cli 0.150.0", &evidence).unwrap_err();
        assert!(stale.contains("0.150.0"), "{stale}");
        assert!(stale.contains("0.163.0"), "{stale}");

        let unknown = evaluate_version("codex-cli unknown", &evidence).unwrap_err();
        assert!(unknown.contains("no version number"), "{unknown}");
        assert!(unknown.contains("codex-cli unknown"), "{unknown}");
    }

    #[test]
    fn every_implemented_wire_declares_a_probe_minimum_and_fixture() {
        for driver in ["antigravity", "opencode"] {
            let declared = declaration(driver)
                .unwrap_or_else(|| panic!("{driver} declaration"));
            assert!(
                declared.wire.is_supported(),
                "{driver} must declare an implemented wire"
            );
            let evidence = declared
                .version
                .unwrap_or_else(|| panic!("{driver} needs version evidence"));
            assert_eq!(evidence.probe_args, vec!["--version"], "{driver} probe");
            assert!(
                evidence.minimum <= evidence.observed,
                "{driver} minimum must not exceed the observed version"
            );

            let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(evidence.fixture);
            let recorded = std::fs::read_to_string(&fixture)
                .unwrap_or_else(|error| panic!("{driver} fixture {}: {error}", fixture.display()));
            assert_eq!(
                parse_version(&recorded),
                Some(evidence.observed),
                "{driver} fixture must record the observed version"
            );
            assert_eq!(
                evaluate_version(&recorded, &evidence),
                Ok(evidence.observed),
                "{driver} fixture must pass its own minimum"
            );
        }
    }

    #[test]
    fn a_documented_gap_is_an_explicit_unsupported_wire() {
        let codex = declaration("codex").expect("codex declaration");

        assert!(codex.version.is_some(), "codex still records its probe evidence");
        let reason = codex
            .wire
            .unsupported_reason()
            .expect("codex wire must be refused");
        assert_eq!(reason, CODEX_APP_SERVER_GAP);
        assert!(reason.contains("app-server"), "{reason}");
        assert!(reason.contains("request frame"), "{reason}");
    }

    #[test]
    fn claude_stays_unknown_and_never_persistent() {
        use crate::chat::session::{declared_session_mode, SessionMode};

        let claude = declaration("claude").expect("claude declaration");

        assert_eq!(claude.session_mode, None);
        assert!(claude.version.is_none(), "no version can be observed");
        assert!(claude.wire.unsupported_reason().is_some());
        assert_eq!(declared_session_mode(&claude, true), SessionMode::OneShot);
    }

    #[test]
    fn a_driver_without_a_wire_never_claims_version_evidence() {
        for driver in ["claude", "cursor", "gemini", "grok"] {
            let declared = declaration(driver)
                .unwrap_or_else(|| panic!("{driver} declaration"));
            assert!(!declared.wire.is_supported(), "{driver}");
            assert!(declared.version.is_none(), "{driver}");
            assert!(
                !declared.wire.unsupported_reason().unwrap_or("").trim().is_empty(),
                "{driver} must explain the missing wire"
            );
        }
    }
}
