# Cross-Provider Subagent & Swarm Orchestration Engine (`kite dispatch` + Thread Runtime) (ODD 2 of 2)

Objective: Enable universal cross-provider subagent delegation and multi-agent Swarm orchestration across Thread Mode and Code Mode so any parent orchestrator (for example, a heavy reasoning model on `antigravity` or `claude`) can spawn, message, wait on, and coordinate subagent workers running on any other connected provider and model (for example, fast executors on `grok`, `codex`, `gemini`, or `opencode`), feeding directly into the canonical `SubagentRun` / `SwarmState` pipeline and `RightDock` Inspector defined in ODD 1.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `ask-on-risk`.
Test runner: `cargo test dispatch::`, `cargo test chat::`, `npx vitest run src/components/views/subagents src/components/views/chat`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.
Series: ODD 2 of 2 for Subagents & Swarm Orchestration (paired with ODD 1: `odd/tasks/thread-subagent-surface-and-dock.md`, and extending `odd/tasks/agent-dispatch-parity.md`).

---

## Architecture Overview

```text
Parent Orchestrator Thread (e.g., Antigravity / Claude — Heavy Model)
   │  Env injected: KITE_DISPATCH=1, KITE_ADDRESS=thread:<parent_id>
   │  Skill loaded: ~/.gemini/antigravity/skills/kite-dispatch/SKILL.md
   │
   ├─► 1. Cross-Provider Subagent Delegation:
   │      `kite dispatch run --via thread --provider grok --model grok-3-mini --role "Grok Executor" --workspace share --wait "<prompt>"`
   │
   └─► 2. Cross-Provider Swarm Coordination:
          `kite dispatch swarm add --name parser --provider grok --model grok-3-mini --workspace share --brief "..."`
          `kite dispatch swarm post "@parser fix the AST node in src/parser.rs"`
          `kite dispatch swarm wait --since 4`
                  │
                  ▼  (Local TCP Loopback Server: `src-tauri/src/dispatch_wire/server.rs`)
   ┌────────────────────────────────────────────────────────────────────────────┐
   │ Unified Dispatch & Swarm Coordinator (`src-tauri/src/chat/swarm.rs`)       │
   │ - Creates child `ChatThread` (`parentThreadId`, `provider`, `model`)       │
   │ - Provisions git worktree when `--workspace share|branch`                  │
   │ - Links `SubagentRun` / `SwarmState` into Parent Thread (ODD 1 pipeline)   │
   │ - Wakes `waiting` Swarm workers reactively on `@mention` (0 idle tokens)   │
   └──────────────┬──────────────────────────────────────────────┬──────────────┘
                  │                                              │
                  ▼                                              ▼
   Child Thread 1 (`provider: "grok"`,            Child Thread 2 (`provider: "codex"`,
   `model: "grok-3-mini"`, `workspace: "share"`)  `model: "o4-mini"`, `workspace: "inherit"`)
                  │                                              │
                  └──────────────┬───────────────────────────────┘
                                 ▼
                  Streams live into `SubagentActivityCard`, `SwarmActivityCard`,
                  and `RightDock` (`SubagentInspectorView` / `SwarmBoardInspector`)
```

---

## Specs

### S1. Thread-Mode Dispatch Environment Injection and One-Shot/Persistent Presence Parity
User words: "¿En algún punto vamos a llegar a un tope? Que sería como lo que queremos llegar a resolver, que sería poder dar soporte a varios. subagentes o tipos de subagentes, mezclando proveedores, es decir, por ejemplo, tener un. orquestador potente de anti-gravity, y luego un ejecutor de Grok, o algo similar. Un subagente de Grok... Luego ya pasamos a crear nuestro propio sistema."
Current fact:
- Terminal PTY spawns inject `KITE_DISPATCH=1` and `KITE_ADDRESS=session:<id>`, and prepend `<roaming_app_dir>/bin` (`kite.cmd` / `kite`) to `PATH`, but Thread mode spawns in `src-tauri/src/chat/runtime/spawn.rs:253` (`spawn_streaming`) and persistent sessions in `src-tauri/src/chat/persistent/` (`antigravity.rs`, `grok.rs`, `opencode.rs`) do not inject `KITE_DISPATCH`, `KITE_ADDRESS=thread:<id>`, or the `kite` CLI `PATH` entry.
- `publish_thread` in `src-tauri/src/dispatch_wire/protocol.rs:304-324` only reads `session_manager().lock().status(thread_id)`, causing one-shot/resumable Thread runs (`claude`, `codex`, `cursor`, `gemini`) tracked in `live_turns()` (`src-tauri/src/chat/runtime/turn.rs:20-22`) to appear `Idle` to `kite dispatch wait` and cannot be interrupted via `kite dispatch kill`.
Acceptance:
- **Environment Injection Across All Thread Transports**:
  - Both `spawn_streaming` (`src-tauri/src/chat/runtime/spawn.rs`) and persistent session launchers (`src-tauri/src/chat/persistent/antigravity.rs`, `grok.rs`, `opencode.rs`) inject:
    - `KITE_DISPATCH=1`
    - `KITE_ADDRESS=thread:<thread_id>`
    - `KITE_WORKSPACE_ID=<workspace_id>` (when bound to a workspace)
    - Prepend `<roaming_app_dir>/bin` (containing the `kite` / `kite.cmd` shim from `dispatch_wire::server::start_background`) to the child process `PATH`.
