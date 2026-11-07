# Response thread

Objective: the thread shows each action as it happens, the chosen thinking level is what every connected provider actually runs, and the composer controls open quickly from the footer.
Branch: `feat/response-thread`. Cut it from the default branch before the first source commit. Do not commit on `main`.
Delivery strategy: `ask-on-risk`. Forecast about 900 authored lines, so the chain question is asked before the commit that crosses about 400. Test runner: `npx vitest run`, `npx tsc --noEmit`, `cargo test chat::`.
Does not change the completion chime or the title-bar mode switcher.

## Specs

### S1. The running turn is a row of actions, not a dots banner
User words: "Me gusta bastante cómo manejan como los íconos. Cómo van mostrando las acciones que va haciendo. por ejemplo, la parte que nosotros mostramos donde, mostramos que dice \"thinking\" y tres puntitos, no me gusta cómo aparece. Tampoco creo que estaba funcionando para agentes como Grok, o distintos."
Current fact:
- `SingleThreadPane.tsx` and `AgentChatShell.tsx` append `chat-working-row` whenever the turn is running or waiting. The label is `Thinking…` unless a tool is running (`Executing …`) or assistant text is already streaming (`Generating response…`). The row is three bouncing dots plus that label.
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
- `parse_agy_models` collapses suffixed catalog rows and fills levels for Antigravity. `spawn_args` appends `--effort` only in the Antigravity arm.
- `drivers.rs` sets `accepts_effort: true` only for Antigravity. OpenCode, Grok, Codex, Claude, Cursor, and Gemini are `false`, with "no effort flag was observed".
- The Grok arm of `spawn_args` passes permission mode and the prompt. It does not pass the selected model or a thinking level. The OpenCode arm passes `--model` and does not pass a level. Codex passes `--model` and does not pass a level.
- Spanish labels cover minimal, low, medium, high, xhigh, and max. They do not cover ultra.
Acceptance:
- The control lists the levels that model actually advertises, in order, including `low`, `medium`, `high`, and whichever of `xhigh`, `max`, and `ultra` that model has. A model with fewer than two levels keeps the control disabled and shows the existing reason. `Automatic` stays without levels.
- Choosing a level is what the next send runs. A change after send does not rewrite the process already running.
- Antigravity keeps `--effort <level>`.
- For OpenCode, Grok, Codex, Claude, Cursor, and Gemini, the send uses the flag or the variant model id that the installed CLI documents. The driver table records the observed flag and the version that was read. A driver whose CLI still documents no flag stays disabled and the spawn does not gain an invented argument.
- Grok sends the selected model together with the level, once its CLI documents the model flag.
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
- Activating it inserts that passage into the draft at the caret, as a quote the user can type around. The selection can be cleared without deleting the draft.
- The quote is sent as part of the prompt. It does not create a second hidden channel.
Checks: a composer test that the action inserts the selected text and leaves surrounding draft text intact.

### S7. A created document opens in the files sidebar
User words: "Muchos archivos se crean. .mds, artefactos. O tipo de, tipo, cosas visuales. Los, en los chats me refiero. Por ejemplo en Antigravity se crean los artefactos. O ese tipo de cosas y bueno. Em, tenemos que poder llegar a integrar, con nuestra sidebar lateral para inspeccionar archivos. Lo que sería la visualización para esos artefactos y demás. Quiero decir, porque ahora mismo em, no lo hacemos así."
Choice: "Al pulsar la fila". The row names the file. A click opens it already rendered in Files. The chat does not fill with the document. The sidebar does not follow the file while it is being written.
Acceptance:
- A work row whose file is markdown, HTML, PDF, or an image opens that file in the existing files sidebar on a plain click. No line number is passed, so markdown stays on the rendered view.
- The chat row does not mount that document as its body.
- A source read stays in the chat. Ctrl-click or meta-click still opens that source file in the sidebar. A command row still opens its output in the chat.
Checks: a row test for the markdown click, and a row test that a source read does not open on a plain click.

## Tasks

- T1. Replace the dots banner with one live action row and kind icons, on the thread and the agent shell. S1. Route: inline. Status: implemented. Commit: pending chain choice
- T2. Map thought frames from every connected provider onto the reasoning row, and stop the banner under it. S2. Route: inline. Status: implemented. Commit: pending chain choice
- T3. Advertise real per-model levels, including ultra, and pass the observed flag on send. Risk: item 3 (spawn arguments are a contract the drivers consume). S3. Route: inline. Status: implemented. Commit: pending chain choice
- T4. Add the composer-menu motion token and use it on every footer menu. S4. Route: inline. Status: implemented. Commit: pending chain choice
- T5. Fit the dictate control and the microphone glyph to the footer. S5. Route: inline. Status: implemented. Commit: pending chain choice
- T6. Cite a selected assistant passage into the composer. S6. Route: inline. Status: implemented. Commit: pending chain choice
- T7. Open a created markdown, image, or HTML file in the files sidebar from the work row. S7. Route: inline. Status: implemented. Commit: pending chain choice. Evidence: ChatItemRow markdown click test and source-read ctrl-click test green; `npx tsc --noEmit` exit 0. Desktop window not re-walked.

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

L7. 2026-11-05. T3 observation of the installed CLIs. Grok 1.0.70 documents `-m/--model` and `--reasoning-effort` (alias `--effort`). The text `grok models` list names ids only; per-model menus come from the CLI catalog `reasoning_efforts`. grok-4.7, grok-4.7-build-fast, and grok-4.6 advertise low, medium, high, xhigh. grok-4.5 advertises low, medium, high. None advertise ultra. OpenCode 2.2.5 `run --help` documents `--model provider/model#variant`. `--thinking` only shows thinking blocks, so it is not sent. Antigravity 1.5.1 still documents `--effort` as low|medium|high|xhigh|max; ultra is a catalog suffix, not a new flag. Claude, Codex, Gemini, and cursor-agent were absent, so those drivers stay without an effort flag. `~/.grok/bin/agent.exe` is Grok, not Cursor. A model with fewer than two advertised levels keeps the control disabled. The next send reads the stored level; an in-flight process is not rewritten. The opt-in OpenCode server turn passes the same `#variant` on `--model` and does not restart the server.

L8. 2026-11-07. The user asked to resume this thread and copy the chat icons and the action trace. Each live action stays visible as its own line. The line is one secondary sentence, with the square-pen, hammer, and wrench marks. A failure does not recolor the line. Collapse waits until the burst finishes. Website favicons stay out. The spoken request is in `.kite/tasks/response-thread-reference.md`.

L9. 2026-11-07. User: "osea falta mas detalle de cada accion y mejorar varias cosas". A stored `read_file` item had title `read file`, no `filePath`, and detail JSON with `"Path"`, while `text` was `1 lines, 569 bytes` painted under the closed row. The working caption read `Working for 125s` under the actions. The line now carries the path or the tool argument, the count is quiet meta, the body opens on click, and the caption is `Working · 2m 5s` above the live rows.

L10. 2026-11-07. User: "Muchos archivos se crean. .mds, artefactos. O tipo de, tipo, cosas visuales. Los, en los chats me refiero. Por ejemplo en Antigravity se crean los artefactos. ... tenemos que poder llegar a integrar, con nuestra sidebar lateral para inspeccionar archivos." Choice: "Al pulsar la fila". Do not auto-open the latest file while the turn runs. The files sidebar already renders markdown when no line is requested, and it already previews images. External paths resolve through the existing file link, including files outside the workspace.
