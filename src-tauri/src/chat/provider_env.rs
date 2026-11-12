//! Inherited provider environment and read-only MCP preservation.
//!
//! A session reuses the account and configuration the driver's own CLI already
//! has. This module describes that inheritance from observed evidence: which
//! environment names the driver reads, where its account lives, how the CLI
//! recovers from a signed-out state, and where its MCP servers are configured.
//!
//! Every field carries a name or a path. No field carries a secret value, and
//! nothing here reads, writes, or resolves a provider file.

/// Whether a driver was observed to keep its own MCP configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preservation {
    /// A session probe observed the provider's own servers still present after
    /// the session started.
    Observed,
    /// No observation exists. A discovered configuration file is not proof.
    Unknown,
}

/// How one driver inherits its account and MCP configuration from the CLI
/// installation that is already on the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEnvironment {
    pub driver: String,
    /// Environment variable names the driver's CLI may read. Names only, never
    /// values. The passthrough still carries the whole process environment;
    /// this list describes the relevant entries, it does not filter them.
    /// Empty when no name was observed for that driver.
    pub inherited_names: Vec<String>,
    /// Where the existing CLI keeps the account. A path or a description, never
    /// a credential value. `unknown` when the location was not observed.
    pub auth_source: String,
    /// The CLI's own sign-in command, or an explicit sentence starting with
    /// `unknown:` when no command was observed.
    pub auth_recovery: String,
    /// Read-only configuration paths the driver's MCP servers come from.
    /// Empty when discovery did not cover that driver.
    pub mcp_sources: Vec<String>,
    /// `Unknown` unless a session probe observed the servers after start.
    pub mcp_preservation: Preservation,
}

struct DriverFacts {
    driver: &'static str,
    inherited_names: &'static [&'static str],
    auth_source: &'static str,
    /// Present only when the CLI's own sign-in command was observed.
    recovery: Option<&'static str>,
    mcp_sources: &'static [&'static str],
}

/// Evidence from the read-only driver matrix. Paths are written as they were
/// observed, not resolved against the current user profile.
const DRIVER_FACTS: &[DriverFacts] = &[
    DriverFacts {
        driver: "antigravity",
        inherited_names: &[],
        auth_source: "~/.gemini/antigravity*; Windows Credential Manager entry gemini:antigravity",
        recovery: None,
        mcp_sources: &[
            "~/.gemini/antigravity-cli/mcp/*",
            "~/.gemini/antigravity/mcp_config.json",
        ],
    },
    DriverFacts {
        driver: "claude",
        inherited_names: &["ANTHROPIC_API_KEY"],
        auth_source: "~/.claude/.credentials.json",
        recovery: Some("claude login"),
        mcp_sources: &["~/.claude.json"],
    },
    DriverFacts {
        driver: "codex",
        inherited_names: &["OPENAI_API_KEY"],
        auth_source: "~/.codex/auth.json",
        recovery: Some("codex login"),
        mcp_sources: &["~/.codex/config.toml"],
    },
    DriverFacts {
        driver: "cursor",
        inherited_names: &[],
        auth_source: "unknown",
        recovery: None,
        mcp_sources: &["~/.cursor/mcp.json"],
    },
    DriverFacts {
        driver: "gemini",
        inherited_names: &["GEMINI_API_KEY"],
        auth_source: "~/.gemini/oauth_creds.json; ~/.gemini/google_accounts.json; GEMINI_API_KEY",
        recovery: None,
        mcp_sources: &[],
    },
    DriverFacts {
        driver: "grok",
        inherited_names: &["GROK_API_KEY"],
        auth_source: "~/.grok/auth.json",
        recovery: None,
        mcp_sources: &[],
    },
    DriverFacts {
        driver: "opencode",
        inherited_names: &[],
        auth_source: "unknown: CLI configuration; the secret store was not observed",
        recovery: None,
        mcp_sources: &[],
    },
];

/// The inherited environment for one driver, or `None` when the driver is not
/// known. An unknown driver stays unknown; nothing is inferred for it.
pub fn environment_for(driver: &str) -> Option<ProviderEnvironment> {
    let facts = DRIVER_FACTS.iter().find(|facts| facts.driver == driver)?;
    Some(ProviderEnvironment {
        driver: facts.driver.to_string(),
        inherited_names: facts
            .inherited_names
            .iter()
            .map(|name| (*name).to_string())
            .collect(),
        auth_source: facts.auth_source.to_string(),
        auth_recovery: recovery_text(facts),
        mcp_sources: facts
            .mcp_sources
            .iter()
            .map(|path| (*path).to_string())
            .collect(),
        mcp_preservation: Preservation::Unknown,
    })
}

