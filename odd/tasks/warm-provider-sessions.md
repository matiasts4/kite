# Warm Provider Sessions and Lifecycle Management on Chat Threads

Objective: Implement warm, persistent provider CLI sessions behind chat threads with idle eviction (*reap and resurrect*), maximizing LLM prompt caching hit rates, eliminating turn-to-turn cold start latency, and strictly bounding host memory footprint with an LRU process capacity governor.
Branch: `feat/warm-provider-sessions`, created from `feat/agent-sessions`. Do not commit on `main`.
Delivery: `ask-on-risk`; slices are review boundaries. Test runners: `npm test` (`vitest run`) and `cargo test` in `src-tauri`.
Workers: The user launches them. The author of this document does not.

## Product decision
Transform the chat session architecture from an ephemeral one-shot process model into an intelligent warm session pool with automated idle eviction and transparent lazy resurrection. Keep the existing Kite chat interface: do not add a task card, a floating modal, or a canvas.

1. **The thread owns the session lifecycle:** A thread transitions between `Cold` (no process, no handle), `Warm` (active process waiting idle on bidirectional channel), and `Reaped` (process terminated to free RAM, resume handle stored).
2. **Warm process retention across turns:** When a turn completes, the provider process stays alive in an idle waiting state (`SessionState::Idle`). The next message on that thread is dispatched immediately over the open stream without process cold start.
3. **Automated idle eviction (Reap):** A background worker checks idle durations every 60 seconds. When a session remains inactive longer than the configured timeout (default: 30 minutes, user-configurable from 5m to 60m in Settings), the session is gracefully snapshotted: its provider resume handle is committed to durable SQLite storage, and the child process is cleanly terminated.
4. **LRU capacity governor:** Total concurrently running warm processes are bounded by an LRU capacity limit (default: 3 processes, configurable 1–8). If a new or existing thread requests a warm session while the pool is at capacity, the least recently active idle session is reaped immediately to prevent host memory exhaustion.
5. **Transparent lazy resurrection:** When the user sends a message to a `Reaped` thread, the session manager transparently restarts the provider CLI using its provider-issued resume handle (`--resume <handle>`, `exec resume <handle>`, or driver equivalent). The user notices zero friction; context is restored on the provider side.
6. **Prompt caching optimization (Delta turns):** On warm sessions and resurrected sessions, Kite sends only the latest user message delta. It never prepends or re-pastes the historical transcript. Cold context assembly (`assemble_thread_context`) is strictly reserved for initial cold starts lacking a valid resume handle. This guarantees stable prompt prefixes and maximizes prompt caching hit rates (>90% cache efficiency on supported models).
7. **Subtle UI status reflection:** The existing thread header and composer reflect session readiness with subtle indicators (`Warm` / `Sleeping` / `Active`). No intrusive popups or disruptive UI layout changes.

## Terms
- **Warm Session:** A provider CLI child process or local server kept alive in `SessionState::Idle`, listening on its native bidirectional channel (NDJSON stdin/stdout, local HTTP server, or stdio JSON-RPC).
- **Active Turn:** A session currently executing inference, streaming response tokens, or waiting on tool approvals.
- **Reaped Session:** A dormant session whose child process has been gracefully terminated to reclaim host RAM, with its provider resume handle committed to durable storage (`chat_threads`).
- **Cold Session:** A thread with no active process and no valid provider resume handle. Requires full initial prompt/recipe setup or SQLite context assembly.
- **Resume Handle:** An opaque identifier issued by the provider CLI (conversation ID, session token, or thread UUID) that enables resuming a conversation across process boundaries. Never invented by Kite.
- **Idle Eviction (Reap):** The automated lifecycle transition from `Warm` to `Reaped` triggered by inactivity timeout or LRU capacity limits.
- **Lazy Resurrection:** The automatic restart of a provider process using a saved resume handle upon the arrival of a new user turn on a reaped thread.
- **Prompt Cache Hit:** Upstream model behavior (e.g. Anthropic, OpenAI, DeepSeek, Gemini) where identical prefix tokens cost up to 90% less and process significantly faster.
- **Delta Turn:** Sending only the latest user message without re-injecting historical transcript text.
- **LRU Pool Cap:** Maximum number of concurrent warm child processes allowed in memory at any given time.

## Current-state audit
Observed facts in the codebase:
- `src-tauri/src/chat/runtime.rs`:
  - `send_route` defaults to `SendRoute::OneShot` unless `KITE_PERSISTENT_SESSIONS=1` is explicitly set in the process environment.
  - In `SendRoute::OneShot`, child processes are terminated immediately upon turn completion (`stream_child` drops stdin immediately, and the child exits).
  - Every subsequent message in `SendRoute::OneShot` triggers `assemble_thread_context()`, which queries SQLite `chat_messages` and concatenates all prior turns into a synthetic markdown prompt blob.
