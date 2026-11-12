# Response thread (Superseded Index — Split into 3 Focused ODDs)

Status: **Split in progress on 2026-11-09.** This file remains the confirmed contract until every former `S#` below is closed in the series. The three files are the implementation cut, not a license to drop a rule that is still only written here.
1. **ODD 1 — Provider runtime**: `odd/tasks/thread-provider-runtime.md` owns former `S2` (normalization), `S3`, `S8`, `S9`, `S10`, `S12`, `S26`, `S29`, `S30`, plus per-thread model and effort persistence.
2. **ODD 2 — Timeline**: `odd/tasks/thread-timeline-surface.md` owns former `S1`, `S2` (row), `S7`, `S11`, `S13` (banner), `S15`, `S16`.
3. **ODD 3 — Composer and navigation**: `odd/tasks/thread-composer-and-navigation.md` owns former `S4`, `S5`, `S6`, `S14`, `S17`–`S25`, `S27`, `S28`, `S31`, `S32`.

Objective: Thread is a durable conversation with one living provider session, a timeline of actions, and the composer and sidebar of that product. Code mode keeps its terminals and CLI. The title-bar mode switcher stays.
Branch: `feat/response-thread`. Cut it from the default branch before the first source commit. Do not commit on `main`.
Delivery strategy: `ask-on-risk`. Forecast is well above 400 authored lines. The chain question is already open; do not commit until it is answered. Test runner: `npx vitest run`, `npx tsc --noEmit`, `cargo test chat::`.
Does not change the completion chime or the title-bar mode switcher.
Totality, confirmed 2026-11-09: the thread product below matches. Deferred: a voice transcription host, a suggested next prompt, a phone app, remote access, device simulators, an in-app browser, cookie import, captures of other windows, a third-party secret store, enterprise policy, another product's telemetry, another product's old database migration, and a registry of third-party agents.

## Specs

### S1. The running turn is a row of actions, not a dots banner
User words: "Me gusta bastante cómo manejan como los íconos. Cómo van mostrando las acciones que va haciendo. por ejemplo, la parte que nosotros mostramos donde, mostramos que dice \"thinking\" y tres puntitos, no me gusta cómo aparece. Tampoco creo que estaba funcionando para agentes como Grok, o distintos."
Current fact:
- `SingleThreadPane.tsx` and `AgentChatShell.tsx` append `chat-working-row` whenever the turn is running or waiting. The label is `Thinking…` unless a tool is running (`Executing …`) or assistant text is already streaming (`Generating response…`). The row is three bouncing dots plus that label.
- A Grok session frame `tool_call`, `tool_call_update`, `plan`, or `agent_thought_chunk` was stored as a `notice`. `ChatItemRow` returns nothing for that kind, so the transcript showed the assistant sentence and `Working ·` with no action rows.
- That banner does not look at a streaming reasoning row, so it stays on screen under a real brain row or a real tool row.
- `ChatWorkEntry` already picks an icon from the tool kind (read, edit, shell, search, MCP). Consecutive tool and command items collapse in `groupTranscriptRows`, and `ChatWorkGroup` shows the latest one until expanded.
Acceptance:
- While a turn is running, a muted caption reads `Working ·` plus a live timer from the turn start, or `Working…` when there is no start time. Past 60 seconds the timer reads minutes, as in `Working · 2m 5s`. The caption sits above the live actions. It does not show three bouncing dots.
- Until the first tool, command, or reasoning row, and only while nothing is waiting for approval, a brain row may sit under that line and read `Thinking`, with a shine and no dots. The moment a tool, command, or reasoning row exists, that placeholder is gone. The item row is the status. A failed latest tool may keep the brain row beside the failure.
- Each action row is one line: a 16px icon and one truncated secondary sentence, at regular weight. Icons: eye for read, square pen for edit, terminal for shell, globe for web, magnifying glass for code search, browser, hammer for a dynamic or MCP tool, wrench for a generic tool, bot for a subagent, list for a plan, brain for reasoning. The same set is used in the thread and in the agent chat shell. A live label may use a slow shine. It does not bounce. A failure keeps a small mark and does not recolor the line.
- A command row reads `Running`, `Ran`, `Failed`, `Declined`, or `Stopped`, followed by the program only. A read reads `Read` plus the path from the tool input, including when the title is only `read file` and the path field is `Path`. An edit reads the path, or `Changed files`. A search reads `Searched` plus the query, or `Searched files` or `Searched the web`. A tool row keeps its name and adds the short argument, such as the query. A count such as `1 lines, 569 bytes` is quiet meta on that same row (`1 line · 569 B`), not a second line. The raw command, diff, and tool output stay closed until the row is opened.
- While the turn is running, every action in the burst stays on screen as its own line. There is no `+N earlier` fold during the turn. When the burst finishes, consecutive actions collapse to the summary. One finished action stays its own row.
- When the burst finishes, consecutive actions of one turn collapse to a summary such as `Read N files`, `Changed N files`, `Ran N commands`, or `Searched N times`, plus `Worked for` and the same clock (`Worked for 2m 5s`). Expanding shows the rows. An interrupted turn reads `You stopped after` plus the duration, or `You stopped this response` when the duration is missing. A new action row fades in. Opening a row reveals its body. Reduced motion drops the transform.
- `Waiting for approval · …` stays a distinct waiting row. It is not labeled `Thinking` or `Working`.
Checks: component tests for the working line, the brain row, the summary, and both surfaces (`SingleThreadPane`, `AgentChatShell`).

