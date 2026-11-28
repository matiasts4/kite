# Argos Assistant v2 — Full Workspace Operator Reach, Multi-Step Plans & Runtime Integrity

Objective: Elevate **Argos** from a single-action voice/chat dispatcher into a reliable, full-reach Kite Code workspace operator that fixes verified core runtime bugs (`index.ts`, `llm.ts`, `peekWorkspace.ts`), controls **Kite Tasks**, **Routines**, **Subagents/Swarms**, **Diffs/Code Search**, and **Persistent Memory** natively, supports multi-step consultative execution plans (`DraftExecutionPlan`), and operates system-wide via an OS-level global Companion shortcut.
Branch: `feat/response-thread`.
Delivery strategy: `ask-on-risk` (8 reviewable ~250–400 line slices `T1–T8`; implementation gated on explicit user authorization before starting `T1`).
Test runner: `npx tsc --noEmit`, `npx vitest run src/lib/operator src/components/ArgosCompanionBar.test.tsx src/components/ArgosStrip.test.tsx src/components/views/chat/ThreadVoiceMode.test.tsx`, `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code`, `npm run verify:desktop:e2e`, `node .kite/sanitizer/audit-references.mjs --check`.
Connected ODDs: `odd/tasks/argos-voice-mode-roadmap.md` (`T0–T10 [x]`), `odd/tasks/assistant-reach.md` (`T1–T13 [x]`), `odd/tasks/seth-conversational-orchestrator.md` (`T1–T5 [x]`), `odd/tasks/voice-mode-native-and-realtime-engine.md` (companion Voice Engine ODD), `odd/tasks/qa-task-handoff-and-tickets-ux.md`.
Constraints: Does not change protected zones (`src/components/TitleBar.tsx` mode switcher) and adheres to `AGENTS.md` §1–§3 radius/height tokens. Implementation gated on explicit user authorization before `T1`.

---

## Verified Code Baseline & Architecture Overview

Inspecting `src/lib/operator/` and `src/components/` on `feat/response-thread` confirmed the following concrete gaps and defects in the shipped Argos operator pipeline:

1. **Streamed Double-Speak Defect (`src/lib/operator/index.ts:337-389, 447-463`)**:
   - When `streamingQueue` streams sentences incrementally during `planTurnLLM` (`streamingQueue.hasSpokenAny() === true`), `runOperatorTurn` still reaches line `447` and invokes `ttsNarrator.speak(reply)` unconditionally, producing duplicate TTS narration on streamed conversational turns.
2. **Broken Prompt Cache Split & Uncompressed History (`src/lib/operator/planner/llm.ts:74, 236-242`, `src/lib/operator/providers/openaiCompat.ts:104`)**:
   - `buildOperatorPromptPartsAsync` generates `staticPrefix` and `dynamicTail`, yet `llm.ts:240` concatenates them back into `fullPrompt` inside a single `system` message—invalidating provider KV prefix caching whenever active terminals, branch, or proposal state change.
   - `MAX_PRIOR_TURNS = 14` injects up to 14 raw prior messages without summarization, and all 22 `OPERATOR_NATIVE_TOOLS` are sent alongside duplicated `ESQUEMA JSON PERMITIDO` text and few-shot examples (`src/lib/operator/planner/prompt.ts:168-254`).
3. **Truncated ReAct Observations & Incomplete `peek_*` Handlers (`src/lib/operator/index.ts:366-379`, `src/lib/operator/executor/actions/peekWorkspace.ts:90-161, 199-241`)**:
   - `index.ts:367` hard-truncates every `peek_*` observation to `400` characters (`JSON.stringify(r.data).slice(0, 400)`), blinding multi-hop reasoning over diffs, files, and transcripts.
   - `peek_changes` declares `includeDiff?: boolean` (`src/lib/operator/contract.ts:117`) without calling `readWorkspaceFileDiff`.
   - `peek_agents` reads only stale `TurnContext` arrays instead of refreshing live subagent, swarm, routine, and autonomous agent state via IPC.
4. **Missing First-Class Kite Workspace Capabilities (`src/lib/operator/contract.ts:191-214`)**:
   - Argos exposes 22 actions but cannot read/create/move **Kite Tasks** (`src/lib/ipc/tickets.ts`), manage **Routines** (`src/lib/ipc/chat.ts:77-86`), steer/cancel/inspect **Subagents & Swarms** (`<<ccr:HASH>>` findings), inspect **File Diffs / Code Search** (`readWorkspaceFileDiff`, `ctx_search`, `codegraph`), run allowlisted **Verification Checks**, navigate **UI Views**, or manage **Memory Notes** explicitly.
