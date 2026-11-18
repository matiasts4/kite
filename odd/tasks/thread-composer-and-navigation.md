# Thread Composer, Context Chips, Live Queue, and Sidebar Navigation (ODD 3 of 3)

Objective: Deliver the complete Thread interaction layer: snappy directional composer menus with rising-bar effort glyphs, live turn controls (`Queue`, `Steer`, `Interrupt`, `Resume`), interactive agent question panels, inline context chips (`@` files/threads/models, assistant citations with comments, terminal excerpts), `/clear` / `/compact` / `/goal` slash commands, checkpoint-backed `Edit from here`, `Ctrl+S` prompt stashing, side chat (`/side`), and the structured Thread sidebar (`Pinned`, `Active`, `Working`, `Snoozed`, `Settled`).
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `ask-on-risk`.
Test runner: `npx vitest run src/components/views/chat src/components/views/agents src/motion`, `cargo test chat::`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.
Series: ODD 3 of 3 for the Thread overhaul (paired with ODD 1: `odd/tasks/thread-provider-runtime.md` and ODD 2: `odd/tasks/thread-timeline-surface.md`). Supersedes the composer, interaction, and sidebar specs (`S4`, `S5`, `S6`, `S14`, `S17`–`S25`, `S27`, `S28`, `S31`, `S32`) previously in `odd/tasks/response-thread.md`.

---

## Composer & Interaction Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ [Optional Docked Panel above Composer]                                     │
│  ├─ ComposerPendingUserInputPanel (1-9 shortcuts, multi-select, attach)    │
│  ├─ ComposerPendingApprovalActions (Allow once | Allow session | Deny)     │
│  └─ QueuedRunsControl (Dashed unsent rows: [Send now] [Edit ✎] [Remove ×]) │
├────────────────────────────────────────────────────────────────────────────┤
│ Composer Card (`rounded-card` 12px, glass surface)                         │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Rich/Markdown Draft + Inline Chips:                                  │  │
│  │  [❝ Cited passage · comment] [@src/main.rs] [@Thread: Auth] [$skill] │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Footer Row (`32px` controls, `rounded-control` 8px, `80ms` popovers) │  │
│  │ [+] [Model ▾] [▃▅▇ Effort ▾] [Mode ▾]       [🎙 32px] [Send/Steer/⏹] │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────────────────────┤
│ Bare Context Strip (below card)                                            │
│  📁 workspace-name  ·  ⎇ feat/branch (or Isolated Worktree)  ·  🛡 Full     │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Specs

### S1. Composer Surface, `80ms` Directional Menus, `EffortGlyph`, and `32px` Dictate Control
User words: "la velocidad o anim, de la animación con la que se, aparecen cada uno de los componentes de la parte de atrás, por ejemplo para seleccionar el modelo, para seleccionar el nivel de pensamiento... hacerlo un poco más rápido? mejorar la animación desde donde sale. Y creo que el micrófono en esa parte se ve un poco distinto."
Current fact:
- Composer popovers use a unanchored `0.12s` scale fade (`kiteFadeIn`), the effort trigger shows only text instead of rising bars, and the dictate button's idle/recording/transcribing icons do not share a single optical `32px` box.
Acceptance:
- **Composer Motion Token**: `src/motion/standard/tokens.ts` defines a dedicated `composerMenu` transition: `80ms` enter duration, `cubic-bezier(0.32, 0.72, 0, 1)` easing, and a `4px` vertical drift from the anchor side (`data-origin="bottom"` enters upward from `translateY(4px)` to `0`; `data-origin="top"` enters downward from `translateY(-4px)` to `0`), with no center-scale transform. Exit uses a fast dismiss tween (`50ms`). `prefers-reduced-motion` removes the `4px` translation.
- **Rising-Bar `EffortGlyph`**: The thinking-effort trigger renders an inline SVG of whole-pixel rising `2px`-wide bars (`4px` pitch, `14px` height, `2px` baseline inset) with one bar per ordinary level advertised by the active model, filled (`opacity: 1`) up to the current selection and muted (`opacity: 0.4`) above it. Named levels (`max`, `ultra`) display their label alongside the filled scale. If a model advertises fewer than 2 levels, the control is disabled with `{model} does not advertise reasoning effort levels.`
- **Optical `32px` Dictate Control**: Idle (`MicIcon`), recording (`StopIcon`), and transcribing (`Spinner`) share one `32px × 32px` (`size-8 rounded-control`) hit target aligned with the attach button, with the microphone stem and arc optically centered inside the `24×24` viewBox at matching `stroke-2` weight and no circular background in the idle state.
- **Context Strip**: A quiet recessed strip (`ComposerContextStrip`) directly beneath the composer card displays the bound workspace/folder selector and active Git branch selector while the conversation is still an unstarted draft (no timeline/thread messages and not running). Once the conversation starts (either a turn begins running or any conversation item exists), the strip closes any open workspace/branch popovers and animates out smoothly (collapsing height and fading upward without layout jump, honoring reduced motion), and stays hidden when opening or resuming an already-started conversation without mounting flicker.
Checks: unit tests for `resolveEffortGlyph` / `effortBarHeights`, motion token contract test on all 6 composer popovers, render test for the `32px` dictate control, and behavioral tests verifying `ComposerContextStrip` is visible on unstarted drafts and hidden/dismissed once the conversation starts.

