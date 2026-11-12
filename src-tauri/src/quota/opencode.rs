pub(crate) mod client;
pub(crate) mod credentials;
pub(crate) mod service;

pub use client::*;
pub use credentials::*;
pub use service::*;

#[allow(unused_imports)]
pub use serde_json::{json, Value};
#[allow(unused_imports)]
pub use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "opencode_tests.rs"]
mod tests;