5. **Single-Action Consultative Proposals (`src/lib/operator/voice/voiceSessionStore.ts`, `src/components/views/chat/ConsultativeDraftCard.tsx`)**:
   - `DraftTaskProposal` models only one `targetKind`, preventing consultative review, step toggling, or live progress tracking for multi-step plans.
6. **Window-Local Companion Shortcut (`src/components/ArgosCompanionBar.tsx:62-73`)**:
   - `Alt+Space` is bound solely to WebView `window.addEventListener('keydown')`, so Argos Companion cannot be summoned when Kite Code is minimized or unfocused, and `captureVisualContextSnapshot` lacks structured active view/file/diff selection fields.

```text
User (Voice / Typed / OS Alt+Space Companion)
   │
   ▼
Argos Operator Coordinator (`src/lib/operator/index.ts`)
   ├─ Guard: `!streamedViaQueue` prevents duplicate TTS narration
   ├─ Bounded ReAct (`<= 3` hops, `kite-ctx` <= 450-token structured envelopes)
   │    ├─ `peek_changes` (+ `readWorkspaceFileDiff`), `peek_runs`, `peek_agents` (live IPC)
   │    ├─ `peek_files`, `peek_search` (`ctx_search` / `codegraph`), `read_finding` (`CcrStore`)
   │    └─ `recall_conversations`
   ├─ Consultative Multi-Step Plans (`DraftExecutionPlan` + `ConsultativeDraftCard` v2)
   │    └─ `propose_task` / `refine_proposal(stepIndex)` / `confirm_proposal` / `cancel_proposal`
   └─ Expanded Workspace Action Surface (`src/lib/operator/executor/actions/`)
        ├─ `manage_tasks` (`list`, `create`, `update`, `move_state` -> `tickets.ts`)
        ├─ `control_subagent` (`send`, `cancel`, `read_finding`) & `coordinate_swarm`
        ├─ `manage_routines` (`list`, `create`, `toggle`, `run_now` -> `routines.rs`)
        ├─ `read_diff`, `run_check` (allowlisted `kite ctx exec`), `navigate_view`
        └─ `manage_memory` (`remember_note`, `search_memory`, `forget_note`)
```

---

## Specs

### S1 — Runtime Integrity & High-Fidelity ReAct Inspection (`peek_*` v2 + Zero Double-Speak)
- **Verbatim**:
  > "tenemos que continuar trabajando en el asistente. En las cosas que puede realizar... no quiero cambios tan ligeros, sino que quiero que sean muy detallados. Con respecto a. Evidenciar avances."
- **Behavior**:
  1. **Zero Double-Speak Guard (`src/lib/operator/index.ts:337-389, 447-463`)**: Track `streamedViaQueue = Boolean(streamingQueue?.hasSpokenAny())`. Skip post-execution `ttsNarrator.speak(reply)` whenever `streamedViaQueue` is `true` and no post-plan action produced new audible receipts.
  2. **Structured `kite-ctx` Observation Envelopes (`src/lib/operator/index.ts:366-379`)**: Replace `JSON.stringify(r.data).slice(0, 400)` with a deterministic formatter that preserves file paths, diff hunks, symbol matches, and summary bullets compressed via `ctxClient` to `<= 450 tokens` per hop.
  3. **Live `peek_*` Upgrades (`src/lib/operator/executor/actions/peekWorkspace.ts`)**:
     - `peek_changes`: when `includeDiff: true` (and optional `path`), fetch concise hunk summaries via `readWorkspaceFileDiff` within the `450 ms` peek budget.
     - `peek_agents`: query live IPC state (`list_global_subagents` / `list_agent_profiles` / `list_routines` fallback to `TurnContext`) so Argos sees running background subagents, swarms, and routines accurately even if `TurnContext` lagged.
  4. **New Read-Only Inspection Actions (`src/lib/operator/contract.ts`)**:
     - `peek_search`: `{ type: 'peek_search', query: string, path?: string, kind?: 'text' | 'symbol', limit?: number }` backed by `ctx_bridge` / `codegraph` (`<= 450 ms`).
     - `read_finding`: `{ type: 'read_finding', hashOrThreadId: string, lines?: string }` retrieving full subagent or check artifacts from `SharedContextStore` / `CcrStore` (`<<ccr:HASH>>`).
