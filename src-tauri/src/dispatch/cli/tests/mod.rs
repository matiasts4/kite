use super::*;
use crate::dispatch::policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
use crate::dispatch::port::FakePort;
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus};

pub(super) fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).to_string()).collect()
}

pub(super) fn exec_run<'a>(
    service: &mut Service<FakePort>,
    command: &Command,
    id: &'a str,
    caller: Caller,
    config_dir: Option<&'a std::path::Path>,
) -> Receipt {
    execute(
        service,
        command,
        &ExecContext {
            id,
            caller,
            from: "agent",
            now_ms: 10,
            config_dir,
            workspace: None,
            mounted: false,
        },
    )
    .unwrap()
}

mod basic_tests;
mod orchestration_tests;