### S2. Reasoning text from every connected provider
User words: "tiene bastantes carencias y errores." The same turn as S1 names Grok and the other agents.
Current fact:
- A reasoning item renders in `ChatItemRow` as a brain row. While `streaming` it says `Thinking…`. Afterward it says `Thought for …` when a duration exists, otherwise `Thought`.
- Antigravity `thought` / `reasoning` steps and ACP `thought_delta` / `agent_thought_chunk` become reasoning events in `normalize.rs`. A frame that does not match those shapes becomes an unknown-event notice, so the thread falls back to the S1 banner.
- Empty reasoning items are dropped by `groupTranscriptRows`, so a provider that emits a thought marker without text never becomes a row.
Acceptance:
- While reasoning text is streaming, the row shows the latest thought line. The status word is `Thinking` only when that line is the whole row. The full text opens from that row.
- When the thought finishes, the status word is `Thought`. The row does not say `Thought for …`. The duration belongs to the turn summary in S1 (`Worked for`). The app does not invent a duration.
- Grok, OpenCode, Codex, Claude, Cursor, Gemini, and Antigravity thought frames that carry text become a reasoning item. A frame shape that is still unknown stays a notice and is covered by a test fixture from that provider. It is not silently dropped.
- The S1 banner does not render under this row.
Checks: normalizer fixtures per provider that already has a stream sample, plus a row test for the streaming and finished labels.

### S3. The thinking-level control drives every connected provider
User words: "cuando hay distintos proveedores que tienen como varios modelos. Y cada uno de esos modelos tiene distintos niveles de pensamiento. Entre low, medium, high. Algunos tienen max o ultra. Y bueno. La cosa es que nosotros tenemos un componente para ir variando lo que sería la. La cantidad de pensamiento. Ya sea colocarlo en low, medium o así. Pero realmente eso no se está utilizando para todos. Quiero decir, anti-gravity sí le damos soporte, creo, pero hay que hacerlo para OpenCode, Grok y todo, básicamente."
Current fact:
- `EffortSliderPopover` is the control. It is disabled when `declaration.effort` is empty. The disabled reason is `{model} does not advertise reasoning effort levels.`
- `parse_agy_models` collapses suffixed catalog rows and fills levels for Antigravity. `spawn_args` appends `--effort` for Antigravity and for Grok. OpenCode sends the level as a model variant.
- `drivers.rs` sets `accepts_effort: true` for Antigravity, Grok, and OpenCode. Codex, Claude, Cursor, and Gemini stay false until a flag is observed.
- The Grok arm of `spawn_args` passes `-p`, then the prompt, then `--permission-mode`, the selected model, and `--effort` when a level is chosen. The installed CLI documents `-p, --single <PROMPT>`, so a flag in the prompt slot is rejected before the turn starts.
- Spanish labels cover minimal, low, medium, high, xhigh, and max. They do not cover ultra.
Acceptance:
- The control lists the levels that model actually advertises, in order, including `low`, `medium`, `high`, and whichever of `xhigh`, `max`, and `ultra` that model has. A model with fewer than two levels keeps the control disabled and shows the existing reason. `Automatic` stays without levels.
- Choosing a level is what the next send runs. A change after send does not rewrite the process already running.
- Antigravity keeps `--effort <level>`.
- For a provider that holds a session under S10, the level is set on that session before the message. It is not appended as a fresh one-shot flag.
- Gemini stays one-shot. Its send uses the flag the installed CLI documents. A driver whose CLI still documents no flag stays disabled and the spawn does not gain an invented argument.
- OpenCode, Grok, Codex, Claude, and Cursor keep the observed flag or variant only on the one-shot path, and only when that path is still the send. The driver table records the observed flag and the version that was read.
- Grok sends the selected model together with the level, once its CLI documents the model flag. The prompt is the immediate value of `-p`. The failure `a value is required for '--single <PROMPT>' but none was supplied` means a flag occupied that slot.
- `ultra` has a Spanish label and detail, consistent with the labels already used for the other levels.
Checks: catalog tests for collapsing and for ultra; one spawn test per driver that pins argv; the declaration table test updated to the observed matrix.

### S4. Footer menus open quickly, upward, from the control
User words: "la velocidad o anim, de la animación con la que se, aparecen cada uno de los componentes de la parte de atrás, por ejemplo para seleccionar el modelo, para seleccionar el nivel de pensamiento y todos esos componentes básicamente. Diría que, se muestran muy lentos. No me gusta mucho la animación." And: "hacerlo un poco más rápido? mejorar la animación desde donde sale."
Current fact:
- Model, effort, work mode, permission, attach, and connection menus use `.kite-floating-card`, which plays `kiteFadeIn` for `0.12s`: opacity plus `scale(0.97)` with no origin.
- `getAnchoredPopoverCoords` knows the anchor side. The card does not use it.
- Production motion for popovers is `springs.pop` (`stiffness: 400`, `damping: 29`) in `src/motion/standard/tokens.ts`. These menus do not use it. A spring at that stiffness feels slower than a short upward tween.
Acceptance:
- Each of those menus enters from the footer control: opacity plus a 4px drift toward the control, in `80ms`, with `cubic-bezier(0.32, 0.72, 0, 1)`. No scale-from-center. The first open is not delayed by a height animation of the footer.
- The exit is shorter than the enter and uses the dismiss tween. Reduced motion removes the transform and keeps the state change.
- The duration, easing, and 4px shift live in `src/motion/standard/tokens.ts` as a composer-menu token. The components use that token. They do not invent a second curve.
Checks: a test or assertion that each popover uses the composer-menu token; the motion contract test still passes.

