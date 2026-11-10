# Agent Dispatch

Objective: one addressable delivery service for every agent surface Kite already runs. A terminal, a chat thread, the Zed operator, and a script in a workspace all call the same policy. The policy decides whether a message may be submitted, queued, or refused. Each surface is a transport behind a port. Delivery does not live inside terminal code, and terminal code does not decide the protocol.
Branch: `feat/agent-dispatch`, created from the current working branch. Do not commit on `main`.
Delivery: `ask-on-risk`. Slices A–F are the review boundaries. A slice that would put more than a reviewable change in one diff stops and splits before apply.
Test runners: `npm test` (`vitest run`) for the frontend; `cargo test` in `src-tauri` for Rust. `npx tsc --noEmit` for types. Before commit or push, `node .kite/sanitizer/audit-references.mjs --check`.
Workers: the user launches them. The author of this document does not.
Walkthrough: `docs/agent-orchestration/agent-dispatch.pptx`.

## Product decision

Kite already delivers text to agents in three places. Each place is a special case, and none of them closes the loop.

1. The service is the product. Surfaces adapt to it. A new surface implements a port. It does not grow a fourth send path.
2. A message has an address, a gate, and a way back. Success is a receipt. Writing bytes, animating a flight, or storing a row is not success.
3. The person keeps approvals. An agent may not answer a permission dialog by sending text. A human caller may, and only with an explicit force flag.
4. Existing commands keep their names while they are moved. `injectPrompt`, `handoff_to_agent`, `send_agent_message`, and `scripts/kite-agent.mjs` become clients. Their user-facing behavior stays until the slice that replaces it has tests.
5. The window stays the window Kite has. This feature adds no multiplexer, no second runtime, no new chat screen, and no new projectile shape.

## Terms

- **Dispatch**: the policy service. It owns addresses, presence, the queue, waits, reports, parent links, and receipts. It does not own panes, transcripts, or animation.
- **Address**: a stable target. Kinds are `session`, `thread`, `agent`, and `alias`.
- **Alias**: a short live name such as `reviewer`. It resolves to one address and dies when that endpoint is released.
- **Endpoint**: one live terminal session or one live chat thread. An agent profile is not an endpoint. It resolves to one.
- **Presence**: the lifecycle record for an endpoint. States are `idle`, `working`, `blocked`, `done`, `error`, `unknown`, and `gone`.
- **Authority**: who last wrote presence. `reported` comes from the program (OSC 7501 on a terminal, or a typed chat event). `observed` comes from the existing pane heuristic. Reported wins when it is newer.
- **Blocked kind**: why a `blocked` endpoint stopped. `permission`, `question`, `auth`, or `none`.
- **Transport**: a port that can submit text, read recent output, stop, and publish presence for one family of endpoints. v1 has terminal and thread.
- **Caller**: `human`, `agent`, or `script`. Agent and script follow the same gate. Only a human may force.
- **Receipt**: the result of one operation. It says whether text was submitted. It does not say the callee understood it.
- **Envelope**: the self-contained body used when one agent reports to another.
- **Parent**: the address that started a child. Optional. The child can name it when reporting.
- **Role file**: an optional Markdown brief. It can name a command and a preface. It is not required to start a program the launcher already knows. A missing file does not mean "do not start".
- **Program**: an engine the terminal launcher already knows how to start. The one-line command names a program. A role file, when one exists with the same name, only supplies the command and a preface.
- **Audit log**: the durable append-only record of receipts and delivered bodies. The profile inbox is a projection of this log.
- **Skill text**: the one-page instructions an agent already has when its process starts. Printed by the CLI so the text matches the binary. It is not a file the agent must go find before it can launch anyone.

## Current-state audit

Observed facts, not future requirements.

Three delivery paths exist. They do not share a gate, a receipt, or a return path.

**Operator injection.** `appOperatorController.injectPrompt` writes the terminal or, when the pane is mounted, dispatches `kite:dispatch-prompt-projectile` and lets the landing event type the prompt. A mounted receiver and a direct write are mutually exclusive so the same text is not submitted twice. The function does not read `working`, `waitingForYou`, `idle`, `done`, or `exited`. `spawnTerminals` opens up to ten terminals and may attach an initial prompt. `handoff_to_agent` builds a prompt from a source buffer or an ODD path and calls `injectPrompt`. `spawnSubagent` calls `spawnTerminals`. The projectile, the orb pulse, and the impact class are specified by `odd/tasks/zed-assistant-overhaul.md` S5 and stay as drawn.

**Profile mailbox.** `send_agent_message` and `agent_message_inbox` in `src-tauri/src/agents.rs` append to `agent-messages.json`. The row is stored with `delivered: true` at write time. `AgentChatShell` renders those rows as teammate messages. Nothing starts a chat turn and nothing writes a terminal. `allow_agent_messaging` on the agent profile and `agent-messaging-preference.json` are a separate switch from delivery.

**Workspace inbox.** `scripts/kite-agent.mjs` supports `agents`, `spawn`, and `inject`. The task body must be a file inside the workspace. The script writes `<cwd>/.kite/inbox/<id>.request.json` and polls up to 8 seconds for `<id>.result.json`. Delivery happens only while Code view is mounted and polling. `docs/agent-orchestration/agent-handoff.md` describes this path. `KITE_SOURCE_SESSION` and `KITE_PANE_ID` are copied onto the request when set.

**Status today.** Close and the proactive watcher already consume pane states `working`, `waitingForYou`, `idle`, `done`, and `exited` from `kite:terminal-agent-update`. That signal is not an input to injection. Chat turns have their own status on the thread. Neither signal is a presence record with a sequence.

**Sessions.** `odd/tasks/agent-sessions.md` is authoritative for provider sessions on threads. Dispatch does not replace that session. The thread transport submits a user message through the session that already exists. It does not spawn a second provider process and it does not paste a recipe.

Missing seams:

- no address that a terminal and a thread can both be named by;
- no queue and no refusal when the destination is blocked;
- no wait on lifecycle;
- no report that lands in the caller's input;
- no parent link;
- no single receipt;
- the script, the operator, and the mailbox cannot see each other's deliveries.

## Specs

