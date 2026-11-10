# Thread Timeline Surface, Work Log, Animations, and Artifacts (ODD 2 of 3)

Objective: Match the Thread timeline's visual anatomy, typography, 24px work-log rows, live shimmer animations, post-turn group collapsing, turn changed-files diff card, sandboxed HTML visual replies, and dismissible error/usage-limit banners so every turn looks, animates, and reads as a cohesive desktop conversation.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `ask-on-risk`.
Test runner: `npx vitest run src/components/views/chat src/components/views/agents src/motion`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.
Series: ODD 2 of 3 for the Thread overhaul (paired with ODD 1: `odd/tasks/thread-provider-runtime.md` and ODD 3: `odd/tasks/thread-composer-and-navigation.md`). Supersedes the timeline/presentation specs (`S1`, `S2`, `S7`, `S11`, `S13`, `S15`, `S16`) previously in `odd/tasks/response-thread.md`.

---

## Visual & Layout Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│SingleThreadPane                                                            │
│                                                                            │
│                                      ┌──────────────────────────────────┐  │
│                                      │ User bubble (fit-content, <=80%) │  │
│                                      │ [@file.ts] Fix the parser bug    │  │
│                                      └──────────────────────────────────┘  │
│                                                                            │
│  Working for 14s                                                           │
│  ────────────────────────────────────────────────────────────────────────  │
│  [Eye]        Read src-tauri/src/chat/normalize.rs       120 lines · 4 KB  │
│  [SquarePen]  src-tauri/src/chat/normalize.rs                      +18 -4  │
│  [Terminal]   Running cargo test chat::normalize (live-tool-shine)         │
│  [Brain]      Checking edge cases in tool_call_update merging...           │
│                                                                            │
│  (Once the turn finishes, the burst above collapses into:)                 │
│  ▸ Worked for 18s · Read 1 file, changed 1 file, ran 1 command             │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Optional Sandboxed HTML Visual Reply (HtmlRenderFrame, [Expand ⤢])   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  Assistant Markdown Reply (full column width, clean prose & code blocks)   │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 1 changed file   +18 -4                                  [Open diff] │  │
│  │ ▾ src-tauri/src/chat/                                                │  │
│  │     normalize.rs                                             +18 -4  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ [!] Dismissible Error / Usage-Limit Banner (Resume | Resume at 22:00)│  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Specs

### S1. Right-Aligned User Message Bubble (80% Column Cap)
User words: "La idea sería copiar bastante, bastante, bastante de la interfaz, o bueno, no la interfaz, sino que toda la parte de chat. El cómo se ve, el cómo tiene las animaciones."
Current fact:
- `.chat-user-row--bubble` in `src/components/views/chat.css` caps width at `720px` instead of `80%` of the transcript column, and does not render inline context chips inside the prose.
Acceptance:
- User messages render as a right-aligned compact bubble (`margin-inline-start: auto`, `width: fit-content`, `max-width: 80%`), using `var(--card-radius)` (`rounded-card`, `12px`), `padding: 10px 14px`, and the surface message token.
- Short messages hug their text and never stretch to 80%. Consecutive user bubbles tighten their shared inner corner using semantic tokens (never arbitrary pixel values).
- Messages exceeding 500 characters or 12 visual lines collapse cleanly with a `Mostrar más` / `Mostrar menos` toggle.
- Hovering or focusing a user bubble reveals a subtle top-right action bar (`Copiar`, `Editar desde aquí`).
- Assistant responses never render inside a bubble; they span the transcript column as left-aligned markdown prose.
Checks: component test in `ChatItemRow.test.tsx` asserting right alignment, `fit-content`, `max-w-[80%]`, and long-message folding.

### S2. Live `Working for` Header and Placeholder `Thinking` Row
User words: "por ejemplo, la parte que nosotros mostramos donde, mostramos que dice 'thinking' y tres puntitos, no me gusta cómo aparece."
Current fact:
- `SingleThreadPane.tsx` and `AgentChatShell.tsx` still mount legacy status rows or keep the placeholder visible after activity rows arrive.
Acceptance:
- While a turn is running, a quiet header row sits at the top of the active work block with a subtle bottom border (`border-b border-border/60 pb-2 pt-1`), `24px` height (`h-6`), `tabular-nums`, and muted text reading `Working · 12s`. Past 60 seconds the timer reads minutes, as in `Working · 2m 5s`. When there is no start time it reads `Working…`. When compacting context, it reads `Compacting · <timer>` with a minimize icon. The same caption is used in the thread and in the agent chat shell.
- It never renders three bouncing dots.
- Immediately below that header, a placeholder brain row reading `Thinking` with a text shimmer (`ActivityShimmerOverlay`) appears **only** when:
  1. The turn is actively running,
  2. No tool call, command, or reasoning text item has arrived yet for this turn, and
  3. No tool approval or interactive question is waiting (`pendingApprovals === 0`).
