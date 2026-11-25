//! `kite dispatch` argument parsing, skill text, and loopback auth.
//! A missing app returns `runtime_offline` and does not start a server.

mod agent_tools;
mod docs;
mod execute;
mod install;
mod parse_cmd;
mod parse_run;
mod types;

pub use agent_tools::*;
pub use docs::*;
pub use execute::*;
pub use install::*;
pub use parse_cmd::*;
pub use parse_run::*;
pub use types::*;

#[cfg(test)]
mod tests;
