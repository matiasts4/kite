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
In `src-tauri/src/chat/runtime.rs:finish_run()`:
- When a turn finishes (and `routine_id.is_none()`):
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
- Background terminal or autopilot non-zero exit code notifications.
- Quota exhaustion alerts (retains existing in-chat `QuotaHandoffBanner`).
- Focus timer / quiet hours scheduling.
- External audio asset bundles (`.mp3` / `.wav` files).

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

---

## Non-regression and verification

- Ensure no disruption to the existing `turnPolling.ts` or `useChatSession.ts` flow.
- Database schema for `notifications` remains 100% backward compatible.
- Audio synthesis must fail gracefully if `AudioContext` is suspended or unavailable.
- Full test pass: `npm test` and `cargo test`.

---

## Candidate edit surfaces

- `src-tauri/src/chat/runtime.rs`
- `src-tauri/src/notifications.rs`
- `src/App.tsx`
- `src/components/TitleBar.tsx`
- `src/components/views/NotificationsView.tsx`
- `src/components/views/NotificationsView.test.tsx`
- `src/components/views/SettingsView.tsx`
- `src/lib/notifications/useNotifications.ts` (new)
- `src/lib/notifications/audioCues.ts` (new)