- **Presence & Lifecycle Parity for All 7 Providers (`protocol.rs`)**:
  - `publish_thread` and `LivePort::status` (`src-tauri/src/dispatch_wire/protocol.rs:286-324`) check **both** `session_manager().lock().status(thread_id)` and `crate::chat::runtime::turn::is_turn_running(thread_id)` (plus `pendingApproval` / `pendingUserInput` on the thread):
    - Active turn in `SessionManager` or `live_turns()` $\rightarrow$ `PresenceState::Working`.
    - Pending approval or user question $\rightarrow$ `PresenceState::Blocked`.
    - Last turn failed $\rightarrow$ `PresenceState::Error`.
    - Completed turn $\rightarrow$ `PresenceState::Done` / `Idle`.
  - `LivePort::kill` (`protocol.rs:84-88`) and `LivePort::interrupt` call `crate::chat::cancel_turn(id)` in addition to `session_manager().lock().interrupt(id)`, terminating both persistent and one-shot `TurnRun` processes cleanly.
Checks: Rust unit/integration tests in `dispatch_wire::protocol` and `chat::runtime` verifying env var injection on Thread spawns and `PresenceState::Working -> Done` transitions for both persistent (`grok`, `antigravity`) and one-shot (`claude`, `codex`) threads.

---

