# Thread Subagent & Swarm Surface, Native Stream Normalization, and RightDock Inspector (ODD 1 of 2)

Objective: Normalize native subagent and swarm executions across all connected providers into canonical `SubagentRun` and `SwarmState` models, render interactive live `SubagentActivityCard` and `SwarmActivityCard` rows in the main orchestrator timeline, and integrate a responsive, animated `SubagentInspectorView` and `SwarmBoardInspector` tab directly inside `RightDock.tsx` so users can inspect live subagent streams and swarm boards on the right while keeping the main orchestrator chat on the left.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `ask-on-risk`.
Test runner: `cargo test chat::`, `npx vitest run src/components/views/chat src/components/views/subagents src/components/RightDock`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.
Series: ODD 1 of 2 for Subagents & Swarm Orchestration (paired with ODD 2: `odd/tasks/thread-cross-provider-orchestration.md`, and connected to `odd/tasks/thread-provider-runtime.md`, `odd/tasks/thread-timeline-surface.md`, and `odd/tasks/thread-composer-and-navigation.md` `S9`).

---

## Architecture & Visual Layout Overview

```text
┌───────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────┐
│ Main Stage: SingleThreadPane (Left — Orchestrator)        │ RightDock: Subagents & Swarm Tab (Right — Inspector) │
│                                                           │ [Dashboard] [Files] [Diffs] [Subagents (2)]      [⤢] │
│                                  ┌─────────────────────┐  ├──────────────────────────────────────────────────────┤
│                                  │ User Prompt Bubble  │  │ ▾ Subagent: Codebase Explorer (1 of 2)  [Swarm Board]│
│                                  └─────────────────────┘  │ Role: Codebase Explorer · Model: Flash · [Working 8s]│
│                                                           ├──────────────────────────────────────────────────────┤
│  [Eye]  Read src/App.tsx                   250 lines      │ ▸ Task Brief: "Map the Thread architecture and..."   │
│                                                           │                                                      │
│  ┌─────────────────────────────────────────────────────┐  │   [Brain]  Checking thread schema in threads.rs...   │
│  │ [Bot] Codebase Explorer   [Flash] [share]  ● 0:08   │  │   [Eye]    Read src-tauri/src/chat/threads.rs        │
│  │ ↳ Reading src-tauri/src/chat/threads.rs   4 steps ▸ │  │   [Search] Searched parentThreadId in src/           │
│  └─────────────────────────────────────────────────────┘  │   [Eye]    Read src/components/RightDock.tsx         │
│                     │ (Click opens/focuses in RightDock)  │                                                      │
│                     └─────────────────────────────────────┼─► Assistant Synthesis (Streaming Markdown):          │
│                                                           │   "Here is the technical handoff with path:line..."  │
│  ┌─────────────────────────────────────────────────────┐  │                                                      │
│  │ [Hub] Parser Rewrite Swarm  2 working · 1 waiting ▸ │  ├──────────────────────────────────────────────────────┤
│  │ #6 @coordinator -> @verifier: "Check #4 and #5"     │  │ [Message subagent or reply to approval...]   [Stop]  │
│  └─────────────────────────────────────────────────────┘  └──────────────────────────────────────────────────────┘
│                                                           │
│  Working · 24s · Subagent: Codebase Explorer              │
└───────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────┘
```

---

## Specs

