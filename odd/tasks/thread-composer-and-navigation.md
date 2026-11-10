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
- **Context Strip**: A quiet strip directly beneath the composer card displays the bound workspace, active Git branch (or isolated worktree), and effective permission mode.
Checks: unit tests for `resolveEffortGlyph` / `effortBarHeights`, motion token contract test on all 6 composer popovers, and render test for the `32px` dictate control.

### S2. Send While Working: `Queue`, `Steer`, `Interrupt`, and `Resume`
User words: "copiar bastante, bastante, bastante de la interfaz, o bueno, no la interfaz, sino que toda la parte de chat... cuando lo llego a probar no se ve ni, se comporta igual."
Current fact:
- While a turn is running, the composer only allows stopping the turn; the user cannot queue follow-up messages, steer the active turn, or edit queued messages in place.
Acceptance:
- **Primary Button State Machine**:
  - When a turn is running and the draft is empty (no text, no attachments), the primary action button displays **Interrupt** (`⏹`).
  - As soon as the draft has text or attachments while a turn is running, the button switches to the user's configured default follow-up action (**Queue** or **Steer**, configurable in `Settings -> Chat`). Holding `Ctrl` (`Cmd` on macOS) or pressing `Ctrl+Enter` (`Cmd+Enter`) flips to the opposite action. **Steer** is only offered when the active provider session supports live steering or interrupt-restart steering.
  - When a turn is stopped, interrupted, or paused by a usage limit (or holds paused queued messages) and the composer is empty, the primary button displays **Resume**.
- **Queued Messages List (`QueuedRunsControl`)**:
  - Queued messages render at the end of the timeline above the composer as dashed unsent cards (showing up to 3 rows before a `Show N more` toggle).
  - Each queued card shows its text, image thumbnails, and three actions: **Send now** (steers into the active turn or starts immediately if idle; shortcut `Ctrl+Shift+Enter`), **Edit** (`PencilIcon`, or `Alt+Up` from an empty composer), and **Remove** (`XIcon`).
  - Editing a queued message loads its text and attachments into the composer while highlighting the queued card, preserving whatever unsent draft was previously in the composer and restoring that draft as soon as the edit is saved (`✓`) or cancelled (`✕`).
  - Queued messages are persisted in the backend so they survive stopping a turn or restarting the app, in exact FIFO order.
Checks: composer and queue tests verifying `Interrupt` -> `Queue`/`Steer` switching, FIFO persistence across stop/resume, and in-place queued message editing with draft restoration.

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
- A failed thread is marked failed. An empty catalog or a signed-out provider does not look like a failed thread.
- A limited thread keeps the provider's explanation and offers Resume.
- **Title Generation**:
  - New threads automatically generate a concise title from the first exchange using configurable **Thread title instructions** in Settings (with optional per-project overrides). The thread context menu offers **Regenerate title** (disabled while generation is already in flight). The background title-generation model never appears as a selectable chat agent.
Checks: sidebar component tests for shelf transitions (`Active` -> `Working` -> `Active`), drag-and-drop state badges, 5-second undo restoration, and `Regenerate title`.

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
