# Focused Notification System: Agent Completion, Tool Approvals & Sound Cues

Objective: Implement a focused, production-grade notification workflow in Kite Code centered on two core moments: agent turn completion and interactive tool approval requests. Ensure every agent finish and tool permission request generates a persistent `NotificationRecord`. Implement configurable, zero-dependency Web Audio synthesized sound cues (completion chime and approval ping). Lift notification state to the application shell so the TitleBar bell badge updates in real time while the popover is closed, with deep navigation directly to the active thread.
Branch: `feat/notification-system`. Do not commit on `main`.
Delivery: `delegated` via subagents.
Test runners: `npm test` (`vitest run`) for frontend; `cargo test` in `src-tauri` for Rust. `npx tsc --noEmit` for type checking.

---

## Product decision

1. **Tight scope**: Confine the notification system strictly to the two most critical agent interaction states:
   - **Agent completion**: Knowing when an agent finishes thinking and building (`completed`, `failed`, or `cancelled`).
   - **Tool approval**: Knowing immediately when an agent pauses waiting for tool permission or user guidance (`needsInput: toolApproval`).
2. **Actionable "Needs you" section**: The top section of the Notification Center is reserved for active input requests. When an approval is requested by the ACP protocol, it appears in "Needs you" with `isWaitingForInput: true`. Resolving or denying the approval in the chat immediately clears its waiting state.
3. **Pleasant, synthesized audio cues**: No external audio assets or fragile static files. Audio cues are generated on the fly via the Web Audio API (`window.AudioContext`):
   - A harmonic major triad chime for completion.
   - A soft dual-tone ping for tool approval requests.
   - Fully gated by the existing "Sound cues" switch in Settings → Notifications.
4. **Real-time bell badge sync**: Fix the architectural defect where notifications only poll when the popover is open. A top-level hook in `App.tsx` keeps `unreadCount` synchronized in the background, keeping the TitleBar bell badge accurate.
5. **Direct thread navigation**: Clicking a notification row navigates to the originating agent and immediately selects the specific thread containing the completed turn or pending approval card.

---

## Terms

- **NotificationRecord**: Durable event record persisted in SQLite table `notifications`. Contains `id`, `runId`, `target` (`source`, `id`), `profileId`, `kind`, `resolution`, `createdAtUnixMs`, `isRead`, and `isWaitingForInput`.
- **Settled Turn**: Completion of an agent turn in `chat/runtime.rs:finish_run()`, with outcome `completed`, `failed`, or `cancelled`.
- **Tool Approval Request**: Permission event triggered in `chat/runtime.rs:PermissionRequired` requiring user authorization (`allowOnce`, `allowForSession`, `deny`, `denyAndStop`).
- **Needs You**: High-priority view section in `NotificationsView` displaying records where `isWaitingForInput == true`.
- **Audio Cue**: Synthesized sound effect played via Web Audio API when an agent turn settles or an approval opens, governed by `finishSoundEnabled`.

---

## Current-state audit & Identified gaps

1. **Agent turn completion is disconnected**: `src-tauri/src/chat/runtime.rs:finish_run()` completes turns, but only routine executions (`routine_id.is_some()`) ever insert into `notifications()`. Regular agent chat turns never create a notification.
2. **Tool approval requests are disconnected**: In `src-tauri/src/chat/runtime.rs:1607` (`PermissionRequired`), the engine emits `approvalOpened` and updates the thread, but never creates a `NotificationRecord`. The "Needs you" section in the UI remains perpetually empty.
3. **Popover lifecycle isolates polling**: `src/App.tsx:1259` unmounts `NotificationsView` whenever the popover is closed. Because polling and snapshot loading live inside `NotificationsView`, `unreadCount` never updates in real time. The bell badge remains at `0`.
4. **Sound cues are disconnected**: `finishSoundEnabled` exists in preferences and Settings UI, but neither backend nor frontend triggers audio when an agent turn finishes or requires approval. The only sound command (`notifications_play_sample`) is a manual Win32 `MessageBeep` test button.
5. **Navigation lacks thread selection**: `NotificationsView.tsx:282` switches `workMode` to `'agent'` or `'code'`, but does not select the specific `threadId` that generated the alert.

---

## Specs