- The instant the first tool call, command, or reasoning item arrives, the placeholder `Thinking` row disappears and the live work rows take its place.
Checks: `TurnActivityStatus.test.tsx` verifying the `Working for` timer format, absence of bouncing dots, and immediate removal of the `Thinking` placeholder when a tool row arrives.

### S3. 24px Work-Log Row Anatomy, Icons, and `live-tool-shine`
User words: "Me gusta bastante cómo manejan como los íconos. Cómo van mostrando las acciones que va haciendo... El cómo se ve, el cómo tiene las animaciones."
Current fact:
- Tool rows in `ChatItemRow.tsx` vary in height and padding, and failed tool rows recolor the entire line or dump raw JSON metadata beneath closed rows.
Acceptance:
- Every work-log row (`ChatWorkEntry`) uses a strict `24px` minimum height (`min-h-6`), `6px` horizontal gap (`gap-1.5`), `14px` font size (`text-sm leading-relaxed`), `var(--control-radius)` (`rounded-md`, `8px`) hover target, and non-selectable label chrome (`select-none`).
- **Icon Slot**: `24px × 24px` (`size-6 shrink-0`) centering a `16px` (`size-4 stroke-2`) muted Lucide glyph (`text-icon-muted`):
  - `Eye` for file read (`Read <relative-path>`)
  - `SquarePen` for file edit/write (`<relative-path>` or `Changed <path>`)
  - `Terminal` for shell command (`Running <program>` while active; `Ran <program>`, `Failed <program>`, `Declined <program>`, or `Stopped <program>` when finished)
  - `Search` for file/code search (`Searched <query>` or `Searched files`)
  - `Globe` for web search/fetch (`Searched the web` or `Fetched <domain>`)
  - `Hammer` for MCP or dynamic tools (`<server>: <tool> <short-arg>`)
  - `Wrench` for generic tools
  - `Bot` for subagent launches/updates
  - `ListTodo` for plan updates
  - `Brain` for reasoning traces
- **Quiet Trailing Meta**: Line/byte counts (`120 lines · 4.2 KB`) or per-file edit stats (`+18 -4`) sit inline at the end of the `24px` row in muted `tabular-nums`, never on a second line below a closed row.
- **Active Shine**: While a tool row's lifecycle status is `inProgress`, its label text plays `.live-tool-shine` (a `2.2s` smooth highlight sweep across the text; disabled under `prefers-reduced-motion`).
- **Muted Failure Indicator**: When a tool call fails, the row text remains muted secondary text; only the leading `16px` icon turns destructive (`text-destructive`) and a `12px` (`size-3`) `XIcon` appears at the trailing edge.
- **Expandable Inspector**: Clicking a tool or command row smoothly toggles its detail body (`max-h-64 overflow-auto font-mono text-xs select-text rounded-control`), showing the full command, arguments, or live tailing output.
Checks: unit and render tests in `ChatItemRow.test.tsx` for all 10 icon mappings, single-line `24px` geometry, `.live-tool-shine` on active rows, and muted failure styling.

### S4. Streaming Reasoning Preview (`line-clamp-4`) and Live-to-Collapsed Burst Transitions
User words: "cuando lo llego a probar no se ve ni, se comporta igual."
Current fact:
- Reasoning rows display `Thought for Ns` on individual rows and either hide streaming thoughts or show an unformatted wall of text.
- Work groups collapse mid-turn (`+N earlier`), hiding actions while the agent is still working.
Acceptance:
- **Reasoning Row**:
  - While reasoning text is streaming and the row is collapsed, it shows the `Brain` icon and the latest thought line, truncated to one line. The status word is `Thinking` only when that line is the whole row. Clicking expands the full markdown reasoning trace (`ReasoningTraceContent`).
  - When a thought item has no text body yet, its label is `Thinking` while active and `Thought` once finished. Individual reasoning rows never say `Thought for Ns`—duration belongs exclusively to the turn summary header.
