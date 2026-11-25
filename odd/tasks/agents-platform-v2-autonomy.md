# Autonomous Multi-Provider Agents Platform v2 — Intelligent AutoPilot, Event Routines, Knowledge Packs & Specialist Playbooks

Objective: Evolve Kite Code's `Agents` mode beyond the foundational v1 platform (`odd/tasks/agent-autonomous-platform.md`, `T1–T8 [x]`) into a deeply autonomous, policy-sandboxed, team-capable specialist engineering platform with real LLM-backed **AutoPilot** across both **Agent Threads** and **Terminals**, native `kite_tasks` / `kite_ctx` / `kite_diff` service tools with granular per-agent policies, on-demand **Knowledge Packs** beyond the 12 KB `memory.txt` ceiling, event-driven **Routines** with persistent SQLite Run Ledgers and proactive notifications, multi-agent **Playbooks**, and a **Tool Audit & Dry-Run Eval** workbench.
Branch: `feat/response-thread`.
Delivery strategy: `ask-on-risk` (8 reviewable ~250–400 line slices `T1–T8`; implementation gated on explicit user authorization before starting `T1`).
Test runner: `cargo test --manifest-path src-tauri/Cargo.toml agents`, `cargo test --manifest-path src-tauri/Cargo.toml agent_mind`, `cargo test --manifest-path src-tauri/Cargo.toml routines`, `cargo test --manifest-path src-tauri/Cargo.toml local_autopilot`, `cargo test --manifest-path src-tauri/Cargo.toml dispatch::`, `npx vitest run src/components/views/agents src/components/views/chat`, `npx tsc --noEmit`, `npm run verify:desktop:e2e`, `node .kite/sanitizer/audit-references.mjs --check`.
Connected ODDs: `odd/tasks/agent-autonomous-platform.md` (`T1–T8 [x]`), `odd/tasks/lateral-agent-icons-and-activity.md` (`T2` pending `AgentRoster` minimal working-dot polish), `odd/tasks/thread-cross-provider-orchestration.md`, `odd/tasks/context-engine.md`, `odd/tasks/argos-assistant-capabilities-v2.md`, `odd/tasks/qa-task-handoff-and-tickets-ux.md`.
Constraints: Does not change protected zones (`src/components/TitleBar.tsx` mode switcher) and adheres to `AGENTS.md` §1–§3 radius/height tokens. All public identifiers and documentation remain 100% Kite Code native. Implementation gated on explicit user authorization before `T1`.

---

## Verified Code Baseline & Architecture Overview

Auditing `src-tauri/src/local_autopilot.rs`, `src-tauri/src/routines.rs`, `src-tauri/src/dispatch/mcp.rs`, `src-tauri/src/agent_mind/`, `src/components/views/AgentsView.tsx`, and `src/components/views/agents/` on `feat/response-thread` confirmed:

1. **Keyword-Only Terminal-Only AutoPilot (`src-tauri/src/local_autopilot.rs:7-8, 155-160`, `src/components/views/agents/AgentAutoPilot.tsx:14-25`)**:
   - `local_autopilot.rs` still returns `UNAVAILABLE_REASON = "Cloud autopilot is unavailable in this local build..."` when falling through and evaluates turns using simplistic string checks (`"compiling "`, `"building "`, `"downloading "`, `"installing "`).
   - `AgentAutoPilot.tsx` only accepts `paneId`/`sessionId` for PTY terminal panes; **Agent Chat Threads** (`AgentChatShell.tsx`) have no multi-turn AutoPilot loop, no configurable deterministic Verification Gates (`tsc`/`vitest`/`cargo test`), and no max-turn/wall-clock escalation.