S1. Every submission of text to a live agent goes through Dispatch. Callers are the Zed operator, the profile inbox, `scripts/kite-agent.mjs`, and the CLI. A transport that submits text by any other new path is a defect.

S2. Policy is a module that imports no terminal, no chat runtime, no pane layout, and no animation. It depends on port traits. One wiring file constructs the real ports. Policy tests use fakes only.

S3. Addresses. `session:<id>` is a terminal session. `thread:<id>` is a chat thread. `agent:<profileId>` resolves to that profile's live thread, or fails with `no_live_endpoint` when none is live. `alias:<name>` resolves to the endpoint that registered it. The name matches `[a-z][a-z0-9-]{0,31}` and is unique among live aliases. Releasing the endpoint frees the name. Commands accept a bare alias when it is unique.

S4. Presence. The record holds state, blocked kind, optional message, app name, sequence, authority, and time. `reported` replaces `observed` when its sequence is greater. A stale report is ignored. Dispatch never classifies a screen. The terminal observer publishes `observed` from the states it already computes, mapping `waitingForYou` to `blocked` and `exited` to `gone`. A program may publish `reported` with OSC 7501. The parser accepts `idle`, `working`, `blocked`, `done`, `error`, and `clear`. `clear` drops the reported record and the observer may publish again. Unknown keys are ignored. A malformed report is dropped whole. `kind` is `permission`, `question`, or `auth`. The message is one line. The parser lives next to presence and is tested without a PTY.

S5. Send. Ready means `idle` or `done`. A ready destination is submitted once. A `working` destination is queued when the caller allows a queue, which is the default. A `blocked` destination is rejected with `destination_blocked` and nothing is written. `unknown` is treated as not ready and is queued, not forced. `gone` is `destination_gone`. Queue depth is 8 per address. A deeper send returns `queue_full` and does not drop the tail. Body limit is 8000 characters after the envelope is applied. One submission is in flight per address. A second ready send waits behind it.

S6. Force and callers. `force` submits even when the state is `blocked` or `working`. Only `caller: human` may set it. An agent or a script that sets it receives `force_forbidden` and nothing is written. Zed speaking for the person is a human caller. An agent that asks Zed to inject is still an agent caller. The operator passes the origin through; it does not upgrade the caller.

S7. Wait. `wait` resolves when presence matches the requested states. The default set is `idle`, `done`, and `blocked`. The caller may pass an explicit set, including `error`. A wait does not submit text. `--children all` resolves when every live child of the address is outside `working` and `unknown`. `--children any` resolves on the next child transition to `blocked`, `done`, `error`, or `gone`, or when a report arrives for the parent. A child that has not reported yet counts as `working` for `all`. Timeout returns `timeout` and does not submit, retry, or dequeue.

S8. Stall. After a submit, if the caller also waits, the service watches for a presence change within 5 seconds. If none arrives, the receipt is `stalled` and `submitted: true`. The caller must read before sending the same body again. The service does not send a second Enter.

S9. Report and the synthetic notice. `report` submits an envelope to the parent, or to an explicit address. The envelope is plain text:

```text
[kite from="<alias-or-address>"]
This is another agent, not the person.
To reply: kite dispatch send <from> "<reply>"
Irreversible and privileged actions still wait for the person.
BODY:
<text>
```

The body must carry the facts the receiver needs. Dispatch does not attach the sender's transcript. When a child enters `blocked`, `done`, `error`, or `gone`, S32 submits one notice to the parent for that entry. The notice uses the same envelope and is still subject to the parent's gate. If the parent is blocked, the notice is queued, not forced.

S10. Parent lifetime. `run` may set a parent. Children stop when the parent stops, unless the child was started with `outlive`. Stop calls the transport's existing stop. Terminal stop is the existing terminate. Thread stop is the existing interrupt. Dispatch does not invent a process group. A parent wait and a parent report are the only coupling.

S11. Read. `read` returns recent text without focusing the pane and without sending input. The terminal port reads the rolling buffer the handoff path already uses. The thread port reads the last transcript items already stored on the thread. `--lines` caps the result. Default is 80 lines. Read does not mark presence `seen` and does not clear `done`.

S12. Run. `run` asks a port to start an endpoint, registers the address, and optionally registers an alias and a parent. The terminal port starts a session through the existing spawn command. It does not split, focus, or resize panes. Layout remains `manage_pane_layout`. The thread port does not start a provider in this feature. Opening a thread stays the chat's own command. `run --role <name>` reads one role file and starts its command through the terminal port. The file body plus the task is the process start prompt (S31), not a queued send. Role files live in the app config directory under `dispatch/roles/<name>.md`. The header holds `command` and an optional `description`. The body is the brief. Unknown header fields are ignored. A name that is neither a role file nor a known program is `program_not_found` and starts nothing. S29 decides that lookup. `role_not_found` remains the result of an explicit `--role` whose file is missing.

S13. Files as bodies. `send --file <path>` and the script's `--task` read a UTF-8 file inside the caller's workspace. A path that escapes the workspace is `path_rejected` and nothing is sent. The file bytes count toward the 8000 character limit. The path itself is not a secret channel.

S14. CLI and IPC share one schema, `schemaVersion: 1`. The command is `kite dispatch`. Subcommands are `ls`, `programs`, `run`, `send`, `wait`, `read`, `report`, `skill`. IPC methods use the same names and the same receipt. The CLI talks to the running app over loopback. The app writes a token file in its own data directory. The CLI sends that token. A missing app returns `runtime_offline` and does not start a hidden server. Inside a Kite terminal the process environment includes `KITE_DISPATCH=1` and `KITE_ADDRESS` for that session. The skill text tells the agent to call the CLI only when `KITE_DISPATCH=1` is set. Outside that environment the CLI still works for a person. The skill text is English and is printed by `kite dispatch skill` from the running binary.

S15. Projectile. A terminal submit emits one presentation event with the source address, the target session, the text, and the optional label. The existing overlay plays one flight and one impact. Policy does not import the overlay. The orb pulse still runs when there is no source pane. The double-submit guard stays in the terminal port: a mounted receiver types the landing text, and the port does not also write the PTY.

S16. Zed keeps the action names and the Spanish parser. `inject_prompt`, `handoff_to_agent`, `open_terminals`, and `spawn_subagent` call Dispatch. Handoff still flies from the source pane to the target pane. Handoff's composed body becomes the send body, wrapped in the envelope when the source is an agent. The planner does not gain a second injection tool.

