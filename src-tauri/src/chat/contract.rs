//! Cross-module contract verification for the session layer.
//!
//! Test-only. This module proves the pieces compose: lifecycle, fallback,
//! normalization, recovery, and environment preservation.

#[cfg(test)]
mod helpers;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod driver_tests;