- **Acceptance**: Streamed conversational replies speak once; multi-hop ReAct turns see full structured diff/file/finding data within `450` tokens without raw 400-char JSON truncation.
- **Checks**: Unit tests in `src/lib/operator/conversationalOrchestrator.test.ts` and `src/lib/operator/executor/executor.test.ts` asserting `ttsNarrator.speak` is skipped after `streamingQueue.hasSpokenAny() === true`, ReAct observation envelopes exceed 400 chars cleanly via `kite-ctx` formatting, and `peek_changes`/`peek_agents`/`peek_search`/`read_finding` receipts verify.

### S2 — Native Kite Tasks Operator Capability (`manage_tasks`)
- **Behavior**:
  1. Add `ManageTasksActionSchema` to `src/lib/operator/contract.ts` and `OPERATOR_NATIVE_TOOLS` supporting `operation: 'list' | 'create' | 'update' | 'move_state'`:
     - `list`: optional `stateFilter` (`Backlog` | `Todo` | `In Progress` | `Review` | `Done`), `query`, `limit` (`1..20`).
     - `create`: `title`, `description?`, `priority?`, `state?`, `oddPath?`, automatically stamping `sourceAgent: 'Argos'` and `sourceThreadId: context.boundThreadId`.
     - `update` / `move_state`: `taskId` (or title search resolved deterministically against `getTicketSnapshot()`), `state?`, `title?`, `description?`.
  2. Implement `src/lib/operator/executor/actions/manageTasks.ts` wired to `getTicketSnapshot()` and `ticketCall()` (`src/lib/ipc/tickets.ts`).
  3. **Spoken Receipts & Safety**: `spokenSummaryEs` never reads raw UUIDs (`KITE-101` or human title only). Moving/closing multiple tasks or deleting/archiving requires consultative `propose_task` confirmation unless immediate execution was requested.
- **Acceptance**: Argos can list pending Kite Tasks, create traceable tasks linked to the active thread/ODD, and move a task's status by voice or chat.
- **Checks**: Unit tests with mocked `tickets.ts` IPC verifying `list`, `create` (with `sourceAgent`/`sourceThreadId`), `move_state`, ambiguity disambiguation on duplicate titles, and clean `spokenSummaryEs`.

### S3 — Active Subagent Lifecycle & Swarm Coordination (`control_subagent`, `coordinate_swarm`)
- **Behavior**:
  1. Add `ControlSubagentActionSchema` (`operation: 'send' | 'cancel' | 'read_finding'`, `target` by role/index/`childThreadId`, `message?`) and `CoordinateSwarmActionSchema` (`operation: 'title' | 'add' | 'post' | 'status' | 'kill'`, `swarmName?`, `members?`, `message?`) to `contract.ts`.
  2. Implement `src/lib/operator/executor/actions/controlSubagents.ts` dispatching to Kite's canonical `dispatch_wire` / `chat_commands` Tauri IPC (`send_subagent_message` / `cancel_subagent_thread` / `swarm_*` commands) and `ctxClient.ccrRetrieve` / `shareGet`.
  3. Reject `send` against already `killed`/`stopped` subagents with clear spoken guidance (`"Ese subagente ya finalizó o fue detenido; ¿querés que lance uno nuevo?"`), matching `dispatch/hook.rs` invariants.
- **Acceptance**: During an active session, the user can steer a running subagent, read its full compressed findings, cancel a stuck child, or launch and message a multi-provider Swarm team directly through Argos.
- **Checks**: Unit tests covering `send`, `cancel`, blocked `send` on settled/killed child, `read_finding`, and `coordinate_swarm` lifecycle receipts.

### S4 — Routines & Autonomous Schedules Control (`manage_routines`)
- **Behavior**:
  1. Add `ManageRoutinesActionSchema` (`operation: 'list' | 'create' | 'toggle' | 'run_now'`, `routineId?`, `routineQuery?`, `name?`, `agentQuery?`, `prompt?`, `intervalSeconds?`, `enabled?`, `permissionMode?: 'readOnly' | 'auto' | 'fullAccess'`).
  2. Implement `src/lib/operator/executor/actions/manageRoutines.ts` wired to `listRoutines`, `createRoutine`, `setRoutineEnabled`, `runRoutineNow` (`src/lib/ipc/chat.ts` & `src-tauri/src/routines.rs` IPC).
  3. Honor `allowAgentScheduling` and require consultative `propose_task` confirmation whenever creating a routine or setting `permissionMode: 'fullAccess'`.
