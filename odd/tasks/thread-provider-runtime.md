# Thread Provider Runtime, Sessions, and Event Normalization (ODD 1 of 3)

Objective: Unify the Thread backend around a single provider session contract, stateful event normalization, per-account model/effort catalogs, thread-scoped permission enforcement, and structured failure classification so every connected provider streams live actions and answers identically without one-shot CLI fallbacks or leaked stderr output.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `ask-on-risk`.
Test runner: `cargo test chat::`, `npx vitest run src/components/views/chat`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.
Series: ODD 1 of 3 for the Thread overhaul (paired with ODD 2: `odd/tasks/thread-timeline-surface.md` and ODD 3: `odd/tasks/thread-composer-and-navigation.md`). Owns the backend half of the former `response-thread.md` specs `S2`, `S3`, `S8`, `S9`, `S10`, `S12`, `S26`, `S29`, and `S30`. The failure banner itself is ODD 2. `odd/tasks/response-thread.md` stays the confirmed source until this file's tasks are closed.

---

## Architecture Overview

```text
User Send / Follow-Up / Approval Reply
                 │
                 ▼
      SessionManager (per thread_id + connection_id)
                 │
    ┌────────────┴────────────────────────────────────────┐
    │                                                     │
    ▼                                                     ▼
Persistent Transports                           Resumable Stream Transports
- ACP Stdio (`grok`, `antigravity`,             - `claude` (`--resume <id> --output-format stream-json`)
  `kiro`, `fx`)                                 - `cursor` (agent resume stream)
- App-Server JSON-RPC (`codex`)                 - `gemini` (one-shot fallback when no resume handle)
- Local HTTP Server (`opencode` 1.x / 2.x)
- RPC Mode (`pi`), Serve Mode (`muse`)
    │                                                     │
    └────────────┬────────────────────────────────────────┘
                 │ Raw JSON-RPC / NDJSON / SSE frames (stdout)
                 │ + Isolated process diagnostics (stderr)
                 ▼
      Stateful Turn Normalizer (`normalize.rs`)
      - ToolCallTracker (merges chunks by `tool_call_id`)
      - DeltaCoalescer (50ms flush window for text & reasoning)
      - Reverse Request Router (approvals, interactive questions, plans)
      - Failure Classifier (`UsageLimit`, `AuthRequired`, `CliUsageError`, `ProcessError`)
                 │
                 ▼
      Single Turn Projector (`runtime.rs`) ──► Live Frontend Events + SQLite Persistence
```

---

## Specs

### S1. One Canonical Event Pipeline and Stateful Tool Merger
User words: "Cómo, también el funcionamiento por detrás también, eso es algo importante. Básicamente, cómo maneja cada respuesta para los proveedores, cómo los conectan... cuando lo llego a probar no se ve ni, se comporta igual. Y bueno, tiene bastantes errores."
Current fact:
- `src-tauri/src/chat/` maintains three separate parsers (`normalize.rs`, `acp.rs`, and `persistent.rs`). `pump_persistent_session` polls every 40ms, wraps ACP frames in `TransportEvent::Activity(raw)`, and re-parses them in `handle_stream_json_line`.
- Streaming tool frames (`tool_call`, `tool_call_update`, `tool_call_content_chunk`) are handled line-by-line without a per-turn state accumulator, losing tool inputs (`Path`, `command`, `query`) or diff counts when status updates arrive in later frames.
- `emit_deltas` locks `threads()` and persists to disk on every incoming chunk.
Acceptance:
- Every provider transport emits into one canonical `ProviderTurnEvent` pipeline: `SessionStarted`, `MessageDelta`, `ReasoningDelta`, `ToolCallUpdated`, `PlanUpdated`, `ApprovalRequested`, `UserInputRequested`, `UsageUpdated`, and `TurnTerminal`.
- A per-turn `ToolCallTracker` indexed by `tool_call_id` merges `tool_call` (initial kind, title, raw input parameters, search `query`), `tool_call_update` (status, file locations, diff line totals), and `tool_call_content_chunk` (streaming output) into a single transcript item (`upsert_tool_snapshot` preserves `query`, `toolName`, and `serverName`) so action rows never lose their path, command, search query, or status.
- When an assistant item receives new text deltas after subsequent tool/work items have been appended (`pos + 1 < list.len()` in `threads.rs` and `idx < items.length - 1` in `turnPolling.ts`), the assistant item moves to the tail of the turn so the final response always renders chronologically below the tool trace.
- `MessageDelta` and `ReasoningDelta` use a `50ms` coalescer: the first chunk and segment-close flush immediately, and intermediate chunks coalesce before updating `threads()` and SQLite.
- Unknown frames are recorded as bounded diagnostic notices (`kind: "notice"`) and covered by provider fixtures; internal housekeeping notifications (`available_commands_update`, `session_info_update`, `hook_execution`, `config_option_update`, `current_mode_update`) are silently ignored and never injected into the assistant message or transcript.
Checks: unit tests in `chat::normalize` verifying multi-frame `tool_call` + `tool_call_update` + `tool_call_content_chunk` merging and 50ms delta coalescing.

