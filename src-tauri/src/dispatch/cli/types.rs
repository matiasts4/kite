use crate::dispatch::policy::ChildrenMode;
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{Caller, Family};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwarmChannelAction {
    Create,
    Subscribe,
    Unsubscribe,
    Archive,
    List,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwarmCommand {
    Title {
        title: String,
    },
    Add {
        name: String,
        provider: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        workspace: Option<String>,
        channels: Vec<String>,
        fork: Option<String>,
        role: Option<String>,
        brief: String,
    },
    Post {
        channel: Option<String>,
        text: String,
    },
    Read {
        since: u64,
        channel: Option<String>,
    },
    Wait {
        since: u64,
        mentions_only: bool,
        timeout_ms: u64,
    },
    Status,
    Model {
        name: String,
        provider: Option<String>,
        model: String,
        effort: Option<String>,
    },
    Kill {
        name: String,
    },
    Channel {
        action: SwarmChannelAction,
        channel: Option<String>,
        topic: Option<String>,
        member: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Ls,
    Programs,
    Providers {
        refresh: bool,
    },
    Models {
        provider: Option<String>,
        refresh: bool,
    },
    Skill,
    Run {
        via: Family,
        explicit_via: bool,
        engine: Option<String>,
        provider: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        workspace: Option<String>,
        name: Option<String>,
        explicit_name: bool,
        parent: Option<String>,
        outlive: bool,
        /// Set only by `--role`. A positional word is `program`, not a role.
        role: Option<String>,
        explicit_role: bool,
        file: Option<String>,
        task: Option<String>,
        wait: bool,
        timeout_ms: Option<u64>,
        hidden: bool,
        pane: bool,
        program: Option<String>,
        /// Remaining words after the program. Each word is one argument.
        words: Vec<String>,
    },
    Kill {
        address: String,
    },
    Interrupt {
        address: String,
    },
    Keys {
        address: String,
        keys: Vec<String>,
    },
    Attach {
        address: String,
    },
    Send {
        address: String,
        body: Option<String>,
        file: Option<String>,
        force: bool,
        only_ready: bool,
        allow_queue: bool,
    },
    Wait {
        address: Option<String>,
        until: Vec<PresenceState>,
        children: Option<ChildrenMode>,
        timeout_ms: u64,
    },
    Read {
        address: String,
        lines: usize,
        last_assistant: bool,
    },
    Report {
        to: Option<String>,
        from: Option<String>,
        body: Option<String>,
        file: Option<String>,
    },
    Swarm(SwarmCommand),
}


pub struct ExecContext<'a> {
    pub id: &'a str,
    pub caller: Caller,
    pub from: &'a str,
    pub now_ms: u64,
    pub config_dir: Option<&'a std::path::Path>,
    pub workspace: Option<&'a std::path::Path>,
    pub mounted: bool,
}