S17. Mailbox. `send_agent_message` is a wrapper that calls `send` to `agent:<id>` with `caller: human` when the UI sends, and `caller: agent` when an agent sends. The inbox UI reads the audit projection and still shows sender, body, and whether the receipt was submitted or only queued. `delivered: true` at file-write time is removed. `allow_agent_messaging: false` and a disabled preference reject agent callers with `messaging_disabled`. `readOnly` accepts human sends and reports, and rejects agent sends. The preference file and the profile field remain the switches. They are not a second bus.

S18. The workspace script. `agents`, `spawn`, and `inject` keep their flags. The implementation calls the CLI schema instead of waiting on Code view to poll `.kite/inbox`. A task file is still required for `spawn` and `inject`. Result JSON remains so existing tests can read a receipt. The inbox directory is not the protocol after slice E. Until that slice, a request file may be written as a trace and is not required for delivery. S33 stops the Code-view poller from opening a terminal or injecting text for those request files.

S19. The proactive watcher subscribes to presence transitions `working → done`, `working → blocked`, and a move to `error` or `gone`. It keeps the current Spanish speech, dedupe, and suppression of a manual close. It does not also speak from the raw terminal event once the bridge is on, so one transition produces one utterance. Notifications use the existing attention report.

S20. Audit. Receipts and submitted bodies append to the existing SQLite database. Reopening the app shows the same log. The first run imports `agent-messages.json` once, marks each imported row as a historical record without a live receipt, and does not resubmit them. A failed import leaves the JSON in place and does not delete it.

S21. Idempotency. Each call carries an id. Repeating the same id returns the same receipt and does not submit twice. The script's request id is that id.

S22. Out of scope: remote machines, SSH, a multiplexer, a runtime that outlives the window, a phone client, a plugin surface that rewrites the UI, a detector per external CLI brand, a new chat screen, a change to projectile geometry, Git actions, sidebar control, edits to `provider-connections.md`, and a second provider login. OSC 9, OSC 99, and title-bar text are not presence.

S23. Visible run. A terminal `run` starts one session through the existing spawn command and then asks the desktop to show that same session. The open event carries the session id, the engine, and the alias. It does not carry the opening body. The always-mounted shell switches to the code surface and reuses the existing spawn event, so the pane attaches to the session that already exists. A second process for the same id is a defect. Policy still does not import pane layout. S12 still holds: Dispatch does not split, focus, or resize.

S24. Command on PATH. Inside a Kite terminal, `kite` resolves without a path to the debug executable. The shim runs this binary and prints nothing of its own. `kite dispatch skill` remains the instructions. The terminal environment still includes `KITE_DISPATCH=1` and `KITE_ADDRESS`.

S25. Names an agent can say. `ls` lists each live endpoint as address, alias when one is registered, engine when the run recorded one, and state. `send`, `wait`, `read`, and `report` accept that alias. A bare alias still resolves only when it is unique.

S26. Read returns text. A terminal `read` returns recent session text. It copies the stored stream and does not drain it, does not focus the pane, and does not type. A thread `read` stays on the stored transcript. When the live text is empty, the last published tail is the fallback. Read still does not clear `done`. S34 prefers the grid the terminal engine has already parsed when that grid is not blank.

S27. Parent default. When `--parent` is omitted and the caller address is `session:`, `thread:`, or `alias:`, that address is the parent. The service attaches that address before the run so a notice can be delivered. The words `human` and `agent` are not parents. An explicit `--parent` wins. `--outlive` still skips the stop. A notice into the parent still obeys the parent gate.

S28. Script calls the same CLI. `spawn`, `inject`, and `agents` send `run`, `send`, and `ls` through the loopback schema. `spawn` does not require Code view to be open first: S23 opens the pane. The request file remains a trace. `--no-wait` still writes that file and exits 0 without contacting the app. A waiting call with no endpoint returns `runtime_offline` and does not poll. The task body stays out of the request file.

S29. One-line run. `kite dispatch run <program> "<task>"` starts that program. The first word is the program. Lookup order: a role file with that name, when it exists, supplies the engine and an optional preface; otherwise a program the terminal launcher already knows still starts; otherwise nothing starts and the receipt is `program_not_found`. `--name` sets the alias. When it is omitted, the program word is the alias if it matches the alias grammar. The remaining words are the task. `--via`, `--engine`, `--name`, `--file`, `--parent`, `--outlive`, `--pane`, and `--hidden` still work. When `--role` or `--engine` is already set, every positional word is the task. `--file` and the positional task combine: file text, a blank line, then the words. An agent caller does not ask for a pane unless `--pane` is set. A human caller asks for a pane unless `--hidden` is set. `--hidden` never asks. A word that fails the alias grammar can still start when `--name` provides a legal alias; with no legal alias, nothing starts. The sample files `review` and `reviewer` are created when missing and are not run by themselves. They are briefs, not the catalog of programs.

S30. The manual is on the agent from the start, and it is not the task. Kite writes the skill text to `dispatch/SKILL.md` in the app data directory and copies that same file into each existing user skill directory as `kite-dispatch/SKILL.md`. It does not create a skill directory for an engine that has none. `KITE_SKILL_FILE` is set on every terminal it starts. `kite dispatch skill` prints that same text. The launch line in it is `kite dispatch run <program> "<task>"`. It names the programs the launcher already starts, from the same table as `kite dispatch programs`. The text says it is the complete manual. It tells the agent not to search the repository and not to open a file to learn the commands. When that engine already accepts a system-prompt argument, the manual is that argument on a fresh start and on a resume, and the first message is only the task. The first message does not tell the agent to open a file and does not repeat the command list. An engine without that argument does not receive the manual as the first chat message. The skill file is the channel. A resume of that engine does not turn the manual into a new task. A process opened from the desktop gets the same rule on spawn, not only a child of `run`. The person does not paste a ritual.