### S5. The dictate control matches the footer, and the microphone glyph fits
User words: "Y creo que el micrófono en esa parte se ve un poco distinto. Tal vez no está correctamente adaptado el contorno del micrófono como tal."
Current fact:
- The dictate button in `ChatComposer.tsx` is a 32px transparent control (`size-8 rounded-control`) with `MicIcon` at 14px. The icon is a 24-unit microphone whose stem runs to the bottom of the viewBox, so the silhouette sits tight against the box and looks heavier than the attach icon beside it.
- Recording swaps in `StopIcon` at 11px. Transcribing swaps in a 13px spinner. The three states do not share one optical box.
Acceptance:
- Idle, recording, and transcribing use one 32px control, `rounded-control`, aligned with the attach control. The control does not grow into a larger touch target, and the idle state does not add a circle behind the glyph.
- The microphone body, arc, and stem are fully inside the icon box, optically centered, at the same stroke width as the attach icon. Nothing clips.
- The recording and transcribing glyphs use that same box and stroke.
Checks: the existing dictation button test, plus a render assertion for the shared class and icon size.

### S6. Cite a passage from an assistant response
User words: "No te limites solamente a las correcciones que yo dije. También investiga otros puntos de mejora que podamos copiar también."
Current fact:
- A finished assistant message has a copy button. There is no way to send a selected passage back into the composer.
Acceptance:
- Selecting text inside one assistant response offers `Citar en el compositor`.
- Activating it inserts a chip at the caret. The chip shows a short quote, or the comment when the user wrote one. The user can type around it. Deleting the chip removes the citation. The rest of the draft stays.
- Selecting the chip in the draft or in a sent message returns to the source passage. If the source is gone, the saved quote stays readable.
- The quote and the comment are sent with the prompt, as the words that were quoted and the comment the user wrote. They count toward the message limit. They do not create a second hidden channel.
Checks: a composer test that the action inserts the chip and leaves surrounding draft text intact.

### S7. A created document opens in the files sidebar
User words: "Muchos archivos se crean. .mds, artefactos. O tipo de, tipo, cosas visuales. Los, en los chats me refiero. Por ejemplo en Antigravity se crean los artefactos. O ese tipo de cosas y bueno. Em, tenemos que poder llegar a integrar, con nuestra sidebar lateral para inspeccionar archivos. Lo que sería la visualización para esos artefactos y demás. Quiero decir, porque ahora mismo em, no lo hacemos así."
Choice: "Al pulsar la fila". The row names the file. A click opens it already rendered in Files. The chat does not fill with the document. The sidebar does not follow the file while it is being written.
Acceptance:
- A work row whose file is markdown, HTML, PDF, or an image opens that file in the existing files sidebar on a plain click. No line number is passed, so markdown stays on the rendered view.
- The chat row does not mount that document as its body.
- A source read stays in the chat. Ctrl-click or meta-click still opens that source file in the sidebar. A command row still opens its output in the chat.
Checks: a row test for the markdown click, and a row test that a source read does not open on a plain click.

### S8. A CLI usage failure is not the answer
User words: "error: a value is required for '--single <PROMPT>' but none was supplied" and "También hay que corregir el error claramente que tenemos de Grok."
Current fact:
- `-p` on that CLI is `--single <PROMPT>`. The prompt now occupies that slot. Permission, model, and effort follow it.
- `read_pipe` still appends stderr to the assistant item. `finish_run` skips the error row when that item is non-empty, so a usage failure can still render as the answer.
Acceptance:
- That sentence is not stored as the assistant answer.
- A non-zero exit whose text is a CLI usage error becomes an error row. The prompt remains in the thread.
Checks: the argv tests already pin the prompt slot. An error-row test for this sentence is still open.

### S9. A thread holds one open session
User choice: "Sesión abierta". Confirmed again inside "si me gusta, vamos con eso". One process per thread; the model, the effort, and each action come from that session, so the execution shows row by row.
Acceptance:
- One thread holds one provider process across messages.
- The next message goes to that process. It does not spawn a second one for the same thread.
- Accepting the send means the intent was stored. It does not mean the provider has finished.
- The selected model and thinking level are set on that session before the message runs. A change after send does not rewrite the process already running.
- Each action that session emits appears as its own row while the turn runs. S1 still governs the row. A missing frame stays a notice. The spawn does not gain an invented argument.
- Closing the thread, or the provider exiting, ends that process. The thread remains. The next message starts or resumes the session. It does not pretend the dead process is still there.
- Gemini has no lasting channel in this product. It stays on one command per message, and the thread does not label that command as a session.
Checks: one test that a second send on the same thread does not spawn a second process; one test that the model and level are applied on the session before the message; one test that Gemini still spawns one command per send.