### S2. Send While Working: `Queue`, `Steer`, `Interrupt`, and `Resume`
User words: "copiar bastante, bastante, bastante de la interfaz, o bueno, no la interfaz, sino que toda la parte de chat... cuando lo llego a probar no se ve ni, se comporta igual." / "cuando envío un nuevo mensaje a la conversación. Mientras está trabajando, no consideramos eso y quiero decir que lo formateamos muy mal, queda muy desordenado. Habría que formatearlo correctamente, mostrarlo donde corresponde. Em, en caso de que haya mandado el mensaje, que no se pierda. ¿A qué me refiero con esto? Me pasó que recientemente había una gente trabajando, le mandé un mensaje, cambié a otra conversación, volví donde ya había mandado el mensaje y se perdió ese mensaje. Quiero decir, no aparecía. Tenemos que seguir un patrón como de anti-gravity, donde el mensaje queda en cola. O bueno, incluso..."
Current fact:
- While a turn is running in `AgentChatShell.tsx`, `onQueue` and `QueuedRunsControl` are not wired at all, so sending a message while an agent is working calls `onSend()` and is silently dropped by `useChatTurnActions.ts` (`isRunning[threadId]`).
- In `SingleThreadPane.tsx`, `queuedRuns` is stored only in component-local React state (`useState`) and written via an un-awaited `update_chat_configuration` call without updating `threadsMap` or `localStorage`, so switching to another conversation and returning loses the queued messages.
- `QueuedRunsControl.tsx` and `chat-core.css` render unstyled raw HTML buttons, hardcode `expanded={false}` and `onToggle={() => undefined}`, drop attachments, and place the queue above `ChangedFilesCard` instead of directly docking above `ChatComposer`.
- Neither `settle.rs` nor the frontend session loop automatically pops and dispatches the next queued message in FIFO order when the active turn finishes, and `onSendNow` only copies text into the composer instead of sending or steering.
Acceptance:
- **Primary Button State Machine**:
  - When a turn is running and the draft is empty (no text, no attachments), the primary action button displays **Interrupt** (`⏹`).
  - As soon as the draft has text or attachments while a turn is running, the button switches to the user's configured default follow-up action (**Queue** or **Steer**, configurable in `Settings -> Chat`). Holding `Ctrl` (`Cmd` on macOS) or pressing `Ctrl+Enter` (`Cmd+Enter`) flips to the opposite action. **Steer** is only offered when the active provider session supports live steering or interrupt-restart steering.
  - When a turn is stopped, interrupted, or paused by a usage limit (or holds paused queued messages) and the composer is empty, the primary button displays **Resume**.
- **Full Composer Actions While Working**:
  - While a turn is running in either Thread mode or Agent Chat mode, the composer remains fully interactive for follow-ups: the placeholder prompts for a follow-up (`Write a follow-up while your agent works…`), clipboard paste (`onComposerPaste` — images, files, mentions, citations, and `>=32 KiB` text-as-file), drag-and-drop (`getDropKind`, `handleDrop`, `onDragOver`), the `+` attach menu (`AttachMenuPopover`), one-shot dictation (`ComposerDictationButton`), Voice Mode launch (opening a fresh voice thread when busy), and next-turn configuration controls (`Model`, `Effort`, `WorkMode`, `Permission`, `Connection` in `ComposerConfigControls`) all remain enabled (subject only to driver capability declarations). Updating configuration while a turn is streaming merges only config fields into live thread state without overwriting streamed transcript items or running status.
  - **Queue & Steer Reliability**: `SingleThreadPane` and `AgentChatShell` delegate queued rows directly to `onQueuePrompt` without fabricating duplicate mismatched local IDs; `ComposerPrimaryActionButton` disables `queue`/`steer` when `!canSend` (e.g. over `120,000` chars) and supports interrupt-restart **Steer** across all providers; `ThreadGrid` and `ChatView` compute `running` consistently (`isRunning[tid] || thread.status === 'running'`); and `handleSteerPrompt` / `handleSendNowQueuedRun` reset synchronous `isRunningRef` state and persist popped `queuedRuns` before calling `handleSendPrompt` so steering or clicking **Send now** never silently drops the message or resurrects a popped queued item.
- **Queued Messages List (`QueuedRunsControl`)**:
  - Queued messages render directly above `ChatComposer` in both `SingleThreadPane` (Thread mode) and `AgentChatShell` (Agent Chat mode) as structured, styled queued cards (showing up to 3 rows before a functional `Show N more` / `Show less` toggle) with a `Queued` order badge, clean typography, attachment chips / image thumbnails, and `26px` `rounded-control` action buttons.
  - Each queued card shows its text, image thumbnails / attachment pills, and three actions: **Send now** (interrupts/steers into the active turn when running, or dispatches immediately when idle), **Edit** (`PencilIcon`, or `Alt+Up` from an empty composer), and **Remove** (`CloseIcon`, releasing any staged attachments owned only by that queued row).
  - Editing a queued message loads its text and attachments into the composer while highlighting the queued card (`queued-runs__card--editing`), preserving whatever unsent draft was previously in the composer and restoring that draft as soon as the edit is saved (`✓` or `Enter`) or cancelled (`✕` or `Escape`).
  - Queued messages (including both `text` and `attachments`, even for attachment-only messages) are updated synchronously in `threadsMap`, `knownThreadsList`, and `localStorage` as well as persisted in the backend (`configure_thread` in `threads.rs`) in exact FIFO order so switching between threads or agents, stopping a turn, or restarting the app never loses a queued message.
  - When an active turn completes normally (transitions from `running` to `idle` without a pending approval, pending user question, turn failure, or manual stop), the session automatically pops the first item in `queuedRuns` (FIFO) and dispatches it as the next turn.
Checks: composer, queue, and session tests verifying `Interrupt` -> `Queue`/`Steer` switching, FIFO persistence across thread switches and stop/resume, automatic FIFO dispatch on turn completion, `AgentChatShell` queue parity, and in-place queued message editing with draft restoration.

### S3. Interactive Agent Questions Docked on the Composer (`ComposerPendingUserInputPanel`)
User words: "todo queda a medias, cuando lo llego a probar no se ve ni, se comporta igual."
Current fact:
- When an agent asks a structured clarifying question (`UserInputRequested`), there is no interactive question card on the composer to answer it with options, custom text, or files.
Acceptance:
- When a thread has a pending `UserInputRequested` event (from ODD 1 `S5`), `ComposerPendingUserInputPanel` docks directly above the composer card:
  - Displays question progress (`1 of N`) when multiple questions are asked in one batch.
  - Single-select questions support clicking an option or pressing number keys `1`–`9` (when focus is not inside a text input), auto-advancing after `200ms`.
  - Multi-select questions render checkboxes (`--vl-radius-xs`, `4px`) and an explicit **Continue / Submit** button.
  - Questions that allow custom answers provide a text input and an **Attach files** control (supporting up to 100 files across the answer set with the standard composer size limits). Choice-only questions do not show the attach control.
  - Submitting sends the structured answer over the session's live RPC channel (or as a continuation turn for async notification questions) and leaves a compact answered-question row in the timeline.