S31. The opening body is the process argument. Dispatch composes the role preface when a role file was used, the file, and the positional task, then passes that text as the start prompt of the existing spawn command. It does not queue that body, does not submit it later, and does not wrap it in a pointer. Later `send` calls still follow S5. The pane-open event still carries no opening body. Typing that body when the pane attaches is a defect. Starting the process with an empty prompt and sending the task after the pane is ready is a defect. `kite:spawn-agent-terminal` passes the task into `start_terminal` as the start prompt. The `dispatch-open-pane` listener mounts a view on the session that already exists and does not call `start_terminal`. When there is no task, the process still starts and the manual still rides the system-prompt argument when the engine has one. The task itself stays empty.

S32. Parent notices. When a child enters `blocked`, `done`, `error`, or `gone`, and it has not reported since it last entered `working`, the service submits one notice to the parent for that entry. A later entry into a different one of those states submits another notice. Entering `working` from any other state clears that record. The notice carries the state, the exit fact or `unknown`, and the last read tail up to 60 lines. It uses the S9 envelope, skips the messaging switch, and still obeys the parent gate. A child that has not been `working` yet still notifies.

S33. One spawn path. The Code-view inbox poller does not open a terminal and does not inject text for `spawn` or `inject` request files. It completes those requests without reading the task body into a prompt. The request file stays a trace. Delivery is `kite dispatch`. Listing agents may remain.

S34. Read the grid. A terminal `read` prefers the text of the grid the terminal engine has already parsed. It skips wide-cell continuations, drops trailing blank lines, and does not drain the live buffer. When that grid is blank, S26's stripped stream remains the fallback. Dispatch does not detect a brand in order to read. The `run` receipt includes `pane`: `hidden` or `pending`. `hidden` means no open event was sent. `pending` means an open event was sent. `ls` may later report `shown` after the desktop confirms. `run` does not wait for that confirmation and does not downgrade `pending` to `not_shown` by timeout. The confirmation does not take the policy lock. Policy still does not import pane layout.

S35. The receipt is the process. `run` returns when the session id exists. It does not wait on a pane, a layout, or a geometry measurement. The open event is fire-and-forget. A two-second wait inside `run` is a defect. An agent caller without `--pane` emits no open event. A human caller without `--hidden` emits one. Mounting the view attaches to the session `run` already started. A second process for that id is a defect.

S36. Programs. `kite dispatch programs` prints the engines the terminal launcher already knows how to start, one name per line, from that launcher's table. It does not scan the disk and it does not probe whether a binary is installed. The skill text includes the same names. An agent uses one of those names in `run`. A role file is never required for a name on this list.

## Architecture

```text
human (Zed, inbox UI, script)
agent (CLI, when KITE_DISPATCH=1)
        │
        ▼
   Dispatch policy
   address · presence · queue · wait · report · receipt
        │
        ├── TerminalPort  → existing session spawn, write, buffer, terminate
        │                   presentation event → projectile (one flight)
        └── ThreadPort    → existing thread session send / interrupt
                            no second process, no recipe paste

observers (pane heuristic, OSC 7501, chat status) → presence
watcher, sidebar, inbox UI ← presence and the audit log
```

The provider stream stays on the thread, as `agent-sessions.md` defines. Dispatch only decides when a new user message may be submitted to that thread.

## CLI

```text
kite dispatch ls
kite dispatch programs
kite dispatch run codex "Review the error path."
kite dispatch run grok "Look at the login bug."
kite dispatch run --pane codex "Review on screen."
kite dispatch run --hidden grok "Review without a pane."
kite dispatch run --via terminal --engine codex --name review --parent <address> --file task.md
kite dispatch run --role reviewer --name review --file task.md
kite dispatch send review "Check the error path."
kite dispatch send review --file task.md --queue
kite dispatch wait review --until done --timeout 120000
kite dispatch wait --children all
kite dispatch read review --lines 80
kite dispatch report --to <parent> --body "Findings: …"
kite dispatch skill
```

`send` defaults to queue-when-working. `--if ready` submits only when ready and otherwise returns `not_ready` without queueing. `--wait` chains S7 after a successful submit and applies S8.

Exit status: 0 when the receipt is `queued`, `submitted`, or `settled`. 1 when the receipt is `rejected`, `stalled`, `failed`, or `timeout`. 2 when the arguments are invalid. Stdout is the receipt JSON. Human-readable lines go to stderr when stdout is a terminal, and stdout stays JSON.

## Receipt

```json
{
  "schemaVersion": 1,
  "id": "…",
  "op": "send",
  "status": "submitted",
  "address": "alias:review",
  "submitted": true,
  "presenceAtSubmit": "idle",
  "error": null
}
```

`status` is `queued`, `submitted`, `rejected`, `settled`, or `failed`. `submitted: true` with `status: stalled` means the text was handed to the transport and no presence change followed. `submitted: false` means the transport was not asked to write. `pane`, when present on a `run` receipt, is `hidden` or `pending`. `ls` may report `shown` after the desktop confirms. `pane` is omitted when the operation is not a run.

Error codes: `unknown_address`, `name_taken`, `no_live_endpoint`, `runtime_offline`, `destination_blocked`, `destination_gone`, `not_ready`, `queue_full`, `body_too_large`, `force_forbidden`, `messaging_disabled`, `path_rejected`, `role_not_found`, `program_not_found`, `stalled`, `timeout`, `parent_missing`, `transport_unsupported`.

## Tasks

