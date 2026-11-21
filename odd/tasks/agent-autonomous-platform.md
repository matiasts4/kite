# Autonomous Multi-Provider Agents Platform (`Agents` Mode)

Objective: Transform Kite Code's `Agents` mode from an isolated chat tab into an autonomous, tool-equipped, provider-agnostic specialist platform where custom agents preserve non-destructive instructions, invoke native service tools (`thread`, `memory`, `routine`, `teammate`), wake cleanly on direct messages across all 7 CLI engines, execute background scheduled routines, and chain multi-turn `AutoPilot` goals cleanly.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `auto-chain` across 8 isolated ~250–400 line commits (`T1`–`T8`), keeping modified files strictly separated from unrelated ODDs; await explicit user authorization before beginning implementation (`T1`).
Test runner: `cargo test agents`, `cargo test agent_mind`, `cargo test routines`, `cargo test dispatch_wire`, `cargo test chat::`, `npx vitest run src/components/views/agents`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.

---

## Specs

### S1 — Non-Destructive Instruction Injection, Terminal Context & Launch Inheritance
Addresses the root breakage where launching a chat or terminal for an `AgentProfile` strips its persona, memory, skills, teammates, workspace context, or overwrites repository instruction files.

1. **Preserve Agent Home Instructions & Protect Repository Files (`agent_mind/memory.rs`, `chat/recipe.rs`, `chat/runtime/spawn.rs`):**
   - Stop `apply_agent_recipe` (`chat/recipe.rs:59-68`) from invoking `write_recipe_instructions` (`agent_mind/memory.rs:361-390`) with stripped `InstructionSkill { name: None, description: "", body: None }` payloads that overwrite full `AGENTS.md` / `CLAUDE.md` files written by `sync_agent_instructions` (`memory.rs:223-327`).
   - Inside an agent's dedicated home directory, maintain complete `AGENTS.md` / `CLAUDE.md` (identity, motor, `brief`, `memory.txt`, `user.txt`, full active skill bodies, and `## Teammates`).
   - Whenever an agent executes inside a git repository / attached workspace (`spawn.rs:158-163`), inject the compiled charter + memory + active skills **non-destructively** via provider-native instruction channels (`--append-system-prompt`, `--system-prompt`, or initial turn/session context envelope) in `build_spawn` (`spawn.rs:574-718`), NEVER overwriting repository `AGENTS.md` / `CLAUDE.md` files on disk.
2. **Complete Launch Inheritance (`useChatSession.ts`, `terminal/commands.rs`, `AgentTerminalPane.tsx`):**
   - Extend `createDraftConfig` (`src/components/views/chat/useChatSession.ts:101-102`) so agent chat sessions inherit `defaultModel`, `defaultMode`, `defaultPlan`, and `defaultProviderOptions` (including `effort`), not just `defaultModel`.
   - Pass the agent's charter/instructions when launching an interactive agent terminal (`src-tauri/src/terminal/commands.rs:185-192`), honoring the behavior advertised by `AgentTerminalPane.tsx:145`.

---

### S2 — Service Tool Pack (`kite agent` CLI & Permission-Gated MCP Bridge)
Addresses *"ampliar nuestra gama de herramientas que tienen los agentes... agentes que sean más serviciales y más autónomos"* across any active provider.

1. **Unified Service Tool Surface (`dispatch_wire` / `kite agent` subcommands & local MCP server):**
   - Expose structured, machine-readable tools usable by any provider running an agent turn:
     - `thread`: `list`, `search`, `read` (cursor-paged summaries/items from other threads without blowing context).
     - `memory`: `read`, `add`, `search` (scoped read/write against agent `memory.txt` and shared `user.txt`).
     - `routine`: `list`, `create`, `toggle`, `run` (gated by `allowAgentScheduling`).
     - `teammate`: `list`, `send`, `delegate` (gated by `allowAgentMessaging`).
2. **Real Permission & Plugin Enforcement (`persist.rs:59-60`, `plugins.rs:14-44`):**
   - Enforce `allowAgentScheduling`, `allowAgentMessaging`, and `disabled_plugin_ids` at spawn/tool-invocation time so disabled plugins, tool packs, or MCP bridges are excluded from the agent's injected tool catalog and blocked if invoked directly.

---

