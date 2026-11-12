# Agent dispatch parity

Objective: agents can launch each other, wait, read, interrupt, and stop through one `kite dispatch` service, and the Zed operator closes sessions through that same service.
Branch: `feat/agent-dispatch-parity`. Delivery strategy: `ask-on-risk`. Test runner: `cargo test --manifest-path src-tauri/Cargo.toml -- dispatch` and `npx vitest run src/lib/operator/executor/executor.test.ts`.
Does not change the title-bar mode switcher.

## Specs

S1. `kite dispatch wait` blocks.
User words: "quiero q vayamos con las correcciones completmanete, la idea es poder llegar a tener algo muy similar o igual incluso que permita la comunicacion, espawneo de agentes o manejarlos entre ellos".
`kite dispatch wait <address>` does not return while the destination is still outside the requested states and the timeout has not elapsed. The default timeout is 30000 ms. A settled wait exits 0. A timeout exits 1 with `"error":"timeout"`. The command writes that receipt to stdout.

S2. A program report wins over the screen.
While an OSC 7501 report is current, `send`, `wait`, and `ls` use that report. A later screen observation does not replace it. `clear`, or a newer report, drops it, and the screen observation applies again. Stopping a session marks it gone even if a report was current.

S3. Agents can manage a session.
`kite dispatch kill <address>` ends that session and the children that do not outlive it. `kite dispatch interrupt <address>` writes Ctrl+C and does not press Enter. `kite dispatch keys <address> <key...>` writes the named keys and does not add an Enter unless the key is `enter`. `kite dispatch attach <address>` asks the desktop to show that session. These commands work while the destination is working or blocked.

S4. An unknown word starts that program.
`kite dispatch run <program> "<task>"` still starts a known agent, and a role file with that name still wins. A word that is neither a role nor a known agent starts that executable with the remaining words as its arguments. The task is not also typed as a second prompt. A missing executable returns `program_not_found` and starts no session.

S5. Receipts are captured by a pipe.
`kite dispatch` writes the receipt, the skill text, and the program list to stdout and flushes. A caller that redirects stdout receives those bytes.

S6. The Zed operator reuses dispatch to close.
Closing a terminal from the operator calls `dispatch_kill` for `session:<id>`. A session the service has not seen yet is still terminated. A failed kill does not mark the terminal exited.

S7. Every agent receives the complete manual.
User words: "hagas las correcciones de las instrucciones. Para que cada agente tenga. Todo lo necesario".
The skill text is the complete manual. It tells the agent not to search the repository and not to open a file to learn the commands. Kite writes that text as `kite-dispatch/SKILL.md` in each existing user skill directory. It does not create a skill directory for an engine that has none. Grok and Claude Code also receive that text as the system prompt on a fresh start and on a resume. The first message stays the task. Every other known agent receives only the task as the first message. A resume of those agents does not turn the manual into a new task. A desktop spawn uses the same rule. No MCP server is added.

S8. Multiline terminal paste stability and single-message delivery.
User words: "al pegar textos un poco largos o más de una línea, en Grok se pegaba como 25 mensajes, quedaban todos en cola... Si no se corrige costaría demasiado ejecutar una sola delegación."
On Windows ConPTY, interactive TUIs (Grok, Claude Code, OpenCode) negotiate bracketed paste directly with the console host. Submitting raw newlines or splitting text into newline chunks caused the CLI to register every line break as a separate message submission, flooding queues with up to 148 messages.
Submissions now:
1. Strip stray `\x1b[200~` and `\x1b[201~` markers.
2. In frontend (`terminalInputKeyEncoder.ts`), any multiline paste is normalized with `\n` line breaks and wrapped in `\x1b[200~${text}\x1b[201~`.
3. In backend (`dispatch_wire.rs` `LivePort::submit`), multiline submissions to unmounted or background terminal sessions format text via `format_terminal_paste`, write the bracketed payload, sleep 45ms for ConPTY input ingestion, and write a single trailing carriage return `\r`.
4. In `TerminalView.tsx`, mounted projectile staged prompts with `visualOnly: true` (already delivered to the PTY by backend dispatch) execute only visual flight/impact animations and bypass duplicate PTY writes.

S9. Canonical codename stack for delegated agents.
User words: "está asignándole un nombre a la gente que delegó, el anti-gravity. Debería asignarle un nombre coherente siguiendo el patrón que tenemos: Atlas, Orion o similares para poder identificar los agentes, no simplemente llamarles anti-gravity."
When an agent or script delegates via `kite dispatch run <program> "<task>"` without an explicit `--name` (or with a name matching a raw engine like `"antigravity"` or `"grok"`):
1. `Service::run` on the backend allocates the next free canonical agent codename (`"orion"`, `"nova"`, `"atlas"`, `"vega"`, etc.) from Kite's 30-codename pool and registers it as the primary alias (`ep.alias`).
2. Address resolution (`parse_address`) accepts canonical codenames case-insensitively (`Orion`, `alias:Orion`).
3. In the UI (`useWorkspaceEventListeners.ts` and `agentNames.ts`), `resolveCanonicalAgentName` normalizes incoming aliases to Title Case and substitutes any raw engine name with the next free codename so tab headers and titles display unique, canonical identities (e.g. `Orion (antigravity)` instead of `antigravity`).