- T0 — Evidence matrix, read-only. S1, S15, S16, S18. Route: user. For each of the three paths record the function, the write it performs, whether it consults state, whether it can double-submit, and the test that already locks that behavior. Do not change code. Output is a short note in the slice log, not a new subsystem.
- T1 — Contract, addresses, receipts, fake ports. S2, S3, S21. Route: delegated. Prove alias uniqueness, release, agent resolution when no thread is live, and idempotent replay. No I/O beyond the fakes.
- T2 — Presence and the OSC 7501 parser. S4. Route: delegated. Table tests for legal reports, stale sequence, `clear`, malformed bodies, and the map from today's pane states. No PTY.
- T3 — Send, queue, force, wait, stall. S5–S8. Route: delegated. Fake ports only. Assert a blocked destination receives zero writes, a timeout does not write, a repeated id does not write twice, and a stall receipt has `submitted: true`.
- T4 — Envelope, parent, synthetic notice, role files. S9, S10, S12. Route: delegated. Fake ports. A child that exits without a report produces one parent notice. `outlive` leaves the child. A role file starts one command and one first send.
- T5 — Terminal port and the projectile event. S11, S15, S16. Route: delegated. `injectPrompt` calls Dispatch and still emits one flight. The mounted-receiver guard still prevents a second PTY write. Pane split and resize are untouched.
- T6 — Thread port and the inbox projection. S17, S20. Route: delegated. A send to a live thread submits one turn through the existing session API. An approval already open counts as `blocked`. Import the old JSON once. The inbox renders queued and submitted differently.
- T7 — CLI, token, skill text, environment. S14. Route: delegated. Loopback rejects a bad token. `runtime_offline` does not spawn a server. `kite dispatch skill` prints the gate, the envelope, and the force rule.
- T8 — Script and Zed retarget. S16, S18. Route: delegated. `kite-agent.mjs` returns a receipt without a mounted Code view. Handoff still flies from source to target. Spanish planner phrases keep their current actions.
- T9 — Watcher on presence. S19. Route: delegated. One transition, one utterance. Manual close stays silent.
- T10 — Remove the duplicate paths. S1, S18, S20. Route: delegated. Inbox files are no longer required. `delivered: true` on write is gone. Policy tests still show a single submit. Delete nothing that another live feature reads until the projection replaces it.
- T11 — Failure fixtures. S5–S9, S21. Route: delegated. Replay a blocked force attempt, a stall, a dead parent, a path escape, and a repeated id. Run the focused Rust tests, the focused Vitest files, `npx tsc --noEmit`, and the reference audit.
- T12 — Role files on disk and `run --role`. S12. Route: delegated. Depends on T4 and T5. One sample role in the config directory. A missing file starts nothing.
- T13 — Visible run. S23. A terminal `run` emits one open-pane event for the session it started. The pane attaches to that session and does not receive the opening body as a second prompt. The opening body is queued once and is not also presented as a flight.
- T14 — `kite` on PATH. S24. A Kite terminal runs `kite dispatch` without the executable path. The shim prints no banner.
- T15 — Names. S25. `ls` includes the alias, the engine, and the state when they exist. `send` accepts the alias.
- T16 — Read. S26. `read` returns recent terminal text. It does not drain the stream and does not type.
- T17 — Parent. S27. An omitted `--parent` uses `KITE_ADDRESS` when that value is `session:`, `thread:`, or `alias:`. `human` and `agent` start no parent link.
- T18 — Script. S28. `spawn`, `inject`, and `agents` call the dispatch CLI. `--no-wait` still writes one request file and exits 0. A waiting call with no endpoint returns `runtime_offline`.
- T19 — One line. S29. `kite dispatch run review "<task>"` resolves the role `review`, uses that name as the alias unless `--name` is set, and puts the remaining words on the start prompt. The existing flags still parse. `--hidden` starts the session and does not ask for a pane.
- T20 — Manual at birth. S30. The skill file is written. `KITE_SKILL_FILE` is set on a Kite terminal. The start prompt names the command, the address, and that file. `kite dispatch skill` still prints the manual.
- T21 — Birth prompt. S31. A role run and an engine run put the task on the start request. Publishing idle afterward performs zero writes. The pane event does not carry the body.
- T22 — Notices. S32. A child that enters `blocked` notifies the parent once. A later `gone` notifies once more. A second `gone` does not. A report since `working` suppresses the notice.
- T23 — One spawn path. S33. A `spawn` or `inject` request file does not open a pane and does not inject. The task body is not loaded into a prompt. `agents` still lists.
- T24 — Screen and pane. S34. `read` uses the parsed grid when it is not blank, and the stripped stream otherwise. The run receipt carries `pane`. `--hidden` does not emit the open event. The acknowledgement does not take the policy lock.
- T25 — Program, not a required role. S12, S29, S36. `kite dispatch run grok "<task>"` starts grok when no role file exists. `kite dispatch run nosuch` starts nothing and returns `program_not_found`. An explicit `--role` whose file is missing still returns `role_not_found`. `review` still starts the command in its file. `kite dispatch programs` prints the launcher's engine names and does not touch the disk.
- T26 — The task is the argument. S30, S31. The process start prompt equals the task, plus a role preface only when a role file was used. It does not contain the command list. When the engine already accepts a system prompt, that argument is the manual. Publishing idle afterward performs zero writes. `kite:spawn-agent-terminal` includes the task on the start call. The open-pane listener does not call `start_terminal`.
- T27 — The receipt is the process. S35. `run` returns without waiting for a pane. An agent caller without `--pane` emits no open event. A human caller without `--hidden` emits one and still returns at once. `pane` on that receipt is `hidden` or `pending`.
- T28 — Skill line. S30. The printed skill says `kite dispatch run <program> "<task>"` and lists the same names as `programs`. It does not tell the agent to open a file before it can launch.
- T29 — Skill file channel. S30. Route: inline. Status: done. The skill text has YAML frontmatter. `install_dispatch_skill` copies it into existing user skill roots as `kite-dispatch/SKILL.md`. Engines without a system-prompt argument receive only the task as the birth prompt. Evidence: `cargo test --manifest-path src-tauri/Cargo.toml -- dispatch` 56 passed; `a_codex_birth_is_the_task_and_grok_keeps_the_system_prompt` passed.

Slices: A = T0–T2; B = T3–T4; C = T5–T6; D = T7–T8; E = T9–T11; F = T12; G = T13–T18; H = T19–T24; I = T25–T28. A later slice does not start until the previous slice's tests are green. Slice C is the first user-visible change. Slices A and B are inert. Slice G is the agent-facing surface: open, name, read, parent, and the same CLI from the script. Slice H is the surface an agent can use in one line: the manual at birth, the task on the process, a notice to the parent, one spawn path, and a screen read. Slice I corrects that line. The program is the launcher. The task is the process argument. The manual is not the task. `run` returns when the process exists.

## Non-regression and verification