/// The driver CLI's own sign-in command when it was observed, or an explicit
/// `unknown:` sentence when it was not. `None` only for an unknown driver.
pub fn auth_recovery_instruction(driver: &str) -> Option<String> {
    DRIVER_FACTS
        .iter()
        .find(|facts| facts.driver == driver)
        .map(recovery_text)
}

fn recovery_text(facts: &DriverFacts) -> String {
    match facts.recovery {
        Some(command) => command.to_string(),
        None => format!(
            "unknown: no sign-in command was observed for the {} CLI. \
             Run the CLI directly to sign in; Kite does not start a second login.",
            facts.driver
        ),
    }
}

/// The current process environment, unchanged except for the explicit
/// overrides. This is the only credential path: the CLI keeps its own account,
/// and this function neither copies a credential nor prepares a login.
///
/// Process order is kept. An override replaces its entry where it already
/// exists, keeps the override's spelling, and a name that is not present is
/// appended in override order. A later override of the same name wins. An entry
/// whose name or value is not valid Unicode is skipped instead of being
/// converted lossily, so every returned value is byte-identical to the process
/// value.
pub fn inherited_environment(overrides: &[(String, String)]) -> Vec<(String, String)> {
    let mut resolved: Vec<(String, String)> = Vec::new();
    for (name, value) in overrides {
        match resolved
            .iter_mut()
            .find(|(existing, _)| same_env_name(existing, name))
        {
            Some(entry) => {
                entry.0 = name.clone();
                entry.1 = value.clone();
            }
            None => resolved.push((name.clone(), value.clone())),
        }
    }

    let mut entries = Vec::new();
    let mut applied = vec![false; resolved.len()];
    for (name, value) in std::env::vars_os() {
        let (Ok(name), Ok(value)) = (name.into_string(), value.into_string()) else {
            continue;
        };
        match resolved
            .iter()
            .position(|(override_name, _)| same_env_name(override_name, &name))
        {
            Some(index) => {
                applied[index] = true;
                entries.push(resolved[index].clone());
            }
            None => entries.push((name, value)),
        }
    }

    for (index, entry) in resolved.into_iter().enumerate() {
        if !applied[index] {
            entries.push(entry);
        }
    }
    entries
}