Checks: component tests for `ComposerPendingUserInputPanel` verifying `1`–`9` keyboard selection, multi-select checkboxes, custom answer with attachments, and choice-only attachment hiding.

### S4. Inline Context Chips: Assistant Citations, `@` Mentions, and Terminal Excerpts
User words: "No te limites solamente a las correcciones que yo dije. También investiga otros puntos de mejora que podamos copiar también."
Current fact:
- Selecting text in an assistant message and clicking `Citar en el compositor` dumps plain markdown (`> passage`) into the textarea instead of an inline chip with comment support and source navigation.
Acceptance:
- **Assistant Citation Chips**:
  - Selecting text inside a finished assistant response shows a floating action pill: `Citar en el compositor`.
  - Activating it inserts an atomic inline `AssistantCitationChip` at the caret (`rounded-sm`, `6px`). The chip displays a short preview of the quote, or the user's comment if they click the chip's pencil button to add a note.
  - Clicking the chip in the draft or in a sent user bubble scrolls the timeline back to and highlights the source passage (if the source message was rewound or deleted, the saved quote remains readable in a popover).
- **`@` Context Mentions & Drag-and-Drop**:
  - Typing `@` opens a filterable menu of workspace files, other threads (`@thread-title`), and model names (`@model`). Dragging a file from the file tree or a thread from the sidebar into the composer also inserts its chip at the caret.
  - Attaching another thread inserts a lightweight reference chip (`ThreadId`); the agent reads that thread's transcript on demand without mutating or sending a message to the referenced thread.
- **Code Terminal Excerpt Chips**:
  - Selecting lines in a Code-mode terminal and choosing `Send to Thread` inserts a `TerminalContextInlineChip` (`Terminal 1 · lines 12–28`) at the caret.
- **Chip Editing & Clipboard Contract**:
  - The user can type before and after any chip, move it with cut/paste, and delete it with a single Backspace/Delete keystroke.
  - Copying draft text into another Kite composer preserves the rich chips; copying out to an external application serializes clean Markdown links/quotes in place of each chip.
- The quote and the comment are sent with the prompt, as the words that were quoted and the comment the user wrote. They count toward the message limit. They do not create a second hidden channel.
Checks: composer tests for citation chip insertion + comment editing, `@` thread reference chip (verifying zero mutation on the referenced thread), terminal excerpt chip, and clipboard Markdown serialization.

### S5. Large Paste as File (`32 KiB`), Prompt Stash (`Ctrl+S`), and Prompt Recall (`ArrowUp`)
User words: the large-paste, stash, and recall behavior is part of the confirmed thread cut. The verbatim request that names an external product lives in `.kite/tasks/thread-series-reference.md`.
Current fact:
- Pasting huge logs floods the textarea, there is no prompt stash (`Ctrl+S`), and `ArrowUp` history does not guard wrapped visual lines or existing attachments.
Acceptance:
- **Large Paste & Message Limits**:
  - Draft messages are capped at `120,000` characters (longer drafts stay editable in the composer with a length indicator and disable send until shortened).
  - Pasting `32 KiB` or more of text—or a smaller paste that would push the draft over `120,000` characters—automatically converts the pasted text into a staged `.txt` file attachment chip (`pasted-text`). Pressing `Ctrl+Shift+V` (`Cmd+Shift+V` on macOS) bypasses conversion and pastes the raw text inline.
  - A message accepts up to `100` attached files: images up to `10 MiB` each (`80 MiB` total per message) and other files up to `50 MiB` each.
- **Prompt Stash (`Ctrl+S` / `Cmd+S`)**:
  - Pressing `Ctrl+S` (`Cmd+S` on macOS) in a non-empty composer saves the current draft (text, inline chips, and staged attachments) into the prompt stash and clears the composer.
  - Pressing `Ctrl+S` in an empty composer immediately restores the stashed prompt when there is only one, or opens `ComposerStashMenu` when multiple stashes exist. Uploaded stash files remain valid for 24 hours.
- **Sent Prompt Recall (`ArrowUp` / `ArrowDown`)**:
  - Pressing `ArrowUp` in an empty composer (no text, no attachments, no chips) recalls the last sent user prompt in the current thread; pressing `ArrowUp` again walks older prompts, and `ArrowDown` walks forward until clearing past the newest prompt. Attachments from the original message are not restored. A composer that already holds an attachment does not count as empty.
- A stash that holds uploaded files restores only in the environment that uploaded them. Those files are kept for 24 hours. After that, restore offers Attach again.
  - While an unedited recalled prompt is active, `ArrowUp` on the first visual line and `ArrowDown` on the last visual line continue walking history; editing the text turns it into a normal draft where arrow keys move the caret normally.
Checks: unit tests for `32 KiB` paste-to-file conversion, `120,000` character send guard, `Ctrl+S` stash round-trip, and `ArrowUp`/`ArrowDown` recall state machine.

### S6. Slash Commands (`/`), Skills (`$`), `/compact`, `/clear`, and `/goal`
User words: "copiar bastante, bastante, bastante de la interfaz, o bueno, no la interfaz, sino que toda la parte de chat... Y también el funcionamiento por detrás"
Current fact:
- Typing `/` or `$` does not open a unified command and provider-skill menu with `/compact`, `/clear` session boundaries, or `/goal` autonomous loops.
Acceptance:
- **Slash & Skill Menus**:
  - Typing `/` opens `ComposerCommandMenu` (`80ms` upward motion, `rounded-card`) listing built-in thread commands (`/clear`, `/compact`, `/model`, `/goal`, `/side`, `/btw`) and enabled skills for the active provider.
  - Typing `$` opens the skill picker filtered to skills installed/enabled for the selected provider.