### S10. Sessions for the first-party providers
User words: "La parte de proveedores." and "si me gusta, vamos con eso".
The confirmed set replaces the earlier four-provider cut.
Current fact:
- OpenCode and Antigravity already declare a lasting channel, and the wire is supported.
- Codex declares a persistent mode and refuses the wire, because the turn frames were not observed.
- Claude, Cursor, and Gemini declare no lasting wire. Cursor's one-shot is not a resumed agent. Claude's one-shot is not a resumed session.
- Grok's one-shot command is `-p`, then the prompt, then permission, model, and `--effort`. It does not yet hold a session.
Acceptance:
- A thread on Codex, Claude, Cursor, Grok, OpenCode, or Antigravity follows S9.
- Codex uses its app-server. Claude resumes the provider session. Cursor resumes its agent. Grok uses `agent stdio`. OpenCode uses its own server: one server per thread on 1.x, one server per account instance on 2.x. Antigravity uses its installed ACP runtime. These are the documented channels, not a second dialect.
- Pi, Muse, Kiro, and fx follow S9 when that program is installed. Pi uses RPC mode. Muse uses its serve handshake. Kiro and fx use ACP. A missing binary is an empty state, not a fake session.
- Each account instance keeps its own session and catalog. Two accounts of the same provider do not share mutable session state.
- A missing frame stays a notice. The spawn does not gain an invented argument.
- Grok does not offer auto-accept edits. A Grok thread stored on that mode runs as Supervised. fx offers Supervised and Auto only. Muse and Kiro offer Supervised and Full access only. A stored mode the provider does not offer runs as Supervised.
Checks: one session test per provider in the set; one test that a second account does not reuse the first account's process; one test that Gemini still spawns one command per send.

### S11. The user message is a compact bubble
User choice: "Sesión, error, texto y crear". Confirmed look: the bubble sits at the end of the column and stops at 80% of that column.
Current fact: `.chat-user-row--bubble` is fit-content, end-aligned, and capped at 720px.
Acceptance:
- The bubble hugs the text and sits at the end of the column.
- Its width stops at 80% of the column, and never stretches to fill a short sentence.
- It keeps the existing card radius, body type, and primary text. A long message still folds. Adjacent bubbles may tighten the shared corner. They do not use an arbitrary pixel radius.
- The assistant answer stays in the column. It does not enter that chip.
Checks: a render assertion that the user row is end-aligned and capped at 80% of the column.

### S12. Creating with Grok loads the account catalog
User words: "Apreto para seleccionar Grok. Y no se cargan los modelos. Es como si no me estuviera detectando la cuenta, quizás. Al menos en la parte de crear."
Current fact: the create form has engine chips and no model list. `create_agent` already accepts `defaultModel`. The account catalog has four visible Grok models. The thread label can already resolve `Grok 4.7`.
Acceptance:
- Selecting Grok, or any other engine, in the create form shows that program's models.
- The list is the same catalog the thread uses. Automatic stays available.
- An empty list shows why, and does not look like a silent blank control.
- The chosen model is saved as that agent's `defaultModel`. Changing engine clears a model from the previous engine.
Checks: a create-form test that selecting Grok requests the catalog and the create command receives the chosen model.

### S13. A failure is a banner, not the answer
User words: "error: a value is required for '--single <PROMPT>' but none was supplied".
Acceptance:
- A provider failure, a usage-limit stop, and a CLI usage error render as a dismissible banner above the transcript. They are not stored as the assistant answer.
- The prompt remains in the thread.
- Approvals, questions, and errors stay visible even when tool calls are hidden.
- A usage-limit stop is its own state. The thread offers Resume. When the provider reports a reset time, it also offers Resume at reset. Queued messages stay saved and run after the continuation.
Checks: an error-row test for the clap sentence in S8, plus a render test that the banner is not an assistant bubble.

### S14. Questions stay in the thread, and a custom answer can carry files
Acceptance:
- A question the agent asks stays on the composer until it is answered, and the answered question remains a row in the timeline.
- A question that accepts a custom answer offers Attach files. The user can send a file alone, with a selected option, or with typed text. A question that only accepts predefined choices does not offer attachments.
- Each question keeps its own attachments. The normal draft stays separate. Uploads finish before submit. A failed response keeps the draft.
- Up to 100 files across one set of answers, with the same size limits as the composer.
Checks: a question-row test, and a test that a choice-only question has no attach control.

### S15. A visual reply is a sandboxed page above the text
User words: "El chat se lo podemos copiar tal cual."
Acceptance:
- When the agent answers with a self-contained HTML page, that page appears in the thread above the written reply.
- Scripts run inside the page. The page cannot reach the session. Links open in the system browser. An expand control opens it full screen.
- Deleting the thread deletes its pages.
- The page uses the current theme. It does not introduce a new radius token.
Checks: a timeline test that the page renders above the assistant text and that the frame is sandboxed.

### S16. A turn's file changes are a card
Acceptance:
- When a turn changes files, the timeline shows a card with the count and the add and delete totals. Opening it reviews that turn's diff.
- Files a pull, merge, or rebase brought in are left out. A file stays when the turn edited it, committed it, or fixed a conflict in it.
- S7 still opens a created markdown, HTML, PDF, or image in the files sidebar from its work row. The card does not dump the document into the chat.
Checks: a card test for the count, and a test that an untouched pulled file is absent.

### S17. Send while the agent is working
Acceptance:
- While a turn runs, a new message can queue for a later turn or steer the running turn. The client setting chooses the default. The opposite action is one modifier away.
- An empty composer shows Interrupt. Text or an attachment replaces it with the default follow-up action.
- Queued messages appear at the end of the thread as unsent dashed messages. Each can be edited, removed, or sent now. They survive a stop and a restart, in order.
- Resume in an empty composer continues a stopped run, a usage-limit stop, or a held queue.
- Steer is offered only when the running session supports it.
Checks: a composer test for queue versus steer, and a test that a stop keeps the queue order.

