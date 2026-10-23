# Provider sessions on chat threads

Objective: run a real provider session behind each Agents chat. The session uses the CLI account and configuration that already exist. The screen stays the chat Kite already has. The live process belongs to the thread. The agent is the recipe applied immediately before that process starts.
Branch: `feat/agent-sessions`, created from the pushed provider branch. Do not commit on `main`.
Delivery: `ask-on-risk`; slices are review boundaries. Test runners: `npm test` (`vitest run`) and `cargo test` in `src-tauri`.
Workers: the user launches them. The author of this document does not.
## Product decision
Copy the provider-session behavior in full. Leave the foreign presentation behind. Kite already has chats. Adapt those chats. Do not add a task card, a floating modal, or a canvas.
1. A thread owns the live session: one process, one resume handle, one in-flight turn.
2. An agent owns the recipe: role, skills, memory, and the default provider, model, effort, permission, and work mode. The recipe is written, then the session starts. Later turns send only the new message.
3. The composer shows the controls that connected driver actually has. Changing them updates this thread. It does not rewrite the agent.
4. A chat with no agent starts from the CLI's own account and config. It does not receive Kite skills.
5. The session inherits the existing CLI login and MCP config. Kite does not start a second login and does not keep a second copy of the secret.
6. When the process exits, the thread stays readable. A later turn resumes only with a provider-issued handle. Otherwise it starts a new session, and an agent thread applies the current recipe again first.
## Terms
- **Driver**: integration kind (`antigravity`, `claude`, `codex`, `cursor`, `gemini`, `grok`, `opencode`). Not an account or a permission.
- **Connection**: one account plus one auth method and the endpoints that method verified. `provider-connections.md` remains authoritative.
- **Provider session**: one child process or local server speaking a driver wire. It is attached to one thread. Ephemeral, with a binding snapshot.
- **Resume handle**: provider-issued identifier for continuing a session. Optional; never invented by Kite.
- **Thread**: the durable conversation Kite already stores. Owns the session, the transcript, and composer overrides for this conversation.
- **Agent recipe**: the existing agent record plus its mind files (role, `memory.txt`, `user.txt`, skills). Not a process. Applied once, before the session starts.
- **Transcript item**: durable projection (`user`, `assistant`, `reasoning`, `tool`, `plan`, `approval`, `notice`, `error`).
- **Work mode**: the driver's own plan / build / ask switch, when that driver has one. Distinct from the permission mode.
- **Permission mode**: how much the session may do without asking. Mapped onto that driver's own flag.
## Current-state audit
Observed facts, not future requirements:
- `src-tauri/src/connections.rs` already verifies concrete endpoints. The registry does not use a driver-wide connected boolean.
- `provider-connections.md` already covers auth-method separation, endpoint entitlement, installed/dev registry sharing, and provider-specific restrictions.
- `src-tauri/src/chat/runtime.rs` `launch_provider` starts a new process on every send. If `providerSessionId` is set, the prompt is only the new message and the spawn passes `--conversation`, `--resume`, or `exec resume`. If it is absent, `assemble_thread_context` pastes the thread into the prompt.
- Antigravity's spawn asks for `--output-format stream-json` and still exits when the turn ends. Claude's spawn uses `--output-format text` and also exits. Cursor, Grok, OpenCode, and Gemini spawns omit model and session arguments.
- `stream_child` already reads the child pipes and `handle_stream_json_line` already turns JSON lines into chat items, including tools.
- `src-tauri/src/acp.rs` parses several stream shapes and discovers native MCP servers. Parsing a wire does not prove that a driver can keep a process open.
- Chat already emits typed `status`, `upsert`, `approvalOpened`, and `approvalResolved` events. The UI already has the agent chat shell, the loose chat, and a composer with provider, model, effort, and a mode menu (`plan` plus `readOnly` / `acceptEdits` / `fullAccess`). Those options come from a static catalog.
- `sync_agent_instructions` writes `AGENTS.md` and `CLAUDE.md` from the agent's role, memory, and skills. `launch_provider` calls it only when the thread has no workspace and falls back to the agent home. A workspace thread does not receive that recipe.
- One agent already has many threads (`AgentChatShell` tabs).
- Threads and items persist as application state. Live turn buffers stay in memory.
- Quota reads are separate endpoints. A usage probe does not verify a chat spawn, and a chat spawn does not refresh the plan meter. OpenCode Go quota stays on its usage endpoint.
Missing seams:
- no session manager that keeps one process open and accepts the next message on that process;
- no record joining thread, connection, session generation, and optional resume handle;
- no step that applies the agent recipe before a workspace session starts;
- composer controls are not the controls the live driver declares;
- no durable event fold independent of the child process.
## Specs
S1. The existing thread is the conversation. Creating a thread does not start a provider process. The first send applies S16, then starts the session. A missing binary, a signed-out CLI, an early exit, or an unknown frame leaves the thread readable and keeps the user's prompt.
S2. The existing agent chat and the loose chat render the session: title, binding, lifecycle, streaming text, reasoning, tools, plans, approvals, usage metadata when the wire sends it, and errors. React consumes normalized events. No new task card, floating modal, or canvas.
S3. The provider session attaches to the thread. Replacing a session does not create another thread. A resume handle is stored only when the provider returns one, and only together with thread, driver, connection, and working directory.
S4. One lifecycle contract covers every driver: `start`, `sendTurn`, `interrupt`, `respondApproval`, `stop`, `status`, `eventsSince`. Each driver declares `session_mode: persistent | resumable | one_shot`, the controls it accepts, and the features it does not. Callers use that declaration.
S5. `auth_mode: inherited_cli` reuses the existing CLI environment and config. Kite does not start a second login, copy credentials into a second plaintext store, rewrite provider auth, or require an app restart. A signed-out CLI reports its own recovery instruction (`claude login`, `codex login`, and the equivalent for that driver).
S6. Provider MCP configuration is used as-is and discovered read-only. Extra Kite MCP injection is opt-in, capability-declared, session-scoped, and revocable. Unknown preservation is `unknown`. Agent skills are the recipe in S16, not an MCP server.
S7. A thread may start only on a verified chat endpoint of its selected connection. Quota, API, local RPC, ACP, CLI, and terminal routes do not stand in for each other. The plan meter stays on its own reader. A turn does not, by itself, mark a quota endpoint verified.
S8. Composer changes on a thread (provider, connection, model, effort, permission, work mode) affect that thread's next turn, or the live session when that driver accepts a live change. They do not rewrite the agent recipe. A running session keeps and shows the binding it started with until a live change is actually applied.
S9. The composer shows a control only when the connected driver declares it. Model choices come from that session's catalog. Effort appears only when the selected model advertises levels. Work mode appears only when that driver has plan, build, or ask. Permission choices map onto that driver's flag. A value that cannot be applied is shown with the reason.
S10. Thread commands have stable ids and idempotent receipts. Durable thread events have monotonic sequence and timestamps. Reopening the app folds the same transcript and lifecycle. A compatibility snapshot may remain. It is not the only source of truth.
S11. Normalize provider frames at the native boundary. Unknown frames become bounded `notice` events with provider and schema metadata. Fixture replay is deterministic.
S12. The approval vocabulary is `allowOnce`, `allowForSession`, `deny`, `denyAndStop`. Adapters map it or return explicit unsupported. Unknown or already-settled requests do not mutate the thread.
S13. Provider exit settles pending approvals and marks the turn interrupted or failed. A persistent or resumable driver resumes only with a provider handle. A one-shot driver starts a new command. A persistent session does not receive the pasted transcript. A one-shot driver without a resume handle receives the thread context, and the chat says that each send is a new command.
S14. Every adapter declares its version check, minimum version, fixtures, and unsupported-wire behavior. A mismatch fails closed with a thread-visible diagnostic and preserves the log.
S15. Out of scope: remote access, voice, a new memory backend, automatic account isolation, a new provider, a visual redesign, a task card, a floating modal, a canvas, moving threads or attachments between app-data roots, and any edit to `provider-connections.md`.
S16. Placement. The live process, resume handle, in-flight turn, and composer overrides belong to the thread. The agent holds the recipe. On the first send of a thread that has an agent, write the current recipe with the existing instruction sync, then start the session. The working directory stays the workspace when the thread has one. The recipe enters through the channel that driver accepts. Later messages on that session do not repeat the recipe. Editing skills or memory does not change a running session. The next session of that agent reads the updated recipe. A thread with no agent starts from inherited CLI config only.
S17. A driver whose wire can stay open keeps one process for the thread. The next user message is written to that process. Claude's open session speaks stream-json on stdin and stdout, with partial messages. Codex's open session speaks its app-server. OpenCode's open session speaks its local server. Cursor and Antigravity use the lasting channel each driver actually has. A driver with no lasting channel stays `one_shot`.
S18. Two threads of the same agent are two sessions. They share the account and the recipe snapshot each one started with. They do not share a process.
## Architecture
```text
agent recipe (role, skills, memory, defaults)
  → applied once, before start, when the thread has an agent
connection registry → verified chat endpoint
  → driver adapter → provider session on the thread
  → normalized events → existing chat transcript
composer overrides stay on the thread
```
The provider stream is operational and bounded. The thread transcript is durable and survives the process.
## Tasks
- T0 — Evidence matrix, read-only. S4, S7, S9, S16, S17. Route: user. Status: done. Evidence: `odd/tasks/agent-sessions-t0.md`. Claude is unobservable on this machine (binary absent). For each driver record launcher, whether the process can stay open, auth source, MCP source, where an instruction document is accepted, model catalog, effort levels, permission flags, work modes, resume handle, and unknowns. Do not mutate provider files.
- T1 — Domain contract and a deterministic fake provider. S1, S3, S4, S10–S13, S16, S18. Route: inline. Status: done. Evidence: `src-tauri/src/chat/session.rs`; `cargo test chat::session::` 12 passed; full suite 142 passed. Prove that the session attaches to the thread, that two threads do not share a process, that the recipe is snapshotted at start, and that a later recipe edit does not rewrite the running session.
- T2 — Project the session into the existing chat and adapt the composer. S2, S8, S9. Route: delegated. Status: done. Evidence: `src/lib/session/`; `npx tsc --noEmit` 0; `npm test` 59 files / 413 tests. The recovered view is exported but not mounted in the running app. Show creating, attaching, running, waiting, completed, interrupted, failed, and resumable on the thread that already exists. Composer rows come from the driver declaration. Do not add a card, a modal, or a canvas.
- T3 — Apply the agent recipe before session start. S16, S18. Route: delegated. Status: done. Evidence: `src-tauri/src/chat/recipe.rs`; 4 tests; the first-send call site is wired by T7. A workspace thread still receives the recipe. A thread with no agent does not. Later turns send only the new message. The cwd stays the workspace.
- T4 — Session manager for drivers that can stay open. S4–S7, S11–S14, S17. Route: delegated. Status: done. Evidence: `src-tauri/src/chat/drivers.rs`, `persistent.rs`. Antigravity and OpenCode keep a process; Codex is refused because its app-server documents no turn frame; Claude is unobservable. Antigravity, Claude, and Codex first, on the wire each one can hold open. Do not treat a parser as proof of a launcher.
- T5 — Auth inheritance and MCP preservation. S5, S6. Route: delegated. Status: done. Evidence: `src-tauri/src/chat/provider_env.rs`; 8 tests; preservation stays `unknown` until a session probe observes it. Fixture probes, hash checks, and an explicit `unknown` when preservation was not observed.
- T6 — Durable thread event log and fold. S1, S3, S10, S13. Route: delegated. Status: done. Evidence: `src-tauri/src/chat/event_log.rs`; 25 tests. The runtime does not append to the log yet, so recovery falls back to the compatibility snapshot. Append, receipts, replay, bounded compaction, and a compatibility projection. A failed migration does not destroy the previous store.
- T7 — Remaining drivers, truthful mode. S4, S7, S9, S13, S17. Route: delegated. Status: done. Evidence: `src-tauri/src/chat/persistent.rs`; `cargo test chat::` 138 tests. Only the observed wires stay open; every other driver says one command per turn. Add a lasting session only where T0 shows one. Otherwise keep one command per turn and say so in the thread.
- T8 — Transcript normalization and approvals. S2, S11, S12. Route: delegated. Status: done. Evidence: `src-tauri/src/chat/normalize.rs`; 18 tests; checked-in fixtures; unknown frames become bounded notices. Normalize tools, plans, reasoning, approvals, notices, usage, and errors.
- T9 — Recovery and a second view. S3, S10, S13, S16. Route: delegated. Status: done. Evidence: `recover_thread` plus `recover_chat_thread`; 25 event-log tests; 5 view tests. The second view is exported but not mounted. Reopen from the log, resume only with a provider handle, and show the same thread twice.
- T10 — Fixture and failure verification. S1–S18. Route: delegated. Status: done. Evidence: `src-tauri/src/chat/contract.rs`; 13 tests; full suite 261 Rust + 413 frontend. Replay adapters, compare behavior before and after, assert auth and MCP bytes, and recover from a malformed frame.
Slices: A = T0–T3; B = T4–T6; C = T7–T8; D = T9–T10.
## Non-regression and verification
- Preserve endpoint-specific connection eligibility, chat item kinds, approval decisions, and a readable thread when the provider fails.
- T0 is read-only. T1–T3 use the fake provider, then the applicable suite. T4–T8 use fixtures and argv or env assertions. T6 and T9 replay the same log twice. T10 runs the focused tests and the applicable suites once.
- Every completed task closes with `Risk: item N (reason)`, or `Risk: none` only after checking shared behavior.
## Candidate edit surfaces
Planning candidates, not blanket authorization. The user names exact surfaces when launching a worker. Expected areas: `src-tauri/src/chat/runtime.rs`, `src-tauri/src/chat/threads.rs`, `src-tauri/src/chat/mod.rs`, `src-tauri/src/acp.rs`, `src-tauri/src/agent_mind/`, `src-tauri/src/chat/session.rs` if a new file is warranted, `src/lib/chat/`, `src/components/views/chat/`, `src/components/views/agents/`. `src-tauri/src/connections.rs` is read-only from this feature. Do not edit `provider-connections.md`.
## Invariants
- Do not branch the shared connection registry on `cfg!(debug_assertions)`.
- Do not write, move, or delete provider auth or MCP files during probes, discovery, or a rejected command.
- Do not derive a capability from a driver id. Process start does not prove auth, entitlement, model support, MCP preservation, or readiness.
- Do not make the renderer parse raw provider frames or terminal output.
- Do not invent resume handles.
- Do not make a one-shot driver look persistent.
- Do not attach the live process to the agent. Two threads of one agent are two sessions.
- Do not start the session and paste the recipe afterwards. The recipe is already written when the process starts.
- Do not repeat the recipe or the prior transcript on a later turn of a persistent session.
- Do not add a task card, a floating modal, or a canvas for this feature.
- Do not let a composer change on one thread rewrite the agent recipe.
- Generated artifacts stay in English. Product docs, UI copy, comments, and commit messages describe this product's own implementation only: no external project names and no derivation or provenance claims.
- Do not add a memory backend or a remote protocol in this feature.
- The author of this document does not launch the implementing agents.
## Allowed edit surfaces
Exact surfaces are fixed when the user launches each task. New files are listed in that launch. A worker does not edit the repository root, unrelated provider modules, or broad unrelated globs.
## Log
L1. 2026-10-23. Product intent, restated without external references: review the existing plan and the code that already exists, then improve the plan until it describes a shippable product. The part that matters is a real provider session running behind a conversation, reusing the CLI account and configuration that already exist instead of asking for a new login. Keep this product's own screen. Any provenance is omitted from every artifact by policy.
L2. 2026-10-23. The prior plan was too transport-centric. This revision separates the durable task card from the ephemeral provider session, makes one-shot behavior valid, and prioritizes existing auth, existing MCP configuration, no app restart, transparent profile degradation, and better transcript presentation.
L3. 2026-10-23. Design input retained from prior artifact analysis: provider sessions are separate from durable orchestration threads; readiness is handshake-based; events are normalized/sequenced; task state is replayable; approvals are mapped per driver; account binding and scoped tool injection are explicit. Product artifacts omit provenance.
L4. 2026-10-23. Current-tree reconciliation: connection/endpoint verification, typed chat events, ACP parsing, and MCP discovery already exist; the missing seam is the task/session manager, durable replay, truthful capability matrix, and New Task card lifecycle.
L5. 2026-10-23. User correction, verbatim: the session layer is what gets implemented. The screen stays the existing chat. The composer is adapted for provider, model, thinking level, permissions, and the work mode each provider already has. Task cards, floating modals, and the canvas are not part of this feature. Quota remains a separate endpoint.
L6. 2026-10-23. User correction, verbatim: decide whether the session belongs to the agent or the thread. Both sides participate. On an agent thread the recipe (how that agent should behave, including skills) is applied before the session starts.
L7. 2026-10-23. Decision recorded for workers the user will launch. The thread owns the live session. The agent owns the recipe and that recipe is snapshotted before start. A loose chat has no Kite recipe. This document supersedes the task-card product decision in L2 and L4. The author does not launch those workers.
L8. 2026-10-23. T0 completed read-only, evidence in `odd/tasks/agent-sessions-t0.md`. Observed: installed `agy` 1.4.5, `codex` 0.163.0, `cursor-agent` 2026.10.22, `gemini` 0.64.0, `grok` 1.0.62, `opencode` 2.1.4; `claude` absent. No provider auth or MCP file was written, moved, or deleted; no provider process was started with a prompt.
Findings that change the plan:
- Cursor's launcher resolves `agent` before `cursor-agent` (`runtime.rs:734`), and on this machine `agent` is Grok's binary. A Cursor send starts Grok. Defect, not a gap.
- Only the absence of argv wiring makes Gemini, Grok, and Cursor one-shot: all three expose resume flags. Antigravity, Codex, and OpenCode expose a lasting channel. The S17 premise holds, but T7's "remaining drivers stay one_shot" does not.
- S17's Claude stream-json premise is unverifiable here; T4 must record `unobservable`, not a pass, for Claude.
- Model catalogs are dynamic only for Antigravity and Codex. Rust and TypeScript lists disagree for Gemini and Grok. S9 is unmet today.
- MCP discovery skips Grok and OpenCode, and a built-in `kite-tasks` server is reported as available to every provider, contradicting S6's opt-in rule.
- The recipe sync writes `AGENTS.md`, `CLAUDE.md`, `README.md` into the agent home only: no `GEMINI.md`, no Cursor rules, and workspace threads never call it.
- `clip_argv` truncates the prompt at 12,000 characters silently (`utils.rs:25-27`), which drops pasted thread context on a one-shot driver without a notice.
Baseline note: the header statement "Branch: not created" is stale. The tree is on `feat/provider-connections` with unrelated modified and untracked files. No commit was made. T1 must start from a decision about that baseline before it measures anything.
L9. 2026-10-23. T1 implemented inline on `feat/agent-sessions`. New module `src-tauri/src/chat/session.rs`: `SessionMode`, `SessionState`, `RecipeSnapshot`, `SessionRecord`, `SessionManager`, `SessionTransport`, and the deterministic `ScriptedTransport`. Proven by test: attach is idempotent and starts nothing; start spawns exactly one process per thread; two threads of one agent are two sessions; the recipe revision reaches the transport before the spawn and a later edit never reaches the running session; later turns carry only the new message; a command id is idempotent, returns a duplicate receipt, and rejects a different payload; events are monotonic; an unknown approval mutates nothing; a provider exit settles pending approvals; resume requires a provider-issued handle; a one-shot session starts a new command per send.
Not covered yet, by design: persistence and replay (T6), real driver wiring (T4), recipe file application (T3), composer and UI projection (T2). `SessionMode::Persistent` reflects the contract only; T0's matrix decides which drivers may declare it.
Verification note: the full suite flaked once under default parallelism in process and network tests, then passed 142/142 with `--test-threads=4`. The new module is deterministic and spawns no thread.
L10. 2026-10-23. T2–T10 implemented in three delegated waves. All commits are local on `feat/agent-sessions`; no push was made.
Delivered: session projection and a declaration-driven composer (T2); recipe snapshot and workspace application, wired before the first send (T3, T7); driver declarations with version evidence and lasting wires for Antigravity and OpenCode (T4, T7); read-only inherited environment with explicit `unknown` preservation (T5); durable event log with fold, receipts, compaction, and recovery (T6, T9); frame normalization and approval mapping with checked-in fixtures (T8); cross-module contract tests (T10).
Verification: `cargo test` 261 passed, 0 failed; `npm test` 59 files / 413 tests; `tsc --noEmit` clean.
Corrected during integration: Grok now maps the declared permission mode onto `--permission-mode`, and `send_route` requires a served transport rather than only a declaration.
Still open, recorded honestly: the runtime does not append to `ThreadEventLog` yet, so recovery usually falls back to the compatibility snapshot; `RecoveredThreadView` and `SessionResumeBar` are exported but not mounted; Cursor, Gemini, and Grok declare resume while the one-shot endpoint contract still omits a session handle; Codex stays one command per turn because its app-server documents no turn frame; the OpenCode turn output and the Antigravity stdin frame are unverified against a real process; S6 opt-in MCP injection and revocation has no implementation; the registry-backed S7 endpoint verification path is not exercised by the contract tests.
## Key Learnings
1. The thread outlives the provider process. The process is a resource of that thread, not of the agent.
2. One agent with several threads means several sessions. They share an account and a recipe snapshot, not a process.
3. The recipe is applied before the process starts. Later turns of a persistent session send only the new message.
4. A successful spawn proves process execution only. It does not prove authentication, entitlement, MCP preservation, model support, or resumability.
5. A driver without a lasting channel stays one command per turn, and the chat says so.
6. The connection registry and the existing chat are the foundations to extend.