- **Live Burst vs Settled Fold**:
  - While a turn is running, **every** action in the current burst remains visible as its own `24px` row in chronological order. New rows enter with a subtle `4px` upward reveal (`tweens.reveal`, dropped under `prefers-reduced-motion`).
  - When the turn completes (or when an assistant message closes an intermediate tool burst), consecutive work rows collapse into a single `24px` summary disclosure button:
    - Finished turn: `Worked for <duration>` (e.g., `Worked for 1m 12s`) followed by up to two prioritized action summaries (`Read 4 files, changed 2 files`, `Ran 3 commands`).
    - Interrupted turn: `You stopped after <duration>` (or `You stopped this response` if no duration is recorded).
    - Single standalone tool call: remains a single `24px` row without wrapping it in a redundant group header.
  - Clicking the summary header expands/collapses the full list of `24px` rows.
- **Tool Visibility Modes (`Settings -> Chat`)**:
  - Supports `Show all` (default), `Hide successful` (shows tools while running, keeps only failed ones after completion), `Hide all` (shows only `Thinking` while working), and `Zen` (hides intermediate assistant messages until the final reply). Pending approvals, interactive questions, and errors remain visible in every mode.
Checks: tests in `ChatItemRow.test.tsx` verifying that live turns never fold mid-stream, finished bursts collapse to `Worked for <duration>` / `You stopped after <duration>`, and `Hide all` still renders approvals and errors.

### S5. Turn Changed-Files Summary Card (`ChangedFilesCard`)
User words: "copiar bastante, bastante, bastante de la interfaz, o bueno, no la interfaz, sino que toda la parte de chat. El cómo se ve"
Current fact:
- When a turn modifies multiple files, there is no consolidated diff summary card at the end of the turn.
Acceptance:
- When a turn edits, creates, or deletes one or more workspace files (excluding files brought in untouched by `git pull` / `merge` / `rebase`), a `ChangedFilesCard` renders below the assistant's reply for that turn:
  - Uses `var(--card-radius)` (`rounded-card`, `12px`) and subtle secondary surface styling.
  - Header displays `{N} changed file(s)`, inline `<DiffStatLabel additions={+A} deletions={-D} />` in green/red `tabular-nums`, an expand/collapse folders icon button (`ChevronsUpDown` / `ChevronsDownUp`) when subdirectories exist, and an `Open diff` button (`var(--control-radius)`).
  - Body renders a compact directory tree of the modified files with per-file `+A -D` stats. Clicking any file opens that file's diff in the right diff/files inspector panel.
Checks: component test for `ChangedFilesCard` verifying file count, `+A -D` totals, directory toggle, and `onOpenTurnDiff` callback.

### S6. Created Documents in Files Sidebar and Sandboxed HTML Visual Replies
User words: "Muchos archivos se crean. .mds, artefactos. O tipo de, tipo, cosas visuales... integrar, con nuestra sidebar lateral para inspeccionar archivos."
Current fact:
- Markdown/image work rows open in the Files sidebar on click, but self-contained HTML visual replies (`HtmlRenderFrame`) are not rendered inline above the assistant reply.
Acceptance:
- **Sidebar Preview Routing**: Clicking a work-log row or inline file link for a `.md`, `.html`, `.pdf`, or image file opens it directly in the Files sidebar in rendered view (no line number passed). Clicking a source-code read row toggles its inline snippet in chat; `Ctrl+Click` (`Cmd+Click` on macOS) opens the source file in the sidebar.
- **Sandboxed HTML Visual Replies (`HtmlRenderFrame`)**: When the agent produces a self-contained visual HTML artifact for the turn, it renders in a `rounded-card` container above the written reply using a sandboxed `iframe` (`sandbox="allow-scripts"`, isolated from Tauri IPC and session state), auto-sizing to content height and offering a top-right full-screen expand dialog (`HtmlRenderDialog`). External links inside the frame open in the system browser.
Checks: tests verifying markdown/image sidebar routing on plain click, source-read inline toggle vs Ctrl-click, and sandboxed `iframe` rendering for HTML visual replies.

### S7. Dismissible Thread Error and Usage-Limit Recovery Banners
User words: "cuando lo llego a probar no se ve ni, se comporta igual. Y bueno, tiene bastantes errores."
Current fact:
- Provider failures and CLI errors either appear as red chat items inside the transcript or leak into the assistant bubble.
Acceptance:
- Structured `TurnFailure` events from ODD 1 (`UsageLimit`, `AuthRequired`, `CliUsageError`, `ProcessError`) render in a dedicated dismissible banner above the transcript (`ThreadErrorBanner` / `UsageLimitRecoveryBanner`), never as an assistant message bubble and never docked only above the composer:
  - Uses `var(--card-radius)` (`rounded-card`, `12px`), glass/elevated surface, leading `CircleAlertIcon` (for errors) or `GaugeIcon` (for usage limits), collapsible detail text (`ExpandableText`), and a dismiss button (`XIcon`).
  - For `UsageLimit`: displays the reset time in local timezone (`Resets <time>`) when reported by the provider, and offers `Resume now` and `Resume at reset` (which schedules automatic continuation when the reset timestamp arrives, keeping queued messages intact).
  - For `AuthRequired`: offers a direct action to open Provider Connections / Sign in.