### S18. Commands and skills
Acceptance:
- `/` lists commands. `$` adds a skill from the selected provider. Provider commands must start the message. Product commands such as `/model`, and skill mentions, work on any line.
- `/compact` in an existing conversation reduces context when the provider supports it.
- `/clear` alone starts a fresh provider session in the same thread. The next message does not see the earlier messages. The thread marks the boundary `New session`. Earlier messages and diffs stay. Dismissing the notice keeps the current session.
- After skills or MCP servers change, Restart agent session continues the conversation and starts the agent again with the new setup.
Checks: a slash-menu test, a `/clear` test that the next send uses a new session id, and a test that `/compact` is refused when the provider has no compact.

### S19. A goal keeps Codex or Claude working
Acceptance:
- On Codex and Claude, `/goal` followed by a done condition keeps the agent working across turns until it judges the goal met. The thread shows Goal and a progress line above the composer.
- `/goal` alone shows the current goal. `/goal clear` removes it.
- Codex also accepts `/goal pause` and `/goal resume`. Stopping a Codex goal pauses it.
- Stopping Claude ends the current turn. The goal stays set and is checked again at the end of the next message.
- Other providers do not invent a goal. The command stays a normal message there.
Checks: a Codex goal test and a Claude goal test. A Grok test that `/goal` is not treated as a native goal.

### S20. Edit from here
Acceptance:
- Edit from here, under a sent message, rewinds the conversation to before that message.
- Revert and keep changes leaves workspace files as they are.
- Revert files too restores the checkpoint from before that message. It is offered only when the provider can rewind its conversation, and only for a thread in its own checkout. It is refused when another thread uses that directory, a folder inside it, or a folder that contains it.
- A provider that cannot rewind its conversation rejects the file restore before any file changes.
- The selected prompt and its attachments return to the composer. An unsent draft stays above that prompt.
Checks: a rewind test that drops the selected message and later items, and a test that a provider without rewind does not touch files.

### S21. Stash and recall
Acceptance:
- Ctrl+S on Windows and Linux, or Cmd+S on macOS, saves the current prompt and its attachments. An empty composer restores the single stash, or opens the stash menu when there are several.
- A stash that holds uploaded files restores only in the environment that uploaded them. Those files are kept for 24 hours. After that, restore offers Attach again.
- ArrowUp in an empty composer recalls the last sent prompt in this thread, then older ones. ArrowDown comes forward. Past the newest, the composer clears. Attachments from the original message are not restored. A composer that already holds an attachment does not count as empty.
Checks: a stash round-trip test and a recall test that walks two sent prompts.

### S22. Context chips
Acceptance:
- A file, another thread, or a terminal excerpt lands at the caret as a chip. The user can type around it, move it, and delete it like a character.
- `@` filters threads and files. A thread chip carries a reference. The agent reads that thread on demand. Attaching it does not change the other thread and does not send a message there.
- A terminal excerpt chip names the terminal and the line range.
- Copying the draft into another draft keeps the chips. Copying out of the app gives readable Markdown with a link in place of each chip.
Checks: a composer test for a file chip and a thread chip, and a test that attaching a thread does not append a message to it.

### S23. A large paste becomes a file
Acceptance:
- A paste of 32 KiB or more becomes a text-file attachment. A smaller paste becomes an attachment when inserting it would pass the message limit.
- The message limit is 120,000 characters. A longer draft stays in the composer.
- Ctrl+Shift+V on Windows and Linux, or Cmd+Shift+V on macOS, keeps a large paste editable in the composer.
- Up to 100 files per message. Each image is at most 10 MiB, and images in one message are at most 80 MiB. Other files are at most 50 MiB. Uploads finish before send.
Checks: a paste test at 32 KiB and a test that a 120,001-character draft does not send.

### S24. The thread sidebar
Acceptance:
- The list has search, New thread, and shelves for pinned, active, working, snoozed, and settled threads.
- Pin, settle, snooze, and archive can be undone for five seconds. Dragging between sections pins, unpins, settles, or wakes. Reduced motion drops the row transition.
- A working or waiting thread can fold into Working. It returns to the top of active when it finishes, fails, or needs an approval or an answer. Pinned threads stay pinned.
- A limited thread keeps the provider's explanation and offers Resume, as in S13.
- Regenerate title asks for a fresh title from the conversation. It is unavailable while a title is already being written.
- A failed thread is marked failed. An empty catalog or a signed-out provider does not look like a failed thread.
Checks: a sidebar test for pin, settle, and the working shelf.

### S25. Subagents and a side chat
Acceptance:
- A subagent's approval or question appears in the parent thread, with the subagent's name. Stop on the parent also stops the subagents it delegated.
- A subagent thread started by the agent does not accept a direct message. The person messages the parent.
- `/side` or `/btw` at the start of a message opens a side chat about the thread. The thread keeps working. The side chat starts with the thread's folder, permissions, model, and thinking level.
- Side chats do not appear in the sidebar. Bring back attaches the side chat to the next message in the parent, and only while the parent is idle. Deleting the thread deletes its side chats.
Checks: a parent-thread test that a subagent approval is answerable there, and a `/side` test that the parent transcript does not gain that question.

### S26. Permission modes belong to the thread
Acceptance:
- The composer sets the mode for that thread: Supervised, Auto-accept edits, Auto, or Full access.
- Supervised asks before commands and file changes. Auto-accept edits approves file edits and can still ask for other actions. Auto uses the provider's review and asks about the rest. Full access allows commands and edits without approval prompts.
- The provider limits in S10 win over this list. A mode above what the provider offers is shown as Supervised when the thread runs.
- The default for a new thread is Full access, unless the project overrides it. A new thread does not copy the mode of the thread that was open.
- Approving or rejecting in the conversation lets the agent continue. Permission modes do not stop the agent from asking questions.
Checks: a picker test for the four modes, and a Grok test that auto-accept edits runs as Supervised.