### S1. Agent Turn Completion Dispatch
In `src-tauri/src/chat/runtime.rs:finish_run()` (`src-tauri/src/chat/runtime/settle.rs`):
- When a top-level user conversation or Agent Chat turn finishes (and `routine_id.is_none()`):
  - Skip internal subagent and swarm worker child threads (`startedByAgent: true`, `sideChat: true`, non-empty `parentThreadId` / `swarmParentThreadId` / `subagentRole` / `swarmMemberName`, or referenced as a `childThreadId` in a parent thread's `subagentRuns` / `swarmState.members`) so subagent completions stay silent and do not fire `playCompletionChime`.
  - Determine outcome: `completed` (if `ok && !stopped`), `cancelled` (if `stopped`), or `failed` (if `!ok`).
  - Generate a `NotificationRecord`:
    ```json
    {
      "id": "<uuid>",
      "runId": "<run_id>",
      "target": {
        "source": "<agentChat | codeThread>",
        "id": "<thread_id>"
      },
      "profileId": "<profile_id | null>",
      "routineId": null,
      "kind": {
        "kind": "settled",
        "outcome": "<completed | failed | cancelled>"
      },
      "resolution": "runSettled",
      "createdAtUnixMs": "<now_unix_ms>",
      "isRead": false,
      "isWaitingForInput": false
    }
    ```
  - Prepend to `persist::notifications()` (cap at 100 items) and invoke `persist()`.

### S2. Tool Approval & "Needs You" Lifecycle
1. **Creation**: In `src-tauri/src/chat/runtime.rs:1607` (`AcpStreamEvent::PermissionRequired`):
   - Generate a high-priority approval notification:
     ```json
     {
       "id": "<approval.request_id>",
       "runId": "<run_id>",
       "target": {
         "source": "<agentChat | codeThread>",
         "id": "<thread_id>"
       },
       "profileId": "<profile_id | null>",
       "routineId": null,
       "kind": {
         "kind": "needsInput",
         "requestKind": "toolApproval"
       },
       "resolution": null,
       "createdAtUnixMs": "<now_unix_ms>",
       "isRead": false,
       "isWaitingForInput": true
     }
     ```
   - Prepend to `persist::notifications()` and call `persist()`.
2. **Resolution**: In `src-tauri/src/chat/runtime.rs:write_approval_to_run(thread_id, request_id, decision)`:
   - Find the notification item with matching `id == request_id`.
   - Update: `isWaitingForInput = false`, `resolution = "attended"`, and `isRead = true`.
   - Persist to SQLite. The item automatically moves from "Needs you" into "Today".

### S3. Real-Time Application Shell Sync (`useNotifications`)
- Extract notification snapshot loading and polling from `NotificationsView.tsx` into a shared React hook `src/lib/notifications/useNotifications.ts`.
- Mount `useNotifications()` at the root of `src/App.tsx`.
- Polling cadence:
  - 4 seconds while `document.hasFocus()` is true.
  - 15 seconds when window loses focus.
- Provide `unreadCount` directly to `<TitleBar unreadCount={unreadCount} />`.
- Pass snapshot and handlers (`markRead`, `markAllRead`) into `<NotificationsView />`.

### S4. Zero-Dependency Web Audio Synthesized Chimes
Create `src/lib/notifications/audioCues.ts`:
- Uses standard Web Audio API (`window.AudioContext || window.webkitAudioContext`).
- **Turn Complete Chime** (`playCompletionChime(success: boolean)`):
  - Success: Ascending harmonic major triad (e.g. C5: 523.25Hz, E5: 659.25Hz, G5: 783.99Hz) with smooth exponential gain decay (total duration ~350ms).
  - Error: Gentle descending minor tone (G4: 392.00Hz, Eb4: 311.13Hz).
- **Tool Approval Ping** (`playApprovalChime()`):
  - Subtle dual-frequency ping (A5: 880Hz, E6: 1318.5Hz) designed to prompt attention without being intrusive.
- **Preferences Integration**:
  - Checks `preferences.finishSoundEnabled`. If false, sound execution is an immediate no-op.
  - Safe against browser auto-play policies (resumes suspended audio contexts gracefully).
- Wire into `SettingsView.tsx` "Play sample sound" button to preview the synthesized chime.

### S5. Deep Thread Navigation
In `NotificationsView.tsx`:
- Extend `NotificationsViewProps` with `onNavigateThread?: (threadId: string, agentId?: string | null) => void`.
- In `handleRowClick`:
  - When clicking an `agentChat` notification: select the agent (`onNavigateAgent(rec.profileId)`) and select the thread (`rec.target.id`).
  - When clicking a `codeThread` notification: switch to `code` mode and activate that thread.
  - Mark notification as read immediately.

### S6. Explicitly Out of Scope
To maintain focus and delivery speed, the following are deferred to subsequent releases:
- Focus timer / quiet hours scheduling.
- External audio asset bundles (`.mp3` / `.wav` files).

### S7. Characteristic Actor & Context Identity
Every user-facing notification (`NotificationRecord`, in-app toast, Notification Center row, and Windows OS Toast) carries and displays real characteristic names rather than generic labels (`"Agent chat"`, `"Code thread"`, `"Kite"`):
- **Agent Chat (`agentChat`, `profileId`)**: Displays the real agent profile name (e.g., `Chip Worker`) as actor/title and the specific chat thread title as secondary context.
- **Code/Chat Thread (`codeThread`)**: Displays the real thread title (`threadTitle`) when available instead of `"Code thread"`.
- **Terminal Agent (`terminal` / `codeTerminal`)**: Displays the terminal agent identity (`actorName`, e.g. `Orion · Codex` or engine display name) and summary.
- **Routines & AutoPilot**: Carry real `actorName`, `profileId`, `threadTitle`, `workspaceId`, and `module`, deduplicated against `kite:agent-announce` so only one record and one delivery decision occur per completion.

### S8. Module-Aware & App-Focus Delivery Policy
Notification delivery on newly arrived unread notifications obeys the user's current context (active Kite module and window focus):
- **Same active module inside focused Kite** (no `Settings` or `Routines` overlay covering it): Play the audio cue only (`finishSoundEnabled`), with **no** in-app toast and **no** OS notification.
- **Different module inside focused Kite** (or when `Settings` / `Routines` overlay is open): Play the audio cue (`finishSoundEnabled`) **and** show an interactive in-app toast (`Sileo`) naming the characteristic actor with a click action that navigates directly to that agent/thread/terminal.
- **Outside Kite (another application; window unfocused or minimized)**: Play the audio cue (deferring to OS toast audio when minimized to avoid WebView suspension and double chimes) **and** dispatch a Windows native OS Toast notification (when `osNotificationsEnabled` is enabled; for `needsInput`, also retain an in-app approval card if needed).
- Subagent and swarm worker child threads remain silent (`S1` invariant preserved).

### S9. Native Windows Toast Channel & Preferences Upgrade
- Replace the hardcoded `denied` authorization stub in `src-tauri/src/notifications.rs` with real WinRT `ToastNotificationManager` delivery under AUMID `dev.kite.code` via the `windows` (`0.62`) crate (`Data_Xml_Dom`, `UI_Notifications`, `Win32_UI_Shell`), registering HKCU `AppUserModelId\dev.kite.code` and `SetCurrentProcessExplicitAppUserModelID` on startup.
- Expose `notifications_send_os` (`title`, `body`, `tag?`, `silent?`, `forceTest?`) in `src-tauri/src/main.rs`.
- Upgrade legacy `schemaVersion < 2` notification center state on Windows from the stubbed `"denied"`/`"notDetermined"` state to `"authorized"` with `osNotificationsEnabled: true`, while preserving explicit v2 user choices.
- Wire `NotificationsTab.tsx` test button to preview both the audio chime and a live Windows OS toast when enabled.

### S10. Always-On Terminal Attention Bridge & Real-Time Push
- Mount `terminalNotificationBridge` unconditionally at the application root (`App.tsx`) listening to `kite:terminal-agent-update` (`working -> done | waitingForYou | exited (error)` for agent engines, ignoring plain shells), decoupled from Argos voice strip (Argos passes `reportAttention: () => {}` to avoid duplicates).
- Emit Tauri event `kite://notifications-updated` from Rust after notification persistence mutations (never while holding mutexes) so `useNotifications` refreshes in real time without waiting for polling intervals.
- Remove unguarded direct `playApprovalChime()` from `turnPolling.ts` and trigger `kite:notifications-refresh` instead so sound cues always flow through the centralized policy.

### S11. Deep Navigation Parity
- Clicking a notification row in `NotificationsView` or an action button on an in-app toast navigates directly to the target:
  - `agentChat`: switches `workMode` to `'agent'`, selects `profileId`, sets `agentViewMode` to `'chats'`, selects `selectedAgentThreadId = target.id`, closes Settings/Routines.
  - `codeThread`: switches `workMode` to `'chat'`, selects `selectedThreadId = target.id`, closes Settings/Routines.
  - `terminal` / `codeTerminal`: switches `workMode` to `'code'`, selects `workspaceId` if present, dispatches `kite:focus-terminal-session` to focus the pane/tab, closes Settings/Routines.

### S12. Approval Toast Formatting, Layout Containment & Auto-Dismiss Lifecycle
- **Visual Format & Width Containment (`toast.css`, `toast.ts`, `presentation.ts`)**:
  - Override Sileo's `text-transform: capitalize` (`text-transform: none`) so toast titles preserve authentic casing instead of mangling Spanish/mixed sentences into Title Case.
  - Constrain `[data-sileo-header]`, `[data-sileo-header-stack]`, `[data-sileo-header-inner]`, and `[data-sileo-title]` inside the `350px`/`360px` toast width with single-line ellipsis so long titles can never overflow Sileo's fixed SVG gooey canvas or leave the badge floating outside the dark capsule background.
  - Approval / input-request toasts (`toast.agentApproval`) use an amber warning accent (`--warning`) with a crisp shield icon, a short non-overflowing title (e.g. `Approval needed` / `Question` / `Input needed`, keeping long thread titles in the wrapped `description` alongside the action detail), an auto-expanded card body (`autopilot`), and a `28px` `var(--control-radius)` `Review` button.
- **Auto-Dismiss & Resolution Cleanup (`toast.ts`, `useNotifications.ts`, `settle.rs`)**:
  - Approval toasts use a finite auto-dismiss duration (`12000ms`) rather than `duration: null`, so they never stay stuck indefinitely on screen.
  - Clicking `Review` dismisses the toast immediately (`toast.dismiss(id)`) in addition to navigating to the target.
  - `useNotifications` tracks active approval toast IDs by `record.id` and calls `toast.dismiss(toastId)` immediately whenever a record transitions out of waiting (`isWaitingForInput === false` or `isRead === true`), disappears from `snapshot.records`, or when the user focuses the originating module/thread.
  - When a turn finishes, fails, or is cancelled without waiting for permission (`finish_run_with_options` in `src-tauri/src/chat/runtime/settle.rs`), any remaining `isWaitingForInput: true` notifications belonging to that `thread_id` / `run_id` are settled (`isWaitingForInput: false`, `resolution: "runSettled"`) and `kite://notifications-updated` is emitted.

---

## Architecture

```text
       Agent Execution Loop (src-tauri/src/chat/runtime.rs)
                          │
         ┌────────────────┴────────────────┐
         ▼                                 ▼
   finish_run()                 PermissionRequired (ACP)
(turn ok / failed / stopped)    (toolApproval waiting = true)
         │                                 │
         └────────────────┬────────────────┘
                          ▼
            persist::notifications()
          (SQLite WAL atomic persist)
                          │
                  notifications_poll
                          ▼
         useNotifications Hook (src/App.tsx)
          ├── unreadCount ─────────► TitleBar Bell Badge (Real-Time)
          ├── finishSoundEnabled ──► audioCues.ts (Web Audio Chimes)
          └── snapshot ────────────► NotificationsView (Popover)
                                       ├── Needs you (pending approvals)
                                       └── Deep navigate to Agent & Thread
```

---

## Tasks

- [x] **T0 — Baseline verification** (Slice A)
  - Verify existing tests in `src-tauri/src/notifications.rs` and `NotificationsView.test.tsx`.
  - Evidence: `cargo test notifications::` (1 passed); `vitest` `NotificationsView.test.tsx` (2 passed).
- [x] **T1 — Backend turn completion & tool approval wiring** (Slice A)
  - Updated `src-tauri/src/chat/runtime.rs`:
    - In `finish_run`: call `settle_turn_notification` for all agent/chat turns (`kind: "settled"`).
    - In `PermissionRequired`: create `NotificationRecord` with `kind: "needsInput"`, `requestKind: "toolApproval"`, `isWaitingForInput: true`.
    - In `write_approval_to_run`: resolve matching notification to `isWaitingForInput: false`, `resolution: "attended"`.
  - Added unit test `test_settle_turn_and_approval_notifications` in `src-tauri/src/notifications.rs`.
  - Evidence: `cargo test notifications::` (2 passed); `cargo test chat::` (145 passed).
- [x] **T2 — Web Audio chime synthesis (`audioCues.ts`)** (Slice B)
  - Implemented `src/lib/notifications/audioCues.ts`:
    - `playCompletionChime(success, enabled)`: Harmonic major triad on success; minor fall on failure.
    - `playApprovalChime(enabled)`: Subtle dual-frequency ping for input requests.
  - Connected `SettingsView.tsx` "Play sample sound" to preview the synthesized chime.
  - Added unit test suite `src/lib/notifications/audioCues.test.ts` (4 passed).
- [x] **T3 — Global application shell hook & TitleBar badge sync** (Slice B)
  - Implemented `src/lib/notifications/useNotifications.ts`.
  - Mounted hook at root of `src/App.tsx`.
  - TitleBar bell badge now reflects `unreadCount` continuously even while the popover is closed.
  - Added unit test suite `src/lib/notifications/useNotifications.test.ts` (2 passed).
- [x] **T4 — Deep thread navigation in NotificationsView** (Slice C)
  - Enhanced `NotificationsView.tsx` with `onNavigateThread`.
  - Clicking notification row selects originating agent and exact thread ID.
  - Passed `externalSnapshot` from global hook to ensure instant popover sync.
- [x] **T5 — End-to-end regression & test suite** (Slice C)
  - Full frontend suite: 500 passed out of 500 across 74 test files (`npm test`).
  - Full backend suite: 147 passed in `src-tauri` (`cargo test chat::` and `cargo test notifications::`).
  - Type checking clean: `npx tsc --noEmit` exited with 0.

Slices: A = T0–T1; B = T2–T3; C = T4–T5. All complete.

### Slice D — Context-Aware Delivery, Characteristic Identity, Windows OS Toasts & Real-Time Push

- [x] **T6** (`S7, S9, S10`, Risk: `item 3 (NotificationRecord enrichment and notifications IPC/event contract), item 5 (Windows WinRT feature flags in src-tauri/Cargo.toml)`, route: `delegated` — `notification-backend-builder`):
  - Enabled `Data_Xml_Dom`, `UI_Notifications`, `Win32_UI_Shell`, `Win32_Security` on `windows = "0.62"` in `src-tauri/Cargo.toml`.
  - Implemented WinRT Toast delivery (`dev.kite.code` AUMID, HKCU registration, XML builder, `notifications_send_os`), real authorization & v1→v2 Windows migration, `resolve_notification_context`, and `kite://notifications-updated` push emission in `src-tauri/src/notifications.rs` + `src-tauri/src/main.rs`.
  - Enriched `settle_turn_notification`, `settle_routine`, `pipeline.rs`, `stream_json.rs`, `routines.rs`, and `local_autopilot.rs` with `actorName`, `threadTitle`, `workspaceId`, `module`, and deduplicated `alreadyPersisted` announcements while keeping subagent/swarm silencing intact.
  - Evidence: `cargo test notifications::` and `cargo test chat::`, `routines`, `local_autopilot`, `agents` passed inside Tier 3 gate (`test-results/quality-gate/2026-11-26T16-31-52-760Z/report.json`).
- [x] **T7** (`S7, S8, S10, S11`, Risk: `item 3 (shared NotificationRecord presentation & delivery policy)`, route: `delegated` — `notification-frontend-builder`):
  - Created `src/lib/notifications/presentation.ts`, `deliveryPolicy.ts`, and `terminalNotificationBridge.ts` with dedicated unit suites (`presentation.test.ts`, `deliveryPolicy.test.ts`, `terminalNotificationBridge.test.ts`).
  - Updated `src/types/index.ts`, `useNotifications.ts`, `toast.ts`, `NotificationsView.tsx`, `AppNotificationsPopover.tsx`, `useAppGlobalEvents.ts`, `turnPolling.ts`, `ArgosStrip.tsx`, `NotificationsTab.tsx`, and `App.tsx` for characteristic actor names, module/app-focus delivery rules, real-time push sync, always-on terminal attention, and deep thread/terminal navigation.
  - Evidence: `npx tsc --noEmit` and Tier 3 `vitest` stage passed cleanly (`test-results/quality-gate/2026-11-26T16-31-52-760Z/report.json`).
- [x] **T8** (`S11`, Risk: `none`, route: `inline`): Seam check across Rust/TS IPC contracts, wired `kite:suppress-terminal-notification` in `src/lib/operator/proactiveWatcher.ts` and `kite:focus-terminal-session` + pending focus buffer in `src/components/code/useWorkspaceEventListeners.ts` / `terminalNotificationBridge.ts`, audited builder diffs against declared surfaces, and stabilized pre-existing parallel test races (`useChatSession.test.tsx`, `runtime_tests.rs`, `ChatItemRow.test.tsx`).
- [x] **T9** (`S7–S11`, Risk: `item 3, item 5`, route: `inline`): Ran Tier 3 automated quality gate (`node scripts/quality/verify-gate.mjs --rebuild-rust --files <34 slice files>`): `VERDICT: PASS` across all stages (`ipc`, `design`, `sanitizer`, `quality-tests`, `tsc`, `vitest`, 9 `cargo:*` suites, `rust-debug-build`, and 7/7 desktop CDP E2E specs) in `test-results/quality-gate/2026-11-26T16-31-52-760Z/report.json`.
- [x] **T10** (`S7–S11`, Risk: `none`, route: `delegated` — fresh read-only Lane 4 Verifier): Independent `research` Verifier inspected `report.json`, `verifier-handoff.md`, all 7 `process-logs.txt`, all 36 captured `1366x840` + `960x680` CDP PNGs, `TitleBar.tsx`, and backend/frontend contracts per `.agents/skills/kite-delivery-loop/references/verifier-checklist.md` §2B; returned `Verdict: APPROVE`, `Defects: None`.
- [x] **T11** (`S7–S11`, Risk: `none`, route: `inline`): Closed out Slice D ODD checkboxes, ran `node .kite/sanitizer/audit-references.mjs --check` after final ODD edit, updated Engram mirror `odd/notification-system/tasks`, and persisted architectural summary via `mem_save`.

### Slice E — Approval Toast Visual Polish & Auto-Dismiss Lifecycle

- [x] **T12** (`S7, S8, S12`, Risk: `item 3 (shared toast styling/API, useNotifications toast lifecycle, and Rust settle.rs notification cleanup)`, route: `inline`): Fix Sileo approval toast formatting (`text-transform: none`, width/ellipsis containment inside SVG capsule bounds, concise non-overflowing approval title with wrapped thread context, amber shield icon, auto-expanded body, compact `28px`/`8px` non-underlined `Review` button) and eliminate permanently stuck approval toasts (finite `12s` duration, dismiss on `Review` click, live `useNotifications` dismissal on resolution/read/removal/context focus, and Rust `finish_run_with_options` cleanup of lingering `isWaitingForInput` records).
  - Evidence: Vitest 11 affected files (134/134 passed, plus `toast.test.ts` 7/7 re-run after final `toast.css` polish); Rust focused suite (`--test-threads=1`, 95/95 passed, incl. `finish_run_resolves_lingering_waiting_approval_notifications_on_cancel_or_settle`); `tsc --noEmit` 0 errors; `vite build` succeeded; `verify-ipc` PASS, scoped `verify-design` (`toast.css`, `toast.ts`, `ChatComposer.tsx`) 0 errors, `audit-references.mjs --check` CLEAN; Desktop CDP E2E `thread-streaming` PASS + `ui-layout` PASS + live CDP approval toast captures (`1366x840` & `960x680` + post-`Review` `REMAINING_TOASTS_AFTER_REVIEW: 0`); Independent QA & Visual Verifier (`thread:fd72e106-be0c-42b4-90b3-b29f3cd1a959`) returned `APPROVE` (`T12 / S7, S8, S12`: PASS).

---

## Non-regression and verification

- Ensure no disruption to the existing `turnPolling.ts` or `useChatSession.ts` flow.
- Subagent and swarm worker child threads remain silent (`S1`).
- Database schema for `notifications` remains 100% backward compatible (new fields optional in JSON records).
- Audio synthesis and Windows Toast delivery fail gracefully if `AudioContext` or WinRT notifier is unavailable.
- TitleBar mode switcher (`src/components/TitleBar.tsx`) remains untouched.
- Full test pass + Tier 3 gate (`npm run verify:gate -- --rebuild-rust`) + independent visual verification.

---

## Candidate edit surfaces

- `src-tauri/Cargo.toml`
- `src-tauri/src/main.rs`
- `src-tauri/src/notifications.rs`
- `src-tauri/src/chat/runtime/settle.rs`
- `src-tauri/src/chat/runtime/pipeline.rs`
- `src-tauri/src/chat/runtime/stream_json.rs`
- `src-tauri/src/chat/runtime_tests.rs`
- `src-tauri/src/routines.rs`
- `src-tauri/src/local_autopilot.rs`
- `src/types/index.ts`
- `src/App.tsx`
- `src/lib/toast.ts`
- `src/lib/notifications/presentation.ts` (new)
- `src/lib/notifications/deliveryPolicy.ts` (new)
- `src/lib/notifications/terminalNotificationBridge.ts` (new)
- `src/lib/notifications/useNotifications.ts`
- `src/lib/operator/proactiveWatcher.ts`
- `src/components/views/NotificationsView.tsx`
- `src/components/app/AppNotificationsPopover.tsx`
- `src/components/app/useAppGlobalEvents.ts`
- `src/components/code/useWorkspaceEventListeners.ts`
- `src/components/views/chat/turnPolling.ts`
- `src/components/views/chat/useChatSession.test.tsx`
- `src/components/views/chat/ChatItemRow.test.tsx`
- `src/components/ArgosStrip.tsx`
- `src/components/views/settings/NotificationsTab.tsx`

---

## Log

- **L1 (2026-11-26, branch `feat/remote-control`)**:
  > "Quiero que mejoremos bastante la parte de notificaciones, ya que actualmente no funciona en su totalidad. Y a lo que me refiero es que, por ejemplo no me, responde correctamente, o sea, perdón, no me notifica correctamente con cosas características, por ejemplo. Me dice que terminó un agente o que terminó un thread. O que terminó, no lo sé, algún agente en una terminal. Eso está correcto, pero no me dice qué agente, no me dice, por ejemplo, si un agente. De la parte de agents. Eh, terminó, por ejemplo, si tienen un nombre característico como chip worker. Debería al menos decirme la notificación. Eso. Que terminó o algo así. En caso de que yo esté en ese módulo, por ejemplo, si es que estoy en el módulo, módulo de agent. Y terminó ese agente, quiero que solamente suene el sonido. No necesariamente que me aparezca la notificación. Pero si es que estoy en algún otro módulo o. En alguna otra aplicación, quiero que sí aparezca. Por ende esas cosas tenemos que llegar a corregirlas. Para que funcionen correctamente."
  - User approved Tier 3 proposal and requested execution with subagents ("si me parece, implementa con subagentes").
- **L2 (2026-11-26, Slice D verification closeout)**:
  - Automated Tier 3 quality gate (`test-results/quality-gate/2026-11-26T16-31-52-760Z/report.json`): `VERDICT: PASS` (`ipc`, `design`, `sanitizer`, `quality-tests`, `tsc`, `vitest`, 9 `cargo:*` targets, `rust-debug-build`, and 7/7 desktop CDP E2E specs).
  - Independent Lane 4 Visual Verifier inspected `report.json`, `verifier-handoff.md`, 7 `process-logs.txt`, and all 36 captured `1366x840` + `960x680` PNG screenshots: `Verdict: APPROVE`, `Defects: None`.
- **L3 (2026-11-27, Slice E)**:
  > "Otra cosa importante a corregir es, el componente de la izquierda, o sea de la derecha, perdón. De las notificaciones toast. Cuando me está pidiendo permiso. Eh, no me gusta el cómo se ve y además se queda esperando siempre." / "si me parece correcto, A ver, más que nada con el problema de la notificación toast, ¿está también en el formato, en cómo aparece? Que aparece mal, claramente. Y también en, que se queda ahí, literalmente. Es decir, no desaparece. Esas son las cosas que habría que corregir."
  - Audited screenshot and `sileo` internals (`node_modules/sileo/dist/index.js`, `styles.css`, `src/lib/toast.ts`, `src/lib/toast.css`, `src/lib/notifications/useNotifications.ts`, `src/lib/notifications/presentation.ts`, `src-tauri/src/chat/runtime/settle.rs`): Sileo's `text-transform: capitalize` mangled titles into Title Case; long `codeThread` titles exceeded Sileo's fixed `WIDTH = 350` SVG filter bounds so `pillX` went negative and chopped off the dark background behind the floating icon; `duration: null` disabled Sileo's auto-expand (hiding description + `Review` button) and left the toast pinned forever because neither `Review` click nor `useNotifications` ever dismissed tracked toast IDs, and `finish_run_with_options` did not clear lingering `isWaitingForInput` records on settle/cancel. Added `S12` and opened `T12`.