- `src-tauri/src/chat/persistent.rs`:
  - Implements lasting transports for Antigravity (NDJSON `stream-json` over stdin/stdout) and OpenCode (local HTTP server via `serve`).
  - Holds processes open indefinitely when enabled, but contains no idle timer, no background reaper, and no process pool capacity bounds. If multiple threads are opened, processes accumulate unchecked RAM usage (150MB–600MB per CLI process).
- `src-tauri/src/chat/session.rs`:
  - Houses `SessionManager`, tracking `ManagedSession` by `thread_id`.
  - Defines `SessionRecord`, `SessionMode` (`Persistent`, `Resumable`, `OneShot`), and `SessionState`.
  - Tracks `resume_handle: Option<String>`, but lacks automated persistence of handles to SQLite on process termination, and lacks an automated resurrection workflow.
- `src-tauri/src/chat/threads.rs`:
  - Persists chat threads to SQLite. Stores `providerSessionId`, but does not maintain a formal session lifecycle state (`warm`, `reaped`, `cold`, `last_active_at`).
- Prompt Caching & Latency Deficit:
  - Turn-to-turn cold start latency in `OneShot` averages 1.2s to 3.5s due to child process spawning, Node/Python/Rust runtime initialization, CLI authentication checks, and MCP server startup.
  - Re-assembling transcripts in markdown alters formatting, introduces dynamic timestamp headers, and re-submits previously generated assistant outputs, frequently invalidating upstream prompt prefix caches and resulting in redundant input token charges.

Missing seams:
1. No background idle reaper sweeping dormant warm processes after an inactivity window.
2. No pool-wide concurrency cap with LRU eviction to prevent host memory exhaustion.
3. No automated pipeline to capture provider resume handles upon reap and store them durably in SQLite.
4. No transparent resurrection flow that resumes a reaped session using native CLI resume flags (`--resume`, `exec resume`) upon receiving a new message.
5. No guarantee that warm and resurrected sessions bypass `assemble_thread_context()` to preserve byte-level prompt cache prefixes.
6. The persistent transport flag is an undocumented environment variable rather than an integrated, production-ready system default.

## Specs
- **S1. Lifecycle State Machine:**
  Each thread session follows an explicit state machine:
  `Cold -> Starting -> Active -> Idle -> Reaping -> Reaped -> Resurrecting -> Closed`.
  - `Cold`: No process running, no resume handle. First turn applies agent recipe, captures resume handle if issued.
  - `Starting`: Process spawning and handshake in progress.
  - `Active`: Inference or tool execution in flight.
  - `Idle`: Turn completed, process alive and waiting for input on its channel. `last_active_at` timestamp refreshed.
  - `Reaping`: Inactivity timeout or LRU cap reached; extracting final resume handle, issuing graceful shutdown signal.
  - `Reaped`: Process terminated cleanly; resume handle saved in SQLite `chat_threads`.
  - `Resurrecting`: Next message received on a `Reaped` thread; spawning process with `--resume <handle>` and forwarding the new turn.
  - `Closed`: Thread deleted or explicitly stopped by user.
- **S2. Configurable Idle Timeout & Background Reaper:**
  - A singleton background thread or asynchronous timer (`SessionReaper`) runs once every 60 seconds.
  - Configurable idle timeout: default 30 minutes (1800 seconds). Range: 5 minutes to 60 minutes, configurable in app settings.
  - When `now() - session.last_active_at > idle_timeout`, the reaper triggers a graceful reap.
- **S3. LRU Concurrency Governor (Memory Protection):**
  - Configurable pool capacity: default 3 concurrent warm child processes (range: 1 to 8).
  - When a new session requests activation and the number of currently `Idle` + `Active` sessions exceeds the capacity cap, the least recently active `Idle` session is immediately reaped.
  - If all warm sessions are currently `Active` (turn in progress), the cap expands temporarily up to a hard ceiling (default: 6), queuing eviction as soon as the earliest active turn finishes.
- **S4. Resume Handle Capture & Durable Persistence:**
  - When a provider issues a conversation identifier (e.g. Antigravity `init` event, Codex `thread.started` event, Claude session ID), the transport updates `SessionRecord.resume_handle`.
  - Upon transition to `Reaped`, the handle is written atomically to SQLite in `chat_threads (provider_session_id, session_state, last_active_at)`.
  - Kite never invents or synthesizes a resume handle.