### S27. Switching providers hands off the conversation
Acceptance:
- Switching providers, or continuing after a restart the provider cannot resume, transfers a budgeted selection of recent messages, the original request, and relevant command outcomes.
- The new request is never shortened to make history fit. Reasoning, tool-call state, and attachments are not copied.
- Codex receives historical messages directly when the installed version supports that. Other providers receive the same selection as attributed context.
- If the target has no room, the product starts a fresh provider conversation with a bounded selection and sends the request. It does not ask the person to compact first.
Checks: a handoff test that the new request is intact, and a test that attachments are absent from the handoff.

### S28. Titles are written for the thread
Acceptance:
- A new thread receives a title from the conversation. Regenerate title is S24.
- Thread title instructions in settings apply to new and regenerated titles. A project may set its own.
- The text-generation model is a setting. It is not listed as an agent the person can chat with.
Checks: a test that a new thread stores a generated title, and a test that the generator id is absent from the agent picker.

### S29. Usage sits in the thread details
Acceptance:
- The thread details card shows context usage once the provider reports it.
- It shows token use for the providers that report it. A turn with no saved completed-turn record is absent, not estimated from the transcript.
- The card is not the transcript.
Checks: a details test that a reported usage figure renders, and a test that a missing record does not invent a token count.

### S30. Empty provider states say what is missing
User words: "Apreto para seleccionar Grok. Y no se cargan los modelos. Es como si no me estuviera detectando la cuenta, quizás. Al menos en la parte de crear."
Acceptance:
- No installed provider: the composer says to open provider settings.
- Installed and signed out: the banner says to sign in. It does not look like an empty model list.
- Signed in and no models yet: the note says the program has not listed its models yet. The control stays usable.
- S12 still loads the create-form catalog from the same source.
Checks: one render test for each of the three states.

### S31. Code keeps the terminals
User words: "Por una parte tenemos la parte de CODE. En la aplicación, la cual funciona perfecto. Terminales. CLI, todo lo demás."
Acceptance:
- Thread does not install a second terminal runtime. A terminal excerpt or a terminal drawer uses the Code terminal the workspace already has.
- A thread may run in an isolated checkout so its file restore cannot erase another thread's files. That checkout does not replace Code.
- The title-bar mode switcher is unchanged.
Checks: a test that opening a terminal from a thread uses the existing terminal id space, and a test that Code's terminal restore still lists the same sessions.

### S32. Deferred surfaces stay deferred
Confirmed deferrals. They are not tasks.
- Voice transcription on a chosen host, and a suggested next prompt, stay out.
- A phone app, remote pairing, device simulators, an in-app browser, cookie import, captures of other windows, a third-party secret store, enterprise policy, another product's telemetry, another product's database migration, and a registry of third-party agents stay out.
- Adding one of these later appends a log entry and a new S#. It does not reopen S9 through S31.
Checks: none. This spec is the boundary.

## Tasks

- T1. Replace the dots banner with one live action row and kind icons, on the thread and the agent shell. S1. Route: inline. Status: reopened. A lasting session was hiding tool frames as notices. Commit: pending chain choice
- T2. Map thought frames from every connected provider onto the reasoning row, and stop the banner under it. S2. Route: inline. Status: implemented. Commit: pending chain choice
- T3. Advertise real per-model levels, including ultra, and pass the observed flag on send. Risk: item 3 (spawn arguments are a contract the drivers consume). S3. Route: inline. Status: reopened, prompt slot corrected. Commit: pending chain choice. Evidence: `grok_sends_the_selected_model_and_the_documented_effort_alias` and `the_one_shot_argv_stays_pinned_for_every_driver` green after the prompt moved to the value of `-p`.
- T4. Add the composer-menu motion token and use it on every footer menu. S4. Route: inline. Status: implemented. Commit: pending chain choice
- T5. Fit the dictate control and the microphone glyph to the footer. S5. Route: inline. Status: implemented. Commit: pending chain choice
- T6. Cite a selected assistant passage into the composer. S6. Route: inline. Status: reopened, chip and comment still open. Commit: pending chain choice
- T7. Open a created markdown, image, or HTML file in the files sidebar from the work row. S7. Route: inline. Status: implemented. Commit: pending chain choice. Evidence: ChatItemRow markdown click test and source-read ctrl-click test green; `npx tsc --noEmit` exit 0. Desktop window not re-walked.
- T8. Keep a CLI usage failure out of the assistant answer. S8. Route: inline. Status: prompt slot done, error row open. Commit: pending chain choice
- T9. Hold one open session per thread and emit its actions as rows. S9, S10. Route: inline. Status: reopened. The four-provider cut is withdrawn. Risk: item 3 (provider session is a contract the drivers consume) and item 4 (one process across turns). Commit: none
- T10. Hug the user message to a compact end-aligned bubble. S11. Route: inline. Status: reopened, cap is 80% of the column. Commit: pending chain choice. Evidence: user row carries `chat-user-row--bubble`; the row rule is fit-content, end-aligned, max 720px.
- T11. Load the account catalog when creating with Grok, and save the chosen model. S12. Route: inline. Status: implemented, create-form test still open. Commit: pending chain choice
- T12. Session transports for Codex, Claude, Cursor, Grok, OpenCode, and Antigravity. S9, S10. Route: delegated for the Grok unit, then inline for the gate. Status: Grok session implemented. OpenCode and Antigravity already had adapters. The three served wires are on unless `KITE_PERSISTENT_SESSIONS=0`. Codex, Claude, and Cursor pending. Commit: none. Evidence: the three Grok session tests, `sessions_stay_on_unless_the_gate_is_exactly_zero`, and `every_driver_keeps_its_declared_session_mode` passed.
- T13. Session transports for Pi, Muse, Kiro, and fx, when installed. S10. Route: inline. Status: pending. Commit: none
- T14. Render provider, usage-limit, and CLI failures as a banner. S8, S13. Route: inline. Status: pending. Commit: none
- T15. Keep questions in the thread, and accept files on a custom answer. S14. Route: inline. Status: pending. Commit: none
- T16. Render a sandboxed HTML page above the reply. S15. Route: inline. Status: pending. Commit: none
- T17. Show a turn's own file changes as a card. S16. Route: inline. Status: pending. Commit: none
- T18. Queue, steer, interrupt, and resume. S17. Route: inline. Status: pending. Commit: none
- T19. Slash commands, skills, compact, clear, and goals. S18, S19. Route: inline. Status: pending. Commit: none
- T20. Edit from here, and restore files only when the provider can rewind. S20. Route: inline. Status: pending. Risk: item 1 (checkpoint restore changes workspace files). Commit: none
- T21. Stash, recall, context chips, and large paste. S21, S22, S23. Route: inline. Status: pending. Commit: none
- T22. Sidebar shelves, undo, and regenerate title. S24, S28. Route: inline. Status: pending. Commit: none
- T23. Parent approvals for subagents, and side chat. S25. Route: inline. Status: pending. Commit: none
- T24. Thread permission modes, with each provider's limit. S26. Route: inline. Status: pending. Risk: item 2 (approval policy). Commit: none
- T25. Isolated accounts and a provider handoff. S10, S27. Route: inline. Status: pending. Risk: item 3. Commit: none
- T26. Usage in thread details, and the three empty provider states. S29, S30. Route: inline. Status: pending. Commit: none
- T27. Reuse Code terminals, and allow an isolated checkout. S31. Route: inline. Status: pending. Commit: none

