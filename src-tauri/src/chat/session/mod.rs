//! Thread-owned provider sessions.
//!
//! The thread is the durable conversation. A session is the ephemeral process
//! that serves it. This module owns the contract only: it never spawns a real
//! provider. Driver adapters provide a [`SessionTransport`], and tests use the
//! deterministic [`ScriptedTransport`].

mod eviction;
mod manager;
mod scripted;
mod types;

pub use eviction::*;
pub use manager::*;
pub use scripted::*;
pub use types::*;

#[cfg(test)]
#[path = "../session_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "eviction_tests.rs"]
mod s4_eviction_tests;
