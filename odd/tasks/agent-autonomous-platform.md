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
- Comparative architecture & donor inventory notes stay isolated in gitignored `.kite/tasks/agent-autonomous-platform.md`.

---

## Tasks

> **Pre-execution gate**: All tasks `[ ]` below are **awaiting explicit user authorization** (*"luego ya te diré cuándo implementes"*). Each task is scoped for a separate Conventional Commit modifying only its own slice's files.

- [ ] **T1** (`S1`, Risk: `item 3 — shared chat/terminal spawn & AGENTS.md integrity`, route: `inline`, ~280 lines): Fix `apply_agent_recipe` / `write_recipe_instructions` so repo `AGENTS.md`/`CLAUDE.md` files are never overwritten while keeping complete agent-home instructions; add non-destructive engine flag/envelope injection in `build_spawn`; pass terminal charter context and extend `createDraftConfig` inheritance (`defaultModel`, `defaultMode`, `defaultPlan`, `effort`). Commit slice separately (`fix(agents): preserve repo instructions and inherit launch config`).
- [ ] **T2** (`S4`, Risk: `item 1, item 3 — memory budget validation & AgentsView workspace wiring`, route: `inline`, ~260 lines): Wire real `workspaceId`/`workspaces` into `AgentsView` & `AgentChatShell`; enforce editable `Places` roots; remove hardcoded `MEMORY_CHAR_BUDGET = 4_000` in favor of agent `memory_budget` (`4000`/`6000`/`12000`); unify shared `user.txt` sync and add fast cross-thread index lookup. Commit slice separately (`feat(agents): bind workspace, places, and dynamic memory budget`).
- [ ] **T3** (`S5`, Risk: `item 3 — agent creation IPC & settings persistence`, route: `delegated`, ~320 lines): Persist `avatar`, `defaultModel`, `defaultMode`, `effort` in `create_agent`/`push_agent`; upgrade `draft_agent_with_ai` to use live active provider generation with offline fallback; fix `AgentSettingsTab` double-save; add `"+ New Skill"`, enable/disable toggle, and real `uses`/`lastUsed` stats in `AgentSkillsTab`; implement `"ask"` confirmation card + `"auto"` structured extraction in reflection. Commit slice separately (`feat(agents): upgrade creation, AI draft, skills editor, and reflection UX`).
- [ ] **T4** (`S2`, Risk: `item 2, item 3 — agent tool execution & plugin/permission gating`, route: `delegated`, ~360 lines): Add permission-gated `kite dispatch` / `kite agent` subcommands & local MCP bridge (`thread list/search/read`, `memory read/add/search`, `routine list/create/toggle/run`, `teammate list/send/delegate`) enforcing `allowAgentScheduling`, `allowAgentMessaging`, and `disabled_plugin_ids`. Commit slice separately (`feat(agents): add permission-gated agent service tool pack`).
- [ ] **T5** (`S3`, Risk: `item 3 — dispatch role resolution & multi-provider spawning`, route: `delegated`, ~300 lines): Bridge `dispatch_wire` role resolution (`kite dispatch run --via thread --role`, `swarm add`) to resolve SQLite `AgentProfile` records first across all 7 engines (model, effort, mode, memory, skills) with fallback to markdown roles and quota failover integration. Commit slice separately (`feat(dispatch): unify AgentProfile resolution across all providers`).
- [ ] **T6** (`S7` part 1, Risk: `item 4 — async session wake-on-message across all providers`, route: `delegated`, ~290 lines): Implement wake-on-message routing in `dispatch_wire/protocol.rs` for `agent:<uuid>` targets across persistent and one-shot providers so cold or idle teammates resume/create a thread and execute incoming turns reliably. Commit slice separately (`feat(dispatch): wake cold AgentProfile targets on message across all providers`).
- [ ] **T7** (`S7` part 2, Risk: `item 4 — background Tokio routine ticker & multi-turn AutoPilot loop`, route: `delegated`, ~340 lines): Add background scheduler ticker in `routines.rs` evaluating `nextRunAtUnixMs`, unlock `antigravity` & `gemini` engines, support configurable routine permission modes (`readOnly`/`auto`/`fullAccess`), and wire real `transcript` + turn-settled loop in `AgentAutoPilot` + `local_autopilot.rs`. Commit slice separately (`feat(agents): add background routine scheduler and multi-turn autopilot loop`).
- [ ] **T8** (`S6`, `S8`, Risk: `none`, route: `inline`, ~240 lines): Unify live execution filtering (`profileId` + `agentId`) across `AgentsView` & `AgentRoster`, add clickable thread deep-links in Teammate inbox, add full regression unit/UI tests across `T1`–`T7`, and verify `cargo test`, `npx tsc --noEmit`, `npx vitest run`, and `audit-references.mjs --check`. Commit slice separately (`feat(agents): reactive roster badges, inbox deep-links, and E2E verification`).

---

## Log

- **L1 (2026-11-16 — Initial Thread `b8033fb2-189e-40b2-84a5-0040f7ea7a76` User Request):**
  > "Eh, recientemente estoy pensando en continuar desarrollando la parte de Agents. Porque ya, bueno, estamos consiguiendo un buen punto. Pero claro, tenemos que hacerlo mucho más funcional. Es por ende que tenemos que hacer una revisión completa de lo que se tiene actualmente. Yo solamente he ido trabajando en lo que sería la parte thread, Y no ha utilizado casi nada de la parte de agents, por ende hay que hacer una revisión completa. Y continuar. Eh, básicamente primero que nada. Haciendo una inspección de qué es lo que se tiene. Luego, qué es lo que se puede mejorar. Pero, tiene que ser muy detallado lo que se puede mejorar, básicamente tenemos que ampliar nuestra gama de, herramientas que tienen los agentes. Las capacidades que tienen. [...] nosotros queremos agentes que sean más serviciales [...] Que son más autónomos [...] Es por ende que nosotros queremos crear algo así como agentes pero que se puedan potenciar y conectar a otros proveedores, no solamente aislándolos, sino que sean más serviciales pero, sin tener que depender de un solo proveedor. ¿Es por ende que tenemos que armar esto, construirlo bastante bien? Quiero que armes un ODD completo investigando sobre este tema. Em, y quiero que continuemos con eso."
  - Full verbatim discovery notes and comparative external matrix stored in internal gitignored `.kite/tasks/agent-autonomous-platform.md`.
- **L2 (2026-11-16 — User Confirmation & Separate-Commit / ODD-First Constraint):**
  > "Eh, sí, quiero llegar a implementar, pero tengo algunas consideraciones. Cada cosa que se desarrolle tiene que quedar con los commits bastante separados, es decir, comitear los archivos que modificaste y las cosas como tal. Con tal de poder separar de otros cambios que respecten a otros ODDs o cosas distintas. Como tal por ahora solamente quiero que escribas. Los ODD y demás, luego ya te diré cuándo implementes."
  - Created `odd/tasks/agent-autonomous-platform.md`, `.kite/tasks/agent-autonomous-platform.md`, and mirrored to Engram (`odd/agent-autonomous-platform/tasks`). Halted implementation cleanly pending user go-ahead.