- **`/compact` and `/clear`**:
  - Sending `/compact` in an existing conversation triggers context compaction on providers that support it (displaying `Compacting for <timer>` in the timeline header) and is refused with an inline notice when unsupported.
  - Picking or sending `/clear` arms a `New session` boundary banner above the composer (dismissible before send). The next sent message starts a fresh provider session (`freshContext = true`) that does not see prior context, while keeping all earlier messages and diffs visible in the thread above a `New session` divider row.
- **Autonomous `/goal` Loop (Codex & Claude)**:
  - On Codex and Claude, sending `/goal <done condition>` starts a multi-turn goal loop that continues across turns until the agent verifies the goal is met. A `Goal` status pill and progress line render above the composer.
  - Supports `/goal` (view current), `/goal clear` (remove), and on Codex `/goal pause` and `/goal resume`. On providers without native goal support (such as Grok), `/goal` is treated as normal message text without inventing a fake loop. Provider commands must start the message. Product commands such as `/model`, and skill mentions, work on any line. After skills or MCP servers change, Restart agent session continues the conversation and starts the agent again with the new setup. Stopping a Codex goal pauses it. Stopping Claude ends the current turn. The goal stays set and is checked again at the end of the next message.
Checks: tests for `/` and `$` menu filtering, `/clear` fresh-session boundary creation, `/compact` capability check, and `/goal` lifecycle on Codex/Claude vs non-goal providers.

### S7. `Edit from here` and Safe Workspace Checkpoint Rewind
User words: "Volver al mensaje y reescribirlo... copiar bastante, bastante, bastante de la interfaz... y el funcionamiento por detrás"
Current fact:
- Clicking edit on a user message only copies text back into the composer without rewinding the conversation or offering workspace file restoration.
Acceptance:
- Before each turn starts in a Git workspace, the backend captures a lightweight hidden Git checkpoint ref (`refs/kite/checkpoints/<thread_id>/<run_id>`) without creating commits on the user's branch.
- Clicking **Editar desde aquí** beneath any sent user message opens a confirmation popover with two explicit actions:
  1. **Revertir y mantener cambios en archivos**: truncates the thread transcript and provider session history to immediately before that message, leaving workspace files untouched.
  2. **Revertir archivos también**: restores the workspace files to the pre-turn checkpoint ref **and** rewinds the conversation. This option is enabled **only** when (a) the provider supports conversation rewind and (b) the thread runs in its own isolated checkout/worktree not shared with any other active thread or agent terminal. If the provider cannot rewind its conversation, file restore is refused before touching disk.
- In both cases, the rewound prompt and its original attachments/chips are placed back into the composer (preserving any unsent draft above them).
Checks: unit and integration tests verifying transcript truncation, checkpoint ref restoration in isolated worktrees, and refusal when a checkout is shared or the provider lacks rewind support.

### S8. Thread Sidebar Shelves (`Pinned`, `Active`, `Working`, `Snoozed`, `Settled`), 5s Undo, and Regenerate Title
User words: "toda la parte de chat. El cómo se ve, el cómo tiene las animaciones. Cómo, también el funcionamiento por detrás"
Current fact:
- The thread list is a flat list without `Working`, `Snoozed`, or `Settled` shelves, drag-and-drop state transitions, 5-second undo toasts, or title regeneration.
Acceptance:
- **Five Structured Shelves**:
  - **Pinned**: stays at the top of the sidebar in user-defined order.
  - **Active**: threads ready for user review or input, ordered by when they last returned to the user (or custom drag order when the `Working` shelf is disabled).
  - **Working** (collapsible): threads currently running a turn or waiting on background work automatically fold into `Working` and jump back to the top of `Active` the instant they finish, fail, or require an approval or question answer. Pinned threads remain in `Pinned`.
  - **Snoozed**: threads parked until a scheduled wake or usage-limit reset time.
  - **Settled**: finished threads moved out of `Active` without deleting history.
- **Drag-and-Drop & 5-Second Undo**:
  - Dragging a thread across shelf boundaries shows an action badge (`Pin`, `Unpin`, `Settle`, `Un-settle`, `Wake`) and animates row insertion gaps smoothly (respecting `prefers-reduced-motion`).
  - Every `Pin`, `Unpin`, `Settle`, `Snooze`, `Archive`, or draft-discard action shows a 5-second toast with **Undo** (also triggered by `Ctrl+Z` / `Cmd+Z`), restoring the exact previous shelf and position.
- The list has search and New thread.
- The sidebar New thread controls — the Threads header **New Thread** action and each workspace **New thread** button — create and focus a thread through the same path as the thread header New thread button. A click opens that thread in the thread pane immediately without requiring multiple clicks or lagging. Reusing an empty draft applies strictly when the currently focused thread in the pane is already a blank draft (zero messages and zero voice turns) in the requested scope, never hijacking historical conversations. Calling `onNewThread` from pane and rail controls does not forward click events into workspace arguments.
- **Explicit Thread–Project Association**:
  - Unassigned threads (`workspaceId: null`) honestly display **No folder** in the thread header, **Local** in the composer strip, and offer **Add a folder** in the blank draft hero—never falsely displaying a Code-mode active workspace fallback in standalone Thread mode.
  - Creating a thread from Sidebar **Threads +** or the empty state creates an unassigned general thread (`workspaceId: null`); creating from a workspace folder's `+` button binds that folder's `workspaceId`; creating from a thread header `+` inherits the current thread's folder scope; and initial mount reconciliation never overwrites an in-flight New thread request.
  - Selecting or adding a folder from the blank draft hero (**Add a folder**), thread header selector, or composer workspace menu immediately assigns `workspaceId` on the thread, updates sidebar grouping, and auto-expands the target folder in `ThreadRoster`. Users can also clear assignment via **No folder**.
- A failed thread is marked failed. An empty catalog or a signed-out provider does not look like a failed thread.
- A limited thread keeps the provider's explanation and offers Resume.
- **Title Generation**:
  - New threads automatically derive a concise, non-placeholder title as soon as the first human prompt (or attachment/voice turn) is submitted—cleaning leading blank lines, inline citation/mention tokens, and markdown prefixes—and refine on first settle without overwriting manual (`"user"`) renames or updating stale chronological timestamps during legacy history healing. Any existing persisted threads still carrying `"New Chat"` placeholders despite human transcript items are healed automatically on load/summary fetch. The thread context menu offers **Regenerate title** (wired end-to-end through `regenerate_chat_thread_title`, disabled while generation is in flight).
