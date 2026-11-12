//! Dispatch policy. This module does not import a terminal, a chat runtime, or a projectile.

pub mod ops;
pub mod service;
pub mod types;

#[cfg(test)]
mod tests;

pub use ops::*;
pub use service::*;
pub use types::*;

// Re-exports from sibling modules for tests and backwards-compatibility
pub use crate::dispatch::presence::{BlockKind, PresenceState};
pub use crate::dispatch::types::{
    Caller, DispatchError, Family, PaneVisibility, Receipt, ReceiptStatus, QUEUE_DEPTH, STALL_MS,
};