2. **Coarse Tool Surface & Missing `kite_tasks` / `kite_ctx` (`src-tauri/src/dispatch/mcp.rs:1890-1898`)**:
   - Agents currently receive `kite_thread`, `kite_memory`, `kite_routine`, and `kite_teammate` gated only by two global booleans (`allowAgentScheduling`, `allowAgentMessaging`) and `disabled_plugin_ids`.
   - Agents have no `kite_tasks` tool (cannot inspect, claim, create, or update Kite Tasks), no `kite_ctx` tool (cannot run compact `read_compact` / `search` or exchange `SharedContextStore`/`CcrStore` artifacts), no `kite_diff` tool, and no per-agent granular policy matrix (`allow` | `ask` | `deny`) or `Places` write sandbox.
3. **Flat 12 KB Memory Ceiling (`src-tauri/src/agent_mind/memory.rs`, `skills.rs`)**:
   - Agent knowledge is restricted to `memory.txt` (`4–12 KB`) and static `skills/*.md` injected eagerly into every prompt. There is no on-demand **Knowledge Pack** index over project docs, ODDs, or `Places` folders backed by `kite-ctx`, nor memory deduplication/staleness cleanup.
4. **Interval-Only Routines Without Run History (`src-tauri/src/routines.rs:12-29, 804-868`)**:
   - `routines.rs` ticks every `20 s` over fixed time intervals (`MIN_INTERVAL_SECONDS = 900.0`). It lacks event-driven triggers (`cron`, git commit, branch change, Kite Task transition, teammate event), a persistent SQLite `routine_runs` ledger, retry/backoff policies, and proactive output actions (desktop alert, Argos spoken notice, or automatic Kite Task filing).
5. **No Multi-Agent Playbooks, Tool Audit Trail, or Eval Testbench (`AgentsView.tsx`, `AgentChatShell.tsx`)**:
   - Specialist collaboration is limited to 1-to-1 `Teammate inbox` messages; there is no reusable multi-stage **Playbook** runner, no persistent **Tool Execution Audit Log**, no **Dry-Run Eval Testbench** for validating charters/skills before autonomous deployment, and no portable `.kite-agent.json` bundle export/import.

```text
Specialist AgentProfile (Any of 7 Providers + Failover Order)
   ├── Charter + Active Skills + Scoped Knowledge Packs (`kite-ctx` on-demand)
   ├── Granular Policy Sandbox (`allow` | `ask` | `deny` per tool + `Places` roots + turn/time cap)
   ├── Service Tool Pack (`kite-dispatch` MCP & `kite agent` CLI):
   │     `kite_thread` · `kite_memory` · `kite_routine` · `kite_teammate`
   │     + `kite_tasks` · `kite_ctx` · `kite_diff`
   ├── Execution Modes:
   │     ├─ Interactive Thread / Terminal + LLM AutoPilot (with Verification Gates)
   │     ├─ Event-Driven Routines (`interval` | `cron` | `git` | `task` | `teammate` -> `routine_runs` SQLite)
   │     └─ Multi-Agent Playbooks (Sequential / Parallel Stages -> `kite_swarm` + `SharedContextStore`)
   └── Observability & Governance:
         `agent_audit_log` · Dry-Run Eval Testbench · Portable `.kite-agent.json` · Argos Handoff
```

---

## Specs

### S1 — Provider-Agnostic LLM AutoPilot for Both Agent Threads & Terminals
- **Verbatim**:
  > "tenemos que continuar trabajando en el asistente. En las cosas que puede realizar... Al mismo tiempo en. La parte de agentes... no quiero cambios tan ligeros, sino que quiero que sean muy detallados. Con respecto a. Evidenciar avances."