- The projectile still flies once from Zed to a pane, and once from pane to pane, including the impact treatment and reduced-motion behavior already specified.
- A shell request still opens a shell. It does not open an agent. That rule stays in the operator.
- A mounted terminal still does not receive the same prompt as both a PTY write and a landing event.
- Chat sessions still follow `agent-sessions.md`. Dispatch does not paste the agent recipe and does not open a second process for a persistent driver.
- Connection eligibility, approval vocabulary, and thread event kinds stay as they are.
- The inbox still lists historical teammate rows after the import.
- `allow_agent_messaging` still exists. Turning it off stops agent-originated sends.
- T0 is read-only. T1–T4 use fakes. T5–T6 add ports and keep the old tests green. T8 keeps `agentHandoff` and operator tests green. T11 runs the suites named above once.
- Every completed task closes with `Risk: item N (reason)`, or `Risk: none` only after checking shared behavior.

## Invariants

- Do not import terminal, xterm, pane layout, or projectile code from the policy module.
- Do not let a transport decide whether a blocked endpoint may be typed into.
- Do not treat a socket write, a file write, or an animation frame as proof of delivery.
- Do not submit twice for one receipt id.
- Do not retry after timeout or stall.
- Do not let an agent or a script set force.
- Do not answer `kind: permission` with a queued or submitted body.
- Do not attach the callee's transcript to a report.
- Do not scrape the screen inside Dispatch.
- Do not require Code view to be mounted for a script send to be accepted.
- Do not start a background server when the app is closed.
- Do not stop an `outlive` child when the parent stops.
- Do not change projectile geometry, timing, or the orb.
- Do not open a second process when the pane attaches to a session that `run` already started.
- Do not type the opening body twice: once into the PTY and again as a landing.
- Do not queue the opening body when it is already the process start prompt.
- Do not open a pane from an inbox request file.
- Do not detect an external CLI brand in order to read the screen.
- Do not take the policy lock to record that a pane attached.
- Do not treat `human` or `agent` as a parent address.
- Do not drain the terminal stream in order to read it.
- Do not require a role file to start a program the launcher already knows.
- Do not put the manual in front of the task. The task is the first message. The manual rides a system-prompt argument when the engine already has one.
- Do not hold `run` until a pane is confirmed.
- Do not call `start_terminal` again when a pane attaches to a session `run` already started.
- Do not start a birth process with an empty prompt and send the task afterwards.
- Do not add a remote protocol, a multiplexer, or a UI-rewriting plugin surface in this feature.
- Do not edit `provider-connections.md`.
- Product docs, UI copy, code comments, and commit messages describe this product's own implementation only.
- The author of this document does not launch the implementing agents.

## Candidate edit surfaces

Planning candidates, not blanket authorization. The user names exact surfaces when launching a worker.

Expected areas:

- new `src-tauri/src/dispatch/` for policy, presence, parser, receipt, and ports;
- one wiring file under `src-tauri/src/` that constructs the real ports;
- `src-tauri/src/agents.rs` wrappers and the inbox projection;
- `src-tauri/src/terminal.rs` only where the terminal port must call spawn, write, buffer, and terminate;
- `src-tauri/src/chat/` only where the thread port submits or interrupts through the existing session API;
- `src/lib/operator/appOperatorController.ts`, `src/lib/operator/executor/actions/injectPrompt.ts`, `src/lib/operator/executor/actions/handoffToAgent.ts`, and the spawn action;
- `src/lib/operator/proactiveWatcher.ts`;
- `scripts/kite-agent.mjs` and its test;
- `src/components/views/agents/AgentChatShell.tsx` for the queued-versus-submitted row;
- the existing projectile overlay only as a subscriber of the presentation event;
- the always-mounted application shell, only to turn one open-pane event into the existing spawn event;
- `src/lib/agentInboxLoop.ts`, only so a request file does not open or inject;
- the terminal grid reader, only to return text it has already parsed;
- the spawn listener, only to acknowledge that the pane attached.

Read-only from this feature: `src-tauri/src/connections.rs`, provider auth files, and `odd/tasks/provider-connections.md`.

## Allowed edit surfaces

Exact surfaces are fixed when the user launches each task. New files are listed in that launch. A worker does not edit the repository root, unrelated provider modules, or broad unrelated globs.

## Trace

Each run, submit, launch, and multiline terminal write appends one line under the dispatch traces folder, next to the skill manual. The daily file is `dispatch-YYYY-MM-DD.jsonl`. `latest.txt` in that folder is the last event.

A terminal write is recorded when it contains a line break or a bracketed paste. A single keystroke is not. `split-risk` means one write contained more than one line and was not bracketed paste. A thread message stays one piece even when it has several lines. The trace is a record only. It does not change how text is passed to a program.

## Log

- L1. 2026-11-02. The user asked for a detailed plan of a general communication service: modular, reusable, not wired into terminal logic, with a professional CLI-style surface. Existing injection, handoff, mailbox, and script behavior must move onto it. The plan is this ODD. The walkthrough deck is `docs/agent-orchestration/agent-dispatch.pptx`.
- L2. 2026-11-02. Scope is the closed loop: address, gate, wait, report, parent, receipt, and two ports. The multiplexer, remote machines, and a runtime that outlives the window are out of scope. The projectile stays a presentation subscriber.
- L3. 2026-11-02. T0 evidence. No behavior change.
  - Operator injection. `appOperatorController.injectPrompt` writes `write_terminal` only when no `.terminal-view-container[data-session-id]` is mounted. Otherwise it emits `kite:dispatch-prompt-projectile` and does not write. It does not read `working`, `waitingForYou`, `idle`, `done`, or `exited`. The mounted check is the double-submit guard. Locking test: `src/lib/operator/operator.test.ts` ("writes the prompt through write_terminal when no terminal pane is mounted").
  - Profile mailbox. `send_agent_message` appends `agent-messages.json` and sets `delivered: true` at write time. It does not consult presence and it does not write a PTY. A second call appends another row. The inbox reader is `agent_message_inbox`, which defaults `delivered` to true. No separate presence test locks this path.
  - Workspace script. `scripts/kite-agent.mjs` `runCli` writes `<cwd>/.kite/inbox/<id>.request.json`. Unless `--no-wait`, it polls for 8 seconds for a result file. It does not consult presence. The desktop poller can submit that request later, so the file is not itself delivery. Locking test: `scripts/kite-agent.test.mjs` (the request JSON keeps `taskPath` and omits the task body).
  - Risk: none. T0 did not edit shared behavior.