### S3 — Multi-Provider `AgentProfile` <-> `kite dispatch` Unification
Eliminates the split brain between `Agents` SQLite profiles and markdown-only dispatch roles (`subagent_settings.rs`), allowing any specialist to collaborate regardless of configured engine.

1. **Profile-First Role Resolution (`dispatch_wire/server.rs:386-427,533-557`):**
   - When handling `kite dispatch run --via thread --role <name|agent:id>` or `swarm add`, resolve SQLite `AgentProfile` records first (by ID, handle, or display name), falling back to `.kite/agents/*.md` and `dispatch/roles/*.md` only when no matching `AgentProfile` exists.
   - Apply the resolved profile's configured engine (`claude`, `codex`, `grok`, `antigravity`, `opencode`, `cursor`, `gemini`), `defaultModel`, `effort`, `defaultMode`, charter, `memory.txt`, and active `skills/*.md`.
   - Integrate with existing provider quota failover / multi-account policies when a target agent's configured provider hits quota exhaustion.

---

### S4 — Workspace Binding, `Places` Enforcement & Budgeted Shared Memory
Unblocks contextual work on real projects and fixes memory budget & index bottlenecks.

1. **Workspace & `Places` Context (`AgentsView.tsx`, `AgentChatShell.tsx`, `persist.rs`):**
   - Stop hardcoding `<ChatView workspaceId={null} />` in `AgentsView.tsx:74`; pass real `workspaceId` and `workspaces` so `AgentChatShell.tsx:809` displays and binds the active repository accurately.
   - Make `place_display_names` interactive in Settings/Shell and pass bound folders (`Places`) as authorized workspace/read roots alongside the agent's instruction context.
2. **Dynamic Memory Budget, Shared `user.txt` & Fast Thread Index (`agent_mind/memory.rs`, `agent_mind/types.rs`):**
   - Remove the hardcoded `MEMORY_CHAR_BUDGET = 4_000` (`agent_mind/types.rs:6`) inside `write_agent_memory_at` (`memory.rs:105-117`) so the agent's configured `memory_budget` (`4000`, `6000`, `12000`) from `AgentSettingsTab.tsx:31` is enforced accurately.
   - Share `user.txt` (`About you`) consistently across agent homes while isolating specialist notes per agent in `memory.txt`, and maintain a fast searchable index for `thread search/read` without full JSONL rescans.

---

### S5 — Creation Flow, AI Drafting, Custom Skills Editor & Reflection UX
Fixes UI/persistence drops and adds first-class skill & reflection workflows in `Agents` mode.

1. **Creation & Settings Integrity (`agents.rs`, `AgentCreatePane.tsx`, `AgentSettingsTab.tsx`):**
   - Persist `avatar`, `defaultModel`, `defaultMode`, and `effort` inside `create_agent` / `push_agent` (`agents.rs:222-278`) instead of dropping fields sent by `AgentCreatePane.tsx:153-161`.
   - Upgrade `draft_agent_with_ai` (`agents.rs:433-548`) from static keyword heuristics (`draft_copy` `503-518`) to real model-backed generation using an available active provider, retaining clean offline/no-session fallback.
   - Fix double-save race in `AgentSettingsTab.tsx:169-196` (`onSaveSettings` + duplicate `update_agent_profile`).
2. **Custom Skills Lifecycle (`AgentSkillsTab.tsx`, `agent_mind`):**
   - Add **"+ New Skill"** authoring flow, per-skill enabled/disabled toggle, and real `uses` / `lastUsed` telemetry updated when a skill is injected/applied.
3. **Interactive & Automated Memory Reflection (`agent_mind/memory.rs:392-442`, chat turn UI):**
   - In `"ask"` mode, surface a compact inline confirmation card (`Save to memory` / `Dismiss`) at turn completion whenever candidate durable learnings are detected instead of running a no-op.
   - In `"auto"` mode, perform structured reflection extraction (respecting configured `memory_budget`) rather than relying solely on literal prompt prefix matches.

---

### S6 — Reactive Live Status Badges & Clickable Teammate Inbox
Gives real-time observability into background routines, delegations, and active turns across the roster.

1. **Unified Active-Run Filtering (`AgentsView.tsx:283-313,566-584`):**
   - Match active executions by both `profileId` and `agentId` so roster badges and status indicators reflect live foreground chats, background routine runs, and dispatched delegations accurately.