- **Behavior**:
  1. **Real LLM Evaluation (`src-tauri/src/local_autopilot.rs`)**: Upgrade `autopilot_next` to evaluate settled transcripts/thread turns using any connected active provider (reusing the provider execution pattern from `draft_agent_with_ai` / `agents.rs`, with deterministic keyword evaluation kept strictly as offline fallback instead of returning `"Cloud autopilot is unavailable..."`).
  2. **Thread + Terminal Parity (`AgentAutoPilot.tsx` + `AgentChatShell.tsx`)**: Decouple `AgentAutoPilot` from terminal-only `paneId`/`sessionId` so users can attach `Complete`, `Dream`, `Harden`, `Review`, or `Custom task` AutoPilot loops directly to **Agent Chat Threads** as well as PTY terminals.
  3. **Verification Gates & Loop Guardrails**: Allow optional deterministic **Verification Gates** (e.g., `tsc --noEmit`, `vitest`, `cargo test`) before AutoPilot accepts `"done"`, enforce configurable `maxTurns` and `maxWallClockMins`, detect repeated identical prompts (`loop/stuck`), and emit desktop/Argos notifications when reaching `"done"` or `"stuck"`.
- **Acceptance**: Attaching AutoPilot to an Agent Chat Thread or Terminal drives multi-turn progress using the agent's configured provider, runs configured verification checks before finishing, and halts cleanly on completion or stuck detection.
- **Checks**: Rust tests in `local_autopilot` (`cargo test local_autopilot`) covering provider-backed evaluation + offline fallback + stuck loop guard, and Vitest tests in `AgentAutoPilot.test.tsx` + `AgentChatShell.test.tsx` covering Thread AutoPilot attachment and gate verification.

### S2 — Expanded Service Tool Pack (`kite_tasks`, `kite_ctx`, `kite_diff`) & Granular Per-Agent Tool Policy Matrix
- **Behavior**:
  1. **New MCP & `kite agent` CLI Tools (`src-tauri/src/dispatch/mcp.rs` & `dispatch/cli/`)**:
     - `kite_tasks`: `list`, `get`, `create`, `update`, `move_state` (stamping `sourceAgent` = specialist handle/name and `sourceThreadId`).
     - `kite_ctx`: `read_compact` (`signatures` | `map` | `lines`), `search`, `share_put`, `share_get`, `ccr_retrieve` (`<<ccr:HASH>>`).
     - `kite_diff`: `status`, `file_diff` scoped to the agent's bound workspace and authorized `Places`.
  2. **Granular Per-Agent Policy Matrix (`agents.rs` + `plugins.rs` + `AgentSettingsTab.tsx`)**:
     - Extend `AgentProfile` with `toolPolicies` (`allow` | `ask` | `deny` per tool family: `thread`, `memory`, `routine`, `teammate`, `tasks`, `ctx`, `diff`, `filesystem_write`, `shell`), `maxTurnsPerRun`, `maxDurationSecs`, and ordered `failoverEngines`.
     - Enforce policies at both `tools/list` catalog generation and `tools/call` / CLI dispatch runtime, validating file/diff targets against the agent's bound workspace + `Places` roots.
- **Acceptance**: Specialist agents can read compact code via `kite_ctx`, inspect diffs via `kite_diff`, file/update tasks via `kite_tasks`, and are strictly blocked or prompted according to their configured `toolPolicies`.
- **Checks**: Rust tests in `dispatch::mcp` and `agents` verifying `kite_tasks`/`kite_ctx`/`kite_diff` calls, `deny` blocking, `ask` approval gate, and `Places` path sandbox rejection.

### S3 — Scoped Knowledge Packs & Smart Memory Lifecycle (`agent_mind/knowledge.rs`)
- **Behavior**:
  1. **On-Demand Knowledge Packs**: Allow attaching named **Knowledge Packs** to an `AgentProfile` (workspace globs such as `odd/tasks/*.md`, `docs/**`, or external folders within authorized `Places`).
  2. **Incremental `kite-ctx` Retrieval**: Index attached Knowledge Packs incrementally into lightweight metadata + chunk headers stored under the agent's mind directory; inject only a compact Pack manifest (`<= 120` tokens) into the system prompt and serve full matching snippets (`<= 800` tokens) on demand via `kite_ctx` / `kite_memory` search—bypassing the flat `12 KB` `memory.txt` limit without prompt bloat.
  3. **Smart Memory Lifecycle (`AgentMemoryTab.tsx`)**: Add fuzzy/semantic deduplication on `memory add`, staleness indicators (`lastVerifiedAt`), pin/archive toggles, and search filtering across `memory.txt` and shared `user.txt`.