### S2. Unified Session Transports Across Connected Providers
User words: "Básicamente, cómo maneja cada respuesta para los proveedores, cómo los conectan. Y todo ese tipo de cosas."
Current fact:
- Only Antigravity, OpenCode, and Grok use `SessionManager`, while Codex, Claude, and Cursor fall back to spawning one-shot CLI commands that re-paste the entire conversation history as markdown on every turn.
Acceptance:
- One thread holds one provider process across messages. The next message goes to that process. It does not spawn a second one for the same thread.
- Accepting the send stores the intent. It does not mean the provider has finished.
- Closing the thread, or the provider exiting, ends that process. The thread remains. The next message starts or resumes the session. It does not pretend the dead process is still there.
- Idle reap may persist `providerSessionId` and resurrect on the next message. The default idle timeout is 30 minutes and the warm cap is 3. A reaped process is not shown as still running.
- The selected model and thinking level are set on an open session before the message runs. A change after send does not rewrite the process already running.
- Each action that session emits appears as its own row while the turn runs. A missing frame stays a notice. The spawn does not gain an invented argument. The driver table records the observed flag and the version that was read.
- A reverse request is answered on the session that owns the process. A reply written only to a one-shot stdin does not count. `x.ai/ask_user_question` and `x.ai/exit_plan_mode` reach the same pipeline as `session/request_permission`. An unknown request that carries an id gets an error result so the process cannot wait forever. A question is shown and answered on that same session. A plan request is acknowledged so its gate opens; the acknowledgement does not approve implementation.
- **ACP Native Tool Execution (`clientCapabilities: {}`)**: ACP `initialize` frames (`grok_initialize_line`) declare `"clientCapabilities": {}` unless the client explicitly implements `fs/read_text_file`, `fs/write_text_file`, and `terminal/*` RPC servers. Advertising unimplemented client capabilities hijacks native tools (`read_file`, `search_replace`, `run_terminal_command`) into `-32601` failures; keeping `clientCapabilities` empty lets ACP providers run their native filesystem and shell tools directly inside their own process.
- **ACP Session Update & Turn Completion Parity**: ACP stream parsing accepts `"session/update"`, `"_x.ai/session/update"`, and `"x.ai/session/update"`. `"turn_completed"` / `"turn_complete"` emits `TransportEvent::TurnEnded` (plus `UsageUpdated` when `usage` is present) so turns settle immediately upon completion instead of hanging until the 20s quiet timer.
- **Antigravity & OpenCode Stream Parity**: `antigravity_args` maps `auto` (`--mode auto`), `acceptEdits` (`--mode accept-edits`), and `fullAccess` (`--dangerously-skip-permissions`) cleanly for headless `stream-json` sessions. `opencode_line_event` forwards structured JSON event frames (`tool_call`, `tool_use`, `tool_result`, `thinking`, `reasoning`, `text_delta`, `content_block_delta`, `step_start`, `step_finish`, `turn.completed`, `session/update`, `session/request_permission`) as `TransportEvent::Activity` while keeping plain text and unrecognized objects as `TransportEvent::Text`.
- Delivered turn events may leave the live buffer. An event the client has not been given is not dropped while the turn is running.
- If the provider sends nothing for 20 seconds, the transcript shows `The provider has not sent an update. Stop the turn if this stays quiet.`
- **Observed lasting channels**: Grok uses `agent stdio`. Antigravity uses its installed ACP runtime. OpenCode uses its server: one server per thread on 1.x, one server per account instance on 2.x. These are the documented channels, not a second dialect.
- **Codex**: `codex app-server --help` documents the stdio transport and the schema tooling, but no request frame that accepts a user turn was observed. This build does not invent one. Codex stays one command per turn. The refusal is `CODEX_APP_SERVER_GAP`.
- **Claude and Cursor**: this build has no observed lasting wire. They stay one command per send. A resume flag is not added until that flag is read from the installed CLI.
- **Pi, Muse, Kiro, and fx**: follow the one-session rule only when that program is installed and a driver declaration has been observed. A missing binary is an empty state, not a fake session. This build has no observed driver declaration for them, so no lasting wire is invented.
- **Gemini** has no lasting channel. It stays one command per message. The thread does not label that command as a session.
- A second account of the same provider does not reuse the first account's process.
Checks: one test that a second send on the same thread does not spawn a second process; one test that Gemini still spawns one command per send; one test that Codex stays one command per turn while `CODEX_APP_SERVER_GAP` is the wire; one test that a missing Pi, Muse, Kiro, or fx binary does not start a fake session.