2. **Deep-Linked Teammate Inbox:**
   - Render incoming/outgoing teammate messages and delegation outcomes cleanly in `Teammate inbox` with direct click-through navigation to open the thread where the target teammate processed the work.

---

### S7 — Wake-on-Message, Background Routine Scheduler & Multi-Turn AutoPilot
Turns autonomous capabilities into working background & multi-turn loops across every provider.

1. **Wake-on-Message for Cold Agents (`dispatch_wire/protocol.rs`, `chat/runtime`):**
   - Upgrade teammate message routing (`agent:<uuid>`) so messaging an idle or cold agent (`live_thread_for_profile` `protocol.rs:620-656` finding no active persistent handle) automatically attaches/resumes the agent's canonical thread or creates a new thread and executes the turn across **all 7 engines** (both persistent sessions and one-shot CLI turns), rather than dropping messages to audit-only logs.
2. **Real Background Routine Ticker (`src-tauri/src/routines.rs`):**
   - Add an async background Tokio scheduler loop evaluating `nextRunAtUnixMs` on due intervals so routines execute automatically without manual `"Run now"` clicks (with missed-run / overlapping-run guards).
   - Remove the engine block on `"antigravity"` and `"gemini"` (`routines.rs:255-264`) and replace hardcoded `"mode": "readOnly"` (`routines.rs:457`) with configurable per-routine permission modes (`readOnly`, `auto`, `fullAccess`).
3. **Multi-Turn `AgentAutoPilot` Continuation (`AgentAutoPilot.tsx:233-281`, `local_autopilot.rs:145-253`):**
   - Capture the latest settled assistant response / terminal buffer into `transcript` instead of sending `transcript: ''`.
   - Attach a turn-settled listener/orchestrator loop so turn 1 completion invokes `autopilot_next` and queues subsequent turns automatically until reaching `"done"`, `"stuck"`, or user pause/stop.

---

### S8 — Kite Code Native Terminology & Clean Task Documentation
- All public ODD specs, presets, code identifiers, UI strings, and documentation remain 100% Kite Code native (`Agents`, `Charter / Brief`, `Memory`, `Skills`, `Routines`, `Teammates`, `AutoPilot`, `Places`, `Plugins`), verified cleanly by `node .kite/sanitizer/audit-references.mjs --check`.
- Comparative external architecture notes stay isolated outside public specifications in internal engineering notes.

---

## Tasks

> **Execution status**: `T1`–`T8` (`S1`–`S8`) are all implemented and verified on `feat/response-thread` (`L4`). Changes remain cleanly separated in the working tree alongside pre-existing parallel ODDs for independent slice review/commit without touching unrelated ODD work.