- L4. 2026-11-02. The loop is in the tree on `feat/ui-composer`. Policy stays free of the terminal and chat modules. Live ports, the loopback CLI, and the existing clients call that policy.
  - `cargo test --manifest-path src-tauri/Cargo.toml -- dispatch`: 20 passed, 0 failed.
  - `injectPrompt` calls `dispatch_send` and no longer calls `write_terminal`. The operator suite (`operator.test.ts`, 45) passed, including the updated locking test.
  - `send_agent_message` and `agent_message_inbox` are wrappers. `readOnly` comes from the preference file and defaults to false. A queued send is not marked delivered.
  - `kite dispatch` returns before the window opens. The running app binds `127.0.0.1` and writes `dispatch-endpoint.json`. Shutdown deletes that file.
  - New terminals get `KITE_DISPATCH=1` and `KITE_ADDRESS=session:<id>`.
  - `scripts/kite-agent.mjs --no-wait` still writes one request file and exits 0. A waiting call with no endpoint prints `runtime_offline` and does not poll for 8 seconds. `node --test scripts/kite-agent.test.mjs` passed.
  - Observed presence is published from the terminal registry when the state changes. The watcher did not gain a second invoke. `proactiveWatcher.test.ts` (8) passed.
  - The projectile overlay also listens for the `dispatch-prompt-projectile` app event and re-dispatches the existing window event. Geometry is unchanged. `PromptProjectileOverlay.test.tsx` (19) passed.
  - Startup creates `dispatch/roles/reviewer.md` only when that file is missing. It does not run the role.
  - Risk: `npx tsc --noEmit` still reports one error in `src/components/views/terminal/canvas/canvasGridRenderer.dirtyRows.test.ts`. That file is outside this change.
  - Risk: a CLI `read` of a terminal can return an empty tail until the desktop registry has published one. The service does not scrape the screen.
  - Risk: the workspace script's waiting path checks that the app is up. The request file is still the trace the desktop poller delivers. A live window was not exercised in this run.
- L5. 2026-11-02. Slice G, on `feat/ui-composer`. Agents get the same commands as a person, from inside a Kite terminal.
  - `run` starts one session and emits `dispatch-open-pane`. The shell switches to code and reuses the existing spawn event with that session id. The opening body is not passed as a second prompt. It is queued once, and the flight flag is already set so the landing does not type it again.
  - `kite.cmd` is written under the roaming `bin` directory and that directory is prepended to the terminal `PATH`.
  - `ls` adds the engine when the run recorded one. `send` still accepts the alias.
  - `read` copies the session stream, strips control sequences, and does not drain it. A published tail is used only when that copy is empty.
  - An omitted `--parent` uses `KITE_ADDRESS` when it is `session:`, `thread:`, or `alias:`. The word `human` does not become a parent.
  - `spawn`, `inject`, and `agents` call `run`, `send`, and `ls`. `--no-wait` still writes one request file and exits 0. The task body stays out of that file.
  - `cargo test --manifest-path src-tauri/Cargo.toml -- dispatch`: 24 passed, 0 failed.
  - Focused Vitest: 6 files, 104 passed. `node --test scripts/kite-agent.test.mjs` passed. `node .kite/sanitizer/audit-references.mjs --check` passed.
  - Risk: `npx tsc --noEmit` still reports one error in `src/components/views/terminal/canvas/canvasGridRenderer.dirtyRows.test.ts`. That file is outside this change.
  - Risk: a live window was not exercised. `read` returns the recent stream as text. It does not interpret a full-screen program cell by cell. The first body still waits until the new endpoint is idle or done.
- L6. 2026-11-03. Slice H, on `feat/ui-composer`. An agent starts another agent in one line. The task arrives when the process starts. The parent is told when the child blocks or ends. One path opens the pane.
  - `kite dispatch run review "<task>"` uses the role `review` and that name as the alias. Remaining words are the task. `--name` wins. `--hidden` starts the session and does not emit the open event. The sample file `dispatch/roles/review.md` is created when missing, beside `reviewer.md`, and is not run by itself.
  - The skill text is written to `dispatch/SKILL.md`. A Kite terminal gets `KITE_SKILL_FILE`. The start prompt names `kite`, `KITE_ADDRESS`, and that file. `kite dispatch skill` still prints the same text.
  - The opening body is the process start prompt. It is not queued and it is not typed again when the pane attaches. Publishing idle afterward performs zero writes.
  - A child entering `blocked`, `done`, `error`, or `gone` notifies the parent once per entry. Entering `working` clears that record. A report since `working` suppresses the notice. The notice still obeys the parent gate.
  - The Code-view poller completes `spawn` and `inject` request files without reading the task into a prompt and without opening a pane. `agents` still lists.
  - `read` prefers the grid the terminal engine has already parsed. A blank grid falls back to the stripped stream. The run receipt carries `pane`: `shown`, `hidden`, or `not_shown`. The acknowledgement does not take the policy lock.
  - `cargo test --manifest-path src-tauri/Cargo.toml -- dispatch`: 28 passed, 0 failed. `screen_text_reads_the_grid_and_drops_blank_tails` passed. `npx vitest run src/lib/agentInboxLoop.test.ts`: 1 passed. `node --test scripts/kite-agent.test.mjs`: 2 passed. `node .kite/sanitizer/audit-references.mjs --check` passed.
  - Risk: `npx tsc --noEmit` still reports one error in `src/components/views/terminal/canvas/canvasGridRenderer.dirtyRows.test.ts` (TS2352). That file is outside this change.
  - Risk: a live window was not exercised. `shown` depends on the desktop confirming the pane. With the app closed, `runtime_offline` stays the result. Remote machines, a multiplexer, and a runtime that outlives the window stay out of scope.
- L7. 2026-11-03. Launch correction, specified as slice I. Not implemented in this entry.
  - What the tree does. `kite dispatch run <word>` resolves `<word>` only as `dispatch/roles/<word>.md`. The sample files are `review` and `reviewer`, both `command: codex`. A known engine with no file returns `role_not_found` and starts nothing. The start prompt prepends a pointer to `KITE_SKILL_FILE` and the command list, then the task. `run` waits up to two seconds for a pane. `dispatch-open-pane` fires `kite:spawn-agent-terminal`, and that handler calls `start_terminal` with `initialPrompt` cleared. A desktop spawn that does carry a task stores it and injects it later, after the pane exists, through the send gate.
  - What is wrong. An agent that names `grok` or `codex` does not start a process. An agent that never opens the skill file has no launch line except the buried pointer. The task is not the first thing the process reads. The receipt waits on the window. A second start can drop the task.
  - What slice I changes. S29, S30, S31, S34, S35, and S36. The word is a program. The task is the process argument. The manual is not the task. `run` returns when the session exists. The pane mounts that session and does not start another.
  - Risk: none for this entry. It edits this specification only.
