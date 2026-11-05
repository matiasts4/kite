//! Stateless native client for the Phase 1 `kite-core` framed pipe.
//!
//! This crate owns no PTY and does not link a terminal host. It speaks the
//! 9-byte frame protocol, caches dirty rows, and paints a GPU shell.

pub mod core_client;
pub mod input_keymap;
pub mod snapshot_bin;
pub mod sprites;
pub mod terminal_view;
pub mod theme;

pub mod ondemand;
pub mod shell;

#[cfg(feature = "gpu")]
pub mod gpu_app;

pub mod headless;