- [x] **T1** (`S1`, Risk: `item 3 — shared chat/terminal spawn & AGENTS.md integrity`, route: `delegated (2 parallel share subagents + follow-up tests)`, ~420 lines incl. tests): Fixed `write_recipe_instructions` / `apply_recipe` so repo/pre-existing `AGENTS.md` and `CLAUDE.md` files and full agent-home instructions are never overwritten; added snapshot-isolated `compile_snapshot_instructions_at` + non-destructive engine flag/envelope injection in `spawn_args_with_instructions` / `launch_provider`; wired terminal startup charter context in `resolve_terminal_agent_prompts` (`terminal/commands.rs`, `terminal/workspace.rs`); and extended `createDraftConfig` + `useChatSession.ts` launch inheritance (`defaultModel`, `defaultMode`, `defaultPlan`, `effort`). Ready to review/commit separately (`fix(agents): preserve repo instructions and inherit launch config`).
- [x] **T2** (`S4`, Risk: `item 1, item 3 — memory budget validation & AgentsView workspace wiring`, route: `delegated (frontend share subagent for part 1 + backend inherit subagent for part 2)`): **Part 1:** wired real `workspaceId` and `workspaces` through `AppMainStage` -> `AgentsView` -> `AgentChatSurface` -> `ChatView` and `useChatSession`, wired `placeDisplayNames` into `AgentsView` `settingsDraft`/save/revert, and made `Places` interactive in `AgentSettingsTab`. **Part 2:** wired `workspaceId` + `plan`/`effort` overrides in `create_agent_chat` (`chat_commands/threads_cmd.rs`), compiled `## Places (Authorized Roots)` in `compile_snapshot_instructions_at` (`agent_mind/memory.rs`), enforced dynamic `AgentProfile.memory_budget` via `write_agent_memory_at_with_budget` + `resolve_agent_memory_budget`, unified shared `user.txt` across agent homes (with legacy fallback) while keeping `memory.txt` per-agent, and added incremental `ThreadSearchIndex` (`chat/thread_index.rs` hooked into `chat/threads.rs`). Ready to review/commit separately (`feat(agents): bind workspace, places, and dynamic memory budget`).
- [x] **T3** (`S5`, Risk: `item 3 — agent creation IPC & settings persistence`, route: `delegated (fullstack inherit subagent)`): Persisted `avatar`, `defaultModel`, `defaultMode`, and `effort`/`defaultProviderOptions` in `create_agent`/`push_agent_with_options`/`accept_agent_draft` (`agents.rs`) and `AgentCreatePane.tsx`; upgraded `draft_agent_with_ai` (`draft_agent_with_runner` / `run_provider_draft_prompt`) to invoke active providers with `draft_copy` offline fallback; consolidated `AgentSettingsTab.tsx` + `AgentsView.tsx` to eliminate the double-save race; added `"+ New Skill"`, `set_agent_skill_enabled` toggle, and `uses`/`lastUsed` telemetry (`agent_mind/skills.rs`, `spawn.rs`, `AgentSkillsTab.tsx`); and upgraded `apply_post_turn_reflection` (`memory.rs`, `settle.rs`) for `"auto"` structured extraction + `"ask"` `reflectionCandidate` inline `AgentReflectionCard.tsx` (`Save to memory` / `Dismiss`). Ready to review/commit separately (`feat(agents): upgrade creation, AI draft, skills editor, and reflection UX`).
- [x] **T4** (`S2`, Risk: `item 2, item 3 — agent tool execution & plugin/permission gating`, route: `delegated (backend inherit subagent)`): Added `kite agent <thread|memory|routine|teammate>` / `kite dispatch agent` CLI commands (`main.rs`, `dispatch/cli/*`, `dispatch/cli_wire.rs`, `dispatch_wire/server.rs`) and MCP tools `kite_thread`, `kite_memory`, `kite_routine`, `kite_teammate` (`dispatch/mcp.rs`) backed by `thread_index`, `agent_mind::memory`, `routines`, and `persist::agents()`/`dispatch_wire`; injected caller agent permissions (`KITE_AGENT_ID`, `KITE_ALLOW_SCHEDULING`, `KITE_ALLOW_MESSAGING`, `KITE_DISABLED_PLUGINS`) at spawn (`chat/runtime/spawn.rs`) and enforced `allowAgentScheduling`, `allowAgentMessaging`, and `disabled_plugin_ids` (`plugins.rs`) across `tools/list`, `tools/call`, and wire/CLI handlers. Ready to review/commit separately (`feat(agents): add permission-gated agent service tool pack`).
- [x] **T5** (`S3`, Risk: `item 3 — dispatch role resolution & multi-provider spawning`, route: `delegated (backend inherit subagent)`): Implemented profile-first `AgentProfile` resolution (`resolve_agent_profile_role` / `resolve_role_target` in `dispatch/role.rs`) ahead of markdown role fallback in `Command::Run`, `Command::Swarm(Add)` (`dispatch_wire/server.rs`, `dispatch/cli/execute.rs`), `WirePort::start_thread` (`dispatch_wire/protocol.rs`), `spawn_child_subagent_thread` (`chat/subagents/{types,spawn}.rs`), and `prepare_swarm_member_thread` (`chat/swarm/{workers,actions}.rs`), inheriting canonical engine across all 7 providers, `default_model`, `default_mode`, `effort`, and `profileId` with quota/unavailability failover (`resolve_command_with_subagent_settings_using`). Ready to review/commit separately (`feat(dispatch): unify AgentProfile resolution across all providers`).
- [x] **T6** (`S7` part 1, Risk: `item 4 — async session wake-on-message across all providers`, route: `delegated (backend inherit subagent + post-review remembered_provider_defaults fix)`): Added `resolve_or_wake_thread_for_profile` (`dispatch_wire/protocol.rs`) so `agent:<uuid>` messages attach live or persisted eligible threads or create canonical threads across persistent, resumable, and one-shot engines with full profile inheritance; added `thread_id` schema migration and `record_audit_with_target` in `dispatch_wire/audit.rs` + `agent_message_inbox` `"threadId"` in `dispatch_wire/server.rs`; and excluded `profileId` specialist threads from leaking into Thread-mode `remembered_provider_defaults` (`chat/subagents/spawn.rs`). Ready to review/commit separately (`feat(dispatch): wake cold AgentProfile targets on message across all providers`).
- [x] **T7** (`S7` part 2, Risk: `item 4 — background Tokio routine ticker & multi-turn AutoPilot loop`, route: `delegated (fullstack inherit subagent)`): Unlocked all 7 engines in `chat_provider_for_engine` (`routines.rs`), replaced hardcoded `"readOnly"` with configurable `permissionMode` (`readOnly`/`auto`/`fullAccess` in `routines.rs` + `RoutineEditorDrawer.tsx` + `RoutinesView.tsx`), added `start_routine_scheduler` (`routines.rs`, spawned in `main.rs`) with missed-run future advancement, overlap guards, and `allowAgentScheduling` checks, and implemented real terminal transcript capture (`read_terminal_transcript` in `terminal/commands.rs`, `local_autopilot.rs`) + settle-driven multi-turn loop in `AgentAutoPilot.tsx`. Ready to review/commit separately (`feat(agents): add background routine scheduler and multi-turn autopilot loop`).
- [x] **T8** (`S6`, `S8`, Risk: `none`, route: `delegated (frontend/QA inherit subagent) + independent reviewer`): Fixed `AgentsView.tsx` `pollLiveRuns` (`profileId ?? agentId`), non-clobbering `AgentRoster.tsx` activity merging, and clickable `Teammate inbox` `threadId` deep-links (`AgentChatShell.tsx`, `agent-surface.css`); added regression tests (`AgentsView.test.tsx`, `AgentChatShell.test.tsx`, `AgentRoster.test.tsx`, `AgentAutoPilot.test.tsx`, `AgentSkillsTab.test.tsx`) and passed independent `reviewer` verification + `audit-references.mjs --check`. Ready to review/commit separately (`feat(agents): reactive roster badges, inbox deep-links, and E2E verification`).