Checks: sidebar component tests for shelf transitions (`Active` -> `Working` -> `Active`), drag-and-drop state badges, 5-second undo restoration, folder association & auto-expansion, `useChatSession` mount/assign synchronization, `SingleThreadPane` honest unassigned state, backend title derivation/healing tests, and `Regenerate title`.

### S9. Subagent Parent Approvals, Ephemeral `/side` Chat, Provider Handoff, and Code Terminal Reuse
User words: "Por una parte tenemos la parte de CODE. En la aplicación, la cual funciona perfecto. Terminales. CLI, todo lo demás."
Current fact:
- Subagent approvals/questions do not surface in the parent thread composer, `/side` chat is missing, and switching providers mid-thread lacks a structured context handoff budget.
Acceptance:
- **Subagent Parent Routing**: When a thread delegates work to a subagent, any tool approval or clarifying question from that subagent surfaces directly in the parent thread's composer (`ChildThreadApprovals`) labeled with the subagent's name. Clicking **Interrupt / Stop** on the parent thread also stops all child subagents it spawned.
- **Ephemeral Side Chat (`/side` or `/btw`)**: Sending `/side <question>` or `/btw <question>` opens a lightweight side-chat drawer (`SideChatPane`) alongside the thread, pre-configured with the parent thread's workspace, permissions, model, and effort level, without interrupting the parent thread's running turn. Clicking **Bring back** attaches the side-chat conclusion as a context chip in the parent composer. Deleting the parent thread deletes its side chats.
- **Provider Handoff on Model/Provider Switch**: Switching providers mid-conversation (or resuming when a provider handle expired) transfers a budgeted selection of recent messages, the original task prompt, and key command outcomes—never truncating the new user prompt to fit history, and omitting raw tool-call blobs and reasoning traces.
- A subagent thread started by the agent does not accept a direct message. The person messages the parent.
- Side chats do not appear in the sidebar. Bring back attaches the side chat to the next message in the parent, and only while the parent is idle.
- Handoff does not copy attachments. Codex receives historical messages directly when the installed version supports that. Other providers receive the same selection as attributed context. If the target has no room, the product starts a fresh provider conversation with a bounded selection and sends the request. It does not ask the person to compact first.
- **Code Terminal Reuse & Protected Zones**: Thread never spawns a second terminal runtime; terminal drawers and terminal excerpt chips reuse Kite's existing Code-mode terminal registry. A thread may run in an isolated checkout so its file restore cannot erase another thread's files. That checkout does not replace Code. The TitleBar stadium mode switcher (`Agent | Code | Thread` in `src/components/TitleBar.tsx`) remains untouched.
Checks: tests for parent subagent approval routing, `/side` drawer isolation and `Bring back` chip insertion, provider handoff prompt preservation, and Code terminal ID reuse.

---

### S10. Deferred surfaces stay deferred
Confirmed deferrals. They are not tasks.
- Voice transcription on a chosen host, and a suggested next prompt, stay out.
- A phone app, remote pairing, device simulators, an in-app browser, cookie import, captures of other windows, a third-party secret store, enterprise policy, another product's telemetry, another product's database migration, and a registry of third-party agents stay out.
- Adding one of these later appends a log entry and a new S#. It does not reopen S1 through S9.
Checks: none. This spec is the boundary.

### S11. End-to-End Image and File Attachment Delivery Across Thread and Agent Chat
User words: "Creo que tenemos un problema en la parte de thread Con respecto al pegado o adjuntado de imágenes. basiamente me dicen los agentes que no estan llegando estas imagenes" / "si corrige" / "corrige completamente"
Current fact:
- `stage_blob_attachment` and `stage_dropped_path` (`src-tauri/src/chat_attachments.rs`) write bytes to `chat-attachments/<thread_id>/<resource_id>/<name>`, but `attachment_payload` only stores `{ resourceId, displayName, isDirectory, byteSize }`, `stage_chat_blob` ignores `mimeType`, and `parse_attachments` returns metadata without the disk path.
- `start_turn_with_binding` (`src-tauri/src/chat/runtime/turn.rs`) saves `attachments` onto `user_item["attachments"]` for UI display only and invokes `launch_provider` without forwarding attachments, resolved paths, or MIME types to persistent transports or CLI `spawn_args`.
- Sending an attachment-only message (`prompt == ""`) fails with `SessionError::EmptyPrompt` in `SessionManager::send_turn` and is skipped by `assemble_thread_context`.
- In Agent Chat draft mode (`draftKey = draft-${agentId}`), attachments staged before the first thread exists are left under `draft-${agentId}` when `handleStartThreadFromHome` creates the real `threadId`.
Acceptance:
- **Resolved Disk Path & MIME Metadata**: `stage_blob_attachment`, `stage_dropped_path`, and `parse_attachments` resolve and include `path` (canonical on-disk file or directory path), `mimeType` (from explicit MIME or extension inference, appending an image extension to extensionless clipboard filenames), and `previewDataUrl` (for image attachments up to 2 MiB) on every staged attachment, with disk fallback under `chat-attachments/<thread_id>/<resource_id>/` when the in-memory map was cleared. `attachment_segment` permits ASCII alphanumeric characters, `-`, and `_` so `draft-${agentId}` keys with underscores stage cleanly.
- **Provider Prompt & Transport Forwarding**:
  - `start_turn_with_binding` and `launch_provider` format the provider prompt (`format_prompt_with_attachments`) with an explicit `[Attached files]` block listing each attachment's display name, MIME type, byte size, and exact on-disk `path` so every connected agent (`antigravity`, `claude`, `codex`, `cursor`, `gemini`, `grok`, `opencode`) receives and can read attached images and files on both persistent sessions and one-shot spawns.
  - When `prompt.trim().is_empty()` and `!attachments.is_empty()`, a non-empty fallback prompt is supplied to the provider transport so `SessionManager::send_turn` never fails with `EmptyPrompt`, while `assemble_thread_context` includes historical user turns that carried attachments.
  - OpenCode turns (`opencode_turn_args_with_model` and one-shot `spawn_args` for `"opencode"`) additionally pass `--file <path>` for each existing attached file path on disk.