- **Acceptance**: Argos lists active routines, triggers `"run_now"` on a named routine, toggles schedules, and drafts new routines consultatively.
- **Checks**: Unit tests verifying `list`, `toggle`, `run_now`, and consultative gating for `create` / `fullAccess`.

### S5 — Diff Inspection, Safe Verification Checks & App Navigation (`read_diff`, `run_check`, `navigate_view`)
- **Behavior**:
  1. **`read_diff`**: `{ type: 'read_diff', path?: string, workspaceId?: string }` calls `readWorkspaceChanges` / `readWorkspaceFileDiff` (`src/lib/ipc/git.ts`), compresses hunks via `kite-ctx`, and produces a concise spoken explanation of what changed (lines added/removed and semantic summary).
  2. **`run_check`**: `{ type: 'run_check', preset: 'tsc' | 'vitest' | 'cargo_test' | 'sanitizer', targetFilter?: string }` executes strictly allowlisted non-destructive verification presets wrapped via `ctx_bridge` (`kite ctx exec`), storing full output in `CcrStore` (`<<ccr:HASH>>`) and returning pass/fail counts + failure summary. Arbitrary unallowlisted shell commands remain routed through terminal `inject_prompt` or consultative confirmation—never silent execution.
  3. **`navigate_view`**: `{ type: 'navigate_view', view: 'threads' | 'code' | 'agents' | 'diffs' | 'tasks' | 'routines' | 'settings', threadId?: string, filePath?: string, taskId?: string }` emits structured UI navigation events without altering the protected `TitleBar.tsx` switcher geometry.
- **Acceptance**: User can ask `"léeme el diff de hook.rs"`, `"corre tsc y vitest en operator"`, or `"llevame a Tasks"` and receive verified results or immediate navigation.
- **Checks**: Executor tests verifying allowlisted `run_check` presets, rejection of invalid presets, `read_diff` formatting, and `navigate_view` event dispatch.

### S6 — Explicit Memory & Knowledge Control (`manage_memory`)
- **Behavior**:
  1. Add `ManageMemoryActionSchema` (`operation: 'remember' | 'search' | 'forget'`, `text?`, `query?`, `scope?: 'workspace' | 'global'`).
  2. Implement `src/lib/operator/executor/actions/manageMemory.ts` over `loadZedMemoryNotes` / `saveZedMemoryNotes` (`operatorConfig`) + `episodicMemory.ts`, deduplicating near-identical entries, preserving existing notes non-destructively, and reporting exact counts/summaries in `spokenSummaryEs`.
- **Acceptance**: `"Acordate que en este proyecto los commits van separados por ODD"` persists a workspace-scoped note immediately without modifying unrelated notes, and `"¿qué guardaste sobre commits?"` retrieves it.
- **Checks**: Unit tests verifying workspace isolation, deduplication, non-destructive add/forget, and search recall.

### S7 — Multi-Step Consultative Execution Plans (`DraftExecutionPlan` + `ConsultativeDraftCard` v2)
- **Behavior**:
  1. Extend `DraftTaskProposal` in `src/lib/operator/voice/voiceSessionStore.ts` with optional `steps?: DraftExecutionStep[]` (`stepId`, `title`, `action: OperatorContractAction`, `dependsOn?: string[]`, `enabled: boolean`, `status?: 'pending' | 'running' | 'done' | 'failed' | 'skipped'`), keeping existing single-step `DraftTaskProposal` fields 100% backward-compatible.
  2. Extend `propose_task` and `refine_proposal` so Argos can propose a 2–5 step workflow (e.g., `1. Run Explorer subagent`, `2. Create Kite Task`, `3. Run Vitest`), refine a specific `stepIndex` by voice (`"en el paso 2 usa Claude"`, `"saltea el paso 3"`), or toggle individual steps in `ConsultativeDraftCard.tsx`.
  3. Upon `confirm_proposal`, `executeConfirmProposalAction` runs enabled steps respecting `dependsOn` (parallelizing independent steps via `Promise.allSettled`), updating `ConsultativeDraftCard` step badges live and summarizing all step outcomes once complete.