/// Environment names are case-insensitive on Windows and case-sensitive
/// elsewhere, so an override follows the platform's own rule.
fn same_env_name(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, HashMap};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, MutexGuard};

    const KNOWN_DRIVERS: [&str; 7] = [
        "antigravity",
        "claude",
        "codex",
        "cursor",
        "gemini",
        "grok",
        "opencode",
    ];

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn env_lock() -> MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Restores the previous process value when the guard is dropped.
    struct EnvGuard {
        name: String,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(name: &str, value: &str) -> Self {
            let previous = std::env::var_os(name);
            std::env::set_var(name, value);
            Self {
                name: name.to_string(),
                previous,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var(&self.name, value),
                None => std::env::remove_var(&self.name),
            }
        }
    }

    fn looks_secret(name: &str) -> bool {
        let upper = name.to_ascii_uppercase();
        ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
            .iter()
            .any(|marker| upper.contains(marker))
    }

    #[test]
    fn environment_description_never_carries_a_secret_value() {
        let _lock = env_lock();
        let secret_name = format!("KITE_TEST_PROVIDER_ENV_{}_API_KEY", uuid::Uuid::new_v4());
        let sentinel = "sentinel-secret-value-7f4c2d9a-not-a-real-credential";
        let _guard = EnvGuard::set(&secret_name, sentinel);

        let secret_values: Vec<(String, String)> = std::env::vars()
            .filter(|(name, value)| looks_secret(name) && value.len() >= 8)
            .collect();
        assert!(
            secret_values
                .iter()
                .any(|(name, value)| name == &secret_name && value == sentinel),
            "the sentinel secret must be visible through the process environment"
        );

        for driver in KNOWN_DRIVERS {
            let environment = environment_for(driver).expect("known driver");
            let mut fields: Vec<&str> = vec![
                &environment.driver,
                &environment.auth_source,
                &environment.auth_recovery,
            ];
            fields.extend(environment.inherited_names.iter().map(String::as_str));
            fields.extend(environment.mcp_sources.iter().map(String::as_str));

            for (name, value) in &secret_values {
                for field in &fields {
                    assert!(
                        !field.contains(value.as_str()),
                        "{driver} leaked the value of {name} in {field:?}"
                    );
                }
            }

            for inherited in &environment.inherited_names {
                assert!(!inherited.trim().is_empty(), "an empty name is not a name");
                assert!(
                    !inherited.contains('='),
                    "an inherited entry is a name, not a name=value pair"
                );
            }
        }
    }

    #[test]
    fn an_unknown_driver_stays_unknown() {
        assert!(environment_for("").is_none());
        assert!(environment_for("unknown-driver").is_none());
        assert!(environment_for("Codex").is_none());
        assert!(auth_recovery_instruction("").is_none());
        assert!(auth_recovery_instruction("unknown-driver").is_none());

        for driver in KNOWN_DRIVERS {
            let environment = environment_for(driver).expect("known driver");
            assert_eq!(environment.driver, driver);
            assert!(!environment.auth_source.trim().is_empty());
        }
    }

    #[test]
    fn unknown_preservation_is_not_upgraded_by_a_discovered_config_file() {
        assert_ne!(Preservation::Observed, Preservation::Unknown);

        for driver in KNOWN_DRIVERS {
            let environment = environment_for(driver).expect("known driver");
            assert_eq!(
                environment.mcp_preservation,
                Preservation::Unknown,
                "{driver} must stay unknown until a session probe observes preservation"
            );
        }

        for driver in ["antigravity", "claude", "codex", "cursor"] {
            let environment = environment_for(driver).expect("known driver");
            assert!(
                !environment.mcp_sources.is_empty(),
                "{driver} has a discovered configuration path"
            );
            assert_eq!(
                environment.mcp_preservation,
                Preservation::Unknown,
                "a discovered configuration path is not proof that the provider kept it"
            );
        }

        for driver in ["gemini", "grok", "opencode"] {
            let environment = environment_for(driver).expect("known driver");
            assert!(
                environment.mcp_sources.is_empty(),
                "{driver} MCP discovery was not observed"
            );
            assert_eq!(environment.mcp_preservation, Preservation::Unknown);
        }
    }

    #[test]
    fn passthrough_keeps_every_byte_and_applies_only_explicit_overrides() {
        let _lock = env_lock();
        let passthrough_name = format!("KITE_TEST_PROVIDER_PASSTHROUGH_{}", uuid::Uuid::new_v4());
        let raw_value = "  value=\"with quotes\"=and=equals  ";
        let _guard = EnvGuard::set(&passthrough_name, raw_value);
        let added_name = format!("KITE_TEST_PROVIDER_ADDED_{}", uuid::Uuid::new_v4());

        let before: HashMap<String, String> = std::env::vars().collect();
        let entries = inherited_environment(&[
            (passthrough_name.clone(), "override".to_string()),
            (added_name.clone(), "added".to_string()),
        ]);
        let after: HashMap<String, String> = entries.iter().cloned().collect();

        assert_eq!(
            after.get(&passthrough_name).map(String::as_str),
            Some("override"),
            "an explicit override must replace the process value"
        );
        assert_eq!(
            after.get(&added_name).map(String::as_str),
            Some("added"),
            "a new override must be added to the passthrough"
        );
        for (name, value) in &before {
            if name == &passthrough_name {
                continue;
            }
            assert_eq!(
                after.get(name),
                Some(value),
                "the value of {name} must pass through unchanged"
            );
        }

        assert_eq!(
            entries.iter().filter(|(name, _)| name == &passthrough_name).count(),
            1,
            "a replaced entry must not be duplicated"
        );
        assert_eq!(
            entries.iter().filter(|(name, _)| name == &added_name).count(),
            1,
            "an added entry must not be duplicated"
        );
    }

    #[cfg(windows)]
    #[test]
    fn an_override_matches_its_name_case_insensitively_on_windows() {
        let _lock = env_lock();
        let name = format!("KITE_TEST_PROVIDER_CASE_{}", uuid::Uuid::new_v4());
        let _guard = EnvGuard::set(&name, "process value");
        let override_name = name.to_ascii_lowercase();

        let entries =
            inherited_environment(&[(override_name.clone(), "override value".to_string())]);

        assert_eq!(
            entries
                .iter()
                .filter(|(entry, _)| entry.eq_ignore_ascii_case(&name))
                .count(),
            1,
            "one variable has one entry regardless of name case"
        );
        let entry = entries
            .iter()
            .find(|(entry, _)| entry.eq_ignore_ascii_case(&name))
            .expect("the variable is present");
        assert_eq!(
            entry.0, override_name,
            "the explicit override keeps its own spelling"
        );
        assert_eq!(entry.1, "override value");
    }

    #[test]
    fn passthrough_does_not_copy_a_credential() {
        let _lock = env_lock();
        let secret_name = format!("KITE_TEST_PROVIDER_COPY_{}_TOKEN", uuid::Uuid::new_v4());
        let secret_value = "sk-test-secret-4b1d9e";
        let _guard = EnvGuard::set(&secret_name, secret_value);

        let entries = inherited_environment(&[]);
        let carrying: Vec<&(String, String)> = entries
            .iter()
            .filter(|(_, value)| value == secret_value)
            .collect();

        assert_eq!(
            carrying.len(),
            1,
            "the credential must appear exactly once, as the process value"
        );
        assert_eq!(
            carrying[0].0, secret_name,
            "the single copy must keep the process name"
        );
    }

    #[test]
    fn recovery_text_is_the_observed_command_or_an_explicit_unknown() {
        assert_eq!(
            auth_recovery_instruction("claude").as_deref(),
            Some("claude login")
        );
        assert_eq!(
            auth_recovery_instruction("codex").as_deref(),
            Some("codex login")
        );

        for driver in KNOWN_DRIVERS {
            let text = auth_recovery_instruction(driver).expect("known driver");
            let environment = environment_for(driver).expect("known driver");
            assert_eq!(text, environment.auth_recovery);
            assert!(!text.trim().is_empty());
            if driver != "claude" && driver != "codex" {
                assert!(
                    text.starts_with("unknown:"),
                    "{driver} recovery must be explicit about the unknown: {text}"
                );
                assert!(!text.contains("claude login"));
                assert!(!text.contains("codex login"));
            }
        }

        assert!(auth_recovery_instruction("nonsense").is_none());
    }

    /// A provider home under the system temp directory, removed on drop.
    struct TempProviderHome(PathBuf);

    impl TempProviderHome {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("kite-provider-env-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create temp provider home");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, relative: &str, contents: &str) {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create fixture directory");
            }
            fs::write(path, contents).expect("write fixture");
        }

        fn snapshot(&self) -> BTreeMap<PathBuf, Vec<u8>> {
            let mut files = BTreeMap::new();
            let mut pending = vec![self.0.clone()];
            while let Some(directory) = pending.pop() {
                for entry in fs::read_dir(&directory).expect("read provider home") {
                    let entry = entry.expect("read provider home entry");
                    let path = entry.path();
                    if entry.file_type().expect("provider home entry type").is_dir() {
                        pending.push(path);
                    } else {
                        let relative = path
                            .strip_prefix(&self.0)
                            .expect("relative fixture path")
                            .to_path_buf();
                        files.insert(relative, fs::read(&path).expect("read provider fixture"));
                    }
                }
            }
            files
        }
    }

    impl Drop for TempProviderHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_lookup_does_not_write_to_the_provider_home() {
        let home = TempProviderHome::new();
        home.write("auth.json", "{\"fixture\":true}");
        home.write("mcp.json", "{\"mcpServers\":{}}");
        home.write(
            "config.toml",
            "[mcp_servers.fixture]\ncommand = \"fixture\"\n",
        );
        home.write("antigravity/mcp_config.json", "{\"fixture\":true}");
        let before = home.snapshot();

        for driver in KNOWN_DRIVERS {
            let _ = environment_for(driver);
            let _ = auth_recovery_instruction(driver);
        }
        let _ = inherited_environment(&[(
            "KITE_TEST_PROVIDER_LOOKUP".to_string(),
            "1".to_string(),
        )]);

        assert_eq!(
            home.snapshot(),
            before,
            "a read-only lookup must not write provider configuration"
        );

        let home_text = home.path().to_string_lossy().to_string();
        for driver in KNOWN_DRIVERS {
            let environment = environment_for(driver).expect("known driver");
            for source in std::iter::once(&environment.auth_source)
                .chain(environment.mcp_sources.iter())
            {
                assert!(
                    !source.contains(home_text.as_str()),
                    "a description stays a name, not a resolved path inside the provider home"
                );
            }
        }
    }
}
