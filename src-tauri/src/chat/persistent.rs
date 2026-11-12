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
pub(crate) mod opencode;
pub(crate) mod grok;

pub use controls::*;
pub use antigravity::*;
pub use opencode::*;
pub use grok::*;

#[cfg(test)]
#[path = "persistent_tests.rs"]
mod tests;