- **Acceptance**: Multi-step tasks appear as an interactive, editable checklist in `ConsultativeDraftCard.tsx` (in `Thread`, `Agent`, and `ArgosStrip`), support voice/click step adjustments, and execute step-by-step with live status feedback.
- **Checks**: `voiceSessionStore` + `ConsultativeDraftCard` + `executor.test.ts` tests covering multi-step creation, per-step refinement, partial step disable, dependency ordering, and live status transitions.

### S8 — System-Wide OS Global Companion (`Alt+Space`) & Rich Active Context Capture
- **Behavior**:
  1. Register an OS-level global shortcut in Rust (`src-tauri/src/window.rs` / `main.rs`, configurable in `ArgosTab.tsx`) that toggles/focuses a compact Companion overlay or raises Kite Code directly to `ArgosCompanionBar` even when the main window is minimized or unfocused, preserving `VoiceHostSingletonClaim` (`companionTransfer.ts`).
  2. Enrich `captureVisualContextSnapshot()` (`src/lib/operator/voice/companionTransfer.ts`) with structured active view (`threads` | `code` | `agents` | `diffs` | `tasks` | `routines` | `settings`), active file path / selected diff path, active thread/agent ID, and capped selected text snippet (`<= 600` chars) so `"revisa esto que tengo seleccionado"` works seamlessly.
- **Acceptance**: Pressing the configured global hotkey from outside Kite Code summons the Companion Bar with live active workspace/file/view context attached.
- **Checks**: Rust command registration test (`cargo check`), `companionTransfer.test.ts` + `ArgosCompanionBar.test.tsx` tests for enriched context snapshot and shortcut registration fallback.

---

## Delivery Waves & Risk Summary

| Wave | Tasks | Focus | Risk Tier |
| :--- | :--- | :--- | :--- |
| **Wave 1 — Core Integrity & Inspection** | `T1` | Fix streamed double-speak, ReAct `kite-ctx` observation formatting, live `peek_changes`/`peek_agents`, `peek_search`, `read_finding` | `item 3` (operator turn loop & ReAct contract) |
| **Wave 2 — Workspace Action Expansion** | `T2–T5` | `manage_tasks`, `control_subagent` + `coordinate_swarm`, `manage_routines` + `manage_memory`, `read_diff` + `run_check` + `navigate_view` | `item 2, item 3` (allowlisted checks, routine permissions, shared contract) |
| **Wave 3 — Multi-Step Plans & OS Companion** | `T6–T7` | `DraftExecutionPlan` + `ConsultativeDraftCard` v2; OS-level Global Companion shortcut + rich visual context capture | `item 3, item 4` (global hotkey lifecycle & multi-step execution) |
| **Wave 4 — Verification & QA Handoff** | `T8` | Full `tsc`, `vitest`, `cargo test`, CDP E2E, `audit-references.mjs --check`, and consolidated QA task proposal | `none` |

---

## Tasks

