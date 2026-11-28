//! Lasting CLI transports for drivers whose wire can stay open.
//!
//! Three lasting wires are wired in this build, each from what its own CLI help
//! documents:
//!
//! - Antigravity's `agy` pair `--input-format stream-json` /
//!   `--output-format stream-json`: one NDJSON user message per line on stdin,
//!   one JSON frame per line on stdout. The exact input frame is this adapter's
//!   own and was not probed, so it stays a single, explicit shape instead of a
//!   guess spread across the runtime.
//! - OpenCode's `serve` command plus its documented client flags `--server`,
//!   `--session`, and `--prompt`: one server process holds the thread's session
//!   and each turn is one documented client invocation against that server.
//!
//! - The grok lasting channel is `agent stdio`. `--permission-mode` is a
//!   top-level flag, so it sits before `agent`. Model and effort are set on
//!   the open session before the message. A stored accept-edits mode runs as
//!   ask, not as auto-accept.
//!
//! Codex documents `app-server` as a transport but no request frame that
//! accepts a user turn, so this build records that command and refuses the
//! wire instead of inventing a protocol. Every other driver keeps one command
//! per turn.

pub(crate) mod controls;
pub(crate) mod antigravity;
pub(crate) mod antigravity_acp;
pub(crate) mod opencode;
pub(crate) mod opencode_pool;
pub(crate) mod grok;
pub(crate) mod grok_pool;
pub(crate) mod codex_app_server;

pub use controls::*;
pub use antigravity::*;
pub use antigravity_acp::{
    agy_acp_pool_stats, global_agy_acp_pool, reap_idle_agy_acp_daemons, AgyAcpSessionHandle,
    SharedAgyAcpPool,
};
pub use opencode::*;
pub use opencode_pool::{
    global_opencode_pool, opencode_pool_stats, reap_idle_opencode_servers, PooledOpenCodeLease,
    SharedOpenCodeServerPool,
};
pub use grok::*;
pub use grok_pool::{
    global_grok_pool, grok_pool_stats, reap_idle_grok_daemons, GrokPooledSessionHandle,
    SharedGrokAcpPool,
};
pub use codex_app_server::{
    probe_codex_app_server, probe_codex_app_server_help, CodexAppServerProbeResult,
    CodexAppServerSession,
};

#[cfg(test)]
#[path = "persistent_tests.rs"]
mod tests;
