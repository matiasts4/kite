//! Canonical turn pipeline shared by every provider transport.
//!
//! Frames enter here. The renderer never parses a provider wire. A tool call
//! keeps one snapshot for its whole life, text waits 50ms unless it is the
//! first chunk or the segment is closing, and a failed process becomes a
//! structured failure instead of assistant text.

mod coalescer;
mod events;
mod frames;
mod tracker;

pub use coalescer::*;
pub use events::*;
pub use frames::*;
pub use tracker::*;

#[cfg(test)]
#[path = "../turn_pipeline_tests.rs"]
mod tests;