- L8. 2026-11-03. Slice I (T25–T28), on `feat/ui-composer`. The word is a program. The task is the process argument. The manual is not the task. `run` returns when the session exists.
  - `kite dispatch run <program> "<task>"` starts a known program when no role file exists. A role file with that name still supplies the engine and the preface, and it wins over a known program of the same name. An unknown word is `program_not_found` and starts nothing. An explicit `--role` whose file is missing stays `role_not_found`. `kite dispatch programs` prints the launcher names, one per line, from the in-code table. It does not scan the disk.
  - The start prompt is the task, plus a role preface only when a role file was used. Engines that already accept a system prompt receive the manual as that argument, and the task does not name the skill file. Other engines get one trailing line, `The manual is in KITE_SKILL_FILE.` The printed skill says `kite dispatch run <program> "<task>"` and lists the same names, in the same order. A desktop spawn of an engine that accepts a system prompt gets that manual when the caller did not pass one.
  - `run` does not wait for a pane. The receipt `pane` is `hidden` or `pending`. An agent does not get a pane unless `--pane`. A person gets a pane unless `--hidden`. `--hidden` wins. The open event mounts the session that already exists and does not start a second process. A real birth passes the task into the start command and does not type that same text again when the pane is ready.
  - `cargo test --manifest-path src-tauri/Cargo.toml -- dispatch`: 35 passed, 0 failed.
  - `npx vitest run src/lib/subagentDispatcher.test.ts src/lib/agentHandoff.test.ts src/lib/operator/executor/executor.test.ts`: 3 files, 32 passed.
  - Risk: `npx tsc --noEmit` still reports one error in `src/components/views/terminal/canvas/canvasGridRenderer.dirtyRows.test.ts` (TS2352). That file is outside this change.
  - Risk: `ls` may later report `shown` after the desktop confirms. This slice does not rewrite `ls`. A live window was not exercised. Remote machines, SSH, and a runtime that outlives the window stay out of scope.
  - Risk: a shell spawn that used to type its prompt after the pane was ready now passes that text only to the start command. A shell that does not take a start argument does not receive a second send.
- L9. 2026-11-03. Handoff trace, on `feat/ui-composer`. Each run, submit, launch, and multiline terminal write appends one line under the dispatch traces folder, next to the skill manual. `latest.txt` is the last event. `split-risk` means one write contained more than one line and was not bracketed paste. A thread message stays one piece. The record does not change how text is passed to a program.
  - `cargo test --manifest-path src-tauri/Cargo.toml -- dispatch`: 42 passed, 0 failed.
  - Risk: a failed trace write does not change the receipt. Paste, argv, the gate, the birth prompt, and pane policy are unchanged. A live window was not exercised.
- L10. 2026-11-07. S30 no longer uses a trailing file pointer. The skill text is the complete manual. Grok and Claude Code receive it as the system prompt on a fresh start and on a resume. Other known agents receive that same text, then the task. A resume of those agents does not turn the manual into a new task.
- L11. 2026-11-07. "A R hemos tenido un problema bastante, frecuente. Cuando yo digo que se implementen nuevas funcionalidades. Copiando. Literalmente otras aplicaciones. Pasan este tipo de cosas. No se entiende en su totalidad. Todo lo que hay que copiar. Este caso. Sí es uno de ellos. Quiero decir, tenemos que llegar a copiar. Como tú dijiste. Tiene que llegarle correctamente el manual, y no necesariamente por un prompt. O sea, por una inyección de prompt al inicio de la conversación. Sino que, por algo más limpio, como lo hacen ellos, claramente. Entonces, tenemos que llegar a corregir, claramente, y no podemos continuar. Teniendo este tipo de errores. Por eso tenemos dos cosas a corregir a futuro. Una de ellas es instruccionamiento más claro con respecto a cuando yo diga. Ok, quiero que copies de tal proyecto. Quiero decir, se tiene que tener una mejor instrucción a mí, una mejor instrucción para que realmente copie todas las funcionalidades o analice todas las funcionalidades y luego las traslademos a nuestro proyecto. Básicamente porque ahora faltaron muchas cosas. También se debe tener en consideración que, se tienen skills, o instrucciones para luego, en la documentación. No incluir. O referenciar, que copiamos de estos proyectos porque no es tan ético. Pero igual lo podemos hacer porque son de código abierto. Y demás. Entonces, em claramente tenemos que llegar a corregir. Completamente. Esta parte. De la, del instruccionamiento. Pero en general, así de cara al futuro. Y también tenemos que llegar a corregir el tema de la skill. Eh, para, para hacerlo más limpio." S30 now installs `kite-dispatch/SKILL.md` into existing skill directories. The first chat message is the task. Public docs do not name a source product.
- L12. 2026-11-07. Multi-line paste normalization, canonical naming on delegation, and presence discrimination.
  - Multiline submissions in backend (`LivePort::submit`) and frontend (`terminalInputKeyEncoder.ts`) format text via bracketed paste (`\x1b[200~...\x1b[201~`) with 45ms PTY write pacing before a single `\r`, preventing queue splitting in interactive TUI agents.
  - Delegated runs without `--name` allocate canonical codenames (`Orion`, `Nova`, `Atlas`, etc.) and UI normalizes aliases to Title Case.
  - `terminalRegistry.ts` maps ready prompt chevrons (`>`, `❯`, `$`) to `idle`/`done` rather than `blocked`, checking for real confirmation queries via `isBlockedOnQuestionOrApproval` to eliminate spurious synthetic parent notices.
  - Evidence: 57 cargo dispatch tests passed; 31 vitest tests passed; `node .kite/sanitizer/audit-references.mjs --check` clean. Published in v0.1.51.