## Verification

- `npx vitest run src/components/views/chat src/components/views/agents src/motion`
- `cargo test chat::`
- `npx tsc --noEmit`
- `node .kite/sanitizer/audit-references.mjs --check`

## Log

L1. 2026-11-05. The verbatim request is in `.kite/tasks/response-thread-reference.md`. This file keeps only the product sentences, because a public task cannot name an external source. Product ask: plan the response thread; show each action with its icon; replace the "thinking" and three-dots treatment, including for Grok and the other agents; apply low, medium, high, max, and ultra on OpenCode, Grok, and every connected provider, not only Antigravity; make the model, thinking-level, and other footer menus faster and come from the control they leave; fit the microphone outline in that footer; look for further thread improvements; write this ODD.

L2. 2026-11-05. Reading of L1: the work is the response thread, the thinking-level control, the footer menus, and the dictate glyph. "Triad" is not specified as the completion chime in `src/lib/notifications/audioCues.ts`. That chime stays out of scope. The reference notes live in `.kite/tasks/response-thread-reference.md` because this file stays product-only.

L3. 2026-11-05. Evidence. Antigravity is the only driver with `accepts_effort: true`, and the only `spawn_args` arm that appends `--effort` (`src-tauri/src/chat/runtime.rs` around the Antigravity match, `drivers.rs` declaration table). Grok's arm passes `-p`, `--permission-mode`, and the prompt. OpenCode's arm passes `run`, `--format json`, optional `--agent`, optional `--model`. The dots banner is duplicated in `SingleThreadPane.tsx` and `AgentChatShell.tsx`. Footer menus animate with `.kite-floating-card` / `kiteFadeIn` 0.12s scale 0.97 in `composer.css`. `odd/tasks/thread-composer-enhancements.md` already asked for snappy menus and Grok effort; those items are still unlanded, and this document owns them.

L4. 2026-11-05. Extra behavior taken from the reference pass, as S6 only: citing a selected assistant passage into the draft. Not taken: slash skills, goals, stash, implementation-action pills, favicons on tool rows, and a second composer. Next step is T1 on `feat/response-thread`, after this document is the spec.

L5. 2026-11-05. Corrected S1, S2, S4, and S5 after the full timeline read. The empty running state is `Working for` plus a timer; the brain row is only the placeholder and it leaves when an action row exists. Reasoning rows say `Thinking` or `Thought` and do not carry `Thought for …`; the duration is the turn summary. Finished bursts collapse to `Read N files`, `Changed N files`, `Ran N commands`, and `Searched N times`. Menu motion is an 80ms, 4px drift with `cubic-bezier(0.32, 0.72, 0, 1)`, not a 120ms scale. The dictate control stays 32px and gains no circle. The reference desktop composer has no microphone; S5 is the Kite glyph, not a port of the mobile hit target.

L6. 2026-11-05. Branch `feat/response-thread` was cut from `feat/ui-composer` at `1e49a1d`, not from the default branch. No source commit yet. The chain question is still open because the forecast is above 400 authored lines.

L7. 2026-11-09. User words: "error: a value is required for '--single <PROMPT>' but none was supplied" and "También hay que corregir el error claramente que tenemos de Grok." The Grok one-shot arm had put `--permission-mode` in the prompt slot of `-p`. T3 reopened. The running window keeps the old binary until it is rebuilt.