---

## Log

- **L1 (2026-11-16 — Initial Thread `b8033fb2-189e-40b2-84a5-0040f7ea7a76` User Request):**
  > "Eh, recientemente estoy pensando en continuar desarrollando la parte de Agents. Porque ya, bueno, estamos consiguiendo un buen punto. Pero claro, tenemos que hacerlo mucho más funcional. Es por ende que tenemos que hacer una revisión completa de lo que se tiene actualmente. Yo solamente he ido trabajando en lo que sería la parte thread, Y no ha utilizado casi nada de la parte de agents, por ende hay que hacer una revisión completa. Y continuar. Eh, básicamente primero que nada. Haciendo una inspección de qué es lo que se tiene. Luego, qué es lo que se puede mejorar. Pero, tiene que ser muy detallado lo que se puede mejorar, básicamente tenemos que ampliar nuestra gama de, herramientas que tienen los agentes. Las capacidades que tienen. [...] nosotros queremos agentes que sean más serviciales [...] Que son más autónomos [...] Es por ende que nosotros queremos crear algo así como agentes pero que se puedan potenciar y conectar a otros proveedores, no solamente aislándolos, sino que sean más serviciales pero, sin tener que depender de un solo proveedor. ¿Es por ende que tenemos que armar esto, construirlo bastante bien? Quiero que armes un ODD completo investigando sobre este tema. Em, y quiero que continuemos con eso."
  - Full verbatim discovery notes stored in internal engineering notes.
- **L2 (2026-11-16 — User Confirmation & Separate-Commit / ODD-First Constraint):**
  > "Eh, sí, quiero llegar a implementar, pero tengo algunas consideraciones. Cada cosa que se desarrolle tiene que quedar con los commits bastante separados, es decir, comitear los archivos que modificaste y las cosas como tal. Con tal de poder separar de otros cambios que respecten a otros ODDs o cosas distintas. Como tal por ahora solamente quiero que escribas. Los ODD y demás, luego ya te diré cuándo implementes."
  - Created `odd/tasks/agent-autonomous-platform.md`, internal engineering notes, and mirrored to Engram (`odd/agent-autonomous-platform/tasks`). Halted implementation cleanly pending user go-ahead.
