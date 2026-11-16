# Persistent Session Recovery, Model-Change Respawn & Failure Propagation

Objective: Ensure persistent turn failures (including quota exhaustion errors) emit `TransportEvent::TurnFailed` cleanly instead of `TurnEnded`, and ensure `SessionManager` verifies backing transport liveness and control compatibility so switching models or retrying after a crashed provider process cleanly respawns the session instead of writing into a dead pipe.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `single-pr` on `feat/response-thread` (isolated clean commit touching only session/transport recovery files; pre-existing concurrent diffs left untouched).
Test runner: `cargo test --manifest-path src-tauri/Cargo.toml chat::persistent`, `cargo test --manifest-path src-tauri/Cargo.toml chat::session`, `cargo test --manifest-path src-tauri/Cargo.toml chat::turn_pipeline`, `cargo test --manifest-path src-tauri/Cargo.toml chat::`, `node .kite/sanitizer/audit-references.mjs --check`.

---

## Specs

### S1 — Persistent Frame Failure Propagation & `UsageLimit` Classification
Addresses root cause where Antigravity `429 RESOURCE_EXHAUSTED` results returned `Notice` + `TurnEnded` (settling runs as `"completed"`) and `spawn.rs` dropped error reasons on pre-write transport failures.

1. **`parse_antigravity_line` Failure Propagation (`persistent/antigravity.rs`):**
   - For `"result"` frames where `/result/status` is not `"SUCCESS"` (case-insensitive) OR `/result/error` is non-empty, keep emitting informative `Notice` events and emit **`TransportEvent::TurnFailed(reason)`** as the terminal turn event instead of `TransportEvent::TurnEnded`.
   - For `"error"` frames, emit informative `Notice` plus **`TransportEvent::TurnFailed(reason)`** so mid-turn protocol/quota errors terminate the turn as failed rather than stalling or appearing successful.
2. **`UsageLimit` & Reset Window Parsing (`turn_pipeline/coalescer.rs`):**
   - Extend `classify_turn_failure` so `"resource_exhausted"` and `"resource has been exhausted"` match `TurnFailure::UsageLimit`.
   - Parse reset duration hints (`"Resets in XhYmZs"`) into `reset_at_unix_ms` when present.
3. **Transport Reject Reason Preservation (`runtime/spawn.rs`):**
   - When `managed_send_prepared` fails with `ManagedSendError::Turn` (or non-before-turn error), pass `error.reason()` to `finish_run` instead of `""` so error history and diagnostics record the cause.

---

### S2 — Transport Liveness & Control Reconciliation in `SessionManager`
Addresses root cause where `SessionManager::attach` returned `AlreadyAttached` for any non-`Closed` session (even dead or `Failed` ones, or with a different CLI model) and `send_turn` attempted `write_turn` onto an EOF child process.

1. **Transport Introspection Trait Methods (`session/types.rs`):**
   - Add default-implemented methods on `SessionTransport`:
     - `fn is_alive(&self) -> bool { true }`
     - `fn controls(&self) -> Option<PersistentControls> { None }`
     - `fn update_controls(&mut self, _next: &PersistentControls) -> bool { true }`
2. **Per-Transport Implementations (`persistent/{antigravity,grok,opencode}.rs`):**
   - `AntigravitySession`: `is_alive` returns `false` once spawned and `stopping || eof || stdin.is_none() || reader finished`. `update_controls` accepts updates in-place only before first spawn (`spawns == 0`); once spawned, returns `self.controls == *next` so switching `model`, `effort`, or `permission_mode` triggers a clean respawn with new CLI flags.
   - `GrokSession`: `is_alive` reflects process/EOF state (`spawns == 0 || (!stopping && !eof && ...)`). `update_controls` updates `model` and `effort` in-place while keeping the running `agent stdio` process (`permission_mode` mismatches return `false` for respawn).
   - `OpenCodeServerSession`: stores `controls`, reports server liveness via `!stopping && !server_eof && server.is_some()` once spawned, and updates `model` / `effort` / `model_arg` in-place (`true`) because turns forward `--model` per turn.