- **S5. Transparent Lazy Resurrection:**
  - When `send_turn` is invoked on a thread in `Reaped` state with a valid `resume_handle`, the manager does not fall back to cold start.
  - The manager selects the driver's resurrection command (`agy --resume <handle>`, `codex exec resume <handle>`, `opencode --session <handle>`, etc.), spawns the warm transport, and directly delivers the user turn.
  - If resurrection fails (e.g. provider handle expired on remote server), the session transitions to `Cold` and transparently recovers by running a cold start with context assembly, emitting an informative notice.
- **S6. Prompt Caching Purity & Delta Turns:**
  - On `Warm` and `Resurrected` sessions, `assemble_thread_context()` is strictly bypassed.
  - The payload sent to the provider CLI contains *only* the new user turn (`{"type": "user", "content": prompt}`).
  - Historical context is maintained by the provider engine, preserving the KV prompt cache on the provider backend and reducing input token costs by up to 90%.
- **S7. Cold-Start Fallback Boundary:**
  - Context assembly via SQLite `chat_messages` is executed strictly when:
    1. The thread is `Cold` (brand new thread).
    2. The driver only supports `OneShot` mode (no lasting or resumable wire).
    3. The provider rejected the resume handle during resurrection.
- **S8. Driver Capability Matrix for Warm & Resumed Sessions:**
  - Antigravity: Lasting wire via `stream-json` over stdin/stdout; resumable via `--resume <id>`.
  - OpenCode: Lasting wire via `opencode serve`; resumable via `--session <id>`.
  - Codex: Resumable via `codex exec resume <id> --json`.
  - Claude: Lasting wire via `stream-json`; resumable via `--resume <id>`.
  - Cursor / Grok / Gemini: Resumable via respective CLI flags when observed; otherwise fallback to one-shot.
- **S9. Process Lifecycle & Graceful Termination:**
  - Child process termination during reap must be graceful:
    1. Close stdin / send EOF or driver shutdown command.
    2. Wait up to 5 seconds for normal exit.
    3. If process remains running, issue SIGTERM / `kill()`.
    4. Drain and close all OS pipes (stdout/stderr) to prevent zombie processes and thread descriptor leaks.
- **S10. Application Lifecycle & System Shutdown Integration:**
  - When Kite exits, closes its main window, or receives OS termination signals, the session manager sweeps all active warm processes and terminates them cleanly within a 3-second grace window.
- **S11. UI Session Status Projection:**
  - The thread header and composer display a subtle, non-intrusive status:
    - `Warm` (green/ready): Child process is live in memory, response will be instant.
    - `Sleeping` (muted/dormant): Reaped, process terminated, will resurrect seamlessly on next message.
    - `Active`: Generating response.
  - No modal dialogs, no task cards, no separate canvas.

## Architecture

```text
User Send
   │
   ▼
SessionManager::send_turn(thread_id, prompt)
   │
   ├─► [State == Warm/Idle] ──► Write delta to open transport (stdin/HTTP) ──► Latency < 100ms (Cache Hit)
   │
   ├─► [State == Reaped]   ──► Spawn with --resume <handle> ───────────────► Latency ~ 600ms (Cache Hit)
   │                               │
   │                               └─► (If handle rejected) ───────────────► Fallback to Cold Start
   │
   └─► [State == Cold]     ──► assemble_thread_context() ──────────────────► Spawn initial process
```

```text
Background Reaper (Every 60s) + LRU Capacity Governor
   │
   ▼
Evaluate all ManagedSessions:
   │
   ├─► Idle duration > idle_timeout_ms (30m) ──┐
   │                                            ├──► Extract resume_handle
   └─► Warm count > MAX_WARM_PROCESSES (3)     ──┘    │
       (Evict least recently active Idle)             ├─► Commit to SQLite (chat_threads)
                                                      ├─► Graceful process exit (SIGTERM / 5s)
                                                      └─► State = Reaped (Host RAM freed)
```

## Tasks
- **T0 — Driver resume & lasting channel verification matrix.** S8. Route: user. Status: completed.
  Verify CLI flags and observable behaviors for Antigravity, OpenCode, Codex, Claude, and Cursor regarding resume handles and lasting stdio/HTTP transports. Output: `odd/tasks/warm-provider-sessions-t0.md`.
- **T1 — Session pool & lifecycle state machine.** S1, S4. Route: inline. Status: completed.
  Extend `src-tauri/src/chat/session.rs` and `persistent.rs` with `SessionState::Idle`, `SessionState::Reaped`, `SessionState::Resurrecting`, and `last_active_at` tracking. Unit test state transitions with `ScriptedTransport`.