### S1. Canonical Native Subagent & Swarm Event Normalization Across Providers
User words: "Podemos primero partir dando soporte nativo a los subagentes de estas a, de estos proveedores. Como Grok, que, claro, tiene subagentes. Antigravity también tiene subagentes en su CLI... y todo ese tipo de cosas."
Current fact:
- `ToolCallTracker::merge_tool` (`src-tauri/src/chat/turn_pipeline.rs:244-353`) and `classify_tool_metadata` (`src-tauri/src/acp/types.rs:159-314`) classify only `{"mcpToolCall", "commandExecution", "fileChange", "webSearch", "dynamicToolCall"}`.
- Subagent and swarm tool calls (`Task`, `invoke_subagent`, `define_subagent`, `send_message`, `manage_subagents`, `swarm`, `post_message`, `read_board`, `swarm_wait`, `delegate`, `spawn_agent`) become generic `"dynamicToolCall"` items without extracting `role`, `model`, `workspaceMode`, `prompt`, `conversationId`, `transcriptUri`, or `swarm` board mutations.
- Nested `stream-json` frames from `claude` that carry `parent_tool_use_id` (`src-tauri/src/chat/runtime/stream_json.rs:14-369`) are merged directly into the parent turn's flat item list instead of being grouped under the parent `Task` subagent item.
Acceptance:
- **Canonical Tool Classification (`src-tauri/src/acp/types.rs` & `src-tauri/src/chat/turn_pipeline.rs`)**:
  - `classify_tool_metadata` and `ToolCallTracker` recognize two new first-class `tool_kind` values: `"subagent"` and `"swarm"`.
  - **Subagent Tool Detection (`toolKind: "subagent"`)**:
    - Matches `invoke_subagent`, `define_subagent`, `send_message`, `manage_subagents` (`antigravity` / ACP), `Task` / `Agent` / `dispatch_agent` (`claude`), `subagent` / `delegate` / `spawn_agent` (`grok`, `codex`, `cursor`, `opencode`, `gemini`), and `kite dispatch run` commands targeting a subagent.
    - Extracts a structured `SubagentMeta` payload stored on `ToolCallSnapshot` and persisted on the `ChatItem`:
      - `subagentId: String` (resolved from the provider's child `conversationId`, `session_id`, `childThreadId`, or deterministic `tool_call_id` fallback)
      - `role: String` (from `Role`, `description`, `subagent_type`, `--role`, `--provider`/program, or concise `"Subagent"` fallback — never leaking generic host shell tool names like `"run command"`)
      - `typeName: Option<String>` (from `TypeName` or `subagent_type`, e.g. `research`, `browser`, `worker`)
      - `provider: Option<String>` (defaults to parent provider unless cross-provider is specified)
      - `model: Option<String>` (from `Model`, `model`, `--model`)
      - `workspaceMode: Option<String>` (`"inherit" | "share" | "branch"`, from `Workspace` or `--workspace`)
      - `prompt: Option<String>` (from `Prompt`, `prompt`, `Message`, or `brief`, stripping trailing shell redirection/pipeline operators such as `2>&1`, `1>&2`, `|`, `&&`, `;` when extracted from shell commands)
      - `status: String` (`"running" | "waiting" | "completed" | "failed" | "killed"` — non-zero exit codes, host errors, or rejected CLI JSON receipts always map to `"failed"` and never report a false `"completed"` status)
      - `transcriptUri: Option<String>` (extracted from tool result JSON such as `logAbsoluteUri` when present)
      - `childThreadId: Option<String>` (when backed by a local `ChatThread`)
      - `latestActivity: Option<String>` (1-line summary of the subagent's newest internal tool or reasoning step)
      - `stepCount: usize` (number of internal steps/tools executed by the subagent)
  - **Swarm Tool Detection (`toolKind: "swarm"`)**:
    - Matches `swarm`, `post_message`, `read_board`, `swarm_wait` (`antigravity` / ACP) and `kite dispatch swarm` commands.
    - Extracts a structured `SwarmMeta` payload stored on `ToolCallSnapshot` and updates the thread's `swarmState`:
      - `action: String` (`"title" | "add" | "status" | "model" | "kill" | "channel" | "post_message" | "read_board" | "swarm_wait"`)
      - `swarmTitle: Option<String>`
      - `memberName: Option<String>` (or sharded `<name>-1..<name>-k` when `tasks` or `n` is passed)
      - `model: Option<String>`
      - `workspaceMode: Option<String>`
      - `channel: Option<String>` (defaults to `"main"`)
      - `postText: Option<String>` and parsed `mentions: Vec<String>` (`@<name>`, `@all`, `@#<channel>`)
      - `seq: Option<u64>`
- **Nested Stream Routing (`parent_tool_use_id` & Subagent Transcript Tailing)**:
  - When `handle_stream_json_line` (`src-tauri/src/chat/runtime/stream_json.rs`) or `parse_acp_stream_line` (`src-tauri/src/acp/stream.rs`) receives any event carrying `parent_tool_use_id` (or `subagent_id` / child `conversation_id`), it routes that event into the matching subagent's nested `items` collection in `subagentRuns` (updating `latestActivity` and `stepCount` on the parent `ChatItem`) rather than appending a loose top-level item to the parent transcript.
  - When a subagent tool call emits or returns a `logAbsoluteUri` / local JSONL transcript path (`file:///.../transcript.jsonl`), `src-tauri/src/chat/subagents.rs` tails and parses that JSONL file (`USER_INPUT`, `PLANNER_RESPONSE` `thinking`, `tool_calls`, `content`) into canonical `ChatItem` entries under that `subagentId` and emits `"chat-subagent-event"` to the frontend.
Checks: unit tests in `src-tauri/src/chat/turn_pipeline.rs` and `src-tauri/src/acp/types.rs` verifying `SubagentMeta` and `SwarmMeta` extraction for `invoke_subagent`, `send_message`, `Task` + `parent_tool_use_id`, `swarm{action:"add"}`, and `post_message`, plus transcript JSONL parsing tests in `chat::subagents`.

---

### S2. Durable Subagent, Swarm, and Child-Thread Persistence in `threads.rs`
User words: "También sé que Antigravity implementa como una función de swarm. Y donde se tiene como un modelo pesado en la conversación main. Y modelos livianos en las conversaciones, eh, más livianas, claramente, de subagentes. Eso es lo que queremos llegar a. Armar. Y bueno, tenemos que darle soporte. En la parte de. Thread, también."
Current fact:
- `THREAD_FIELD_NAMES` (`src-tauri/src/chat/threads.rs:13-34`) and `blank_thread` (`threads.rs:64-94`) do not persist `parentThreadId`, `parentToolCallId`, `startedByAgent`, `sideChat`, `subagentRole`, `workspaceMode`, `subagentRuns`, or `swarmState`, even though `ExtendedChatThread` (`src/components/views/chat/types.ts:91-93`) and `childApprovals.ts` (`src/components/views/chat/childApprovals.ts:1-48`) already reference `parentThreadId`, `startedByAgent`, and `sideChat`.
Acceptance:
- Add `parentThreadId`, `parentToolCallId`, `startedByAgent`, `sideChat`, `subagentRole`, `workspaceMode`, `swarmId`, `swarmMemberName`, `subagentRuns`, and `swarmState` to `THREAD_FIELD_NAMES` and `blank_thread` in `src-tauri/src/chat/threads.rs` so they round-trip durably through `.kite/chat/threads.json` and SQLite storage.
- Expose a Tauri command `get_thread_subagent_detail(thread_id: String, subagent_id: String)` in `src-tauri/src/chat/commands.rs` that returns the full `SubagentRun` (metadata + nested `ChatItem[]` items, or the linked child `ChatThread` items when `childThreadId` is set, or parsed `transcriptUri` items).
- Expose a Tauri command `get_thread_swarm_state(thread_id: String)` that returns the consolidated `SwarmState`:
  - `title: String`
  - `coordinatorModel: Option<String>`
  - `members: Vec<SwarmMember>` (`name`, `role`, `provider`, `model`, `workspaceMode`, `state`: `"waiting" | "working" | "stopped" | "killed"`, `channels: Vec<String>`, `subagentId`, `childThreadId`)
  - `posts: Vec<SwarmBoardPost>` (`seq`, `author`, `channel`, `text`, `mentions: Vec<String>`, `createdAtUnixMs`)
  - `channels: Vec<SwarmChannel>` (`name`, `topic`, `archived`)
- In `src/components/views/chat/threadInteraction.ts` (`sidebarThreads`), filter out threads where `Boolean(thread.parentThreadId) && Boolean(thread.startedByAgent)` so agent-spawned child subagent threads do not pollute the user's primary left-hand `ChatRail` list.
Checks: Rust unit tests in `chat::threads` verifying durable round-trip of all new fields across `save_threads` / `load_thread`, and Vitest unit tests in `threadInteraction.test.ts` confirming child subagent threads are excluded from `sidebarThreads` while remaining accessible in `knownThreadsList` for `childApprovals` and `childStopIds`.

---

### S3. Interactive `SubagentActivityCard` and `SwarmActivityCard` in the Main Timeline
User words: "Básicamente te muestran la ejecución de los subagentes. En el chat principal y bueno, si uno les da clic, se abre la zona como en una sidebar... Claro, tendríamos que crear esta nueva parte de visualización de subagentes. Con las animaciones correspondientes, vista correspondiente, que quede todo bien responsivo."
Current fact:
- `ChatWorkEntry` in `src/components/views/chat/ChatItemRow.tsx:192-334` renders every tool call as a flat 24px text row that only toggles an inline `<pre>` block on click.
- `groupTranscriptRows` (`src/components/views/chat/transcriptGrouping.ts`) folds all consecutive tool rows into a single `Worked for <duration>` button once the turn finishes, hiding subagents inside the collapsed group.
Acceptance:
- **Dedicated Timeline Cards (`SubagentActivityCard.tsx` & `SwarmActivityCard.tsx`)**:
  - When `ChatItemRow` or `ChatWorkGroup` encounters an item with `toolKind === 'subagent'` (or `item.subagentMeta`), it renders `<SubagentActivityCard>` instead of a plain `<pre>` work entry.
  - **Geometry & Minimalist Workbench Design Tokens (`AGENTS.md` Compliance)**:
    - Single subagent and swarm entries render as refined, restrained minimalist activity rows (`min-height: 32px`, `border-radius: var(--control-radius)` (`8px`), `1px solid` hairline separator/stroke on hover or active selection rather than heavy nested button boxes), matching the typography hierarchy of `ChatWorkEntry`.
    - Interactive controls and micro-tags inside rows use `var(--control-radius)` (`8px`) and `var(--vl-radius-sm)` (`6px`). Zero arbitrary pixel radii.
  - **`SubagentActivityCard` Anatomy**:
    1. **Primary Compact Row (`min-height: 32px`, `padding: 6px 10px`, `display: flex`, `align-items: center`, `gap: 8px`)**:
       - **Status / Leading Icon**: Crisp 14–16px status glyph (pulsing active indicator while `running`, calm check on `completed`, destructive cross on `failed`/`killed`).
       - **Verb + Role / Task Label**: Crisp inline primary label (e.g. `Started · Code Explorer` or muted role + concise prompt excerpt) with `.live-tool-shine` animation while active (disabled under `prefers-reduced-motion`), truncated cleanly on narrow widths (`text-overflow: ellipsis`).
       - **Subtle Metadata**: Minimal provider/model text badge and optional `share` / `branch` workspace badge (`--vl-radius-sm`), without visual pill noise or duplicated raw prompt lines.
       - **Trailing Status & Elapsed Clock**: `Working · 14s` while running, duration or failure indicator (`Failed` / `Stopped`) on settle in `tabular-nums`.
       - **Clickability Honesty**: Renders as an interactive inspect trigger (hover fill + inspect chevron) **only** when backed by a `childThreadId`, `transcriptUri`, or captured `items`; non-inspectable failed or unbacked rows render statically without a dead inspect chevron.
    2. **Optional Secondary Sub-Line**:
       - Only shown when a distinct live tool activity or failure summary adds signal beyond the primary row (e.g., live step `Reading src/components/RightDock.tsx` or concise CLI validation error message).
  - **`SwarmActivityCard` Anatomy (`SwarmActivityCard.tsx`)**:
    - Renders a matching minimalist hairline row when `toolKind === 'swarm'` or when a turn initializes/updates a Swarm, showing the Swarm title, concise active/waiting worker summary, member status dots, and latest `@mention` post preview.
  - **Multi-Subagent Disclosure Grouping (`transcriptGrouping.ts`)**:
    - Parallel or consecutive subagent invocations (2 or more consecutive `subagent` items) group cleanly into an expandable inline disclosure container (`Started N subagents` / `N subagents running`), matching `ChatWorkGroup` restraint while letting each backed subagent row open `RightDock` on click. Single subagent or swarm rows remain ungrouped inline rows and never disappear inside unrelated tool bursts.
  - **Click-to-Inspect Action**:
    - Clicking a `SubagentActivityCard` dispatches `window.dispatchEvent(new CustomEvent('kite:open-right-dock-subagent', { detail: { threadId, subagentId: meta.subagentId, childThreadId: meta.childThreadId, mode: 'subagent' } }))`.
    - Clicking a `SwarmActivityCard` dispatches `window.dispatchEvent(new CustomEvent('kite:open-right-dock-subagent', { detail: { threadId, swarmId: meta.swarmId, mode: 'swarm' } }))`.
    - The currently inspected card renders an active accent border (`chat-subagent-card--active`) synchronized with `RightDock`'s active inspection selection.
  - **Bottom `TurnActivityStatus` Stage Integration (`TurnActivityStatus.tsx`)**:
    - When a subagent or swarm is the active in-progress item in the turn, the live stage after the clock in `TurnActivityStatus` reads `Working · 1m 6s · Subagent: <Role>` or `Working · 1m 6s · Swarm: <N working>`.
Checks: component tests in `SubagentActivityCard.test.tsx`, `SwarmActivityCard.test.tsx`, and `ChatItemRow.test.tsx` verifying card rendering, model/workspace badges, live status timer, exemption from post-turn folding in `transcriptGrouping.test.ts`, and `kite:open-right-dock-subagent` event dispatch on click.

---

### S4. `RightDock` Integration: `subagents` Tab, Event Routing, and Responsive Split
User words: "Noto que varias aplicaciones, como, no lo sé todas las que ya tenemos, todos los AD, por así decirlo. Tienen lo mismo que nosotros, una parte. A la derecha con. Distintas opciones para abrir, por ejemplo. Abrir archivos, abrir terminales, abrir browser, todo ese tipo de cosas. Nosotros también tenemos divs o, no lo sé todas las cosas. Bueno, en esa misma zona lateral, en nuestra sidebar, por así decirlo. Ahí podríamos incluir esta inspección para el subagente. Diría que es, un patrón que sigue AntiGravity. O los demás, y nosotros también podemos darle uso a nuestra sidebar en lugar de tener que crear algo. Desde cero. Quiero decir, ya tenemos como esa parte de responsiva."
Current fact:
- `RightDockTabKind` in `src/components/dock/dockConfig.tsx:17-24` supports only `'dashboard' | 'browser' | 'files' | 'diffs' | 'tasks' | 'prompts' | 'app'`.
- `useAppGlobalEvents.ts:111-125` opens `RightDock` on `kite:open-right-dock-file` and `OPEN_RIGHT_DOCK_BROWSER_EVENT`, and `RightDock.tsx:159-207` switches tabs on `kite:open-right-dock-file`, `OPEN_RIGHT_DOCK_BROWSER_EVENT`, and `kite:open-right-dock-diffs`, but there is no `subagents` tab or `kite:open-right-dock-subagent` listener.
Acceptance:
- **Extend `dockConfig.tsx` (`src/components/dock/dockConfig.tsx`)**:
  - Add `'subagents'` to `RightDockTabKind`.
  - Add `'subagents'` to the allowed kinds array in `loadInitialTabs()` (`dockConfig.tsx:61`).
  - Add `subagents` to `TAB_CONFIGS`:
    ```ts
    subagents: { label: 'Subagents', tooltip: 'Subagents & Swarm Inspector', closable: true, renderIcon: () => <SubagentsGlyph /> }
    ```
  - Add `{ kind: 'subagents' as const, label: 'Subagents', icon: <SubagentsGlyph />, shortcut: 'Ctrl+Alt+S' }` to `STANDARD_MENU_TABS`.
- **Global Event & Shortcut Wiring (`useAppGlobalEvents.ts` & `RightDock.tsx`)**:
  - Export constant `OPEN_RIGHT_DOCK_SUBAGENT_EVENT = 'kite:open-right-dock-subagent'` with payload type:
    ```ts
    export interface OpenRightDockSubagentDetail {
      threadId: string;
      subagentId?: string | null;
      childThreadId?: string | null;
      swarmId?: string | null;
      mode?: 'subagent' | 'swarm';
      workspaceId?: string | null;
    }
    ```
  - In `useAppGlobalEvents.ts`, listen for `kite:open-right-dock-subagent` and call `setRightDockVisible(true)` (and update `selectedWorkspaceId` if `detail.workspaceId` is provided). Also listen for `kite:open-right-dock-diffs` in `useAppGlobalEvents.ts` so clicking `Open diff` or a subagent card when `RightDock` is closed always makes `RightDock` visible (`setRightDockVisible(true)`).
  - In `RightDock.tsx`:
    - Listen for `kite:open-right-dock-subagent`: ensure `{ id: 'subagents', kind: 'subagents' }` is present in `tabs`, set `activeTabId('subagents')`, and store the latest inspection target (`inspectedTarget: OpenRightDockSubagentDetail | null`).
    - Bind keyboard shortcut `Ctrl+Alt+S` (`Cmd+Alt+S` on macOS) to open/focus the `subagents` tab.
    - Display a live count pill (`<span className="side-panel-tab__count">{activeSubagentsCount}</span>`) on the `subagents` tab button whenever subagents or swarm workers are actively running.
- **Responsive Layout & Motion**:
  - Opening `RightDock` in Thread Mode (`workMode === 'chat'`) or Code Mode (`workMode === 'code'`) uses the existing `motion.aside` `surfaceMotion('panel')` transition (`RightDock.tsx:534-541`) and `.app-browser-sidebar__grip` pointer resize (`320px` min width to `72%` viewport max width), keeping the main orchestrator conversation on the left and the Subagent/Swarm Inspector on the right without overlapping or clipping the composer.
Checks: tests in `RightDock.test.tsx` and `dockConfig.test.ts` verifying `'subagents'` tab persistence, `kite:open-right-dock-subagent` opening and focusing the `Subagents` tab, `Ctrl+Alt+S` shortcut handling, and responsive width clamping.

---

### S5. `SubagentInspectorView` and `SwarmBoardInspector` Inside `RightDock`
User words: "basándose tal vez en po, un poco en... su diseño, de anti-gravity por ejemplo, donde se ve en la zona lateral, si es que uno quiere, la ejecución del subagente y al lado izquierdo. La ejecución del agente main, o del orquestador...También sé que Antigravity implementa como una función de swarm. Y donde se tiene como un modelo pesado en la conversación main. Y modelos livianos en las conversaciones, eh, más livianas, claramente, de subagentes."
Current fact:
- There is no component to render a subagent's live step-by-step execution stream, model hierarchy, or a Swarm's shared message board and worker roster inside `RightDock`.
Acceptance:
- Create `src/components/views/subagents/SubagentInspectorView.tsx`, `src/components/views/subagents/SwarmBoardInspector.tsx`, and `src/components/views/subagents/subagents.css`, mounted in `RightDock.tsx` when `activeTab.kind === 'subagents'`.
- **1. Inspector Header Bar (`height: var(--vl-control-md, 32px)` controls, `padding: 8px 12px`)**:
  - **Subagent / Swarm Selector**: Dropdown or pill strip listing all subagents and swarms in the current parent thread (showing `Role`, `Model` badge, and status dot for each) so the user can switch between subagents without leaving `RightDock`.
  - **Mode Switcher (`Subagent` | `Swarm Board`)**: Segmented control (`var(--control-radius)`, `28px` compact height) when the thread has both subagent streams and an active swarm.
  - **Parent Context Link**: Subtle breadcrumb button (`← Main Thread: <title>`) that focuses the parent orchestrator thread and scrolls to the corresponding `SubagentActivityCard` (`[data-subagent-id="<id>"]`).
- **2. Subagent Live Stream Mode (`SubagentInspectorView.tsx`)**:
  - **Metadata Banner**: Displays the subagent's `Role`, `TypeName` (`research`, `browser`, `worker`), **Model Hierarchy Pill** (`Main: <ParentModel> ➔ Subagent: <SubagentModel>`), `Workspace` badge (`inherit` / `share` / `branch`), and live elapsed timer (`Working · 18s` with smooth ripple dot, or total duration when completed).
  - **Collapsible Task Brief (`TaskBriefCard`)**: Shows the exact `Prompt` / instructions given by the parent orchestrator to the subagent (`line-clamp-3` by default, expandable on click, `var(--card-radius)`).
  - **Live Transcript Column**:
    - Renders the subagent's internal `ChatItem[]` stream using the same `24px` work-log row anatomy (`Eye`, `SquarePen`, `Terminal`, `Search`, `Globe`, `Brain` with `.live-tool-shine`) and markdown assistant blocks as `SingleThreadPane`.
    - Automatically scrolls to the newest step while the subagent is `running` (`follow-the-newest` observer) and pauses auto-scroll when the user scrolls up manually.
    - Animates new subagent steps with the `4px` upward reveal transition (`tweens.reveal`, respecting `prefers-reduced-motion`).
  - **Minimalist Inspector Header & Error Visibility**:
    - Streamlines `SubagentInspectorView` metadata banner into a concise header row (`Role` + hairline subtitle `MainModel -> Provider / SubagentModel · Workspace` + live status timer) and renders a clean inline failure card when a subagent settled with `failed` status so diagnostics are immediately legible without opening raw logs.
  - **Empty State**: When no subagent has been launched yet in the active thread, renders a clean empty state explaining that subagents and swarms spawned by the main agent will appear here live.
- **3. Swarm Board & Roster Mode (`SwarmBoardInspector.tsx`)**:
  - **Coordinator vs. Workers Header**: Shows the Swarm `title` and highlights the **Main Coordinator** (with its heavy model badge) alongside the pool of **Workers** (with their lightweight/assigned model badges).
  - **Sub-navigation Tabs (`Board Feed` | `Roster (<N>)` | `Activity Graph`)**:
    1. **`Board Feed`**:
       - Channel filter pills at the top (`#main`, plus any area `#channels` created via `swarm{action:"channel"}`).
       - Chronological list of board posts (`#1`, `#2`, ...). Each post card (`var(--card-radius)`) shows the sequence badge `#seq`, author pill (`@coordinator`, `@parser`), timestamp, and formatted message body where `@mentions` (`@verifier`, `@all`, `@#parser`) and sequence references (`#4`) render as interactive pills. Clicking `#4` scrolls to post `#4`; clicking `@worker` opens that worker's stream.
    2. **`Roster`**:
       - Grid/list of worker cards (`var(--card-radius)`). Each card shows:
         - Member name (`@parser`), role summary from its `brief`, and assigned **Model Badge** (`Flash`, `Grok-Mini`, etc.).
         - **State Badge**:
           - `working`: pulsing green dot + current tool activity.
           - `waiting`: calm cyan/muted dot + `Sleeping on board (0 tokens)`.
           - `stopped`: neutral gray dot + `Stopped (wakes on @mention)`.
           - `killed`: red dot + `Killed`.
         - **Workspace Mode Badge**: `inherit`, `share`, or `branch`.
         - **Inspect Stream Action**: Clicking any worker opens its individual live subagent transcript inside `SubagentInspectorView` with a `← Back to Swarm Roster` button.
    3. **`Activity Graph`**:
       - Compact visual flow diagram (`Coordinator` $\rightarrow$ `@worker` $\leftrightarrow$ `@verifier`) showing active `@mention` edges, post counts, and which worker currently holds the baton (or if a `[stall]` was flagged by `@monitor`).
Checks: component tests in `SubagentInspectorView.test.tsx` and `SwarmBoardInspector.test.tsx` verifying live step rendering, model hierarchy badge (`Main -> Subagent`), Task Brief expansion, Swarm Board `#seq` and `@mention` pill rendering, channel filtering, Roster state badges (`waiting`, `working`, `stopped`, `killed`), and worker drill-down navigation.

---

## Tasks

- [x] **T1 — Extend `acp/types.rs`, `turn_pipeline.rs`, `stream_json.rs`, and `subagents.rs` to normalize native subagent and swarm events across all providers.** `S1`. Route: inline. Evidence: `acp::tests::` (5 passed) & `chat::` (205 passed).
  Classify `toolKind: "subagent"` and `"swarm"`, extract `SubagentMeta` and `SwarmMeta` for Antigravity (`invoke_subagent`, `define_subagent`, `send_message`, `manage_subagents`, `swarm`, `post_message`, `read_board`, `swarm_wait`), Claude (`Task` + `parent_tool_use_id` routing), Grok, Codex, Cursor, and OpenCode, and implement JSONL transcript tailing in `src-tauri/src/chat/subagents.rs`.
- [x] **T2 — Persist `parentThreadId`, `subagentRuns`, `swarmState`, and child-thread metadata in `threads.rs` and filter child subagent threads from `ChatRail`.** `S2`. Route: inline. Evidence: `chat_commands::tests::thread_persists_subagent_and_swarm_metadata_and_serves_detail_commands` (1 passed), `chat::` (205 passed), `threadInteraction.test.ts` (35 passed), `useSubagentEvents.test.ts` (1 passed), `tsc --noEmit` (ok).
  Update `THREAD_FIELD_NAMES` and `blank_thread` in `src-tauri/src/chat/threads.rs`, expose `get_thread_subagent_detail` and `get_thread_swarm_state` in `src-tauri/src/chat_commands.rs`, and filter `startedByAgent && parentThreadId` threads out of `sidebarThreads` in `src/components/views/chat/threadInteraction.ts`.
- [x] **T3 — Build `SubagentActivityCard.tsx` and `SwarmActivityCard.tsx` in the main chat timeline and exempt them from post-turn burst folding.** `S3`. Route: inline. Evidence: `SubagentActivityCard.test.tsx` (2 passed), `ChatItemRow.test.tsx` (18 passed), `TurnActivityStatus.test.tsx` (7 passed), `activityPresentation.test.ts` (19 passed), `tsc --noEmit` (ok).
  Render interactive subagent and swarm cards in `ChatItemRow.tsx` / `ChatWorkGroup` with role, model pill, workspace pill, live ripple dot + timer, 1-line live tool preview with `.live-tool-shine`, exemption from folding in `transcriptGrouping.ts`, and `kite:open-right-dock-subagent` dispatch on click.
- [x] **T4 — Register the `'subagents'` tab in `dockConfig.tsx`, `RightDock.tsx`, and `useAppGlobalEvents.ts` with `kite:open-right-dock-subagent` and `Ctrl+Alt+S`.** `S4`. Route: inline. Evidence: `dockConfig.test.ts` (2 passed), `useAppGlobalEvents.test.ts` (5 passed), `RightDock.test.tsx` (10 passed), `useSubagentEvents.test.ts` (1 passed), `tsc --noEmit` (ok).
  Wire `RightDockTabKind`, `TAB_CONFIGS`, `STANDARD_MENU_TABS`, automatic `setRightDockVisible(true)` on subagent/diff dock events, active running count badge, and responsive split layout.
- [x] **T5 — Build `SubagentInspectorView.tsx`, `SwarmBoardInspector.tsx`, and `subagents.css` inside `RightDock`.** `S5`. Route: inline. Evidence: `SubagentInspectorView.test.tsx` (3 passed), `SwarmBoardInspector.test.tsx` (2 passed), `chat`+`subagents`+`RightDock`+`dock`+`useAppGlobalEvents` Vitest (39 files / 272 passed), `acp::` (6 passed), `chat::` (207 passed), `chat_commands::tests::` (8 passed), `tsc --noEmit` (0 errors), `audit-references.mjs --check` (clean).
  Implement the subagent selector, `Main -> Subagent` model hierarchy badge, collapsible `TaskBriefCard`, live auto-scrolling subagent step stream, and the 3-view `SwarmBoardInspector` (`Board Feed` with `#channels` & `@mentions`, `Roster` with worker drill-down, and `Activity Graph`).
- [ ] **T6 — Harden subagent CLI normalization in `acp/types.rs`, `turn_pipeline.rs`, and `subagents.rs` to strip shell redirections (`2>&1`), eliminate `"run command"` role fallback, and propagate failed CLI exit codes/receipts as `"failed"`.** `S1`. Route: inline (`src-tauri/src/acp/types.rs`, `src-tauri/src/chat/turn_pipeline.rs`, `src-tauri/src/chat/runtime/stream_json.rs`, `src-tauri/src/chat/subagents.rs`).
  Ensure shell invocation failures never produce false `"completed"` subagent cards, remove `"2>&1"` / pipeline tokens from extracted prompts, and fall back to `"Subagent"` or the target provider rather than `"run command"`.
- [ ] **T7 — Redesign `SubagentActivityCard`, `SwarmActivityCard`, multi-subagent disclosure grouping, and `RightDock` inspector visuals for minimalist workbench clarity under `AGENTS.md` tokens.** `S3`, `S5`. Route: inline (`src/components/views/chat/SubagentActivityCard.tsx`, `SwarmActivityCard.tsx`, `ChatItemRow.tsx`, `chat.css`, `src/components/views/subagents/`).
  Adopt single-line hairline workbench rows with accurate interactive states (clickable only when backed by a child thread, transcript URI, or captured steps), expandable multi-subagent disclosure groups (`Started N subagents`), and clean header/error hierarchy in `RightDock`.

---

## Verification

- `cargo test chat::`
- `npx vitest run src/components/views/chat src/components/views/subagents src/components/RightDock`
- `npx tsc --noEmit`
- `node .kite/sanitizer/audit-references.mjs --check`

---

## Log

- **L1. 2026-11-12.** User words: "Mira, creo que es de los próximos tópicos que podemos tomar de la parte de thread Sería la muestra de subagentes, o la ejecución de estos mismos. Así también Swarm... Básicamente te muestran la ejecución de los subagentes. En el chat principal y bueno, si uno les da clic, se abre la zona como en una sidebar... También sé que Antigravity implementa como una función de swarm. Y donde se tiene como un modelo pesado en la conversación main. Y modelos livianos en las conversaciones, eh, más livianas, claramente, de subagentes." / "Podemos primero partir dando soporte nativo a los subagentes de estas a, de estos proveedores. Como Grok, que, claro, tiene subagentes. Antigravity también tiene subagentes en su CLI... Bueno, en esa misma zona lateral, en nuestra sidebar, por así decirlo. Ahí podríamos incluir esta inspección para el subagente... Claro, tendríamos que crear esta nueva parte de visualización de subagentes. Con las animaciones correspondientes, vista correspondiente, que quede todo bien responsivo." / "Mira, creo que arma ese lo de D, pero que quiero que sea muy muy específico, por ende, si que se llegan a realizar muchas tareas. Puedes llegar a crear dos. ODDs distintos. Eh, con tal de que los subagentes que realmente lo hagan. Puedan llegar a entender qué tanto se espera. Por ende. Yo creo que solamente hagas los oDD. Y esperes, luego ya comenzaré a ejecutarlos con otro." Created `odd/tasks/thread-subagent-surface-and-dock.md` (ODD 1 of 2) specifying native subagent & swarm stream normalization, durable thread metadata, interactive timeline cards, and the `RightDock` Subagent & Swarm Inspector.
- **L2. 2026-11-12.** Executed and verified T1-T5 of ODD 1 (`acp::` 6 passed, `chat::` 207 passed, `chat_commands::tests::` 8 passed, Vitest 39 files / 272 passed, `tsc --noEmit` 0 errors, `audit-references.mjs --check` clean). Also wired `AgentChatShell.tsx` to match `SingleThreadPane.tsx` for subagent/swarm card rendering and live stage telemetry.
- **L3. 2026-11-12.** User words: "También para la parte de subagentes donde se muestran, no le gustan mucho. Quiero decir, se pueden mejorar bastante, hacer un poco más profesional. Puedes basarte en anti-gravity, utilizar REA para ver cómo lo hacen ellos. La parte de mostrarlo." / "Okay, mira, exacto, tenemos que llegar a modificar todas estas cosas, pero no sé si realmente valga la pena crear un nuevo ODD, sino que modificar los que ya creamos, con respecto a esto. Entonces, la cosa sería configurar esos o sea, configurar correctamente la skill, hacer las correcciones pertinentes para todo el instruccionamiento, vista y demás. Quiero que vayas con todo eso como tal. Pero claro, quiero que modifiques también el ODD. E implementes de una, no me consultes nuevamente." Updated `S1`, `S3`, and `S5`, and added `T6`–`T7` covering shell redirection/role/failed-status normalization and the minimalist workbench redesign of `SubagentActivityCard`, `SwarmActivityCard`, multi-subagent grouping, and `RightDock` inspector header/failure presentation.