Checks: component tests for `ThreadErrorBanner` and `UsageLimitRecoveryBanner` covering error dismissal, reset countdown display, and `Resume at reset` scheduling.

---

## Tasks

- **T1 — Update user message bubble geometry (`max-w-[80%]`, `fit-content`, folding, hover actions) in `ChatItemRow.tsx` and `chat.css`.** S1.
- **T2 — Implement `WorkingTimelineRow` (`Working for <timer>`) and conditional `Thinking` shimmer placeholder in `TurnActivityStatus.tsx`, `SingleThreadPane.tsx`, and `AgentChatShell.tsx`.** S2.
- **T3 — Standardize `24px` `WorkLogRow` anatomy, 10 Lucide kind icons (`stroke-2`), inline quiet meta, `.live-tool-shine`, and muted failure marks in `ChatItemRow.tsx`.** S3.
- **T4 — Implement `line-clamp-4` streaming reasoning preview, live uncollapsed burst rendering, and `Worked for <duration>` / `You stopped after <duration>` post-turn folding (`groupTranscriptRows`).** S4.
- **T5 — Build `ChangedFilesCard` and `DiffStatLabel` at the bottom of file-modifying turns and wire to the diff/files inspector.** S5.
- **T6 — Build `HtmlRenderFrame` / `HtmlRenderDialog` for sandboxed visual replies and verify `.md`/HTML/PDF/image sidebar preview routing.** S6.
- **T7 — Build `ThreadErrorBanner` and `UsageLimitRecoveryBanner` (`Resume` / `Resume at reset`) above the composer.** S7.

---

## Verification

- `npx vitest run src/components/views/chat src/components/views/agents src/motion`
- `npx tsc --noEmit`
- `node .kite/sanitizer/audit-references.mjs --check`

---

## Log

- **L2. 2026-11-09.** User bubbles use `max-width: 80%` and fold with `Mostrar más`. Work rows keep the 24px target and `.live-tool-shine`. `ChangedFilesCard`, `HtmlRenderFrame`, and `ThreadErrorBanner` mount on the thread surface. `npx tsc --noEmit` passed.
- **L3. 2026-11-09.** Settings → Chat stores `Show all` / `Hide successful` / `Hide all` / `Zen` and the transcript filter keeps failed tools, pending approvals, and errors. `HtmlRenderDialog` expands the sandboxed frame. `npx vitest run` on chat/agents/motion/notifications: 180 passed. `npx tsc --noEmit` passed.
- **L5. 2026-11-10.** Implemented the confirmed caption: `Working · 2m 5s`, `Working…`, and `Compacting ·`. The failure banner renders at the top of the thread body. Reasoning preview clamps to one line. `npx vitest run` on activityPresentation, catalogEmptyState, and TurnActivityStatus: 22 passed.
- **L4. 2026-11-10.** User words: "la idea es qeu revisemos detalaldamente los 3, corregir e implementar en su totalidad cada uno". The live caption is `Working · 2m 5s`, or `Working…` when there is no start. Reasoning preview is one truncated line, not four. The failure banner sits above the transcript.
- **L1. 2026-11-09.** Created `odd/tasks/thread-timeline-surface.md` (ODD 2 of 3) to specify the complete visual anatomy, `24px` work-log rows, `live-tool-shine` and reveal animations, reasoning preview, post-turn group collapsing, `ChangedFilesCard`, sandboxed `HtmlRenderFrame`, and `ThreadErrorBanner` / `UsageLimitRecoveryBanner`.
- **L6. 2026-11-10.** Fixed `assistantRef` mutable ref in `ChatItemRow.tsx`. Verified timeline surface suite across `ChatItemRow`, `TurnActivityStatus`, `ChangedFilesCard`, `ThreadErrorBanner`, and `activityPresentation`. `npx vitest run src/components/views/chat` (213 passed). `npx tsc --noEmit` clean. T1–T7 verified complete.