- **L3 (2026-11-18 — Authorization for `T1` (`S1`) and `T2` Part 1 (`S4`)):**
  > "Trabajemos sobre odd/tasks/agent-autonomous-platform.md implementando únicamente T1 (S1) y la primera parte de T2 (S4: conectar workspaceId real en AgentsView.tsx y Places básicos), manteniendo los cambios de cada tarea listos para revisar por separado sin tocar nada de otros ODDs."
  - Implemented `T1` (`S1`) across backend (`src-tauri/src/agent_mind/{memory,tests}.rs`, `src-tauri/src/chat/{recipe.rs,runtime_tests.rs,runtime/spawn.rs,session/types.rs}`, `src-tauri/src/terminal/{commands.rs,workspace.rs}`, `src-tauri/src/terminal_tests.rs`) and frontend (`src/types/index.ts`, `src/components/views/chat/hooks/useChatDraftConfig{.ts,.test.ts}`, `src/components/views/chat/useChatSession{.ts,.test.tsx}`), and implemented `T2` part 1 (`S4`) (`src/components/app/AppMainStage.tsx`, `src/components/views/AgentsView.tsx`, `src/components/views/agents/{AgentSettingsTab.tsx,AgentSettingsTab.test.tsx,AgentsView.test.tsx,agent-surface.css}`).
  - Note: `src-tauri/src/chat/runtime/spawn.rs` preserves the pre-existing `ensure_dispatch_skill_once()` edit at line 123, and `src-tauri/src/chat/runtime_tests.rs` preserves pre-existing uncommitted tests from parallel ODD work.
  - Observed verification after final code edits:
    - `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code`: `recipe` 6 passed, `agent_mind` 15 passed, `chat::runtime::tests` 56 passed, `terminal::tests` 33 passed; full `--no-fail-fast` run: `--bin kite-code` 739 passed / 1 pre-existing failure (`dispatch::cli_wire::mcp::tests::supports_both_newline_delimited_and_content_length_framed_jsonrpc`, `0.1.66` vs `0.1.65`), `--bin kite` 9 passed / 1 same pre-existing failure.
    - `npx tsc --noEmit`: exited 0.
    - `npx vitest run src/components/views/agents src/components/views/chat`: 45 passed (45 files), 361 passed (361 tests).
- **L4 (2026-11-18 — Full ODD Continuation `T2` Part 2 through `T8`):**
  > "Okey, mira, ahora que intentamos esas correcciones, ahora creo que tenemos que pasar con el tema de atrás, o de fondo, que sería la continuidad de este ODD en su totalidad. El de agent-autonomous-platform.md,  La idea es que identifiques qué es todo lo que se ha hecho. Yo creo que es solamente la T1. Entonces, quiero que continúes con absolutamente todas. Puedes utilizar subagentes para ejecutarlo. Ojalá que puedas hacerlo con subagentes de hecho."
  - Audited existing working tree: confirmed `T1` (`S1`) complete and `T2` part 1 (`S4` frontend `workspaceId` / `workspaces` + interactive `Places`) already implemented uncommitted (`L3`), and uncovered a remaining `T2` part 1 backend gap in `create_agent_chat` (`src-tauri/src/chat_commands/threads_cmd.rs`) ignoring `workspaceId`.
  - Executed `T2` part 2 through `T8` cleanly via sequential `workspace: "inherit"` Kite subagents (`thread:0a8b2823`, `thread:8741c026`, `thread:caef3dae`, `thread:d7756d70`, `thread:47ec611e`, `thread:763e7a50`, `thread:aa12c62f`) plus an independent `reviewer` subagent (`thread:d3c0df5f`), preserving all pre-existing uncommitted parallel ODD edits on `feat/response-thread`.
  - Fixed a `remembered_provider_defaults` (`src-tauri/src/chat/subagents/spawn.rs`) leak surfaced during parallel Cargo verification so `profileId` specialist agent threads never hijack Thread-mode subagent defaults.
  - Observed final verification after all code edits:
    - `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code --no-fail-fast`: **776 passed; 0 failed; 0 ignored** (exit 0).
    - `cargo test --manifest-path src-tauri/Cargo.toml --bin kite --no-fail-fast`: **15 passed; 0 failed; 0 ignored** (exit 0).
    - `npx tsc --noEmit`: exited 0.
    - `npx vitest run --reporter=dot`: **198 passed (198) test files, 1446 passed (1446) tests** (exit 0).
