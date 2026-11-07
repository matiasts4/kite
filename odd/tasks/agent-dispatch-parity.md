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
The skill text is the complete manual. It tells the agent not to search the repository and not to open a file to learn the commands. Grok and Claude Code receive that text as the system prompt on a fresh start and on a resume. The first message stays the task. Every other known agent receives the same text, then the task. A resume of those agents does not turn the manual into a new task. A desktop spawn uses the same rule. No MCP server is added.

## Tasks

- T1. S5, S1. Route: inline. Status: done. stdout receipts, and `wait` polls until settled or timeout.
- T2. S2. Route: inline. Status: done. Reported presence wins. A stop still marks the session gone.
- T3. S3. Route: inline. Status: done. `kill`, `interrupt`, `keys`, `attach`.
- T4. S4. Route: inline. Status: done. Raw program argv, no second prompt, missing executable starts nothing.
- T5. S6. Route: inline. Status: done. Operator close calls `dispatch_kill`.
- T6. S7. Route: inline. Status: done. The complete manual is on every known agent. No MCP.

## Log

L1. 2026-11-07. "quiero q vayamos con las correcciones completmanete, la idea es poder llegar a tener algo muy similar o igual incluso que permita la comunicacion, espawneo de agentes o manejarlos entre ellos luego alinear con el asistente zed para reutilizar el sistema quizas"

L2. 2026-11-07. The corrections from the review are the specs above. Zed reuses the service for close in this change. Launch from the operator already starts a terminal and publishes presence; this change does not start a second process for that path. Sessions already stay up when the window closes and kite-core owns the PTYs. The branch is cut from `5cae8d1` because `feat/response-thread` has unrelated uncommitted work.

L4. 2026-11-07. "el MCP no lo vamos a implementar, pero sí quiero que hagas las correcciones de las instrucciones. Para que cada agente tenga. Todo lo necesario". The MCP the user saw belongs to another project. This change does not add one. The manual no longer points at a file.

L3. 2026-11-07. T1–T5 implemented on `feat/agent-dispatch-parity` in `88c9b85`. `wait` polls until settled or the timeout, then writes a failed receipt with error `timeout`. Reported presence wins until `clear`. `kill`, `interrupt`, `keys`, and `attach` are commands. An unknown word starts that argv and does not type a second prompt. A missing executable returns `program_not_found` before a PTY opens. Receipts go to stdout. Operator close calls `dispatch_kill` for `session:<id>` and does not mark the terminal exited when the receipt fails. Proof: `cargo test --manifest-path src-tauri/Cargo.toml -- dispatch` 55 passed; `npx tsc --noEmit` exit 0; `npx vitest run src/lib/operator/executor/executor.test.ts -t close_terminals` 3 passed. The installed app was not restarted, so this build was not tried in a live window.