- [x] **T1** (`S1`, Risk: `item 3 (shared runOperatorTurn streaming/TTS & ReAct peek envelope contract)`, route: `inline`): Implemented `src/lib/operator/context/reactEnvelope.ts` (`formatReactObservation`, `formatReactObservationBatch`, `formatReactObservationWithCtx`, `<= 450` tokens), wired `includeDiff` (`readWorkspaceFileDiff`) in `peek_changes`, live IPC refresh in `peek_agents`, and `peek_search` + `read_finding` (`contract.ts`, `peekWorkspace.ts`, `executor/index.ts`). Verified: `npx tsc --noEmit` + `npx vitest run src/lib/operator/context/reactEnvelope.test.ts src/lib/operator/executor/actions/argosV2Peek.test.ts` (9/9 passed). Note: `src/lib/operator/index.ts` was left untouched for Agent 2 (`streamedViaQueue`); drop-in hook: `import { formatReactObservationBatch } from './context/reactEnvelope'; const obsSummary = formatReactObservationBatch(peekExec.receipts, 450);`.
- [x] **T2** (`S2`, Risk: `item 3 (operator contract & Kite Tasks IPC integration)`, route: `inline`): Implemented `manage_tasks` (`list`, `create`, `update`, `move_state`) in `src/lib/operator/contract.ts`, `src/lib/operator/executor/actions/manageTasks.ts`, and `executor/index.ts` wired to `src/lib/ipc/tickets.ts`, auto-attaching `sourceAgent: 'Argos'` and `sourceThreadId`, with consultative gating for bulk moves and clean spoken receipts. Verified: `npx vitest run src/lib/operator/executor/actions/manageTasks.test.ts` (4/4 passed).
- [x] **T3** (`S3`, Risk: `item 3 (dispatch subagent/swarm control from operator)`, route: `inline`): Implemented `control_subagent` (`send`, `cancel`, `read_finding`) and `coordinate_swarm` (`title`, `add`, `post`, `status`, `kill`) in `src/lib/operator/executor/actions/controlSubagents.ts` + `contract.ts` + `executor/index.ts`, enforcing killed/settled guards and `CcrStore` retrieval. Verified: `npx vitest run src/lib/operator/executor/actions/controlSubagents.test.ts` (4/4 passed).
- [x] **T4** (`S4`, `S6`, Risk: `item 2, item 3 (routine scheduling permission gate & persistent notes mutation)`, route: `inline`): Implemented `manage_routines` (`list`, `create`, `toggle`, `run_now`) in `actions/manageRoutines.ts` and `manage_memory` (`remember`, `search`, `forget`) in `actions/manageMemory.ts`, honoring `allowAgentScheduling`, consultative gating on `create` / `fullAccess`, `routines.rs` revision/UUID contract, and non-destructive deduplication. Verified: `npx vitest run src/lib/operator/executor/actions/manageRoutines.test.ts src/lib/operator/executor/actions/manageMemory.test.ts` (2 files, 5 passed).
- [x] **T5** (`S5`, Risk: `item 2, item 3 (allowlisted verification check execution & UI navigation bus)`, route: `inline`): Implemented `read_diff`, `run_check` (allowlisted `tsc` / `vitest` / `cargo_test` / `sanitizer` with `targetFilter` shell-injection guard & `CcrStore`), and `navigate_view` (`ui-bus.ts` `navigate-view` + `App.tsx` listener) in `actions/workspaceOps.ts` + `contract.ts` + `executor/index.ts`. Verified: `npx vitest run src/lib/operator/executor/actions/workspaceOps.test.ts` (3/3 passed).
- [x] **T6** (`S7`, Risk: `item 3, item 4 (multi-step consultative plan state & concurrent wave execution)`, route: `inline`): Extended `DraftTaskProposal` -> `DraftExecutionPlan` in `voiceSessionStore.ts`, `propose_task`/`refine_proposal`/`confirm_proposal` (`contract.ts`, `peekWorkspace.ts`, `executor/index.ts`), and `ConsultativeDraftCard.tsx` for interactive step checklists, voice/click step refinement, dependency-ordered `Promise.allSettled` wave execution, and live per-step status badges. Verified: `npx vitest run src/components/views/chat/ConsultativeDraftCard.test.tsx src/lib/operator/executor/actions/multiStepProposal.test.ts` (2 files, 5/5 passed). Note: `planner/prompt.ts` & `planner/disambiguation.ts` left untouched per parallel boundary.
- [x] **T7** (`S8`, Risk: `item 3, item 4 (OS global shortcut registration & window focus lifecycle)`, route: `inline`): Wired configurable OS-level global Companion shortcut (`RegisterHotKey` Win32 `user32.dll` + non-Windows fallback) in `src-tauri/src/window.rs` / `main.rs` + `ArgosTab.tsx` / `ArgosCompanionBar.tsx` / `App.tsx`, and enriched `captureVisualContextSnapshot()` (`companionTransfer.ts`) with `activeView`, `activeFilePath`, `selectedDiffPath`, `activeAgentId`, and 600-char selection snippet while keeping `< 150` tokens. Verified: `npx vitest run src/lib/operator/voice/companionTransfer.test.ts src/components/ArgosCompanionBar.test.tsx` (14/14 passed) and `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code window::tests` (3/3 passed).
- [x] **T8** (`S1–S8`, Risk: `none`, route: `inline + independent verifier`): Verified full suite & synced ODD/Engram:
  - `npx tsc --noEmit`: 0 errors across all Argos v2 files (`3` errors only in parallel Agent 2 files `src/lib/operator/ttsNarrator.ts` and `src/lib/operator/voice/audioDevices.ts`).
  - `npx vitest run src/lib/operator src/components/ArgosCompanionBar.test.tsx src/components/ZedStrip.test.tsx src/components/views/chat/ThreadVoiceMode.test.tsx src/components/views/chat/ConsultativeDraftCard.test.tsx`: 46/47 files passed, 517/518 tests passed (all Argos v2 specs `reactEnvelope.test.ts`, `argosV2Peek.test.ts`, `manageTasks.test.ts`, `controlSubagents.test.ts`, `manageRoutines.test.ts`, `manageMemory.test.ts`, `workspaceOps.test.ts`, `multiStepProposal.test.ts`, `ConsultativeDraftCard.test.tsx`, `companionTransfer.test.ts`, `ArgosCompanionBar.test.tsx` passed; 1 unrelated failure in `planner/intentDisambiguationPhase3.test.ts:207`). Note: `ArgosStrip.test.tsx` does not exist; ran `ZedStrip.test.tsx`.
  - `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code`: 852 passed, 1 ignored, 1 unrelated live-quota failure (`quota::tests::test_fetch_antigravity_quota`); `window::tests` 3/3 passed.
  - `node .kite/sanitizer/audit-references.mjs --check`: `[AUDIT CLEAN] Scanned 240 file(s). Zero reference leaks detected.`
  - `npm run verify:desktop:e2e`: Pending live desktop CDP & consolidated manual QA handoff (`qa-task-handoff`).