- **Acceptance**: An agent attached to `docs/` and `odd/tasks/` retrieves accurate architecture excerpts on demand without exceeding memory token budgets or blowing up prompt size.
- **Checks**: `cargo test agent_mind` covering Knowledge Pack indexing, `Places` boundary enforcement, deduplication, and `AgentMemoryTab.test.tsx`.

### S4 — Event-Driven Routines, Persistent `routine_runs` Ledger, Retries & Output Actions (`routines.rs`)
- **Behavior**:
  1. **Expanded Triggers (`src-tauri/src/routines.rs`)**: Support `interval` (existing), `cron` (standard 5-field schedule evaluated cleanly in UTC/local), `on_git_commit`, `on_branch_change`, `on_task_state_change`, `on_teammate_message`, and `on_routine_complete` (chaining), each with configurable debounce/cooldown windows to prevent event storms.
  2. **Persistent SQLite `routine_runs` Ledger (`persist.rs` + `routines.rs`)**: Record every run (`runId`, `routineId`, `agentId`, `triggerKind`, `status`: `running` | `succeeded` | `failed` | `skipped` | `cancelled`, `startedAtUnixMs`, `finishedAtUnixMs`, `threadId`, `summary`, `changedFilesCount`, `retryAttempt`, `error`).
  3. **Retries & Output Actions**: Configurable `maxRetries` (`0..3` with exponential backoff) and post-run `outputActions`: `notify_desktop`, `announce_via_argos`, `create_kite_task_on_findings` (files a Kite Task linked to the routine's `threadId`), and `notify_teammate`.
  4. **Routines UI Upgrade (`RoutinesView.tsx` + `RoutineEditorDrawer.tsx`)**: Add trigger type selector + visual cron builder, permission/output action controls, and a **Run History & Findings Drawer** with direct thread links.
- **Acceptance**: Committing to git or transitioning a Kite Task fires a matching event routine automatically, retries transient failures per policy, logs the run in `routine_runs`, and optionally creates a Kite Task or notifies via Argos.
- **Checks**: Rust tests in `routines` (`cargo test routines`) for cron parsing, event debounce, `routine_runs` persistence, retry scheduling, and output action dispatch; Vitest UI tests for `RoutinesView` / `RoutineEditorDrawer`.

### S5 — Multi-Agent Specialist Playbooks & Live Handoff Graph (`agent_playbooks.rs`)
- **Behavior**:
  1. **Playbook Schema & Storage (`src-tauri/src/agent_playbooks.rs`)**: Persist multi-stage **Playbooks** (`id`, `name`, `description`, `stages[]` where each stage defines `stageId`, `title`, `agentProfileId`, `promptTemplate`, `dependsOn[]`, `workspaceMode: 'inherit' | 'share' | 'branch'`, `handoffKeys[]`).
  2. **Orchestration via Canonical `kite_swarm` + `SharedContextStore`**: Execute Playbooks on top of Kite's existing Swarm/Dispatch coordinator (`chat/swarm/`), passing outputs cleanly between stages via `SharedContextStore` (`playbook:<runId>:stage:<stageId>`) without re-dumping entire transcripts across stages, and supporting mixed providers per stage (e.g., `Explorer` on `grok` -> `Architect` on `antigravity` -> `Implementer` on `codex` -> `Reviewer` on `claude`).
  3. **Live Stage Progress & Handoff Graph (`AgentsView.tsx` + `RightDock`)**: Render an interactive pipeline strip showing each stage's status, active provider/model, elapsed time, `SharedContextStore` handoffs, and one-click thread jump.
- **Acceptance**: Running a 3-stage Playbook executes stages sequentially/in-parallel according to `dependsOn`, transfers compressed findings automatically via `SharedContextStore`, and displays live progress per stage.
- **Checks**: Rust tests (`cargo test agent_playbooks`) verifying DAG stage ordering, `SharedContextStore` handoff persistence, and failure halt/retry; Vitest UI tests for Playbook runner and stage graph.

### S6 — Tool Execution Audit Trail, Dry-Run Eval Testbench & Portable Agent Bundles
- **Behavior**:
  1. **Persistent Tool Audit Trail (`agent_audit_log` SQLite table)**: Log every tool invocation, policy verdict (`allowed` | `asked` | `denied`), skill injection event, duration, and linked `threadId` per `agentId`, surfaced in a filterable **Activity & Audit** tab inside `AgentsView.tsx`.
  2. **Dry-Run / Eval Testbench (`AgentSettingsTab.tsx` / `AgentSkillsTab.tsx`)**: Run 1..N test prompts against an agent's compiled charter + active skills + Knowledge Packs in read-only dry-run mode (blocking mutating tools), reporting predicted tool calls, policy violations, skill activations, and prompt token count before enabling background schedules.
  3. **Portable `.kite-agent.json` Bundles & Curated Templates**: Export/import specialist agents (charter, skills, starters, tool policies, Knowledge Pack patterns, and routine templates—strictly stripping API keys, tokens, and local absolute paths), plus ship 5 curated built-in multi-provider specialist presets (`ODD Architect`, `Security & Policy Auditor`, `Test & Regression Runner`, `PR Diff Reviewer`, `Research Librarian`).
- **Acceptance**: Users can audit every tool call an autonomous agent made, dry-run a charter/skill change safely, and export/import reusable specialist bundles cleanly.
- **Checks**: Rust tests for `agent_audit_log` queries and bundle export secret-stripping; Vitest tests for Audit tab, Dry-Run Eval drawer, and bundle import validation.

### S7 — Roster Presence Polish, Bidirectional Argos <-> Agent Handoff & Clean-Room Verification
- **Behavior**:
  1. **Complete `AgentRoster` Live Presence (`lateral-agent-icons-and-activity.md` `T2`)**: Render a minimal, non-clobbering live-working indicator on `AgentRoster.tsx` / `AgentAvatar.tsx` whenever an agent has an active foreground chat, AutoPilot loop, background routine, or Playbook stage.
  2. **Bidirectional Argos <-> Agent Bridge**: Let Argos invoke Playbooks and inspect `routine_runs` / `agent_audit_log` summaries cleanly, and let autonomous agents/routines deliver concise spoken summary notices through Argos when `announce_via_argos` is enabled.
  3. **Clean-Room & Security Hygiene**: Maintain 100% Kite Code native terminology verified by `node .kite/sanitizer/audit-references.mjs --check`.
- **Acceptance**: Left `AgentRoster` reflects live autonomous background work accurately; Argos and Agents collaborate seamlessly; zero sanitizer violations.
- **Checks**: `AgentRoster.test.tsx`, `AgentsView.test.tsx`, `audit-references.mjs --check`.

---

## Delivery Waves & Risk Summary

| Wave | Tasks | Focus | Risk Tier |
| :--- | :--- | :--- | :--- |
| **Wave 1 — Core Autonomy & Safety** | `T1–T2` | LLM AutoPilot (Threads + Terminals + Gates) & `kite_tasks`/`kite_ctx`/`kite_diff` + Tool Policy Matrix | `item 2, item 3, item 4` (policy sandbox, MCP/CLI contracts, async AutoPilot loop) |
| **Wave 2 — Knowledge & Event Routines** | `T3–T4` | Scoped Knowledge Packs + Smart Memory & Event-Driven Routines + `routine_runs` SQLite Ledger | `item 1, item 3, item 4` (SQLite schema migration, background event triggers) |
| **Wave 3 — Teams & Governance** | `T5–T7` | Multi-Agent Playbooks + Live Graph, Tool Audit Trail + Dry-Run Eval + Bundles, `AgentRoster` & Argos Bridge | `item 1, item 3` (SQLite `agent_audit_log`, Swarm/Playbook coordination, bundle import) |
| **Wave 4 — Full Verification & QA Handoff** | `T8` | Full Cargo, TypeScript, Vitest, CDP E2E, `audit-references.mjs --check`, and consolidated QA task proposal | `none` |

---

## Tasks

- [x] **T1** (`S1`, Risk: `item 3, item 4 (autopilot_next LLM provider contract & multi-turn Thread/Terminal orchestration loop)`, route: `delegated (Rust + React fullstack unit)`): Upgrade `src-tauri/src/local_autopilot.rs` to evaluate turns with any active connected provider (keeping keyword heuristics as offline fallback), refactor `AgentAutoPilot.tsx` + `AgentChatShell.tsx` to support both **Agent Chat Threads** and **Terminals**, and add Verification Gates, turn/time caps, and loop/stuck escalation, with Cargo + Vitest tests. (`cargo test local_autopilot`: 7 passed; `cargo test local_tasks`: 1 passed; `AgentAutoPilot.test.tsx` + `AgentChatShell.test.tsx`: 12 passed; `audit-references.mjs`: clean)
- [x] **T2** (`S2`, Risk: `item 2, item 3 (per-agent tool policy sandbox, Places path enforcement & MCP/CLI schema extension)`, route: `delegated (Rust MCP/CLI + Settings UI unit)`): Add `kite_tasks`, `kite_ctx`, and `kite_diff` to `src-tauri/src/dispatch/mcp.rs` and `kite agent` CLI, add per-agent `toolPolicies` (`allow` | `ask` | `deny`), `maxTurnsPerRun`, `maxDurationSecs`, and `failoverEngines` to `agents.rs` + `AgentSettingsTab.tsx`, and enforce policies + `Places` roots at runtime with unit tests. (`cargo test dispatch::`: 91 passed; `cargo test agents`: 64 passed + 3 passed; `cargo test --bin kite`: 21 passed; `AgentSettingsTab.test.tsx` + `AgentsView.test.tsx`: 11 passed; `audit-references.mjs`: clean)
- [x] **T3** (`S3`, Risk: `item 2, item 3 (Places root validation & Knowledge Pack retrieval contract)`, route: `inline`): Implement `src-tauri/src/agent_mind/knowledge.rs` for incremental **Knowledge Pack** indexing and compact `kite-ctx` on-demand retrieval, add memory deduplication, staleness metadata, and search/pin controls in `agent_mind/memory.rs` + `AgentMemoryTab.tsx`, with Cargo + Vitest tests. (`cargo test agent_mind`: 12 passed; `AgentMemoryTab.test.tsx`: 2 passed; `audit-references.mjs`: clean)
- [x] **T4** (`S4`, Risk: `item 1, item 4 (SQLite routine_runs migration & event-driven Tokio trigger dispatch)`, route: `delegated (Rust routines + React RoutinesView unit)`): Add `cron` + event triggers (`on_git_commit`, `on_branch_change`, `on_task_state_change`, `on_teammate_message`, `on_routine_complete`) with debounce/cooldown in `src-tauri/src/routines.rs`, add SQLite `routine_runs` ledger in `persist.rs`, implement retry backoff + post-run output actions (`notify_desktop`, `announce_via_argos`, `create_kite_task_on_findings`), and upgrade `RoutinesView.tsx` + `RoutineEditorDrawer.tsx` with a Run History drawer and tests. (`cargo test routines`: 11 passed; `RoutinesView.test.tsx`: 2 passed; `audit-references.mjs`: clean)
- [ ] **T5** (`S5`, Risk: `item 3, item 4 (Playbook DAG orchestration over Swarm & SharedContextStore)`, route: `delegated (Rust playbooks + React pipeline graph unit)`): Implement `src-tauri/src/agent_playbooks.rs` + Tauri IPC commands running multi-stage specialist Playbooks over Kite's Swarm/Dispatch engine with `SharedContextStore` stage handoffs, and build the Playbook editor + live stage progress / handoff graph in `src/components/views/agents/` with tests.
- [ ] **T6** (`S6`, Risk: `item 1, item 2 (SQLite agent_audit_log & secret-free portable bundle import/export)`, route: `delegated (Rust audit/bundles + React Audit/Eval UI unit)`): Add `agent_audit_log` persistence and **Activity & Audit** tab in `AgentsView.tsx`, implement read-only **Dry-Run / Eval Testbench** in `AgentSettingsTab.tsx` / `AgentSkillsTab.tsx`, and add `.kite-agent.json` bundle export/import + 5 curated specialist templates with secret-stripping verification tests.
- [ ] **T7** (`S7`, Risk: `none`, route: `inline`): Complete minimal `AgentRoster.tsx` / `AgentAvatar.tsx` live-working indicator (`lateral-agent-icons-and-activity.md` `T2`) across foreground chats, AutoPilot, routines, and Playbook stages, and wire bidirectional Argos <-> Agent Playbook/routine announcement hooks with Vitest specs.
- [ ] **T8** (`S1–S7`, Risk: `none`, route: `inline + independent verifier`): Run full `cargo test --manifest-path src-tauri/Cargo.toml --workspace`, `npx tsc --noEmit`, `npx vitest run`, `npm run verify:desktop:e2e`, and `node .kite/sanitizer/audit-references.mjs --check`, sync Engram mirror, and propose one consolidated manual QA verification task in Kite Tasks per `AGENTS.md` §4.4.

---

## Log

- **L1 (2026-11-25 — Initial Audit & ODD Authoring)**:
  > "Ok, mira, lo que tenemos que hacer actualmente es, analizar un poco de lo que estuvimos trabajando últimamente. ¿A qué me refiero? Bueno. Estuvimos trabajando. En. Eh, todo lo que sería la mejora de la orquestación. Subagentes y demás. Lo cual está bien. Pero también tenemos que continuar trabajando en el asistente. En las cosas que puede realizar. En el modo de voz, que está bastante conectado con el asistente. En todo este tipo de cosas. Al mismo tiempo en. La parte de agentes. Entonces quiero que armes un ODD para cada uno. O para cada cosa, que elije. Rápidamente. Pero claro, no quiero cambios tan ligeros, sino que quiero que sean muy detallados. Con respecto a. Evidenciar avances. Eh nosotros ya examinamos otras soluciones y creo que tenemos ODDs pendientes. Tal vez, o tal vez, puedes analizar los últimos en los que trabajamos con respecto a las cosas que mencioné. Para continuar. Mejorando y haciendo mucho más profesional todo esto."
  - Audited `odd/tasks/agent-autonomous-platform.md` (`T1–T8 [x]`), `odd/tasks/lateral-agent-icons-and-activity.md` (`T2` pending), `src-tauri/src/local_autopilot.rs`, `src-tauri/src/routines.rs`, `src-tauri/src/dispatch/mcp.rs`, `src-tauri/src/agent_mind/`, and `src/components/views/agents/AgentAutoPilot.tsx`.
  - Created `odd/tasks/agents-platform-v2-autonomy.md` (`S1–S7`, `T1–T8`) to evolve `Agents` mode with LLM AutoPilot across Threads & Terminals, `kite_tasks`/`kite_ctx`/`kite_diff` + policy sandboxes, Knowledge Packs, event-driven Routines + `routine_runs` ledger, Multi-Agent Playbooks, and Audit/Eval/Portable Bundles. Awaiting user authorization before `T1`.