### S2. Cross-Provider Child Thread Spawning via `kite dispatch run --via thread`
User words: "poder dar soporte a varios. subagentes o tipos de subagentes, mezclando proveedores, es decir, por ejemplo, tener un. orquestador potente de anti-gravity, y luego un ejecutor de Grok, o algo similar. Un subagente de Grok... aumentar las capacidades de la CLI para esto"
Current fact:
- `cli::parse_run` (`src-tauri/src/dispatch/cli.rs:201-206`) parses `--via thread`, but `Service::run` (`src-tauri/src/dispatch/policy/ops.rs:357-364`) immediately fails with `DispatchError::TransportUnsupported` when `input.via == Family::Thread`, and `Port` (`src-tauri/src/dispatch/policy/service.rs`) only defines `start_terminal`.
Acceptance:
- **Extend `kite dispatch run` CLI & Policy (`src-tauri/src/dispatch/cli.rs` & `ops.rs`)**:
  - Support the following options on `kite dispatch run`:
    - `--via <terminal|thread>`: when omitted, defaults to `thread` if the caller's `KITE_ADDRESS` starts with `thread:`, or `terminal` if called from `session:`.
    - `--provider <provider>` (or positional program name `grok`, `antigravity`, `claude`, `codex`, `cursor`, `opencode`, `gemini`): selects the target provider for the child subagent thread. If omitted, inherits the parent thread's provider.
    - `--model <model_id>`: pins the child thread to a specific model (for example, a lightweight/fast model such as `grok-3-mini`, `gemini-2.5-flash`, `claude-haiku-4-5`, `o4-mini`). If omitted, uses the target provider's remembered default model.
    - `--effort <level>`: optional reasoning effort (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`).
    - `--role <role_title>`: human-readable subagent role (e.g. `"Grok Code Executor"`, `"Database Researcher"`).
    - `--workspace <inherit|share|branch>`: workspace isolation mode (defaults to `inherit`).
      - `inherit`: runs in the parent thread's workspace directory.
      - `share` / `branch`: creates an isolated git worktree under `<workspace_root>/.kite/worktrees/subagent-<short_id>` (`git worktree add`) so parallel subagents can edit and run tests concurrently without file collisions.
    - `--wait` (and `--timeout-ms <ms>`): waits for the child subagent's initial turn to complete and writes the child thread's final assistant response text (plus `[subagent_id: thread:<child_id>]`) directly to `stdout` so the parent agent receives the result in a single tool call. Without `--wait`, returns the receipt `started thread:<child_id>` immediately for asynchronous parallel execution followed by `kite dispatch wait thread:<child_id>` and `kite dispatch read thread:<child_id>`.
- **Implement `Port::start_thread` in `LivePort` (`src-tauri/src/dispatch_wire/protocol.rs`)**:
  1. Creates a persisted child `ChatThread` in `threads.rs` with:
     - `parentThreadId: Some(parent_thread_id)`
     - `startedByAgent: true`
     - `subagentRole: Some(role)`
     - `provider: target_provider`
     - `model: target_model`
     - `effort: target_effort`
     - `workspaceMode: Some(workspace_mode)`
     - `workspaceId: parent_workspace_id`
  2. Automatically registers a `SubagentRun` (`toolKind: "subagent"`) on the parent thread's active turn (`subagentRuns` in `threads.rs`) with `childThreadId: Some(child_id)`, `provider: target_provider`, `model: target_model`, `role`, `workspaceMode`, and `status: "running"`, emitting `"chat-turn-event"` and `"chat-subagent-event"`.
  3. Starts the turn on the child thread via `crate::chat::start_turn(child_id, ...)` and mirrors every item update from the child thread into the parent's `SubagentRun` (`latestActivity`, `stepCount`, `status`) so `SubagentActivityCard` and `RightDock`'s `SubagentInspectorView` (from ODD 1) stream the cross-provider child thread live!
Checks: unit tests in `dispatch::cli` and `dispatch::policy::ops` for `kite dispatch run --via thread --provider grok --model ... --role ... --workspace ...`, plus integration tests verifying child `ChatThread` creation, parent `SubagentRun` linkage, and `--wait` output capture.

---

### S3. Universal Cross-Provider Swarm Engine (`kite dispatch swarm`) and Reactive `@mention` Wakeup
User words: "También sé que Antigravity implementa como una función de swarm. Y donde se tiene como un modelo pesado en la conversación main. Y modelos livianos en las conversaciones, eh, más livianas, claramente, de subagentes. Eso es lo que queremos llegar a. Armar... mezclando proveedores, es decir, por ejemplo, tener un. orquestador potente de anti-gravity, y luego un ejecutor de Grok, o algo similar."
Current fact:
- Native swarm tools only exist inside one provider's closed runtime and cannot mix providers (e.g., an `antigravity` or `claude` coordinator cannot add a `grok` or `codex` worker to its swarm board).
Acceptance:
- Create `src-tauri/src/chat/swarm.rs` and expose `kite dispatch swarm <subcommand>` in `src-tauri/src/dispatch/cli.rs`, `ops.rs`, and `protocol.rs`:
  - **Swarm State Machine (`SwarmState` in `src-tauri/src/chat/swarm.rs`)**:
    - Keyed by the coordinator's `parent_thread_id` and persisted in `threads.rs` (`thread.swarmState`) and `.kite/chat/swarms/<swarm_id>.json`.
    - Emits `"chat-swarm-event"` on every roster or board mutation so `SwarmActivityCard` and `SwarmBoardInspector` in `RightDock` (ODD 1) update in real time.
  - **Supported CLI Subcommands**:
    1. `kite dispatch swarm title "<title>"`:
       - Initializes (if not yet created) and sets the human-readable title of the Swarm for the caller's thread.
    2. `kite dispatch swarm add --name <worker_name> [--provider <provider>] [--model <model>] [--effort <level>] [--workspace <inherit|share|branch>] [--channels <ch1,ch2>] [--fork <member|coordinator>] --brief "<assignment>"`:
       - Validates `<worker_name>` (short, lowercase, unique; `coordinator` and `all` are reserved; killed names cannot be reused).
       - Creates a child `ChatThread` bound to `(provider, model, effort, workspace)` with `swarmId` and `swarmMemberName: <worker_name>` (if `--fork` is passed, copies the prior transcript items from that member's thread as warm context).
       - Appends post `#seq` to the board (`@<worker_name> <brief>`) in the worker's primary channel (`main` by default).
       - Transitions `<worker_name>` to `working` and triggers its initial turn on `childThreadId` with a system/board envelope explaining its roster name (`@<worker_name>`), how to post back (`kite dispatch swarm post "@coordinator ..."`), and its initial brief.
    3. `kite dispatch swarm post [--channel <channel>] "<message_text>"`:
       - Increments the monotonic board sequence number `seq` (`#1`, `#2`, ...), parses all `@<name>`, `@<prefix>`, `@#<channel>`, and `@all` mentions, and appends the post to the board.
       - **Reactive `@mention` Doorbell (Zero Idle Token Cost)**:
         - A worker in `waiting` or `stopped` state has no running turn and consumes **zero tokens**.
         - When a new board post mentions `@<worker_name>`, `@<group_prefix>`, `@#<subscribed_channel>`, or `@all`, the Swarm coordinator engine in `swarm.rs`:
           - If the worker is `waiting` or `stopped`, transitions it to `working` and automatically launches a new turn on that worker's `ChatThread` containing all board posts since that worker's `lastReadSeq`.
           - If the worker is already `working`, records the pending mention so the worker wakes for a follow-up turn as soon as its current turn settles (unless it already read up to the new `seq` before finishing).
         - If a worker's post mentions `@coordinator` (or `[stall]` / `[done]`) and the coordinator is blocked in `kite dispatch swarm wait`, immediately unblocks the coordinator's `wait` call with the new board posts.
    4. `kite dispatch swarm read [--since <seq>] [--channel <channel|*>]`:
       - Returns formatted board posts with sequence numbers `#N`, channel, author, timestamp, and text for all posts with `seq > since` visible to the caller.
    5. `kite dispatch swarm wait [--since <seq>] [--mentions-only <true|false>] [--timeout-ms <ms>]`:
       - Parks the caller without polling loops using a Tokio `Notify` / broadcast channel in `swarm.rs` until a board post with `seq > since` arrives (filtered to posts mentioning the caller when `--mentions-only true`), then returns the new posts and current worker status summary.
    6. `kite dispatch swarm status`:
       - Prints the full roster (`name`, `provider`, `model`, `state`: `waiting | working | stopped | killed`, `workspace`, `channels`, `lastReadSeq`) and board head `seq`.
    7. `kite dispatch swarm model --name <worker_name> [--provider <provider>] --model <new_model> [--effort <level>]`:
       - Switches a `waiting` or `stopped` worker (or `coordinator`) to a new `(provider, model, effort)` while keeping its existing `ChatThread` conversation history intact—enabling instant cross-provider or cross-model failover when a model runs out of quota.
    8. `kite dispatch swarm kill --name <worker_name>`:
       - Cancels any running turn on `<worker_name>`'s `ChatThread`, removes its temporary worktree if clean, and permanently marks the member `killed` on the roster.
    9. `kite dispatch swarm channel <create|subscribe|unsubscribe|archive|list> [--channel <name>] [--topic "<text>"] [--name <worker_name>]`:
       - Manages area channels (`#parser`, `#ui`) so large swarms (>6 workers) only wake workers subscribed to that area while keeping `#main` for cross-area coordination.
Checks: Rust unit and async integration tests in `chat::swarm` and `dispatch::cli` verifying `swarm add`, `#seq` monotonic ordering, reactive `@mention` wakeup from `waiting -> working -> waiting`, `@#channel` addressing, `swarm wait` notification wakeup, `swarm model` hot-swapping, and `swarm kill`.

---

### S4. Interactive Controls from `RightDock` Inspector to Child Threads & Swarm Runtime
User words: "donde se ve en la zona lateral, si es que uno quiere, la ejecución del subagente y al lado izquierdo. La ejecución del agente main, o del orquestador... en esa misma zona lateral, en nuestra sidebar, por así decirlo. Ahí podríamos incluir esta inspección para el subagente."
Current fact:
- In ODD 1, `SubagentInspectorView` and `SwarmBoardInspector` render streams and board state, but users also need direct interactive controls in `RightDock` to steer a subagent, post feedback on the Swarm Board, switch a quota-blocked worker's model, or stop a worker.
Acceptance:
- Expose Tauri commands in `src-tauri/src/chat/commands.rs` and wire them into `SubagentInspectorView.tsx` and `SwarmBoardInspector.tsx`:
  1. `send_subagent_message(parent_thread_id, subagent_id, text)`:
     - When the subagent is backed by a `childThreadId`, starts a follow-up turn or queues steering input on that child `ChatThread` and posts a summary note to the subagent stream.
  2. `stop_subagent_run(parent_thread_id, subagent_id)`:
     - Calls `cancel_turn` / `interrupt` on the child `ChatThread` and marks the `SubagentRun` as `stopped` / `interrupted`.
  3. `swarm_post_from_ui(parent_thread_id, channel, text)`:
     - Allows the user to post a message directly to the Swarm Board from the bottom input bar of `SwarmBoardInspector` (e.g. `@parser use the existing helper in utils.ts` or `@all pause`), triggering the exact same reactive `@mention` wakeup as `kite dispatch swarm post`.
  4. `swarm_switch_worker_model(parent_thread_id, member_name, provider, model, effort)`:
     - Allows the user to click a worker's model badge in the `SwarmBoardInspector` Roster tab and pick a different provider/model from `ModelPickerPopover`, hot-switching the worker and waking it if it was stalled on a `UsageLimit`.
  5. `swarm_kill_worker_from_ui(parent_thread_id, member_name)`:
     - Kills the selected worker from its Roster card in `RightDock`.
Checks: Vitest tests in `SubagentInspectorView.test.tsx` and `SwarmBoardInspector.test.tsx` verifying `send_subagent_message`, `stop_subagent_run`, `swarm_post_from_ui`, `swarm_switch_worker_model`, and `swarm_kill_worker_from_ui` IPC invocations.

---

### S5. Auto-Installed `kite-dispatch/SKILL.md` Upgrade for Multi-Provider Subagents & Swarms
User words: "no sé si es que podemos crear alguna solución universal, es decir, por ejemplo, aumentar las capacidades de la CLI para esto, o basarnos completamente en anti-gravity y llegar a armar algo similar."
Current fact:
- `src-tauri/src/dispatch/cli.rs:473-536` auto-installs `kite-dispatch/SKILL.md` into `~/.claude/skills`, `~/.grok/skills`, `~/.codex/skills`, `~/.cursor/skills`, `~/.gemini/antigravity/skills`, and `~/.config/opencode/skills`, but its instructions only document terminal PTY commands (`run`, `send`, `wait`, `read`, `kill`) without cross-provider `--via thread` subagents or `kite dispatch swarm`.
Acceptance:
- Update the embedded `SKILL.md` template and `kite dispatch --help` manual in `src-tauri/src/dispatch/cli.rs` to document:
  1. **Cross-Provider Subagents (`kite dispatch run --via thread`)**:
     - How an orchestrator delegates a task to a specific provider and lightweight model (`kite dispatch run --via thread --provider grok --model grok-3-mini --role "Fast Executor" --workspace share --wait "<prompt>"`).
     - How to launch multiple parallel subagents without `--wait`, then synchronize with `kite dispatch wait thread:<id1> thread:<id2>` and read results with `kite dispatch read thread:<id>`.
  2. **Cross-Provider Swarms (`kite dispatch swarm`)**:
     - How a heavy coordinator model initializes a swarm (`kite dispatch swarm title "..."`), spawns specialized workers across providers/models (`kite dispatch swarm add --name <role> --provider <prov> --model <model> --workspace share --brief "..."`), coordinates via `@mentions` (`kite dispatch swarm post "@verifier check #2"`), sleeps at zero token cost (`kite dispatch swarm wait --since <seq>`), and handles quota failover (`kite dispatch swarm model --name <role> --provider <prov> --model <new_model>`).
Checks: unit test in `src-tauri/src/dispatch/cli.rs` asserting that the generated `SKILL.md` and `manual()` include `--via thread`, `--provider`, `--model`, `--role`, `--workspace`, and the `kite dispatch swarm` command reference.

---

## Tasks

- [x] **T1 — Inject `KITE_DISPATCH=1`, `KITE_ADDRESS=thread:<id>`, and CLI `PATH` into Thread spawns and unify one-shot/persistent thread presence in `protocol.rs`.** `S1`. Route: inline (`src-tauri/src/hidden_exec.rs`, `src-tauri/src/chat/session.rs`, `src-tauri/src/chat/runtime/`, `src-tauri/src/chat/persistent/`, `src-tauri/src/dispatch_wire/protocol.rs`).
  Update `src-tauri/src/chat/runtime/spawn.rs`, `src-tauri/src/chat/persistent/`, and `src-tauri/src/dispatch_wire/protocol.rs` (`publish_thread`, `kill`, `interrupt`) so every Thread provider can invoke `kite dispatch` and reports live `Working` / `Blocked` / `Done` states.
- [ ] **T2 — Implement cross-provider `kite dispatch run --via thread` (`--provider`, `--model`, `--effort`, `--role`, `--workspace`, `--wait`) in `cli.rs`, `ops.rs`, and `protocol.rs`.** `S2`. Route: inline or bounded worker.
  Wire `Port::start_thread` to create child `ChatThread`s, provision git worktrees for `share`/`branch` modes, link `SubagentRun` items into the parent turn, and stream live updates to `SubagentActivityCard` and `RightDock`.
- [ ] **T3 — Build the cross-provider Swarm engine (`src-tauri/src/chat/swarm.rs`) and `kite dispatch swarm` CLI (`title`, `add`, `post`, `read`, `wait`, `status`, `model`, `kill`, `channel`).** `S3`. Route: inline or bounded worker.
  Implement the `.kite/chat/swarms/` state machine, monotonic `#seq` message board, Tokio `Notify` zero-polling `swarm wait`, reactive `@mention` worker wakeup (`waiting -> working -> waiting`), and live `"chat-swarm-event"` emissions.
- [ ] **T4 — Wire interactive `RightDock` subagent and swarm actions (`send_subagent_message`, `stop_subagent_run`, `swarm_post_from_ui`, `swarm_switch_worker_model`, `swarm_kill_worker_from_ui`).** `S4`. Route: inline or bounded worker.
  Add Tauri commands in `src-tauri/src/chat/commands.rs` and connect them to `SubagentInspectorView.tsx` and `SwarmBoardInspector.tsx`.
- [ ] **T5 — Upgrade auto-installed `kite-dispatch/SKILL.md` and CLI manual in `src-tauri/src/dispatch/cli.rs` with cross-provider subagent and swarm workflows.** `S5`. Route: inline or bounded worker.
  Document `--via thread`, mixed heavy/lightweight model delegation, and `kite dispatch swarm` commands for all installed agent skill roots.

---

## Verification

- `cargo test dispatch::`
- `cargo test chat::`
- `npx vitest run src/components/views/subagents src/components/views/chat`
- `npx tsc --noEmit`
- `node .kite/sanitizer/audit-references.mjs --check`

---

## Log

- **L1. 2026-11-12.** User words: "¿En algún punto vamos a llegar a un tope? Que sería como lo que queremos llegar a resolver, que sería poder dar soporte a varios. subagentes o tipos de subagentes, mezclando proveedores, es decir, por ejemplo, tener un. orquestador potente de anti-gravity, y luego un ejecutor de Grok, o algo similar. Un subagente de Grok. Ese es como, no lo sé, la la cosa que quiero investigar a hacer, pero claro. Podemos primero partir dando soporte nativo a los subagentes de estas a, de estos proveedores... Eh, luego ya pasamos a crear nuestro propio sistema." / "Mira, creo que arma ese lo de D, pero que quiero que sea muy muy específico, por ende, si que se llegan a realizar muchas tareas. Puedes llegar a crear dos. ODDs distintos. Eh, con tal de que los subagentes que realmente lo hagan. Puedan llegar a entender qué tanto se espera. Por ende. Yo creo que solamente hagas los oDD. Y esperes, luego ya comenzaré a ejecutarlos con otro." Created `odd/tasks/thread-cross-provider-orchestration.md` (ODD 2 of 2) specifying Thread-mode dispatch env injection, `kite dispatch run --via thread` cross-provider child threads with isolated worktrees and lightweight model pinning, the `kite dispatch swarm` engine with reactive `@mention` wakeups, interactive `RightDock` controls, and `kite-dispatch/SKILL.md` updates.
- **L2. 2026-11-12.** Completed T1 (`3417768`) and hardened S1 lifecycle/presence parity after adversarial verification: prioritized `pendingUserInput` as `BlockKind::Question` over generic `"waiting"` status, implemented `Port::interrupt` / `LivePort::interrupt` for `Family::Thread`, preserved `SessionState::Closed` + `Gone` (closing idle persistent transports via `manager.stop`), prioritized one-shot fallback `Done` over stale `SessionState::Failed`, added monotonic `next_publish_seq()` so sub-ms `publish_thread` updates never drop, and aligned Windows env-block sort to uppercase order. Verified GREEN (`dispatch_wire::tests` 8/8, `hidden_exec::tests` 6/6, `dispatch::` 51/51, `chat::runtime::tests` 32/32).
- **L3. 2026-11-12.** Fixed the two remaining S1 interrupt/resume edge cases (`clear_thread_killed` on `start_turn_with_binding`, keeping `interrupt` resumable as `Done`/`Idle` while closing warm `Interrupted` persistent servers to `Closed`). Verified GREEN (`dispatch_wire::tests` 8/8).