---

## Log

- **L1 (2026-11-25 — Initial Audit & ODD Authoring)**:
  > "Ok, mira, lo que tenemos que hacer actualmente es, analizar un poco de lo que estuvimos trabajando últimamente. ¿A qué me refiero? Bueno. Estuvimos trabajando. En. Eh, todo lo que sería la mejora de la orquestación. Subagentes y demás. Lo cual está bien. Pero también tenemos que continuar trabajando en el asistente. En las cosas que puede realizar. En el modo de voz, que está bastante conectado con el asistente. En todo este tipo de cosas. Al mismo tiempo en. La parte de agentes. Entonces quiero que armes un ODD para cada uno. O para cada cosa, que elije. Rápidamente. Pero claro, no quiero cambios tan ligeros, sino que quiero que sean muy detallados. Con respecto a. Evidenciar avances. Eh nosotros ya examinamos otras soluciones y creo que tenemos ODDs pendientes. Tal vez, o tal vez, puedes analizar los últimos en los que trabajamos con respecto a las cosas que mencioné. Para continuar. Mejorando y haciendo mucho más profesional todo esto."
  - Audited `odd/tasks/argos-voice-mode-roadmap.md` (`T0–T10 [x]`), `odd/tasks/assistant-reach.md` (`T1–T13 [x]`), `odd/tasks/seth-conversational-orchestrator.md` (`T1–T5 [x]`), and inspected `src/lib/operator/` + `src/components/ArgosCompanionBar.tsx` on `feat/response-thread`.
  - Created `odd/tasks/argos-assistant-capabilities-v2.md` (`S1–S8`, `T1–T8`) to fix verified runtime bugs and expand Argos into full workspace operations (Tasks, Subagents/Swarms, Routines, Diffs/Checks, Memory, Multi-Step Consultative Plans, and OS Global Companion). Awaiting user authorization before `T1`.
- **L2 (2026-11-25 — T1 Complete)**:
  - Created `src/lib/operator/context/reactEnvelope.ts` (`REACT_OBSERVATION_MAX_TOKENS = 450`, `formatReactObservation(receipt, maxTokens)`, `formatReactObservationBatch(receipts, maxTokensPerHop)`, `formatReactObservationWithCtx(receipt, maxTokens)`), added `PeekSearchActionSchema` & `ReadFindingActionSchema` in `src/lib/operator/contract.ts`, upgraded `peek_changes` (`includeDiff` + `path`) and `peek_agents` (live IPC refresh) in `src/lib/operator/executor/actions/peekWorkspace.ts`, and wired `executor/index.ts`.
  - Verified with `npx tsc --noEmit` and `npx vitest run src/lib/operator/context/reactEnvelope.test.ts src/lib/operator/executor/actions/argosV2Peek.test.ts` (2 files, 9 passed). `src/lib/operator/index.ts` left untouched per parallel boundary for Agent 2 (`streamedViaQueue` + drop-in `formatReactObservationBatch(peekExec.receipts, 450)`).