- **UI Previews & Agent Draft Transfer**:
  - `ComposerAttachments`, `ChatItemRow`, and `QueuedRunsControl` render image thumbnails when `previewDataUrl` is present on an image attachment.
  - Staging or dropping attachments in Agent Chat draft mode (`draft-${agentId}`) transfers those attachments to the newly created thread on `handleStartThreadFromHome` and forwards them in the initial turn.
Checks: Rust unit tests in `chat_attachments` and `chat::runtime` verifying disk path/MIME resolution, `format_prompt_with_attachments`, empty-prompt-with-attachment handling, and OpenCode `--file` forwarding; frontend tests verifying image preview rendering and Agent Chat draft attachment handoff.

## Tasks

- **T1 — Implement `composerMenu` `80ms` directional motion token, `EffortGlyph` rising bars, `ContextStrip`, and optical `32px` dictate icon in `ChatComposer.tsx` and `composer/*.tsx`.** S1.
- **T2 — Build `QueuedRunsControl`, backend FIFO run queue, in-place queued message editing, and `Interrupt` / `Queue` / `Steer` / `Resume` primary action button.** S2.
- **T3 — Build `ComposerPendingUserInputPanel` (digit shortcuts `1`–`9`, multi-select, custom answer + attachments) docked above `ChatComposer`.** S3.
- **T4 — Replace plain-text quote insertion with inline `ContextChip` tokens (`AssistantCitationChip` with comments + source jump, `@` file/thread/model chips, `TerminalContextInlineChip`, and Markdown clipboard serialization).** S4.
- **T5 — Implement `32 KiB` paste-as-file conversion, `120,000` char limit, `Ctrl+S` prompt stash (`useComposerStash` + `ComposerStashMenu`), and `ArrowUp`/`ArrowDown` prompt recall.** S5.
- **T6 — Build `ComposerCommandMenu` (`/` commands and `$` provider skills), `/compact`, `/clear` (`New session` boundary), and `/goal` autonomous loop for Codex and Claude.** S6.
- **T7 — Implement pre-turn Git checkpoint refs (`refs/kite/checkpoints/...`) and `Editar desde aquí` (`Revert and keep changes` vs `Revert files too` in isolated worktrees).** S7.
- **T8 — Upgrade the Thread sidebar with `Pinned`, `Active`, `Working`, `Snoozed`, and `Settled` shelves, drag-and-drop badges, 5-second `Undo`, and `Regenerate title`.** S8.
- **T9 — Wire subagent parent approvals (`ChildThreadApprovals`), ephemeral `/side` chat drawer (`SideChatPane`), budgeted provider handoff, and Code terminal reuse.** S9.
- **T10 — Route the sidebar New thread controls through the thread session create-and-focus path and eliminate multi-click latency.** S8. Route: inline. The Threads header New Thread action, each workspace plus button, and the pane header New thread button open a fresh thread instantly. Empty draft deduplication is scoped strictly to the current active blank thread, click events are sanitized, and selection hold + IPC synchronization prevents re-render rollbacks.
- **T11 — Fix thread-to-project (`workspaceId`) association and immediate/healed thread title generation.** S8. Route: inline. Standalone threads never inherit Code-mode's active workspace fallback, initial-mount `initChatView` cannot clobber newly requested threads, selecting or adding a folder from the hero/header/composer associates `workspaceId` on the thread and auto-expands the target folder in `ThreadRoster`, immediate provisional titles derive on turn start (with cleanup of leading newlines, markdown prefixes, and inline PUA tokens), legacy `"New Chat"` threads heal on load/list, and **Regenerate title** is wired end-to-end.
- **T12 — Deliver end-to-end image and file attachments to providers (`chat_attachments.rs`, `attachments_cmd.rs`, `turn.rs`, `spawn.rs`, `opencode.rs`), empty-prompt attachment turns, image thumbnails, and Agent Chat draft attachment handoff.** S11, S5. Route: inline (shares `useChatSession.ts`, `useChatTurnActions.ts`, `ChatView.tsx`, and `types.ts` with T13; no disjoint writer split). Status: completed (uncommitted on `feat/response-thread`).
- **T13 — Overhaul Send-While-Working queue (`QueuedRunsControl.tsx`, `chat-core.css`, `SingleThreadPane.tsx`, `AgentChatShell.tsx`, `useChatSession.ts`, `threads.rs`): styled docked queue cards with attachments, synchronous `threadsMap` + `localStorage` + backend persistence across conversation switches, in-place edit with draft restoration, `Send now` / `Steer`, and automatic FIFO turn dispatch on settlement.** S2. Route: inline (shares session and composer surfaces with T12). Status: completed (uncommitted on `feat/response-thread`).
- **T14 — Hide `ComposerContextStrip` (folder and branch selectors) with a smooth collapse/fade animation once a conversation starts, across `ChatComposer`, `SingleThreadPane`, and `AgentChatShell`.** S1. Route: inline. Status: completed (uncommitted on `feat/response-thread`). Risk: item 3 (updates shared `ChatComposerProps` / `ChatComposer.tsx` behavior and compact control height/radius in `composer.css` consumed across Thread, Agent, and Code composers; verified via focused Vitest `ChatComposer.test.tsx` 34/34, `SingleThreadPane.test.tsx` 16/16, `composerMenu.test.ts` 4/4, full `npx vitest run` 193/193 files / 1383/1383 tests, `npx tsc --noEmit` 0 errors, `npm run build:vite` 4110 modules, `node .kite/sanitizer/audit-references.mjs --check`, and independent `research` verifier PASS on `S1-T14` plus follow-up `AGENTS.md` §1–§2 alignment).
- [x] **T15 — Unlock all composer/staging/config actions while working, unify Thread follow-up placeholder & `running` detection, fix `handleSteerPrompt` / `handleSendNowQueuedRun` stale `isRunning` drop & duplicate queue IDs, wire `Settings -> Chat` follow-up mode (`Queue` vs `Steer`) and Agent Chat busy Voice Mode thread launch, and allow underscored agent IDs in `chat_attachments.rs` (`ChatComposer.tsx`, `ComposerConfigControls.tsx`, `ComposerDictationButton.tsx`, `ComposerPrimaryActionButton.tsx`, `composerPrimaryAction.ts`, `ChatSettingsTab.tsx`, `SingleThreadPane.tsx`, `AgentChatShell.tsx`, `ThreadGrid.tsx`, `ChatView.tsx`, `useChatSession.ts`, `hooks/useChatTurnActions.ts`, `chat_attachments.rs`).** S2, S11. Route: delegated (parallel writer Unit A; disjoint from Unit B formatting) + inline seam polish. Status: completed (uncommitted on `feat/response-thread`). Risk: item 3, item 4 (updates shared `ChatComposer`, `AgentChatShell`, `useChatSession`, and async cancel-to-send `isRunningRef` / `pendingQueuedRunsRef` / `configUpdateSeqRef` ordering; verified via `ChatComposer.test.tsx` 38/38, `SingleThreadPane.test.tsx` 18/18, `AgentChatShell.test.tsx` 5/5, `useChatTurnActions.test.ts` 8/8, `useChatSession.test.tsx` 12/12, `SettingsModal.test.tsx` 15/15, full `npx vitest run` 193/193 files / 1404/1404 tests, `cargo test` 703/703 tests, `npx tsc --noEmit` 0 errors, `npm run build:vite` 4110 modules, and `node .kite/sanitizer/audit-references.mjs --check`).