S10. Observed presence discrimination: Idle/Done vs genuine blocked approvals.
Normal ready prompt markers (`>`, `❯`, `$`, `?`) previously caused `terminalRegistry.ts` to map `waitingForYou` directly to `state: blocked`, which in turn triggered synthetic parent notice envelopes (`[kite from="..."] Child state: blocked`) 2 seconds after every spawn and completion.
1. `isBlockedOnQuestionOrApproval` now checks specifically for genuine interactive confirmation keywords (`(y/n)`, `[y/n]`, `confirm?`, `proceed?`, `approval required`, `allow once`, `select an option`) or non-placeholder question lines.
2. Prompts at normal CLI chevrons map to `idle` (before the first task) or `done` (after execution), suppressing bogus blocked notifications to parents.
3. Clean 2D screen text is read for parent notices, and transient spinner frames / trailing blank rows are stripped.

## Tasks

- T1. S5, S1. Route: inline. Status: done. stdout receipts, and `wait` polls until settled or timeout.
- T2. S2. Route: inline. Status: done. Reported presence wins. A stop still marks the session gone.
- T3. S3. Route: inline. Status: done. `kill`, `interrupt`, `keys`, `attach`.
- T4. S4. Route: inline. Status: done. Raw program argv, no second prompt, missing executable starts nothing.
- T5. S6. Route: inline. Status: done. Operator close calls `dispatch_kill`.
- T6. S7. Route: inline. Status: done. The complete manual is a skill file, plus a system prompt only on engines that accept one. No MCP. Evidence: dispatch 56 passed; terminal birth test passed.
- T7. S8. Route: inline. Status: done. Bracketed paste for multiline submissions in backend & frontend, `visualOnly` projectile flag.
- T8. S9. Route: inline. Status: done. Canonical codename allocation on delegation, case-insensitive alias parsing, Title Case display normalization.
- T9. S10. Route: inline. Status: done. `isBlockedOnQuestionOrApproval` in presence observer, clean 2D screen tail in parent notices.

## Log

L1. 2026-11-07. "quiero q vayamos con las correcciones completmanete, la idea es poder llegar a tener algo muy similar o igual incluso que permita la comunicacion, espawneo de agentes o manejarlos entre ellos luego alinear con el asistente zed para reutilizar el sistema quizas"

L2. 2026-11-07. The corrections from the review are the specs above. Zed reuses the service for close in this change. Launch from the operator already starts a terminal and publishes presence; this change does not start a second process for that path. Sessions already stay up when the window closes and kite-core owns the PTYs. The branch is cut from `5cae8d1` because `feat/response-thread` has unrelated uncommitted work.

L5. 2026-11-07. "tenemos que llegar a fusionar varias cosas" and "al finalizar quiero que generes la actualización". `feat/ui-composer` was already inside `feat/response-thread`. The dispatch commits and the uncommitted thread work are now on `feat/response-thread`.

L4. 2026-11-07. "el MCP no lo vamos a implementar, pero sí quiero que hagas las correcciones de las instrucciones. Para que cada agente tenga. Todo lo necesario". The MCP the user saw belongs to another project. This change does not add one. The manual no longer points at a file.

L6. 2026-11-07. The first chat message is no longer the manual. `kite-dispatch/SKILL.md` is copied into existing user skill directories. Engines without a system-prompt argument receive only the task.

L7. 2026-11-07. S8–S10 implemented for delegation paste stability, canonical naming, and clean presence reporting.
- Backend wraps multiline terminal submissions in bracketed paste (`\x1b[200~...\x1b[201~`) followed by a single `\r` after 45ms delay, preventing line-by-line queue flooding (`Queued 148`) in Grok and other TUIs.
- Delegated runs without `--name` (or naming raw engines like `antigravity`) automatically receive the next canonical agent codename (`Orion`, `Nova`, `Atlas`, etc.) both as backend alias and frontend title.
- Ready CLI prompts (`>`, `❯`, `$`) map to `idle`/`done` rather than `blocked`, restricting `blocked` to genuine question/approval prompts (`isBlockedOnQuestionOrApproval`) and eliminating bogus parent notice envelopes.
- Evidence: 57 cargo dispatch tests passed; 31 vitest tests passed; zero leaks on sanitizer audit.

L3. 2026-11-07. T1–T5 implemented on `feat/agent-dispatch-parity` in `88c9b85`. `wait` polls until settled or the timeout, then writes a failed receipt with error `timeout`. Reported presence wins until `clear`. `kill`, `interrupt`, `keys`, and `attach` are commands. An unknown word starts that argv and does not type a second prompt. A missing executable returns `program_not_found` before a PTY opens. Receipts go to stdout. Operator close calls `dispatch_kill` for `session:<id>` and does not mark the terminal exited when the receipt fails. Proof: `cargo test --manifest-path src-tauri/Cargo.toml -- dispatch` 55 passed; `npx tsc --noEmit` exit 0; `npx vitest run src/lib/operator/executor/executor.test.ts -t close_terminals` 3 passed. The installed app was not restarted, so this build was not tried in a live window.