- **L3 (2026-11-25 — T2 Complete)**:
  - Implemented `ManageTasksActionSchema` in `src/lib/operator/contract.ts`, `src/lib/operator/executor/actions/manageTasks.ts` (wired to `getTicketSnapshot` + `ticketCall('save_issue', ...)`), and wired `executor/index.ts`.
  - Verified with `npx vitest run src/lib/operator/executor/actions/manageTasks.test.ts` (4/4 passed).
- **L4 (2026-11-25 — T3 Complete)**:
  - Implemented `ControlSubagentActionSchema` and `CoordinateSwarmActionSchema` in `src/lib/operator/contract.ts`, `src/lib/operator/executor/actions/controlSubagents.ts`, and wired `executor/index.ts`.
  - Verified with `npx vitest run src/lib/operator/executor/actions/controlSubagents.test.ts` (4/4 passed).
- **L5 (2026-11-25 — T4 Complete)**:
  - Implemented `ManageRoutinesActionSchema` and `ManageMemoryActionSchema` in `src/lib/operator/contract.ts`, `actions/manageRoutines.ts`, `actions/manageMemory.ts`, and wired `executor/index.ts`.
  - Verified with `npx vitest run src/lib/operator/executor/actions/manageRoutines.test.ts src/lib/operator/executor/actions/manageMemory.test.ts` (2 files, 5 passed).
- **L6 (2026-11-25 — T5 Complete)**:
  - Implemented `ReadDiffActionSchema`, `RunCheckActionSchema`, `NavigateViewActionSchema` in `src/lib/operator/contract.ts`, `actions/workspaceOps.ts`, `ui-bus.ts` (`navigate-view`), `executor/index.ts`, and `src/App.tsx` listener.
  - Verified with `npx vitest run src/lib/operator/executor/actions/workspaceOps.test.ts` (3/3 passed).
- **L7 (2026-11-25 — T6 Complete)**:
  - Extended `voiceSessionStore.ts` (`DraftExecutionStep`, `DraftExecutionPlan`, `toggleDraftProposalStep`, `updateDraftProposalStep`), `contract.ts` (`DraftStepInputSchema`, multi-step `propose_task` / `refine_proposal`), `peekWorkspace.ts` + `executor/index.ts` (topological wave execution + live step badges), and `ConsultativeDraftCard.tsx` (interactive step checklist).
  - Verified with `npx vitest run src/components/views/chat/ConsultativeDraftCard.test.tsx src/lib/operator/executor/actions/multiStepProposal.test.ts` (2 files, 5/5 passed). (`planner/prompt.ts` & `planner/disambiguation.ts` untouched per parallel boundary).
- **L8 (2026-11-25 — T7 Complete)**:
  - Implemented Win32 OS-level `RegisterHotKey` listener + commands in `src-tauri/src/window.rs`, registered in `src-tauri/src/main.rs`, enriched `captureVisualContextSnapshot()` & shortcut persistence in `companionTransfer.ts`, wired `ArgosCompanionBar.tsx`, `ArgosTab.tsx`, and `App.tsx`.
  - Verified with `npx vitest run src/lib/operator/voice/companionTransfer.test.ts src/components/ArgosCompanionBar.test.tsx` (2 files, 14 passed) and `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code window::tests` (3 passed).
- **L9 (2026-11-25 — T8 Verification & Closeout)**:
  - Ran `npx tsc --noEmit` (0 errors on Argos v2 files; 3 errors in parallel `ttsNarrator.ts` / `audioDevices.ts`), Vitest suite (46/47 files, 517/518 tests passed; all Argos v2 tests green; 1 unrelated failure in `planner/intentDisambiguationPhase3.test.ts`), `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code` (852 passed, 1 ignored, 1 unrelated live `quota::tests::test_fetch_antigravity_quota` failure; `window::tests` 3/3 passed), and `node .kite/sanitizer/audit-references.mjs --check` (`[AUDIT CLEAN]`, 240 files).
  - Left `src/lib/operator/index.ts` untouched for Agent 2 (`streamedViaQueue` + drop-in `formatReactObservationBatch(peekExec.receipts, 450)`). Ready for consolidated manual QA proposal (`qa-task-handoff`).