3. **Session Reconciliation (`session/manager.rs`):**
   - In `SessionManager::attach`: replace an existing session (preserving `resume_handle` when same canonical driver & `connection_id` and non-empty handle) whenever:
     - `!existing.transport.is_alive()`
     - `matches!(existing.record.state, SessionState::Failed | SessionState::Resumable | SessionState::Interrupted | SessionState::Closed)`
     - `driver`, `connection_id`, `working_directory`, or `mode` changed (dropping `resume_handle` if driver or connection changed)
     - incoming `transport.controls()` returns `Some(next)` and `!existing.transport.update_controls(&next)`
   - When `Existing` remains valid (`is_alive()` and compatible controls), retain it cleanly (`AttachOutcome::AlreadyAttached`, `spawn_count` unchanged).
   - In `SessionManager::start` and `send_turn`: verify `session.transport.is_alive()` before reusing a persistent process (`Idle`/`Completed`); respawn via `Reaped` + `resume_handle` fallback if the backing process died without a prior `Exit` poll; and if `write_turn` fails when `!session.transport.is_alive()`, mark `session.record.state = SessionState::Failed`.

---

### S3 — Regression Tests
- **`persistent_tests.rs`**: Assert `"result"` with error status/error string and `"error"` frames produce `TransportEvent::TurnFailed`; assert `AntigravitySession` refuses in-place model mutation after spawn while `GrokSession` and `OpenCodeServerSession` update `model`/`effort` in-place without extra process spawns.
- **`session_tests.rs`**: Test `SessionManager` respawns with preserved `resume_handle` when existing transport dies (`!is_alive()`), when `state` is `Failed`/`Exited`, and when `update_controls` returns `false` (simulating `gemini-4-argon` -> `gemini-4-hydrogen` model switch after failure).
- **`turn_pipeline_tests.rs`**: Test `classify_turn_failure` matches `RESOURCE_EXHAUSTED` / `"Individual quota reached..."` as `TurnFailure::UsageLimit` and parses reset duration hints.

---

## Tasks

- [x] **T1** (`S1`, `S3`, Risk: `item 3 — shared chat error & frame parsing`, route: `inline`, ~90 lines): Update `parse_antigravity_line` (`antigravity.rs`), `classify_turn_failure` (`coalescer.rs`), and `spawn.rs` `ManagedSendError::Turn` error propagation, plus unit tests in `persistent_tests.rs` & `turn_pipeline_tests.rs`.
- [x] **T2** (`S2`, `S3`, Risk: `item 3, item 4 — persistent session lifecycle & state transitions`, route: `inline`, ~220 lines): Add `is_alive`, `controls`, `update_controls` on `SessionTransport` + implementations in `antigravity.rs`, `grok.rs`, `opencode.rs`, `scripted.rs`, reconcile dead/incompatible sessions in `SessionManager`, and add recovery tests in `session_tests.rs` & `persistent_tests.rs`.
- [x] **T3** (`S1`–`S3`, Risk: `none`, route: `inline`, ~30 lines): Run `cargo test --manifest-path src-tauri/Cargo.toml chat::`, verify `audit-references.mjs --check`, mark specs verified, and commit cleanly without sweeping unrelated dirty diffs.

---

## Log

- **L1 (2026-11-16 — User Incident Report & Requirements):**
  > "Eh entonces yo le mando un prompt. Pero no continuó. Básicamente me aparece como failed. Cambié a modelo Argon. Que me di cuenta que no me quedaba cuota en Argon. Cambié al modelo Hidrogen, que sí me quedaba. Pero, me continuaba apareciendo fallido entonces. Habría que investigar qué pasó."
  - Forensic root cause verified via `cli-20261116_162535.log`, `kite.sqlite` (`b8033fb2`), `quota_cache.json`, `antigravity.rs:180-231,413-416`, `manager.rs:48-55,208-219`, and `spawn.rs:308-321`.
- **L2 (2026-11-16 — Verification & Completion):**
  - Observed RED failures in `persistent_tests`, `turn_pipeline_tests`, and `session_tests`, implemented `S1`–`S3`, and verified `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code chat::` (`257 passed; 0 failed`).
