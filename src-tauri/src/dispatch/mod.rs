//! Dispatch policy, presence, and receipts.
//! The wiring file outside this module is the only place that touches a live terminal or chat.

pub mod address;
pub mod audit;
pub mod cli;
pub mod envelope;
pub mod files;
pub mod keys;
pub mod osc;
pub mod policy;
pub mod port;
pub mod presence;
pub mod programs;
pub mod role;
pub mod trace;
pub mod types;

pub use policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
pub use port::{FakePort, Port, StartRequest, SubmitMeta};
pub use presence::{BlockKind, PresenceState};
pub use types::{Caller, DispatchError, Family, Receipt, ReceiptStatus};