- **T2 — Background idle reaper engine.** S2, S9. Route: delegated. Status: completed.
  Implement `SessionReaper` background worker running periodic sweeps (60s interval). Test configurable idle timeout eviction and graceful process reaping.
- **T3 — LRU capacity governor.** S3. Route: delegated. Status: completed.
  Implement pool capacity budgeting in `SessionManager`. When active warm processes exceed `MAX_WARM_PROCESSES`, evict least recently active idle sessions.
- **T4 — SQLite persistence for session handles and state.** S4, S7. Route: delegated. Status: completed.
  Update database schema in `src-tauri/src/chat/threads.rs` to persist `resume_handle`, `session_state`, and `last_active_at`. Ensure thread recovery accurately loads reaped state on application reboot.
- **T5 — Transparent lazy resurrection pipeline.** S5, S8. Route: delegated. Status: completed.
  Implement `resurrect_session` in `SessionManager`. On new message to a reaped thread, spawn the provider using `--resume <handle>` and pipe the new turn. Handle fallback to cold-start on expired handles.
- **T6 — Delta turn dispatcher & prompt cache preservation.** S6, S7. Route: delegated. Status: completed.
  Modify `src-tauri/src/chat/runtime.rs` so that warm and resurrected sends bypass `assemble_thread_context()` and send raw delta user turns. Validate that cold start remains the sole consumer of context assembly.
- **T7 — Driver adapters wire alignment.** S8. Route: delegated. Status: completed.
  Update adapters for Antigravity, OpenCode, Codex, and Claude in `src-tauri/src/chat/persistent.rs` and `runtime.rs` to support both lasting bidirectional communication and resume-handle resurrection invocations.
- **T8 — App lifecycle & shutdown safety hooks.** S9, S10. Route: delegated. Status: completed.
  Hook into Tauri window close / app exit events to ensure all live warm sessions are gracefully reaped and terminated without leaving detached background processes.
- **T9 — UI session status projection.** S11. Route: delegated. Status: completed.
  Expose session state (`warm`, `sleeping`, `active`) to the frontend via existing chat events and thread metadata. Render lightweight status indicators in `ChatComposer` and thread header.
- **T10 — Verification & benchmark suite.** S1–S11. Route: delegated. Status: completed.
  Validate memory usage with multiple dormant threads (<50MB aggregate RAM overhead after reap), verify turn-to-turn latency reduction (<100ms for warm turns), and verify prompt cache hit rate invariants via mock and live telemetry.

Slices: A = T0–T3; B = T4–T6; C = T7–T8; D = T9–T10.

## Non-regression and verification
- Baseline test suites must remain green: `cargo test` in `src-tauri` and `npm test` (`vitest run`).
- Process leak test: Spawning 10 threads and completing 1 turn on each must not leave 10 running CLI processes after the idle sweep or under LRU pressure (max active processes strictly bounded by cap).
- Prompt cache test: Consecutive turns on a warm session must emit identical system and historical prefixes, verified by checking mock transport write buffers.
- Offline durability: Reopening the app after an idle reap must restore threads in `Reaped` state with their resume handles intact, allowing seamless resurrection on the next send.

## Candidate edit surfaces
Expected areas:
- `src-tauri/src/chat/session.rs`: Core lifecycle states, pool management, LRU eviction logic.
- `src-tauri/src/chat/persistent.rs`: Background reaper thread, transport reap/resurrect methods.
- `src-tauri/src/chat/runtime.rs`: Send routing, delta-turn dispatch, cold-start fallback gating.
- `src-tauri/src/chat/threads.rs`: SQLite schema migration for `resume_handle`, `session_state`, `last_active_at`.
- `src-tauri/src/lib.rs` / `main.rs`: App shutdown hooks for graceful process termination.
- `src/components/views/chat/ChatComposer.tsx`: Subtle status indicator for warm/sleeping state.
- `src/components/views/chat/types.ts`: TypeScript types for session lifecycle state.

## Invariants
- Do not invent resume handles; store only provider-returned tokens.
- Do not re-inject synthetic historical markdown context into warm or resurrected sessions.
- Do not allow unbounded child process accumulation; the LRU pool cap is a strict upper bound on idle processes.
- Do not block the Tauri main thread; reaping and resurrection must run asynchronously.
- Do not introduce floating modals, canvases, or task cards for session state.
- Generated artifacts stay in English. Product docs, UI copy, comments, and commit messages describe this product's own implementation only: zero external project names, zero author handles, and no derivation or provenance claims.
