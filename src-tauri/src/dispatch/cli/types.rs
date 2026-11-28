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
        override_stack: bool,
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
        override_stack: bool,
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
        override_stack: bool,
        name: Option<String>,
        explicit_name: bool,
        parent: Option<String>,
        outlive: bool,
        /// Set only by `--role`. A positional word is `program`, not a role.
        role: Option<String>,
        explicit_role: bool,
        file: Option<String>,
        task: Option<String>,
        tasks: Vec<String>,
        count: Option<usize>,
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
        wait: bool,
        timeout_ms: Option<u64>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentCommand {
    ThreadList {
        workspace_id: Option<String>,
        agent_id: Option<String>,
        cursor: usize,
        limit: usize,
    },
    ThreadSearch {
        query: String,
        workspace_id: Option<String>,
        agent_id: Option<String>,
        cursor: usize,
        limit: usize,
    },
    ThreadRead {
        thread_id: String,
        cursor: Option<usize>,
        limit: usize,
    },
    ThreadLaunch {
        title: Option<String>,
        prompt: String,
        workspace_id: Option<String>,
        provider: Option<String>,
        model: Option<String>,
        mode: Option<String>,
        effort: Option<String>,
        worktree: bool,
        odd_path: Option<String>,
        open: bool,
        orchestrate: bool,
    },
    MemoryRead {
        target: String,
        agent_id: Option<String>,
    },
    MemoryAdd {
        text: String,
        target: String,
        agent_id: Option<String>,
    },
    MemorySearch {
        query: String,
        target: String,
        agent_id: Option<String>,
        limit: usize,
    },
    RoutineList {
        agent_id: Option<String>,
    },
    RoutineCreate {
        agent_id: Option<String>,
        name: String,
        prompt: String,
        cadence_seconds: u64,
        workspace_id: Option<String>,
    },
    RoutineToggle {
        agent_id: Option<String>,
        routine_id: String,
        enabled: bool,
    },
    RoutineRun {
        agent_id: Option<String>,
        routine_id: String,
    },
    TeammateList,
    TeammateSend {
        target: String,
        message: String,
    },
    TeammateDelegate {
        target: String,
        task: String,
        wait: bool,
        timeout_ms: Option<u64>,
    },
    Tool(AgentToolCommand),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentToolCommand {
    TasksList {
        state: Option<String>,
        label: Option<String>,
        limit: usize,
    },
    TasksGet {
        id: String,
    },
    TasksCreate {
        title: String,
        description: String,
        state: Option<String>,
        priority: Option<String>,
        labels: Vec<String>,
        odd_path: Option<String>,
        source_agent: Option<String>,
        source_thread_id: Option<String>,
    },
    TasksUpdate {
        id: String,
        title: Option<String>,
        description: Option<String>,
        state: Option<String>,
        priority: Option<String>,
        labels: Option<Vec<String>>,
    },
    TasksMoveState {
        id: String,
        state: String,
    },
    CtxReadCompact {
        path: String,
        mode: String,
    },
    CtxSearch {
        query: String,
        path: Option<String>,
        limit: usize,
    },
    CtxSharePut {
        key: String,
        content: String,
        scope: Option<String>,
        scope_id: Option<String>,
    },
    CtxShareGet {
        key: String,
        scope: Option<String>,
        scope_id: Option<String>,
        full: bool,
    },
    CtxCcrRetrieve {
        hash: String,
        lines: Option<String>,
        search: Option<String>,
    },
    DiffStatus {
        workspace_id: Option<String>,
    },
    DiffFile {
        path: String,
        workspace_id: Option<String>,
        staged: bool,
    },
    Browser {
        payload_json: String,
    },
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