---

## Verification

- `npx vitest run src/components/views/chat src/components/views/agents src/motion`
- `cargo test chat::`
- `npx tsc --noEmit`
- `node .kite/sanitizer/audit-references.mjs --check`

---

## Log

- **L3. 2026-11-09.** `queuedRuns` persists through `update_chat_configuration`. `QueuedRunsControl`, `ComposerCommandMenu`, Ctrl+S stash, `SideChatPane`, and the `Editar desde aquí` popover are mounted. File restore stays disabled unless the thread has an isolated checkout. Git checkpoint refs, 5-second undo, atomic citation chips, and parent subagent approvals are not closed.

- **L2. 2026-11-09.** Composer primary action resolves Interrupt, Queue, Steer, and Resume. Ctrl/Cmd flips Queue and Steer. A paste of 32 KiB or a paste that would pass 120,000 characters becomes `pasted-text.txt`. Agent questions dock above the composer and answer through `respond_chat_user_input`. The rail has a Snoozed band when `snoozedUntil` is in the future.
- **L5. 2026-11-10.** Citation tokens land in the composer (`citationChip.ts`). Hidden checkpoint refs are captured in `chat::checkpoints` before launch. Sidebar pin/archive undo is 5 seconds. Child approvals, direct-message refusal, idle side-chat bring-back, and the reported-usage card are mounted. File restore is still refused unless `providerCanRewind` and `isolatedCheckout` are both true. `@` mentions, terminal excerpt chips, regenerate title, and drag-and-drop shelves are still open.
- **L4. 2026-11-10.** User words: "la idea es qeu revisemos detalaldamente los 3, corregir e implementar en su totalidad cada uno". Restored the dropped rules for citations, stash, slash position, goal stop, sidebar search, failed-versus-empty, subagent direct message, side-chat idle bring-back, handoff, and the deferral boundary as S10. The source-product sentence moved to `.kite/tasks/thread-series-reference.md`.
- **L1. 2026-11-09.** Created `odd/tasks/thread-composer-and-navigation.md` (ODD 3 of 3) to specify the complete Thread composer, `80ms` directional menus, `EffortGlyph`, live `Queue`/`Steer`/`Interrupt`/`Resume` controls, `ComposerPendingUserInputPanel`, inline context chips (citations, `@` mentions, terminal excerpts), `32 KiB` paste-to-file, `Ctrl+S` stash, `/` and `$` menus (`/clear`, `/compact`, `/goal`), checkpoint-backed `Edit from here`, structured sidebar shelves (`Pinned`, `Active`, `Working`, `Snoozed`, `Settled`), subagent approvals, `/side` chat, and provider handoff.
- **L6. 2026-11-10.** Fixed `.at(-1)` in `ChatComposer.test.tsx` and `Shelf` typing in `threadInteraction.test.ts`. Verified complete composer, context chips, checkpoint rewind, shelves, and side chat suite (`npx vitest run src/components/views/chat src/components/sidebar`: 213 passed, 0 failed; `cargo test chat::`: 193 passed; `npx tsc --noEmit` clean). T1–T9 verified complete.
- **L7. 2026-11-11.** User words: "para crear un nuevo thread, se tienen varios botones. De new thread, pero solamente uno de ellos me está funcionando. El cual está en la esquina superior derecha. El que, los, los que están en la sidebar izquierda, no? Me están funcionando, para crear un nuevo thread. Entonces verifica la funcionalidad correcta de esos botones." Added the sidebar New thread acceptance on S8 and T10. The header button already focuses the pane; the sidebar buttons were only selecting an existing draft or creating through a separate path that did not focus it. T10 implemented, uncommitted. `npx vitest run src/lib/newThreadRequest.test.ts src/components/sidebar/ThreadRoster.test.tsx`: 13 passed. `npx tsc --noEmit`: exit 0. Live sidebar click was not exercised in the desktop window.
- **L8. 2026-11-11.** User words: "Verifica por qué razón cada uno de los fotones de crearon un nuevo tríad. Me está fallando. Básicamente, los errores tienen que ver con que yo lo aprieto, varias veces, cualquiera. Ya sea, por ejemplo, abrir un nuevo threaden un, proyecto. O abrirlo desde la zona superior. O abrirlo desde la parte. En la esquina derecha. Superior. Bueno, ninguna, me funciona ninguna. Tenemos que llegar a corregir eso. Completamente. Pues bueno, me funciona si es que lo aprieto unas cinco veces seguidas y no se abre al, al tiro, porque sería un nuevo thread, sino que se demora." Diagnosed and fixed the 4 root causes causing all New Thread buttons to fail or require 5 clicks: (1) `handleCreateNewThread` was scanning `knownThreadsList` with `(!t.items || t.title === 'New Chat')`; since summaries do not contain `items`, every existing thread was falsely classified as an empty draft and reloaded instead of creating a new thread; (2) `SingleThreadPane` and `ChatRail` passed the click `MouseEvent` directly to `onNewThread`, causing `targetWorkspaceId` to become a complex event object which broke Tauri IPC serialization; (3) direct calls to `handleCreateNewThread` were not holding selection or dispatching `kite:select-thread`, causing `App.tsx`'s `loadThreads` to revert back to the old thread; (4) sidebar header `+` in `mode === 'chat'` was opening a context menu instead of immediately calling `onNewChat()`. Verified clean compile (`npx tsc --noEmit`), audit references clean, and tests passed (34/34 in `threadInteraction.test.ts`, 13/13 in `newThreadRequest.test.ts` & `ThreadRoster.test.tsx`).
- **L9. 2026-11-17.** User words: "Tenemos varios problemas con respecto a lo que son las tele, o sea, el, la parte de atrás. Uno de estos es, por ejemplo, cuando abro un nuevo thread Y bueno, eh, selecciono la carpeta, por ejemplo, en este caso, kit. Eh, no se coloca automáticamente esa conversación en, en kit. Quiero decir, hay una mala asociación. De los threads a los proyectos los cuales corresponden. Creo que tiene que ver con respecto a desde dónde se le está haciendo clic a la opción de crear un nuevo thread. Quiero decir, si se le hace clic al más que aparece en la carpeta. Quite. Entonces ahí sí se abre dentro de esa conversación. Pero si es que abro un nuevo thread. Y selecciono la carpeta. Eh, no se está asociando o no se está dejando dentro de esa, de ese directorio, básicamente. Otra cosa que puedo evidenciar es, el tema de, los títulos de las conversaciones o threads. Bueno, pasa que simplemente quedan como new chats. Entonces, eso es algo que tenemos que corregir. Para que realmente se asocie a algo. En lugar de simplemente mostrar new chat". Implemented S8/T11 fixes across `SingleThreadPane.tsx`, `SingleThreadHeader.tsx`, `ChatComposer.tsx`, `ComposerContextStrip.tsx`, `useChatSession.ts`, `ChatView.tsx`, `ThreadRoster.tsx`, `useAppSidebarHandlers.ts`, `useAppGlobalEvents.ts`, `AppMainStage.tsx`, `App.tsx`, and Rust `chat::threads` / `runtime::turn` / `runtime::settle` / `chat_commands` (`regenerate_chat_thread_title`).
- **L10. 2026-11-17.** User words: "Creo que tenemos un problema en la parte de thread Con respecto al pegado o adjuntado de imágenes. basiamente me dicen los agentes que no estan llegando estas imagenes" / "si corrige y Otra cosa que quiero corregir de las de threads o de las conversaciones es, básicamente, cuando envío un nuevo mensaje a la conversación. Mientras está trabajando, no consideramos eso y quiero decir que lo formateamos muy mal, queda muy desordenado. Habría que formatearlo correctamente, mostrarlo donde corresponde. Em, en caso de que haya mandado el mensaje, que no se pierda. ¿A qué me refiero con esto? Me pasó que recientemente había una gente trabajando, le mandé un mensaje, cambié a otra conversación, volví donde ya había mandado el mensaje y se perdió ese mensaje. Quiero decir, no aparecía. Tenemos que seguir un patrón como de anti-gravity, donde el mensaje queda en cola. O bueno, incluso..." / "corrige completamente". Added S11, updated S2, and opened T12 and T13 for end-to-end attachment/image delivery and live queue persistence/formatting/auto-dispatch across Thread and Agent Chat.
- **L11. 2026-11-17.** User words: "Eh, que quiero que, quiero que corrijamos cosas puntuales, en este caso de un componente. El de thread, básicamente. Cuando se comienza una conversación aparece el componente completo que incluye la selección de modelo, abajo, la selección de carpeta y luego la rama. A mi parecer deberíamos no mostrar la selección de carpeta ni rama una vez comenzado el chat. Básicamente porque ya no tiene caso, quiero decir. ¿Si has seleccionado eso? ¿Y la conversación no debería poder cambiar entonces? ¿O utiliza espacio eso? Por ende debería desaparecer con una animación bastante buena. Al momento de iniciar la conversación como tal." Updated S1 Context Strip acceptance and opened T14 (`route: inline`).
- **L12. 2026-11-17.** User words: "Tenemos que corregir unas cuantas cosas con respecto al funcionamiento de la parte de atrás, básicamente. Una de las cosas que no me gusta actualmente es que no me deja pegar imágenes ni hacer ciertas cosas mientras se está trabajando, quiero decir mientras estaba trabajando claramente un agente, en ese termi, en ese conversación. Debería poder pegar imágenes, poder hacer todo, escribir, mandar mensajes. Y todo lo que corresponde con las acciones. Por ende, hay que llegar y corregir todo eso." Audited `ChatComposer.tsx`, `ComposerConfigControls.tsx`, `ComposerDictationButton.tsx`, `ComposerPrimaryActionButton.tsx`, `SingleThreadPane.tsx`, `AgentChatShell.tsx`, `ThreadGrid.tsx`, `ChatView.tsx`, `useChatSession.ts`, `useChatTurnActions.ts`, and `chat_attachments.rs`: found `running` guards blocking paste/drop/attach/dictate/voice/config, Thread-mode placeholder still claiming `"Working — send when it's done, or stop it."`, stale `isRunning[threadId]` closure in `handleSendPrompt` dropping Steer/Send-now turns after `handleCancelTurn`, duplicate local `QueuedRunRow` IDs, `ComposerPrimaryActionButton` missing `!canSend` guard on `queue`/`steer` and limiting Steer to 3 providers, `attachment_segment` rejecting `_`, and `handleUpdateConfig` overwriting live streaming items. Updated `S2` and `S11`, and opened `T15` (parallel writer Unit A).