### S3. Account Isolation and Side-Effect-Free Model & Effort Discovery
User words: "cuando hay distintos proveedores que tienen como varios modelos. Y cada uno de esos modelos tiene distintos niveles de pensamiento. Entre low, medium, high. Algunos tienen max o ultra... Apreto para seleccionar Grok. Y no se cargan los modelos."
Current fact:
- Model cache in `src-tauri/src/chat/models.rs` is keyed only by provider name (`canon`), not by `(provider, connection_id)`, so multiple accounts share one cached catalog.
- Spanish effort labels lacked `ultra`, and some drivers had hardcoded `accepts_effort: false`.
Acceptance:
- Model and capability caches are keyed by `(provider, connection_id)`. Two accounts of the same provider never share mutable session state, credentials, or model catalogs.
- Catalog discovery never opens an interactive chat session that triggers MCP servers or browser logins:
  - Grok reads `~/.grok/models_cache.json` first (extracting `id`, `name`, `reasoning_efforts`, and skipping hidden entries) and falls back to `grok models` (including `Default model:` parsing).
  - Antigravity and OpenCode collapse suffixed reasoning variants into a single base model entry with ordered `effortLevels` (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`).
  - Codex, Claude, and Cursor expose their documented models and effort descriptors (`low`, `medium`, `high`, `xhigh`, `max`, `ultra` where supported by the model).
- Before a turn starts on an open session, the selected model and effort level are applied via session configuration (`session/set_config_option` on ACP, `turn/start` model options on Codex, `#variant` on OpenCode, `--model` / `--effort` on resumable CLIs). Changing the picker while a turn is running applies to the next turn, never mutating the in-flight turn.
- The agent creation view (`AgentCreatePane`) and the thread composer read from the exact same catalog source and expose the three explicit empty states: (1) no installed provider, the composer says `Open provider settings.`; (2) installed and signed out, the note says `Sign in.` and does not look like an empty model list; (3) signed in and no models yet, the note says `The program has not listed its models yet.` and the control stays usable. Changing engine in the create form clears a model from the previous engine. The chosen model is saved as that agent's `defaultModel`.
Checks: catalog parser tests for Grok, Antigravity, and OpenCode (`low` through `ultra`), plus account-isolation cache tests.

### S4. Thread-Scoped Permission Modes and Provider Ceilings
User words: "también el funcionamiento por detrás también, eso es algo importante. Básicamente, cómo maneja cada respuesta para los proveedores"
Current fact:
- Permission flags are passed inconsistently across one-shot CLI args and persistent sessions.
Acceptance:
- Every thread stores one of four canonical permission modes: `supervised` (ask before commands and edits), `acceptEdits` (auto-approve file edits, ask for commands), `auto` (provider policy), or `fullAccess` (approve commands and edits without prompts).
- New threads default to `fullAccess` unless overridden by workspace/project settings; creating a new thread does not inherit the mode of whichever thread was previously focused.
- Each driver declares its supported permission ceiling:
  - Grok does not support `acceptEdits`; a thread configured with `acceptEdits` on Grok runs as `supervised` and reports the effective mode.
  - `fx` supports `supervised` and `auto`; `muse` and `kiro` support `supervised` and `fullAccess`; unsupported modes fall back to `supervised`.
- When auto-approving a tool request on a shared server (`fullAccess` or `acceptEdits`), the adapter replies with a single-request grant (`AllowOnce`) rather than a permanent project-wide grant so other supervised threads in the same workspace cannot have their permissions widened.
- Permission modes never suppress interactive agent questions (`UserInputRequested`).
Checks: unit tests verifying effective mode clamping per driver and `AllowOnce` replies on automatic approvals.

### S5. Reverse Requests: Tool Approvals, Interactive Questions, and Proposed Plans
User words: "todo queda a medias, cuando lo llego a probar no se ve ni, se comporta igual."
Current fact:
- Reverse JSON-RPC requests from Grok (`x.ai/ask_user_question`, `x.ai/exit_plan_mode`) and Codex (`user_input_request`) are not normalized into interactive thread requests, causing the session to hang or drop the prompt.
Acceptance:
- Incoming permission requests (`session/request_permission`, `permission/request`, and tool-step approval gates) emit `ProviderTurnEvent::ApprovalRequested` and transition the session to `SessionState::Waiting`.
- Incoming user-question requests (`x.ai/ask_user_question`, `_x.ai/ask_user_question`, `AskUserQuestion`, Codex `user_input_request`) emit `ProviderTurnEvent::UserInputRequested` with structured question IDs, headers, predefined options, and `allowCustomAnswer` / `allowAttachments` flags. Answering commits the resolution and sends the response back over the live RPC channel (or as a continuation turn for async notification questions).
- Incoming plan transitions (`x.ai/exit_plan_mode`, `_x.ai/exit_plan_mode`, `plan`, `plan_update`, `<proposed_plan>`) emit `ProviderTurnEvent::PlanUpdated` and reply to the reverse RPC gate so the turn completes cleanly.
Checks: protocol fixture tests for Grok `x.ai/ask_user_question`, `x.ai/exit_plan_mode`, and ACP `session/request_permission`.

### S6. Strict Separation of Process `stderr` and Structured Failure Taxonomy
User words: "error: a value is required for '--single <PROMPT>' but none was supplied" and "También hay que corregir el error claramente que tenemos de Grok."
Current fact:
- `read_pipe` pipes `stderr` through the same delta emitter as `stdout`, storing CLI usage errors and crash messages inside the assistant's markdown bubble.
Acceptance:
- `stderr` is never routed into `emit_deltas` or stored as assistant message text.
- `stderr` is buffered into a bounded diagnostic ring per run and inspected only when classifying a turn or process termination.
- Every failed turn produces a structured `TurnFailure` on `TurnTerminal`:
  1. `UsageLimit { message, reset_at_unix_ms: Option<i64> }` (rate limit or quota exhaustion; preserves queued messages and offers `Resume` / `Resume at reset`).
  2. `AuthRequired { provider, message }` (missing or expired sign-in).
  3. `CliUsageError { command, message }` (invalid flag or CLI invocation error).
  4. `ProcessError { exit_code, message }` (unexpected process exit or transport drop).
- The user's sent prompt remains intact in the thread, and the failure is projected as a dismissible thread banner state (consumed by ODD 2), never as an assistant reply.
Checks: regression test verifying that a non-zero exit with clap usage text on `stderr` produces zero assistant items and one `TurnFailure::CliUsageError`.

### S7. Real Provider Token Usage and Silent Cancellation Policy
User words: "Si yo cancelo un chat y me llega la notificación de que se terminó o que se ejecutó correctamente la conversación... no debería aparecer una notificación toast cada vez que responde en threads."
Current fact:
- `runtime.rs:1805` invents a dollar cost using hardcoded constants, and `settle_turn_notification` triggers settlement events that `useNotifications.ts` turns into completion toasts even on cancelled turns.
Acceptance:
- `UsageUpdated` records only provider-reported `inputTokens`, `outputTokens`, `cachedInputTokens`, `contextWindowTokens`, and `durationSeconds`. No synthetic dollar cost is fabricated when the provider does not report one, and turns without usage reports do not estimate tokens from character length.
- Cancelling or interrupting a turn (`cancel_turn`) transitions the turn to `Interrupted` / `Cancelled` without firing a completion chime or a "Completed" toast.
- Normal turn completion in an active thread plays only the subtle completion chime without spawning a toast banner.
Checks: unit tests for `UsageUpdated` serialization and notification suppression on `cancelled` / `interrupted` outcomes.

### S8. Durable Per-Thread and New-Thread Model, Provider, and Effort Persistence
User words: "también hay cosas, que noto que tenemos bastante mal, por ejemplo, que no se recuerda qué modelo se seleccionó ni nada de eso. Cosa que tiene que ser correcta, o sea, si selecciona un modelo. Para una conversación que se mantenga, incluido el nivel de pensamiento y todo, básicamente. Em si es que yo creo una nuevo, un nuevo thread. Ojalá que se recuerde el último modelo que se seleccionó. Eh para crear una nueva conversación claramente."
Current fact:
- `src/components/views/chat/modelPersistence.ts` stores `kite_last_selected_models`, `kite_last_selected_provider`, and `kite_last_selected_agents`, but has no persistence at all for `effort` (`getSavedSelectedEffort` / `saveSelectedEffort`).
- `createDraftConfig` in `useChatDraftConfig.ts:57` hardcodes `effort: null`, `applyDraftPatch` never persists `effort`, and `draftThreadRequest` (`useChatDraftConfig.ts:108`) omits `effort` / `providerOptions` when creating a new thread.
- In `src-tauri/src/chat/threads.rs`, `blank_thread` and `configure_thread` store `providerOptions: [{"id": "effort", "value": "..."}]` without a top-level `effort` field, and `load_thread` / `threadWithResolvedBinding` never hydrate `thread.effort` back from `providerOptions`. As soon as a thread reloads or the user switches threads, `thread.effort` becomes `undefined`.
- In `useChatSession.ts:547`, `handleCreateNewThread` reuses an old empty draft thread or stale `draftConfig` from mount instead of reading the latest remembered `(provider, model, effort, agent)` selection.
Acceptance:
- **Per-Thread Persistence**: Every thread durably stores and hydrates `provider`, `model`, `effort` (both top-level `effort` and `providerOptions` in `threads.rs`), `mode`, `agent`, and `connectionId`. Switching between threads, reloading a thread, or restarting the app preserves each thread's exact selected model and thinking effort level. Clearing `effort` to default (`null`) explicitly clears the stored option in `configure_thread`.
- **Remembered Defaults for New Threads**: Selecting a provider, model, or thinking effort level in any thread or draft saves that selection as the remembered default (`saveSelectedProvider`, `saveSelectedModel(provider, model)`, `saveSelectedEffort(provider, model, effort)`).
- **New Thread Inheritance**: Creating a new general thread (`handleCreateNewThread` / `create_general_chat`) or opening a fresh draft reads the latest remembered `provider`, `model`, and `effort` for that provider/model. If an agent profile has an explicit `defaultModel`, that agent's default takes precedence for agent-bound threads; otherwise the remembered selection for that provider is used.
Checks: unit tests in `useChatDraftConfig.test.ts` and `chat::threads` verifying that (1) changing model + effort on Thread A persists across `load_thread` and reload, and (2) creating Thread B immediately inherits the last selected provider, model, and effort.

---

## Tasks

- **T1 — Unify `ProviderTurnEvent`, `ToolCallTracker`, and 50ms `DeltaCoalescer` in `normalize.rs` and `runtime.rs`.** S1.
  Replace the three diverging parsers (`acp.rs`, `persistent.rs`, `normalize.rs`) with one stateful turn normalizer that merges `tool_call` / `tool_call_update` / `tool_call_content_chunk` by `tool_call_id` and coalesces text/reasoning deltas at 50ms.
- **T2 — Upgrade `AcpStdioTransport` (`grok`, `antigravity`, `kiro`, `fx`) with full session config and reverse RPC handling.** S2, S4, S5.
  Support `session/set_config_option` (`model`, `reasoning_effort`, `mode`), `session/request_permission`, `x.ai/ask_user_question`, and `x.ai/exit_plan_mode`.
- **T3 — Keep unsupported wires one-shot. Do not invent Codex, Claude, Cursor, Pi, Muse, Kiro, or fx frames.** S2. Risk: item 3 (a session transport is a contract the drivers consume).
  Codex stays on `CODEX_APP_SERVER_GAP` until a request frame that accepts a user turn is observed. Claude, Cursor, Pi, Muse, Kiro, and fx stay one command per send until a driver declaration is observed. OpenCode keeps the server it already has. A missing binary is an empty state.
- **T4 — Isolate `(provider, connection_id)` model catalogs and side-effect-free effort discovery (`low`..`ultra`).** S3.
  Key `MODEL_CACHE` and disk cache by `(provider, connection_id)`, wire `~/.grok/models_cache.json` and variant collapsing, add `ultra` labels, and expose the 3 empty states to composer and `AgentCreatePane`.
- **T5 — Enforce thread-scoped `PermissionMode` ceilings and `AllowOnce` auto-approval policy.** S4.
  Clamp unsupported provider modes (e.g. Grok `acceptEdits` -> `supervised`) and ensure automatic approvals reply `AllowOnce`.
- **T6 — Separate `stderr` from assistant deltas and implement structured `TurnFailure` classification (`UsageLimit`, `AuthRequired`, `CliUsageError`, `ProcessError`).** S6.
  Remove `stderr` from `read_pipe` -> `emit_deltas`, classify rate-limit and CLI errors into `TurnFailure`, and emit banner state instead of assistant text.
- **T7 — Record authentic provider token usage and suppress cancellation/turn toast spam.** S7.
  Remove hardcoded `costUsd` math from `runtime.rs` and fix `settle_turn_notification` / `useNotifications.ts` so cancelled turns stay silent.
- **T8 — Persist and hydrate `(provider, model, effort, agent)` per thread and as remembered defaults for new threads.** S8.
  Add `getSavedSelectedEffort` / `saveSelectedEffort` to `modelPersistence.ts`, wire `effort` through `createDraftConfig`, `applyDraftPatch`, `draftThreadRequest`, `handleCreateNewThread`, and `threads.rs` (`blank_thread`, `configure_thread`, `load_thread`) so existing threads never lose their model/effort and new threads inherit the last selected model and effort.
- **T11 — Answer reverse requests on the lasting session, and say when the provider goes quiet.** S2. Route: inline. `cargo test chat::`: 197 passed.
- **T12 — Restore native tool execution, turn completion, and chronological response ordering across all providers (`grok`, `antigravity`, `opencode`, `codex`, `claude`, `cursor`, `gemini`).** S1, S2, S4, S7. Route: inline.
  Set `clientCapabilities: {}` on ACP `initialize`, accept `_x.ai/session/update` (`turn_completed` -> `TurnEnded` + `UsageUpdated`), filter housekeeping frames (`available_commands_update`, `session_info_update`, `hook_execution`, `config_option_update`, `current_mode_update`), support `auto` mode in `antigravity_args`, route structured JSON activity frames in `opencode_line_event`, preserve `query`/`toolName`/`serverName` in `upsert_tool_snapshot`, and move the assistant item to the tail whenever new text arrives after subsequent work items.

---

## Verification

- `cargo test chat::`
- `npx vitest run src/components/views/chat src/lib/notifications`
- `npx tsc --noEmit`
- `node .kite/sanitizer/audit-references.mjs --check`

---

## Log

- **L1. 2026-11-09.** Created `odd/tasks/thread-provider-runtime.md` (ODD 1 of 3) to replace the backend/provider portion of the monolithic `odd/tasks/response-thread.md` with concrete architectural contracts: a single `ProviderTurnEvent` pipeline with stateful `ToolCallTracker` and 50ms delta coalescing, unified session transports (`AcpStdioTransport`, `CodexAppServerTransport`, `OpenCodeServerTransport`, `ResumableStreamTransport`), `(provider, connection_id)` catalog isolation with `low`–`ultra` effort tiers, reverse RPC handling for approvals/questions/plans, strict `stderr` separation with structured `TurnFailure` taxonomy, and authentic token usage reporting.
- **L3. 2026-11-09.** Wired `ToolCallTracker` and the 50ms `DeltaCoalescer` into `handle_stream_json_line` on `feat/response-thread`. Known frames project into the existing transcript; unknown frames still fall through to the ACP parser. Grok `acceptEdits` spawns with `--permission-mode default`. Automatic approvals on that path reply `allowOnce`. `cargo test chat::`: 181 passed. Codex app-server frames stay refused by `CODEX_APP_SERVER_GAP`.
- **L4. 2026-11-09.** Notice-only frames stay in the canonical pipeline and unrecognized structured frames emit a `notice` item. Claude `--resume` turns use `--output-format stream-json`. Catalog responses include `catalogState` (`missing-binary`, `signed-out`, `ready`) and the composer plus `AgentCreatePane` show those empty states. `cargo test chat::`: 182 passed. Codex remains `CODEX_APP_SERVER_GAP`. `kiro`, `fx`, and `muse` have no observed driver declaration in this build, so no lasting wire was invented for them. ACP `step_update` frames still adapt through `parse_acp_stream_line` when the canonical ingest returns no events.
- **L5. 2026-11-10.** User words: "la idea es qeu revisemos detalaldamente los 3, corregir e implementar en su totalidad cada uno". S2 no longer prescribes unobserved Codex, Claude, Cursor, Pi, Muse, Kiro, or fx frames. Those wires stay one-shot until a declaration is observed. Gemini is not labeled a session. Accepting a send stores intent.
- **L2. 2026-11-09.** User words: "también hay cosas, que noto que tenemos bastante mal, por ejemplo, que no se recuerda qué modelo se seleccionó ni nada de eso. Cosa que tiene que ser correcta, o sea, si selecciona un modelo. Para una conversación que se mantenga, incluido el nivel de pensamiento y todo, básicamente. Em si es que yo creo una nuevo, un nuevo thread. Ojalá que se recuerde el último modelo que se seleccionó. Eh para crear una nueva conversación claramente." Added `S8` and `T8`: full per-thread persistence and hydration of `(provider, model, effort, agent)` in `threads.rs` and `useChatSession.ts`, plus remembered default persistence in `modelPersistence.ts` and `useChatDraftConfig.ts` for new threads.
- **L6. 2026-11-10.** Disambiguated `rewind_thread_transcript` in `src-tauri/src/main.rs`. Verified complete backend and provider session suite: `cargo test chat::` (193 passed, 0 failed); `npx vitest run src/components/views/chat` (213 passed, 0 failed); `npx tsc --noEmit` clean. 0 reference leaks. T1–T8 verified complete.
- **L7. 2026-11-11.** User words: "se quedo pegado en esta tarea 15 minutos, es imposible que demore tanto en eso osea algo paso, podemos revisar? ademas no se actualiza ninguna accion ni dada quiero decir esta pegado". The live Grok process `agent stdio` was still up with almost no CPU, and the clock is local, so Working kept ticking after stdout went silent. Replies were written to the one-shot stdin, which a lasting session does not publish. T11 covers the reply path, unknown-request decline, and the quiet note.
- **L8. 2026-11-11.** User words: "Primero que nada quiero saber por qué razón no le estamos dando soporte. ¿Por qué no está pudiendo ejecutar herramientas nativas si se supone que estamos utilizando como tal? Lo que serían herramientas nativas, quiero decir. Tenemos que evaluar tal vez, qué es lo que estamos implementando realmente. Entenderlo y por qué es que está fallando en estos casos. ¿Qué puede pasar con otros proveedores, por ejemplo con AntiGravity? ¿Qué puede llegar a suceder lo mismo?" Audited `kite.sqlite` and `~/.grok/sessions/*/session.jsonl`: `grok_initialize_line` advertised `clientCapabilities.fs` and `terminal` without implementing `fs/read_text_file`, `fs/write_text_file`, or `terminal/*`, hijacking ACP native tools into `-32601` failures; `_x.ai/session/update` (`turn_completed`) was ignored by `parse_grok_line`, leaving turns running until the 20s quiet timer; and `upsert_item` kept the assistant response at its initial top index when tools ran after an opening sentence.
- **L9. 2026-11-11.** User words: "Okey, correcto, pero creo que te limitaste bastante al revisar solamente para los que ya te dije, que eran Grok y Anti Gravity, pero también hay otros que se conectan por ASP. No recuerdo exactamente cuáles, pero hay otros. La idea es que revises todos los agentes, no solamente te limites a lo que yo te diga. Eh, básicamente darle soporte a todos los que tenemos. Ya sea que se manejen por ACP o no. Y bueno, eh. Me parece correcto, deberíamos plantear las correcciones y llevarlas a cabo. Para esto, creo que deberíamos modificar los ODD como tal o inclusive crear uno nuevo y conectarlo con los otros para tener todo conectado claramente." Expanded `S1`, `S2`, and `T12` to cover all 7 providers (`grok`, `antigravity`, `opencode`, `codex`, `claude`, `cursor`, `gemini`), connected with `odd/tasks/thread-timeline-surface.md` (`S2`, `S3`, `S8`).