L8. 2026-11-09. User words: "Sí, en esta sesión quiero que escribas. En lo de D, pero ten en consideración que tenemos que ir conversando mucho sobre cómo. Y qué es lo que vamos a abarcar. Definir mucho. Ok? Conversemos." S8 is the only new accepted rule. The open definitions stay out of acceptance until this conversation settles them.

L9. 2026-11-09. User choice: "Sesión abierta". Landed as S9. The provider list, the user-message look, and the create model list stay open.

L10. 2026-11-09. User choice: "Los que ya tienen sesión". The set is Grok, Codex, OpenCode, and Antigravity. Claude, Cursor, and Gemini stay one-shot. Landed as S10. OpenCode and Antigravity already declare a lasting channel. Grok and Codex do not speak one in this build yet.

L11. 2026-11-09. User choice: "Sesión, error, texto y crear". Landed as S11 and S12. This iteration is S8 through S12. The open-definition list is empty.

L7. 2026-11-05. T3 observation of the installed CLIs. Grok 1.0.70 documents `-m/--model` and `--reasoning-effort` (alias `--effort`). The text `grok models` list names ids only; per-model menus come from the CLI catalog `reasoning_efforts`. grok-4.7, grok-4.7-build-fast, and grok-4.6 advertise low, medium, high, xhigh. grok-4.5 advertises low, medium, high. None advertise ultra. OpenCode 2.2.5 `run --help` documents `--model provider/model#variant`. `--thinking` only shows thinking blocks, so it is not sent. Antigravity 1.5.1 still documents `--effort` as low|medium|high|xhigh|max; ultra is a catalog suffix, not a new flag. Claude, Codex, Gemini, and cursor-agent were absent, so those drivers stay without an effort flag. `~/.grok/bin/agent.exe` is Grok, not Cursor. A model with fewer than two advertised levels keeps the control disabled. The next send reads the stored level; an in-flight process is not rewritten. The opt-in OpenCode server turn passes the same `#variant` on `--model` and does not restart the server.

L8. 2026-11-07. The user asked to resume this thread and copy the chat icons and the action trace. Each live action stays visible as its own line. The line is one secondary sentence, with the square-pen, hammer, and wrench marks. A failure does not recolor the line. Collapse waits until the burst finishes. Website favicons stay out. The spoken request is in `.kite/tasks/response-thread-reference.md`.

L9. 2026-11-07. User: "osea falta mas detalle de cada accion y mejorar varias cosas". A stored `read_file` item had title `read file`, no `filePath`, and detail JSON with `"Path"`, while `text` was `1 lines, 569 bytes` painted under the closed row. The working caption read `Working for 125s` under the actions. The line now carries the path or the tool argument, the count is quiet meta, the body opens on click, and the caption is `Working · 2m 5s` above the live rows.

L10. 2026-11-07. User: "Muchos archivos se crean. .mds, artefactos. O tipo de, tipo, cosas visuales. Los, en los chats me refiero. Por ejemplo en Antigravity se crean los artefactos. ... tenemos que poder llegar a integrar, con nuestra sidebar lateral para inspeccionar archivos." Choice: "Al pulsar la fila". Do not auto-open the latest file while the turn runs. The files sidebar already renders markdown when no line is requested, and it already previews images. External paths resolve through the existing file link, including files outside the workspace.

L11. 2026-11-08. User: selecting Grok in the thread model picker loads no models, as if the account were missing. Evidence: Grok 1.0.77 `grok models` prints `You logged in with grok.com.` then `Default model: grok-4.6 (not in list below)` and an empty `Available models:` list. The account catalog is `~/.grok/models_cache.json` (grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5 with effort menus). `fetch_grok_models_dynamic` only parsed bullets, so the picker stayed on Automatic. Fix: catalog file first, default-model line when the bullet list is empty, retry an empty prefetch when the user selects that provider, keep the picker clickable while the list is empty.

L15. 2026-11-09. User words: "cosas que note instantaneamente que estan mal, no se muestra las acciones o nada de lo que va haciendo". A Grok tool frame was a notice, and a notice is not an action row. Those frames now stay activity lines and use the existing row builder. T1 reopened.

L14. 2026-11-09. User choice: "Encender los tres". Grok, OpenCode, and Antigravity take the session route unless `KITE_PERSISTENT_SESSIONS=0`. Codex, Claude, Cursor, and Gemini stay one command per send. The running window keeps the old binary until it is rebuilt.

L13. 2026-11-09. Grok session evidence. `agent stdio` is the lasting channel. `--permission-mode` sits before `agent`. Model and effort are `session/set_config_option` before `session/prompt`. Stored `acceptEdits` is sent as `default`. The one-shot arm is unchanged. The route still requires `KITE_PERSISTENT_SESSIONS=1`; unset stays one-shot, including for Grok. Parent re-ran the three session tests: 3 passed. `chat::normalize::tests::the_existing_acp_parsers_are_unchanged` failed outside this diff and stays out. No commit.

L12. 2026-11-09. User words: "si me gusta, vamos con eso". That confirms the thread-product cut: a living session, the timeline, the working composer, permissions, the sidebar, checkpoints, questions, HTML pages, handoff, side chat, and the first-party providers Codex, Claude, Cursor, Grok, OpenCode, Antigravity, Pi, Muse, Kiro, and fx. Gemini stays one-shot. Code terminals stay. The earlier four-provider cut in S10 is withdrawn. S9, S10, S11, and S6 are rewritten. S13 through S32 are the rest of the confirmed cut. S32 records the deferrals. The chain question from L6 is still open, so this confirmation does not commit.
