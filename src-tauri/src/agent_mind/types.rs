use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MEMORY_BYTE_LIMIT: usize = 200_000;
pub const SKILL_BYTE_LIMIT: usize = 64_000;
pub const MEMORY_CHAR_BUDGET: usize = 4_000;
pub const USER_CHAR_BUDGET: usize = 2_000;
pub const SKILL_NAME_LIMIT: usize = 64;
pub const SKILL_DESCRIPTION_LIMIT: usize = 256;
pub const MAX_SKILLS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMindError {
    pub code: String,
    pub message: String,
}

impl AgentMindError {
    pub(crate) fn new(code: &str, message: &str) -> Self {
        Self { code: code.chars().take(64).collect(), message: message.chars().take(500).collect() }
    }
}

pub(crate) struct Starter {
    pub(crate) id: &'static str,
    pub(crate) title: &'static str,
    pub(crate) summary: &'static str,
    pub(crate) name: &'static str,
    pub(crate) description: &'static str,
    pub(crate) body: &'static str,
}

pub(crate) struct TextRecord {
    pub(crate) text: String,
    pub(crate) revision: Option<String>,
    pub(crate) updated_at: Option<i64>,
    pub(crate) issue: Option<Value>,
}

pub(crate) const STARTERS: &[Starter] = &[
    Starter {
        id: "keep-a-memory",
        title: "Keep a memory",
        summary: "Save a fact that should still be true after this chat.",
        name: "Keep a memory",
        description: "Use when the builder states a preference, decision, or fact that should outlive this chat.",
        body: "Write one durable line into agent memory, newest last. Leave secrets out.",
    },
    Starter {
        id: "write-a-skill",
        title: "Write a skill",
        summary: "Turn a repeated procedure into a skill the agent can read back.",
        name: "Write a skill",
        description: "Use when the same procedure has worked twice and should be saved for the next matching task.",
        body: "Write a skill with a short name, a description of when it fires, and the steps.",
    },
    Starter {
        id: "research-a-question",
        title: "Research a question",
        summary: "Answer a question from the project files before guessing.",
        name: "Research a question",
        description: "Use when the builder asks what the code or documents actually say.",
        body: "Read the relevant files first, then answer with the paths you checked and what is still unknown.",
    },
    Starter {
        id: "draft-for-a-reader",
        title: "Draft for a reader",
        summary: "Draft text for a specific reader, then revise it once.",
        name: "Draft for a reader",
        description: "Use when the builder wants a draft written for someone else to read.",
        body: "Name the reader, write the draft, and revise it once for clarity.",
    },
    Starter {
        id: "root-cause",
        title: "Root cause",
        summary: "Trace a failure to the change that produced it.",
        name: "Root cause",
        description: "Use when something fails and the builder wants the cause, not a workaround.",
        body: "Reproduce the failure, find the producing change, and say what would prevent it.",
    },
];
