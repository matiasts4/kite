# Grok pane restore stays on that pane's conversation

Objective: Restart restores each Grok pane's own conversation, and a development session does not come back inside the installed app.
Branch: `feat/response-thread` (uncommitted; this branch already holds unrelated work)
Delivery strategy: `ask-on-risk` | Test runner: `cargo test --lib session_resolver::tests` and `cargo test --lib core_daemon::tests::development_build_uses_its_own_daemon_pipe`

## Specs

S1. "se restauran sesiones equivocadas"
A Grok pane restarts on the conversation id saved for that pane. It does not resume a different conversation from the same folder. If that saved id is already open in a live process, the pane does not take a different conversation in its place.

S2. "Hay sesiones que yo no abrí en la versión instalada, pero sí en la de desarrollo y se restaura la de desarrollo en la instalada"
The installed app restores only sessions it opened. The development app restores only sessions it opened. A development daemon does not answer the installed app, and the installed app does not answer the development daemon.

S3. "a veces no se restauran las correctas. A veces sí, pero no el cien por ciento de las veces."
Restart restores the saved Grok conversation every time that id is not open in a live process. A stale active-session record with a dead process id does not discard the saved conversation.

Assumption: a pane with no saved conversation id starts a new Grok conversation. It does not guess among older conversations in that folder.

## Tasks

- T1 — S2 — inline — done — `core_pipe_stem` is `kite-core-v1-dev` in debug and `kite-core-v1` in release. Evidence: `development_build_uses_its_own_daemon_pipe` passed; `node scripts/kite-agent.test.mjs` 7 passed.
- T2 — S1, S3 — inline — done — restore keeps a saved id whose owner pid is dead, refuses a live owner, and does not discover a sibling. Evidence: RED then GREEN on `restore_grok_keeps_saved_id_and_does_not_substitute`.
- T3 — S1 — inline — done — a live bind records only an active-session id whose pid is in this process tree. Evidence: `grok_owned_session_id_matches_only_this_process_tree` passed.

## Log

L1 (2026-11-11): Quiero que trabajemos en corregir la restauración de sesiones de Grok. Básicamente creo que hay bastantes errores y tienen que ver con respecto a que se restauran sanciones eh, equivocadas. Aparte de que creo que se combina un poco la versión de desarrollo con la versión instalada. Quiero decir. Hay sesiones que yo no abrí. En la versión de instalada, pero sí en la de desarrollo y se restaura la de desarrollo. En la instalada, cosa que está bastante raro. Y bueno, la mayoría de veces cuando reinicio la aplicación, a veces no se restauran las correctas. A veces sí, pero no el cien por ciento de las veces.

L2 (2026-11-11): Verified. `restore_grok_keeps_saved_id_and_does_not_substitute` failed on the old substitute path, then passed. `development_build_uses_its_own_daemon_pipe`, `grok_owned_session_id_matches_only_this_process_tree`, `grok_parse_active_session_ids_reads_session_id_field`, and `resolve_grok_picks_unclaimed_cwd_session_closest_to_spawn` passed. `node scripts/kite-agent.test.mjs` 7 passed. Not exercised in the installed window.
